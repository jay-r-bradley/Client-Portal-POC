"""In-memory CRM service with the same interface as LiveCrm, for demos and tests.
Sample brokerage data lives in sample_data.json."""

from __future__ import annotations

import copy
import json
from datetime import datetime, timezone
from pathlib import Path

from ..config import Settings
from ..criteria import matches_criteria, sort_properties

SEED = json.loads((Path(__file__).parent / "sample_data.json").read_text())


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class MockCrm:
    def __init__(self, settings: Settings):
        self.crm = settings.crm
        # A private copy, so tests and demo sessions never share state.
        self.data = copy.deepcopy(SEED)
        self._next = 1

    def _id(self, prefix: str) -> str:
        self._next += 1
        return f"mock-{prefix}-{self._next}"

    async def get_contact(self, contact_id: str) -> dict | None:
        return self.data["contacts"].get(contact_id)

    async def find_contact_by_email(self, email: str) -> dict | None:
        return next((c for c in self.data["contacts"].values() if c["email"].lower() == email.lower()), None)

    async def get_agent(self, contact_id: str) -> dict | None:
        contact = self.data["contacts"].get(contact_id)
        return self.data["agents"].get(contact["ownerId"]) if contact else None

    def _deal(self, raw: dict) -> dict:
        prop = next((p for p in self.data["properties"] if p["id"] == raw.get("propertyId")), None)
        return {
            **{k: raw.get(k) for k in ("id", "name", "stage", "amount", "closingDate", "type", "description", "contactId", "modifiedAt")},
            "property": {"id": prop["id"], "name": prop["name"]} if prop else None,
            "agent": self.data["agents"].get(raw.get("agentId")),
        }

    async def list_deals(self, contact_id: str) -> list[dict]:
        return [self._deal(d) for d in self.data["deals"] if d["contactId"] == contact_id]

    async def get_deal(self, contact_id: str, deal_id: str) -> dict | None:
        raw = next((d for d in self.data["deals"] if d["id"] == deal_id and d["contactId"] == contact_id), None)
        return self._deal(raw) if raw else None

    async def get_stages(self) -> list[str]:
        return self.crm.deal_stages

    def _available(self) -> list[dict]:
        return [p for p in self.data["properties"] if p["status"] == self.crm.available_status]

    async def search_properties(self, criteria: dict) -> list[dict]:
        return sort_properties([p for p in self._available() if matches_criteria(p, criteria)], criteria.get("sort", "price_asc"))

    async def list_featured_properties(self, limit: int = 6) -> list[dict]:
        available = self._available()
        featured = [p for p in available if p.get("featured")] or available
        return sorted(featured, key=lambda p: p.get("listedDate") or "", reverse=True)[:limit]

    async def get_property_filter_options(self) -> dict:
        def unique(key: str) -> list[str]:
            return sorted({p[key] for p in self.data["properties"] if p.get(key)})
        return {"propertyTypes": unique("propertyType"), "listingTypes": unique("listingType")}

    async def get_property(self, property_id: str) -> dict | None:
        return next((p for p in self.data["properties"] if p["id"] == property_id), None)

    async def test_connection(self) -> dict:
        return {"ok": True, "note": "Demo mode: sample data, no Zoho connection."}

    async def check_fields(self, catalog: list[dict]) -> list[dict]:
        # Sample data has every field, but there is no real org to check.
        return [{"module": m["module"], "fields": [{"apiName": f["apiName"], "status": "sample"} for f in m["fields"]]} for m in catalog]

    async def list_messages(self, contact_id: str) -> list[dict]:
        msgs = [{k: v for k, v in m.items() if k != "contactId"} for m in self.data["messages"] if m["contactId"] == contact_id]
        return sorted(msgs, key=lambda m: m["createdAt"])

    async def send_message(self, contact_id: str, *, subject: str, body: str, deal: dict | None, property: dict | None) -> dict:
        context = [c for c in (deal and f"Deal: {deal['name']}", property and f"Property: {property['name']}") if c]
        message = {"id": self._id("msg"), "contactId": contact_id, "from": "client", "author": None, "subject": subject,
                   "body": f"{body}\n\n— {' · '.join(context)}" if context else body, "createdAt": _now()}
        self.data["messages"].append(message)
        return {k: v for k, v in message.items() if k != "contactId"}

    async def create_signup_lead(self, g: dict) -> dict:
        lead = {**g, "id": self._id("lead"), "source": self.crm.signup.lead_source, "createdAt": _now()}
        self.data["leads"].append(lead)
        return {"id": lead["id"]}

    async def update_lead_criteria(self, lead_id: str, criteria: str) -> None:
        for lead in self.data["leads"]:
            if lead["id"] == lead_id:
                lead["criteria"] = criteria

    def _referral(self, r: dict) -> dict:
        referrer = self.data["contacts"].get(r["referrerId"])
        return {
            **{k: r.get(k) for k in ("id", "name", "email", "phone", "interest", "notes", "leadStatus", "createdAt")},
            "referrer": {"contactId": r["referrerId"], "name": referrer["name"] if referrer else None},
            "agent": self.data["agents"].get(referrer["ownerId"]) if referrer else None,
        }

    async def create_referral(self, contact_id: str, r: dict) -> dict:
        record = {**r, "id": self._id("ref"), "referrerId": contact_id, "leadStatus": self.crm.referral.new_status, "createdAt": _now()}
        self.data["referrals"].append(record)
        return self._referral(record)

    async def list_referrals(self, contact_id: str) -> list[dict]:
        rows = [self._referral(r) for r in self.data["referrals"] if r["referrerId"] == contact_id]
        return sorted(rows, key=lambda r: r["createdAt"], reverse=True)

    async def list_all_referrals(self) -> list[dict]:
        return sorted((self._referral(r) for r in self.data["referrals"]), key=lambda r: r["createdAt"], reverse=True)
