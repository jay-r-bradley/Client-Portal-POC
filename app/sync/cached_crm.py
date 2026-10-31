"""The CRM service the portal pages use when reading from the synced copy.

Same interface as LiveCrm / MockCrm, so routes and the AI do not change:
* Reads come from the crm_* tables (one indexed query instead of Zoho calls).
* Writes go to Zoho first (the source of truth); on success the new record is
  written into the copy straight away, so the client sees it immediately.
* If a record a client needs is not in the copy yet (e.g. invited before the
  first sync), it is fetched from Zoho once and stored ("read-through").
"""

from __future__ import annotations

import logging
from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Any

from sqlalchemy import and_, func, or_, select, update
from sqlalchemy.orm import aliased

from ..config import Settings
from ..criteria import matches_keywords, sort_properties
from ..db import CrmAgent, CrmContact, CrmDeal, CrmDealStage, CrmLead, CrmMessage, CrmProperty, Database
from .engine import SyncEngine
from .sources import parse_dt, split_name

log = logging.getLogger("portal.sync")


def _num(value: Any) -> int | float | None:
    if value is None:
        return None
    if isinstance(value, Decimal):
        return int(value) if value == value.to_integral_value() else float(value)
    return value


def _date(value: date | None) -> str | None:
    return value.isoformat() if value else None


def _dt(value: datetime | None) -> str | None:
    if not value:
        return None
    value = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    return value.isoformat().replace("+00:00", "Z")


def _parse(value: Any) -> datetime:
    return parse_dt(value) or datetime.now(timezone.utc)


def _like(text: str) -> str:
    """LIKE pattern for a user-typed fragment, with wildcards escaped."""
    return "%" + text.lower().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


def agent_dict(a: CrmAgent | None) -> dict | None:
    return {"id": a.zoho_id, "name": a.full_name, "email": a.email, "phone": a.phone} if a else None


def contact_dict(c: CrmContact) -> dict:
    return {"id": c.zoho_id, "name": c.full_name or " ".join(x for x in (c.first_name, c.last_name) if x), "firstName": c.first_name,
            "email": c.email, "phone": c.mobile or c.phone, "ownerId": c.owner_zoho_id}


def property_dict(p: CrmProperty) -> dict:
    return {"id": p.zoho_id, "name": p.name, "address": p.address, "city": p.city, "price": _num(p.price), "propertyType": p.property_type,
            "listingType": p.listing_type, "bedrooms": _num(p.bedrooms), "bathrooms": _num(p.bathrooms), "floorArea": _num(p.floor_area),
            "status": p.status, "description": p.description, "photoUrl": p.photo_url, "featured": bool(p.featured),
            "listedDate": _date(p.listed_date)}


def deal_dict(d: CrmDeal, prop: CrmProperty | None, agent: CrmAgent | None) -> dict:
    return {"id": d.zoho_id, "name": d.deal_name, "stage": d.stage, "amount": _num(d.amount), "closingDate": _date(d.closing_date),
            "type": d.type, "description": d.description, "contactId": d.contact_zoho_id,
            "property": {"id": prop.zoho_id, "name": prop.name} if prop else None, "agent": agent_dict(agent),
            "modifiedAt": _dt(d.zoho_modified_at)}


class CachedCrm:
    def __init__(self, *, db: Database, zoho: Any, sync: SyncEngine, settings: Settings):
        self.db = db
        self.zoho = zoho  # the live (or sample) CRM: writes and fallbacks
        self.sync = sync
        self.crm = settings.crm
        self.settings = settings

    # ---- helpers -----------------------------------------------------------------
    async def _fetch_into_copy(self, module: str, zoho_id: str | None) -> None:
        if not zoho_id:
            return
        try:
            await self.sync.sync_record(module, zoho_id)
        except Exception as err:  # noqa: BLE001 - the page then shows what the copy has
            log.warning("Read-through of %s %s failed: %s", module, zoho_id, err)

    async def _fetch_contact(self, contact_id: str) -> None:
        """A contact not in the copy yet (e.g. invited before the next sync): copy it and its deals."""
        await self._fetch_into_copy("contacts", contact_id)
        try:
            for deal in await self.zoho.list_deals(contact_id):
                await self._fetch_into_copy("deals", deal["id"])
        except Exception as err:  # noqa: BLE001
            log.warning("Read-through of deals for %s failed: %s", contact_id, err)

    async def _contact_row(self, session, contact_id: str) -> CrmContact | None:
        return await session.scalar(select(CrmContact).where(CrmContact.zoho_id == contact_id))

    # ---- contacts & agents -----------------------------------------------------------
    async def get_contact(self, contact_id: str | None) -> dict | None:
        if not contact_id:
            return None
        async with self.db.session() as s:
            c = await self._contact_row(s, contact_id)
        if c is None:
            await self._fetch_contact(contact_id)
            async with self.db.session() as s:
                c = await self._contact_row(s, contact_id)
        return contact_dict(c) if c else None

    async def find_contact_by_email(self, email: str) -> dict | None:
        async with self.db.session() as s:
            c = await s.scalar(select(CrmContact).where(CrmContact.email == email.strip().lower()).limit(1))
        if c:
            return contact_dict(c)
        found = await self.zoho.find_contact_by_email(email)  # not synced yet: ask Zoho, then keep a copy
        if found:
            await self._fetch_contact(found["id"])
        return found

    async def get_agent(self, contact_id: str) -> dict | None:
        contact = await self.get_contact(contact_id)
        if not contact or not contact["ownerId"]:
            return None
        async with self.db.session() as s:
            return agent_dict(await s.scalar(select(CrmAgent).where(CrmAgent.zoho_id == contact["ownerId"])))

    # ---- deals ---------------------------------------------------------------------------
    def _deal_query(self):
        return (select(CrmDeal, CrmProperty, CrmAgent)
                .outerjoin(CrmProperty, CrmProperty.zoho_id == CrmDeal.property_zoho_id)
                .outerjoin(CrmAgent, CrmAgent.zoho_id == CrmDeal.owner_zoho_id))

    async def list_deals(self, contact_id: str) -> list[dict]:
        async with self.db.session() as s:
            known = await self._contact_row(s, contact_id)
        if known is None:  # first visit before the contact was synced
            await self._fetch_contact(contact_id)
        async with self.db.session() as s:
            rows = (await s.execute(self._deal_query().where(CrmDeal.contact_zoho_id == contact_id))).all()
        return [deal_dict(*row) for row in rows]

    async def get_deal(self, contact_id: str, deal_id: str) -> dict | None:
        async with self.db.session() as s:
            row = (await s.execute(self._deal_query().where(CrmDeal.zoho_id == deal_id))).first()
        # Never reveal another client's deal, even if its id is guessed.
        return deal_dict(*row) if row and row[0].contact_zoho_id == str(contact_id) else None

    async def get_stages(self) -> list[str]:
        async with self.db.session() as s:
            names = list(await s.scalars(select(CrmDealStage.name).order_by(CrmDealStage.sequence, CrmDealStage.name)))
        return names or await self.zoho.get_stages()

    # ---- properties ------------------------------------------------------------------------
    async def search_properties(self, criteria: dict) -> list[dict]:
        p = CrmProperty
        conditions = [p.status == self.crm.available_status]
        if criteria.get("budgetMin") is not None:
            conditions.append(p.price >= criteria["budgetMin"])
        if criteria.get("budgetMax") is not None:
            conditions.append(p.price <= criteria["budgetMax"])
        if criteria.get("locations"):
            conditions.append(or_(*(func.lower(p.city).like(_like(loc), escape="\\") for loc in criteria["locations"])))
        if criteria.get("propertyType"):
            conditions.append(p.property_type == criteria["propertyType"])
        if criteria.get("listingType"):
            conditions.append(p.listing_type == criteria["listingType"])
        if criteria.get("minBedrooms") is not None:
            conditions.append(p.bedrooms >= criteria["minBedrooms"])
        if criteria.get("minBathrooms") is not None:
            conditions.append(p.bathrooms >= criteria["minBathrooms"])
        if criteria.get("minFloorArea") is not None:
            conditions.append(p.floor_area >= criteria["minFloorArea"])
        async with self.db.session() as s:
            rows = list(await s.scalars(select(p).where(and_(*conditions)).limit(500)))
        found = [property_dict(r) for r in rows]
        return sort_properties([x for x in found if matches_keywords(x, criteria.get("keywords"))], criteria.get("sort", "price_asc"))

    async def list_featured_properties(self, limit: int = 6) -> list[dict]:
        p = CrmProperty
        available = p.status == self.crm.available_status
        newest = (p.listed_date.desc(), p.name)
        async with self.db.session() as s:
            rows = list(await s.scalars(select(p).where(available, p.featured.is_(True)).order_by(*newest).limit(limit)))
            if not rows:
                rows = list(await s.scalars(select(p).where(available).order_by(*newest).limit(limit)))
        return [property_dict(r) for r in rows]

    async def get_property_filter_options(self) -> dict:
        async with self.db.session() as s:
            types = [t for t in await s.scalars(select(CrmProperty.property_type).distinct().order_by(CrmProperty.property_type)) if t]
            listings = [t for t in await s.scalars(select(CrmProperty.listing_type).distinct().order_by(CrmProperty.listing_type)) if t]
        return {"propertyTypes": types, "listingTypes": listings}

    async def get_property(self, property_id: str) -> dict | None:
        async with self.db.session() as s:
            row = await s.scalar(select(CrmProperty).where(CrmProperty.zoho_id == property_id))
        if row is None:
            await self._fetch_into_copy("properties", property_id)
            async with self.db.session() as s:
                row = await s.scalar(select(CrmProperty).where(CrmProperty.zoho_id == property_id))
        return property_dict(row) if row else None

    # ---- messages (write to Zoho, then the copy) ---------------------------------------------
    async def list_messages(self, contact_id: str) -> list[dict]:
        async with self.db.session() as s:
            rows = list(await s.scalars(select(CrmMessage).where(CrmMessage.contact_zoho_id == contact_id).order_by(CrmMessage.created_time)))
        return [{"id": m.zoho_id, "from": m.direction, "subject": m.subject, "body": m.body or "", "author": m.author_name,
                 "createdAt": _dt(m.created_time)} for m in rows]

    async def send_message(self, contact_id: str, *, subject: str, body: str, deal: dict | None, property: dict | None) -> dict:
        sent = await self.zoho.send_message(contact_id, subject=subject, body=body, deal=deal, property=property)
        try:
            await self.sync.write_through("messages", [{
                "zoho_id": sent["id"], "contact_zoho_id": contact_id, "deal_zoho_id": deal["id"] if deal else None,
                "property_zoho_id": property["id"] if property else None, "direction": "client", "subject": subject[:255],
                "body": sent.get("body"), "author_name": None, "created_time": _parse(sent.get("createdAt")),
            }])
        except Exception as err:  # noqa: BLE001 - Zoho has it; the next sync brings it in
            log.warning("Message %s saved in Zoho but not yet in the copy: %s", sent.get("id"), err)
        return sent

    # ---- leads: sign-ups and referrals ----------------------------------------------------------
    async def create_signup_lead(self, g: dict) -> dict:
        lead = await self.zoho.create_signup_lead(g)
        await self._lead_through({"zoho_id": lead["id"], "kind": "signup", "first_name": g.get("firstName"), "last_name": g.get("lastName") or "",
                                  "email": g.get("email"), "phone": g.get("phone"), "lead_source": self.crm.signup.lead_source,
                                  "lead_status": self.crm.referral.new_status, "inquiry_type": None, "match_criteria": g.get("criteria"),
                                  "description": g.get("description"), "referred_by_zoho_id": None,
                                  "owner_zoho_id": self.crm.signup.lead_owner_id, "created_time": datetime.now(timezone.utc)})
        return lead

    async def update_lead_criteria(self, lead_id: str, criteria: str) -> None:
        await self.zoho.update_lead_criteria(lead_id, criteria)
        async with self.db.session() as s, s.begin():
            await s.execute(update(CrmLead).where(CrmLead.zoho_id == lead_id).values(match_criteria=criteria))

    async def create_referral(self, contact_id: str, r: dict) -> dict:
        created = await self.zoho.create_referral(contact_id, r)
        contact = await self.get_contact(contact_id)
        first, last = split_name(r["name"])
        await self._lead_through({"zoho_id": created["id"], "kind": "referral", "first_name": r.get("firstName", first),
                                  "last_name": r.get("lastName", last), "email": r.get("email"), "phone": r.get("phone"),
                                  "lead_source": self.crm.referral.lead_source, "lead_status": created.get("leadStatus"),
                                  "inquiry_type": r.get("interest"), "match_criteria": None, "description": r.get("notes"),
                                  "referred_by_zoho_id": contact_id, "owner_zoho_id": (contact or {}).get("ownerId"),
                                  "created_time": _parse(created.get("createdAt"))})
        return created

    async def _lead_through(self, row: dict) -> None:
        try:
            await self.sync.write_through("leads", [row])
        except Exception as err:  # noqa: BLE001
            log.warning("Lead %s saved in Zoho but not yet in the copy: %s", row["zoho_id"], err)

    async def link_lead_user(self, lead_id: str, user_id: str) -> None:
        await self.sync.link_lead_user(lead_id, user_id)

    def _referral_query(self):
        referrer = aliased(CrmContact)
        return (select(CrmLead, referrer, CrmAgent)
                .outerjoin(referrer, referrer.zoho_id == CrmLead.referred_by_zoho_id)
                .outerjoin(CrmAgent, CrmAgent.zoho_id == CrmLead.owner_zoho_id)
                .where(CrmLead.kind == "referral")
                .order_by(CrmLead.created_time.desc())), referrer

    @staticmethod
    def _referral_dict(lead: CrmLead, referrer: CrmContact | None, agent: CrmAgent | None) -> dict:
        return {"id": lead.zoho_id, "name": " ".join(x for x in (lead.first_name, lead.last_name) if x), "email": lead.email,
                "phone": lead.phone, "interest": lead.inquiry_type, "notes": lead.description, "leadStatus": lead.lead_status,
                "createdAt": _dt(lead.created_time),
                "referrer": {"contactId": lead.referred_by_zoho_id, "name": contact_dict(referrer)["name"] if referrer else None}
                if lead.referred_by_zoho_id else None,
                "agent": agent_dict(agent)}

    async def list_referrals(self, contact_id: str) -> list[dict]:
        query, _ = self._referral_query()
        async with self.db.session() as s:
            rows = (await s.execute(query.where(CrmLead.referred_by_zoho_id == contact_id))).all()
        return [self._referral_dict(*row) for row in rows]

    async def list_all_referrals(self) -> list[dict]:
        query, _ = self._referral_query()
        async with self.db.session() as s:
            rows = (await s.execute(query)).all()
        return [self._referral_dict(*row) for row in rows]

    # ---- passed straight to Zoho ---------------------------------------------------------------
    async def test_connection(self) -> dict:
        return await self.zoho.test_connection()

    async def check_fields(self, catalog: list[dict]) -> list[dict]:
        return await self.zoho.check_fields(catalog)

