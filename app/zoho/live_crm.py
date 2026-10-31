"""CRM service backed by a real Zoho CRM org (REST, or MCP for the AI)."""

from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime, timezone
from typing import Any

from ..config import Settings
from ..criteria import matches_keywords
from .mappers import assert_id, build_featured_query, build_property_query, map_contact, map_deal, map_property, map_user, quote

log = logging.getLogger("portal.zoho")
CACHE_SECONDS = 600


class LiveCrm:
    def __init__(self, settings: Settings, *, api: Any):
        self.crm = settings.crm
        self.api = api
        self._stage_cache: tuple[float, list[str]] | None = None
        self._user_cache: dict[str, tuple[float, dict | None]] = {}

    @property
    def deal_fields(self) -> list[str]:
        return list(dict.fromkeys([*vars(self.crm.deal).values(), "Owner", "Modified_Time"]))

    async def get_contact(self, contact_id: str) -> dict | None:
        record = await self.api.get_record(self.crm.contacts_module, assert_id(contact_id),
                                           ["First_Name", "Last_Name", "Full_Name", "Email", "Phone", "Mobile", "Owner"])
        return map_contact(record) if record else None

    async def find_contact_by_email(self, email: str) -> dict | None:
        records = await self.api.search_by_email(self.crm.contacts_module, email)
        return map_contact(records[0]) if records else None

    async def get_user(self, user_id: str | None) -> dict | None:
        if not user_id:
            return None
        cached = self._user_cache.get(user_id)
        if cached and cached[0] > time.time():
            return cached[1]
        user = map_user(await self.api.get_user(user_id))
        self._user_cache[user_id] = (time.time() + CACHE_SECONDS, user)
        return user

    async def get_agent(self, contact_id: str) -> dict | None:
        """The client's primary agent is the Zoho owner of their Contact."""
        contact = await self.get_contact(contact_id)
        return await self.get_user(contact["ownerId"]) if contact else None

    async def _with_agent(self, deal: dict) -> dict:
        if not (deal.get("agent") or {}).get("id"):
            return deal
        try:
            agent = await self.get_user(deal["agent"]["id"])
        except Exception:  # noqa: BLE001 - agent details are optional
            agent = None
        return {**deal, "agent": agent or deal["agent"]}

    async def list_deals(self, contact_id: str) -> list[dict]:
        # The Contact -> Deals related list only ever returns this client's deals.
        records = await self.api.get_related_records(self.crm.contacts_module, assert_id(contact_id), self.crm.deals_module, self.deal_fields)
        return list(await asyncio.gather(*(self._with_agent(map_deal(r, self.crm.deal)) for r in records)))

    async def get_deal(self, contact_id: str, deal_id: str) -> dict | None:
        record = await self.api.get_record(self.crm.deals_module, assert_id(deal_id), self.deal_fields)
        if not record:
            return None
        deal = map_deal(record, self.crm.deal)
        # Never reveal another client's deal, even if its id is guessed.
        if deal["contactId"] != str(contact_id):
            return None
        return await self._with_agent(deal)

    async def get_stages(self) -> list[str]:
        """Pipeline order comes from the Deals Stage picklist."""
        if self._stage_cache and self._stage_cache[0] > time.time():
            return self._stage_cache[1]
        stages = self.crm.deal_stages
        try:
            fields = await self.api.get_fields(self.crm.deals_module)
            stage_field = next((f for f in fields if f.get("api_name") == self.crm.deal.stage), None)
            values = sorted((v for v in (stage_field or {}).get("pick_list_values", []) if v.get("display_value") not in (None, "-None-")),
                            key=lambda v: v.get("sequence_number") or 0)
            if values:
                stages = [v["display_value"] for v in values]
        except Exception as err:  # noqa: BLE001
            log.warning("Could not read Deal stages from Zoho, using configured defaults: %s", err)
        self._stage_cache = (time.time() + CACHE_SECONDS, stages)
        return stages

    async def search_properties(self, criteria: dict) -> list[dict]:
        query = build_property_query(criteria, module=self.crm.properties_module, fields=self.crm.property, available_status=self.crm.available_status)
        rows = await self.api.coql(query)
        return [p for p in (map_property(r, self.crm.property) for r in rows) if matches_keywords(p, criteria.get("keywords"))]

    async def list_featured_properties(self, limit: int = 6) -> list[dict]:
        def query(featured_only: bool) -> str:
            return build_featured_query(module=self.crm.properties_module, fields=self.crm.property,
                                        available_status=self.crm.available_status, featured_only=featured_only, limit=limit)
        rows = await self.api.coql(query(True)) or await self.api.coql(query(False))
        return [map_property(r, self.crm.property) for r in rows]

    async def get_property_filter_options(self) -> dict:
        try:
            fields = await self.api.get_fields(self.crm.properties_module)
        except Exception:  # noqa: BLE001
            fields = []

        def picklist(api_name: str) -> list[str]:
            field = next((f for f in fields if f.get("api_name") == api_name), None)
            return [v["display_value"] for v in (field or {}).get("pick_list_values", []) if v.get("display_value") not in (None, "-None-")]

        return {"propertyTypes": picklist(self.crm.property.type), "listingTypes": picklist(self.crm.property.listing_type)}

    async def get_property(self, property_id: str) -> dict | None:
        record = await self.api.get_record(self.crm.properties_module, assert_id(property_id))
        return map_property(record, self.crm.property) if record else None

    async def test_connection(self) -> dict:
        try:
            await self.api.get_fields(self.crm.deals_module)
            return {"ok": True}
        except Exception as err:  # noqa: BLE001
            return {"ok": False, "error": str(err)}

    async def check_fields(self, catalog: list[dict]) -> list[dict]:
        async def check(module: dict) -> dict:
            if not module["fields"]:
                return {"module": module["module"], "fields": []}
            try:
                existing = {f.get("api_name") for f in await self.api.get_fields(module["module"])}
                return {"module": module["module"], "fields": [{"apiName": f["apiName"], "status": "found" if f["apiName"] in existing else "missing"} for f in module["fields"]]}
            except Exception as err:  # noqa: BLE001
                return {"module": module["module"], "error": str(err), "fields": [{"apiName": f["apiName"], "status": "unknown"} for f in module["fields"]]}
        return list(await asyncio.gather(*(check(m) for m in catalog)))

    # ---- Messages (Notes + Tasks) ---------------------------------------------

    async def list_messages(self, contact_id: str) -> list[dict]:
        notes = await self.api.get_related_records(self.crm.contacts_module, assert_id(contact_id), "Notes",
                                                   ["Note_Title", "Note_Content", "Created_Time", "Owner"])
        out = []
        for note in notes:
            title = note.get("Note_Title") or ""
            if title.startswith(self.crm.portal_note_prefix):
                sender, prefix = "client", self.crm.portal_note_prefix
            elif title.startswith(self.crm.portal_reply_prefix):
                sender, prefix = "agent", self.crm.portal_reply_prefix
            else:
                continue  # internal agent note: never shown to the client
            out.append({
                "id": str(note["id"]), "from": sender, "subject": title[len(prefix):].strip(), "body": note.get("Note_Content") or "",
                "author": (note.get("Owner") or {}).get("name") if sender == "agent" else None, "createdAt": note.get("Created_Time"),
            })
        return sorted(out, key=lambda m: m["createdAt"] or "")

    async def send_message(self, contact_id: str, *, subject: str, body: str, deal: dict | None, property: dict | None) -> dict:
        """A client message becomes a Note on their Contact and a Task for their agent."""
        context = [c for c in (
            f"Deal: {deal['name']} ({deal.get('stage') or 'no stage'})" if deal else None,
            f"Property: {property['name']}{', ' + property['address'] if property.get('address') else ''}" if property else None,
        ) if c]
        content = body + "\n\n— Sent from Client Portal" + ("\n" + "\n".join(context) if context else "")
        note = await self.api.create_record("Notes", {
            "Note_Title": f"{self.crm.portal_note_prefix} {subject}",
            "Note_Content": content,
            "Parent_Id": {"module": {"api_name": self.crm.contacts_module}, "id": contact_id},
        })
        contact = await self.get_contact(contact_id)
        agent_id = ((deal or {}).get("agent") or {}).get("id") or (contact or {}).get("ownerId")
        try:
            await self.api.create_record("Tasks", {
                "Subject": f"Client Portal message from {(contact or {}).get('name') or 'client'}: {subject}"[:255],
                "Description": content,
                "Due_Date": datetime.now(timezone.utc).date().isoformat(),
                "Priority": "High",
                "Status": "Not Started",
                "Who_Id": {"id": contact_id},
                **({"What_Id": {"id": deal["id"]}, "$se_module": self.crm.deals_module} if deal else {}),
                **({"Owner": {"id": agent_id}} if agent_id else {}),
            })
        except Exception as err:  # noqa: BLE001 - the note is the record of truth
            log.warning("Message saved as a note, but creating the follow-up task failed: %s", err)
        return {"id": str(note.get("id")), "from": "client", "subject": subject, "body": content, "author": None,
                "createdAt": note.get("Created_Time") or datetime.now(timezone.utc).isoformat()}

    # ---- Guest sign-ups (Zoho Leads) -------------------------------------------

    async def create_signup_lead(self, g: dict) -> dict:
        s = self.crm.signup
        details = await self.api.create_record(self.crm.leads_module, {
            "First_Name": g.get("firstName"), "Last_Name": g["lastName"], "Email": g["email"], "Phone": g.get("phone"),
            "Lead_Source": s.lead_source, "Lead_Status": self.crm.referral.new_status, "Description": g.get("description"),
            s.criteria_field: g.get("criteria"),
            **({"Owner": {"id": s.lead_owner_id}} if s.lead_owner_id else {}),
        })
        return {"id": str(details.get("id"))}

    async def update_lead_criteria(self, lead_id: str, criteria: str) -> None:
        await self.api.update_record(self.crm.leads_module, assert_id(lead_id), {self.crm.signup.criteria_field: criteria})

    # ---- Referral program (Zoho Leads) -----------------------------------------

    def _referral_columns(self) -> str:
        r = self.crm.referral
        return ", ".join(["First_Name", "Last_Name", "Email", "Phone", "Lead_Status", "Description", "Created_Time", "Owner", r.referred_by_field, r.interest_field])

    def _map_referral(self, lead: dict) -> dict:
        r = self.crm.referral
        referrer = lead.get(r.referred_by_field) or {}
        owner = lead.get("Owner") or {}
        return {
            "id": str(lead["id"]), "name": " ".join(x for x in (lead.get("First_Name"), lead.get("Last_Name")) if x),
            "email": lead.get("Email"), "phone": lead.get("Phone"), "interest": lead.get(r.interest_field),
            "notes": lead.get("Description"), "leadStatus": lead.get("Lead_Status"), "createdAt": lead.get("Created_Time"),
            "referrer": {"contactId": str(referrer["id"]), "name": referrer.get("name")} if referrer.get("id") else None,
            "agent": {"id": str(owner["id"]), "name": owner.get("name")} if owner.get("id") else None,
        }

    async def create_referral(self, contact_id: str, r: dict) -> dict:
        """The referral becomes a Lead owned by the referring client's agent."""
        s = self.crm.referral
        contact = await self.get_contact(contact_id)
        description = "\n".join(x for x in (f"Referred through the client portal by {(contact or {}).get('name') or 'a client'}.",
                                             f"Interested in: {r['interest']}.", r.get("notes")) if x)
        details = await self.api.create_record(self.crm.leads_module, {
            "First_Name": r.get("firstName"), "Last_Name": r["lastName"], "Email": r.get("email"), "Phone": r.get("phone"),
            "Lead_Source": s.lead_source, "Lead_Status": s.new_status, s.interest_field: r["interest"],
            s.referred_by_field: {"id": contact_id}, "Description": description,
            **({"Owner": {"id": contact["ownerId"]}} if contact and contact.get("ownerId") else {}),
        })
        return {**{k: r.get(k) for k in ("name", "email", "phone", "interest", "notes")}, "id": str(details.get("id")),
                "leadStatus": s.new_status, "createdAt": details.get("Created_Time") or datetime.now(timezone.utc).isoformat(),
                "referrer": {"contactId": str(contact_id), "name": (contact or {}).get("name")}, "agent": None}

    async def list_referrals(self, contact_id: str) -> list[dict]:
        # Zoho moves converted Leads out of the Leads module, so a referral that
        # became a client no longer appears here.
        r = self.crm.referral
        rows = await self.api.coql(f"select {self._referral_columns()} from {self.crm.leads_module} where {r.referred_by_field} = {quote(assert_id(contact_id))} order by Created_Time desc limit 200")
        return [self._map_referral(row) for row in rows]

    async def list_all_referrals(self) -> list[dict]:
        rows = await self.api.coql(f"select {self._referral_columns()} from {self.crm.leads_module} where Lead_Source = {quote(self.crm.referral.lead_source)} order by Created_Time desc limit 200")
        return [self._map_referral(row) for row in rows]
