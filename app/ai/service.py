"""AI features. The model works as a small agent over client-scoped portal tools
(which read the CRM through Zoho MCP when configured). Answers are
schema-checked, and what the model says about a listing or deal is matched back
to records the tools actually returned."""

from __future__ import annotations

import asyncio
import hashlib
import json
import time
from collections import defaultdict, deque
from datetime import datetime, timezone
from typing import Any, Callable

from ..config import Settings
from .agent import run_agent
from .portal_tools import create_portal_tools, deal_facts
from .prompts import deal_insight_prompt, portfolio_insight_prompt, property_search_prompt


class AiLimitError(Exception):
    pass


def _hash(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, default=str).encode()).hexdigest()[:16]


class AiService:
    def __init__(self, *, client: Any, crm: Any, settings: Settings, now: Callable[[], datetime] | None = None):
        self.client = client
        self.crm = crm
        self.settings = settings
        self.now = now or (lambda: datetime.now(timezone.utc))
        self.cache: dict[str, tuple[float, Any]] = {}
        self.usage: dict[str, deque[float]] = defaultdict(deque)
        self.source = "mock data"
        self.mcp = None

    def _today(self) -> str:
        return self.now().date().isoformat()

    def consume(self, key: str, limit: int | None = None) -> None:
        """Per-account hourly cap so one account cannot run up the OpenAI bill."""
        limit = limit or self.settings.ai.max_requests_per_hour
        q = self.usage[key]
        cutoff = time.monotonic() - 3600
        while q and q[0] <= cutoff:
            q.popleft()
        if len(q) >= limit:
            raise AiLimitError("You have reached the hourly limit for the AI assistant. Please try again later.")
        q.append(time.monotonic())

    async def _cached(self, key: str, compute: Callable[[], Any]) -> Any:
        hit = self.cache.get(key)
        if hit and hit[0] > time.monotonic():
            return hit[1]
        value = await compute()
        self.cache[key] = (time.monotonic() + self.settings.ai.cache_minutes * 60, value)
        if len(self.cache) > 1000:
            self.cache.pop(next(iter(self.cache)))
        return value

    async def _tools(self, contact_id: str | None):
        return await create_portal_tools(crm=self.crm, contact_id=contact_id, settings=self.settings, now=self.now)

    async def _agent(self, prompt: dict, *, user: Any, tools: list) -> Any:
        result, _ = await run_agent(client=self.client, system=prompt["system"], user=user, tools=tools,
                                    output=prompt["output"], max_steps=self.settings.ai.max_steps)
        return result

    async def property_search(self, contact_id: str | None, query: str, *, guest_id: str | None = None) -> dict:
        """Guests get the same matcher without deal tools, under a smaller allowance."""
        if guest_id:
            self.consume(f"guest:{guest_id}", self.settings.ai.guest_max_requests_per_hour)
        else:
            self.consume(contact_id)
        portal = await self._tools(None if guest_id else contact_id)
        tools = portal.pick("search_listings", "get_listing") if guest_id else portal.pick("search_listings", "get_listing", "list_my_deals")
        result = await self._agent(property_search_prompt(currency=self.settings.currency, today=self._today(), guest=bool(guest_id)),
                                   user={"clientRequest": query}, tools=tools)

        # Trust the model for order and wording only; property data comes from the CRM.
        seen: set[str] = set()
        results = []
        for r in sorted(result.get("results") or [], key=lambda r: r.get("score") or 0, reverse=True):
            prop = portal.listings.get(r.get("id"))
            if not prop or r["id"] in seen or prop.get("status") != self.settings.crm.available_status:
                continue
            seen.add(r["id"])
            results.append({"property": prop, "score": max(0, min(100, int(r.get("score") or 0))), "reason": r.get("reason")})
        final = portal.searches[-1] if portal.searches else None
        results += [{"property": p, "score": None, "reason": None} for p in (final or {}).get("results", []) if p["id"] not in seen]
        first_empty = bool(portal.searches) and not portal.searches[0]["results"]
        return {
            "criteria": final["criteria"] if final else None,
            "preferences": result.get("preferences") or [],
            "interpretation": result.get("interpretation"),
            "relaxed": bool(results and (result.get("relaxed") or first_empty)),
            "overview": result.get("overview"),
            "results": results,
        }

    async def deal_insights(self, contact_id: str, deal_id: str) -> dict | None:
        portal = await self._tools(contact_id)
        deal = next((d for d in await portal.my_deals() if d["id"] == deal_id), None)
        if not deal:
            return None
        facts = deal_facts(deal, await portal.stages(), self.settings, self.now())

        async def compute() -> Any:
            self.consume(contact_id)
            return await self._agent(deal_insight_prompt(today=self._today(), currency=self.settings.currency),
                                     user={"deal": facts}, tools=portal.pick("get_listing", "list_my_deals"))

        # Regenerated only when the deal (or the day) changes.
        return await self._cached(f"deal:{contact_id}:{_hash({'facts': facts, 'day': self._today()})}", compute)

    async def portfolio_insights(self, contact_id: str) -> dict:
        portal = await self._tools(contact_id)
        deals, stages = await asyncio.gather(portal.my_deals(), portal.stages())
        if not deals:
            return {"overview": None, "priorities": []}
        facts = [deal_facts(d, stages, self.settings, self.now()) for d in deals]

        async def compute() -> Any:
            self.consume(contact_id)
            prompt = portfolio_insight_prompt(today=self._today(), currency=self.settings.currency, deal_ids=[d["id"] for d in deals])
            return await self._agent(prompt, user={"deals": facts}, tools=portal.pick("get_deal"))

        insight = await self._cached(f"portfolio:{contact_id}:{_hash({'facts': facts, 'day': self._today()})}", compute)
        names = {d["id"]: d["name"] for d in deals}
        return {
            "overview": insight.get("overview"),
            "priorities": [{"dealId": p["dealId"], "dealName": names[p["dealId"]], "note": p.get("note")}
                           for p in insight.get("priorities") or [] if p.get("dealId") in names],
        }
