"""Zoho -> portal sync: keeps the crm_* tables in step with Zoho CRM.

* Full sync: copies everything the portal shows and removes rows that no
  longer exist in Zoho. Runs on first start and daily.
* Catch-up sync: every few minutes, only records changed since the last run
  (Zoho Modified_Time), so a missed webhook is corrected.
* One record: what a Zoho webhook triggers when a record changes.

Each module is written in one transaction. A row that points at a record not
yet in the copy (say, a deal for a brand-new contact) fetches that record first;
if Zoho no longer has it, the reference is cleared."""

from __future__ import annotations

import asyncio
import contextlib
import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import delete, func, select, text, update

from ..config import Settings
from ..db import (CrmAgent, CrmContact, CrmDeal, CrmDealStage, CrmLead, CrmMessage, CrmProperty, CrmTask, Database, SyncState, User,
                  utcnow)
from .sources import MODULES

log = logging.getLogger("portal.sync")

MODELS = {"agents": CrmAgent, "contacts": CrmContact, "properties": CrmProperty, "deals": CrmDeal, "leads": CrmLead,
          "messages": CrmMessage, "tasks": CrmTask}
REFS = {
    "contacts": [("owner_zoho_id", "agents")],
    "deals": [("contact_zoho_id", "contacts"), ("property_zoho_id", "properties"), ("owner_zoho_id", "agents")],
    "leads": [("referred_by_zoho_id", "contacts"), ("owner_zoho_id", "agents")],
    "messages": [("contact_zoho_id", "contacts"), ("deal_zoho_id", "deals"), ("property_zoho_id", "properties")],
    "tasks": [("message_zoho_id", "messages"), ("owner_zoho_id", "agents"), ("contact_zoho_id", "contacts"), ("deal_zoho_id", "deals")],
}
REQUIRED_REFS = {("messages", "contact_zoho_id")}  # a message without its contact is dropped
# Webhook / API module names -> sync modules.
MODULE_ALIASES = {"contacts": "contacts", "deals": "deals", "properties": "properties", "leads": "leads", "notes": "messages",
                  "messages": "messages", "tasks": "tasks", "users": "agents", "agents": "agents"}
ADVISORY_LOCK_KEY = 7_201_337
OVERLAP = timedelta(minutes=1)  # re-read a little before the cursor so nothing slips between runs


class SyncEngine:
    def __init__(self, *, db: Database, source: Any, settings: Settings):
        self.db = db
        self.source = source
        self.settings = settings
        self._lock = asyncio.Lock()

    # ---- coordination --------------------------------------------------------
    @contextlib.asynccontextmanager
    async def _exclusive(self):
        """One sync at a time: in this process, and across instances on PostgreSQL."""
        async with self._lock:
            if not self.db.is_postgres:
                yield True
                return
            async with self.db.engine.connect() as conn:
                got = await conn.scalar(text("SELECT pg_try_advisory_lock(:k)"), {"k": ADVISORY_LOCK_KEY})
                try:
                    yield bool(got)
                finally:
                    if got:
                        await conn.execute(text("SELECT pg_advisory_unlock(:k)"), {"k": ADVISORY_LOCK_KEY})
                        await conn.commit()

    # ---- writing rows ----------------------------------------------------------
    async def _exists(self, session, module: str, ids: set[str]) -> set[str]:
        if not ids:
            return set()
        model = MODELS[module]
        return set(await session.scalars(select(model.zoho_id).where(model.zoho_id.in_(ids))))

    async def _resolve_refs(self, session, module: str, rows: list[dict], depth: int = 0) -> list[dict]:
        for column, target in REFS.get(module, []):
            wanted = {r[column] for r in rows if r.get(column)}
            missing = wanted - await self._exists(session, target, wanted)
            fetched: list[dict] = []
            if missing and depth < 2:
                for zoho_id in missing:
                    try:
                        row = await self.source.one(target, zoho_id)
                    except Exception as err:  # noqa: BLE001
                        log.warning("Could not fetch %s %s from Zoho: %s", target, zoho_id, err)
                        row = None
                    if row:
                        fetched.append(row)
                if fetched:
                    await self._write(session, target, fetched, depth=depth + 1)
                missing -= {r["zoho_id"] for r in fetched}
            if missing:
                if (module, column) in REQUIRED_REFS:
                    rows = [r for r in rows if r.get(column) not in missing]
                else:
                    for r in rows:
                        if r.get(column) in missing:
                            r[column] = None
        return rows

    async def _ensure_stages(self, session, rows: list[dict]) -> None:
        names = {r["stage"] for r in rows if r.get("stage")}
        known = set(await session.scalars(select(CrmDealStage.name).where(CrmDealStage.name.in_(names)))) if names else set()
        for name in names - known:  # a stage added in Zoho since the last stage sync
            session.add(CrmDealStage(name=name, sequence=999, is_won=name in self.settings.crm.won_stages,
                                     is_lost=name in self.settings.crm.lost_stages))
        if names - known:
            await session.flush()

    async def _write(self, session, module: str, rows: list[dict], depth: int = 0) -> int:
        """Insert or update rows by Zoho id."""
        if not rows:
            return 0
        rows = await self._resolve_refs(session, module, [dict(r) for r in rows], depth)
        if module == "deals":
            await self._ensure_stages(session, rows)
        if module == "leads":
            lead_ids = [r["zoho_id"] for r in rows]
            users = dict((await session.execute(select(User.zoho_lead_id, User.id).where(User.zoho_lead_id.in_(lead_ids)))).all())
            for r in rows:
                r["portal_user_id"] = users.get(r["zoho_id"])
        model = MODELS[module]
        existing = {o.zoho_id: o for o in await session.scalars(select(model).where(model.zoho_id.in_([r["zoho_id"] for r in rows])))}
        now = utcnow()
        for r in rows:
            obj = existing.get(r["zoho_id"])
            if obj is None:
                obj = model(**r, synced_at=now)
                session.add(obj)
                existing[r["zoho_id"]] = obj
            else:
                for key, value in r.items():
                    setattr(obj, key, value)
                obj.synced_at = now
        await session.flush()
        return len(rows)

    async def _write_stages(self, session, names: list[str]) -> int:
        won, lost = self.settings.crm.won_stages, self.settings.crm.lost_stages
        existing = {s.name: s for s in await session.scalars(select(CrmDealStage))}
        for i, name in enumerate(names, start=1):
            stage = existing.get(name) or CrmDealStage(name=name)
            stage.sequence, stage.is_won, stage.is_lost, stage.synced_at = i, name in won, name in lost, utcnow()
            session.add(stage)
        return len(names)

    async def _state(self, session, module: str) -> SyncState:
        state = await session.get(SyncState, module)
        if state is None:
            state = SyncState(module=module, records_synced=0)
            session.add(state)
        return state

    # ---- runs ------------------------------------------------------------------------
    async def run(self, *, full: bool = False) -> dict:
        """Syncs every module; returns a per-module summary."""
        async with self._exclusive() as acquired:
            if not acquired:
                return {"skipped": "another instance is syncing"}
            summary: dict[str, Any] = {}
            for module in MODULES:
                summary[module] = await self._run_module(module, full=full)
            return summary

    async def _run_module(self, module: str, *, full: bool) -> dict:
        started = utcnow()
        try:
            async with self.db.session() as session, session.begin():
                state = await self._state(session, module)
                if module == "stages":
                    count = await self._write_stages(session, await self.source.stages())
                    removed = 0
                    cursor = state.last_modified_at
                else:
                    since = None
                    if module != "agents" and not full and state.last_modified_at:
                        since = (state.last_modified_at if state.last_modified_at.tzinfo else state.last_modified_at.replace(tzinfo=timezone.utc)) - OVERLAP
                    rows = await (self.source.agents() if module == "agents" else self.source.changed(module, since))
                    count = await self._write(session, module, rows)
                    removed = 0
                    if full or module == "agents":
                        model = MODELS[module]
                        seen = [r["zoho_id"] for r in rows]
                        result = await session.execute(delete(model).where(model.zoho_id.not_in(seen)) if seen else delete(model))
                        removed = result.rowcount or 0
                    stamps = [r["zoho_modified_at"] for r in rows if r.get("zoho_modified_at")]
                    previous = [state.last_modified_at] if state.last_modified_at else []
                    cursor = max(stamps + previous, key=_aware, default=None)
                state.last_modified_at = cursor
                state.last_run_at = started
                state.last_status = "ok"
                state.last_error = None
                state.records_synced = count
            return {"ok": True, "records": count, "removed": removed}
        except Exception as err:  # noqa: BLE001 - one module failing must not stop the others
            log.error("Sync of %s failed: %s", module, err)
            async with self.db.session() as session, session.begin():
                state = await self._state(session, module)
                state.last_run_at, state.last_status, state.last_error = started, "error", str(err)[:500]
            return {"ok": False, "error": str(err)[:200]}

    async def sync_record(self, module: str, zoho_id: str, *, deleted: bool = False) -> str:
        """Refreshes (or removes) one record: what a Zoho webhook triggers."""
        module = MODULE_ALIASES.get(module.lower(), "")
        if not module:
            raise ValueError("Unknown module")
        model = MODELS[module]
        row = None if deleted else await self.source.one(module, zoho_id)
        async with self.db.session() as session, session.begin():
            if row is None:
                await session.execute(delete(model).where(model.zoho_id == zoho_id))
                return "removed"
            await self._write(session, module, [row])
            return "updated"

    async def write_through(self, module: str, rows: list[dict]) -> None:
        """Called right after the portal writes a record to Zoho."""
        async with self.db.session() as session, session.begin():
            await self._write(session, module, rows)

    async def status(self) -> list[dict]:
        async with self.db.session() as session:
            states = {s.module: s for s in await session.scalars(select(SyncState))}
            counts = {}
            for module, model in MODELS.items():
                counts[module] = await session.scalar(select(func.count()).select_from(model)) or 0
            counts["stages"] = await session.scalar(select(func.count()).select_from(CrmDealStage)) or 0
        out = []
        for module in MODULES:
            s = states.get(module)
            out.append({"module": module, "rows": counts.get(module, 0), "lastRunAt": _iso(s.last_run_at) if s else None,
                        "lastStatus": s.last_status if s else None, "lastError": s.last_error if s else None,
                        "lastModifiedAt": _iso(s.last_modified_at) if s else None, "recordsLastRun": s.records_synced if s else 0})
        return out

    async def link_lead_user(self, lead_id: str, user_id: str) -> None:
        async with self.db.session() as session, session.begin():
            await session.execute(update(CrmLead).where(CrmLead.zoho_id == lead_id).values(portal_user_id=user_id))


def _aware(value: datetime) -> datetime:
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def _iso(value: datetime | None) -> str | None:
    return _aware(value).isoformat().replace("+00:00", "Z") if value else None
