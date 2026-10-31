"""Where the sync reads from. Each source turns records into rows for the
crm_* tables (keys are the model attribute names; `zoho_id` is the Zoho record
id). LiveSource reads Zoho CRM's REST API; MockSource reads the sample data."""

from __future__ import annotations

from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Any

from ..config import Settings

# Sync order: referenced tables first.
MODULES = ["agents", "stages", "contacts", "properties", "deals", "leads", "messages", "tasks"]
TASK_SUBJECT_PREFIX = "Client Portal message from"


def parse_dt(value: Any) -> datetime | None:
    if not value:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def parse_date(value: Any) -> date | None:
    if not value:
        return None
    if isinstance(value, date):
        return value
    try:
        return date.fromisoformat(str(value)[:10])
    except ValueError:
        return None


def dec(value: Any) -> Decimal | None:
    if value is None or value == "":
        return None
    try:
        return Decimal(str(value))
    except InvalidOperation:
        return None


def whole(value: Any) -> int | None:
    d = dec(value)
    return int(d) if d is not None else None


def ref(value: Any) -> str | None:
    if isinstance(value, dict):
        return str(value["id"]) if value.get("id") else None
    return str(value) if value not in (None, "") else None


def lead_kind(source: str | None, settings: Settings) -> str:
    if source == settings.crm.signup.lead_source:
        return "signup"
    if source == settings.crm.referral.lead_source:
        return "referral"
    return "other"


def split_name(name: str | None) -> tuple[str | None, str]:
    parts = (name or "").split()
    return (" ".join(parts[:-1]) or None, parts[-1] if parts else "")


class LiveSource:
    """Reads Zoho CRM. `api` is the ZohoApi client."""

    def __init__(self, settings: Settings, api: Any):
        self.s = settings
        self.api = api
        crm = settings.crm
        self.module_names = {"contacts": crm.contacts_module, "properties": crm.properties_module, "deals": crm.deals_module,
                             "leads": crm.leads_module, "messages": "Notes", "tasks": "Tasks"}

    # ---- field lists --------------------------------------------------------
    def _fields(self, module: str) -> list[str]:
        crm = self.s.crm
        return {
            "contacts": ["First_Name", "Last_Name", "Full_Name", "Email", "Phone", "Mobile", "Owner", "Modified_Time"],
            "properties": [*crm.property.values(), "Modified_Time"],
            "deals": [*vars(crm.deal).values(), "Owner", "Modified_Time"],
            "leads": ["First_Name", "Last_Name", "Email", "Phone", "Lead_Source", "Lead_Status", "Description", "Owner", "Created_Time",
                      "Modified_Time", crm.referral.referred_by_field, crm.referral.interest_field, crm.signup.criteria_field],
            "messages": ["Note_Title", "Note_Content", "Parent_Id", "Owner", "Created_Time", "Modified_Time"],
            "tasks": ["Subject", "Status", "Priority", "Due_Date", "Owner", "Who_Id", "What_Id", "Modified_Time"],
        }[module]

    # ---- raw Zoho record -> row ------------------------------------------------
    def row(self, module: str, r: dict[str, Any]) -> dict[str, Any] | None:
        crm = self.s.crm
        base = {"zoho_id": str(r["id"]), "zoho_modified_at": parse_dt(r.get("Modified_Time"))}
        if module == "contacts":
            return {**base, "first_name": r.get("First_Name"), "last_name": r.get("Last_Name") or "", "full_name": r.get("Full_Name"),
                    "email": (r.get("Email") or "").lower() or None, "phone": r.get("Phone"), "mobile": r.get("Mobile"),
                    "owner_zoho_id": ref(r.get("Owner"))}
        if module == "properties":
            f = crm.property
            featured = r.get(f.featured)
            return {**base, "name": r.get(f.name) or "Property", "address": r.get(f.address), "city": r.get(f.city), "price": dec(r.get(f.price)),
                    "property_type": r.get(f.type), "listing_type": r.get(f.listing_type), "bedrooms": whole(r.get(f.bedrooms)),
                    "bathrooms": dec(r.get(f.bathrooms)), "floor_area": whole(r.get(f.floor_area)), "status": r.get(f.status),
                    "description": r.get(f.description), "photo_url": r.get(f.photo_url), "featured": featured is True or featured == "true",
                    "listed_date": parse_date(r.get(f.listed_date))}
        if module == "deals":
            d = crm.deal
            return {**base, "deal_name": r.get(d.name) or "Untitled deal", "stage": r.get(d.stage), "amount": dec(r.get(d.amount)),
                    "closing_date": parse_date(r.get(d.closing_date)), "type": r.get(d.type), "description": r.get(d.description),
                    "contact_zoho_id": ref(r.get(d.contact)), "property_zoho_id": ref(r.get(d.property)), "owner_zoho_id": ref(r.get("Owner"))}
        if module == "leads":
            kind = lead_kind(r.get("Lead_Source"), self.s)
            if kind == "other":
                return None  # only portal sign-ups and referrals are copied
            return {**base, "kind": kind, "first_name": r.get("First_Name"), "last_name": r.get("Last_Name") or "",
                    "email": (r.get("Email") or "").lower() or None, "phone": r.get("Phone"), "lead_source": r.get("Lead_Source"),
                    "lead_status": r.get("Lead_Status"), "inquiry_type": r.get(crm.referral.interest_field),
                    "match_criteria": r.get(crm.signup.criteria_field), "description": r.get("Description"),
                    "referred_by_zoho_id": ref(r.get(crm.referral.referred_by_field)), "owner_zoho_id": ref(r.get("Owner")),
                    "created_time": parse_dt(r.get("Created_Time"))}
        if module == "messages":
            title = r.get("Note_Title") or ""
            parent = r.get("Parent_Id") or {}
            if (parent.get("module") or {}).get("api_name") not in (None, crm.contacts_module):
                return None
            if title.startswith(crm.portal_note_prefix):
                direction, prefix = "client", crm.portal_note_prefix
            elif title.startswith(crm.portal_reply_prefix):
                direction, prefix = "agent", crm.portal_reply_prefix
            else:
                return None  # internal agent notes are never copied
            return {**base, "contact_zoho_id": ref(parent), "direction": direction, "subject": title[len(prefix):].strip()[:255],
                    "body": r.get("Note_Content"), "author_name": (r.get("Owner") or {}).get("name") if direction == "agent" else None,
                    "created_time": parse_dt(r.get("Created_Time"))}
        if module == "tasks":
            if not (r.get("Subject") or "").startswith(TASK_SUBJECT_PREFIX):
                return None  # only the portal's follow-up tasks
            return {**base, "subject": r.get("Subject")[:255], "status": r.get("Status"), "priority": r.get("Priority"),
                    "due_date": parse_date(r.get("Due_Date")), "owner_zoho_id": ref(r.get("Owner")), "contact_zoho_id": ref(r.get("Who_Id")),
                    "deal_zoho_id": ref(r.get("What_Id"))}
        raise ValueError(module)

    # ---- reads ----------------------------------------------------------------
    async def agents(self) -> list[dict]:
        return [{"zoho_id": str(u["id"]), "full_name": u.get("full_name"), "email": u.get("email"),
                 "phone": u.get("mobile") or u.get("phone"), "active": u.get("status", "active") == "active"}
                for u in await self.api.list_users()]

    async def stages(self) -> list[str]:
        fields = await self.api.get_fields(self.s.crm.deals_module)
        field = next((f for f in fields if f.get("api_name") == self.s.crm.deal.stage), None)
        values = sorted((v for v in (field or {}).get("pick_list_values", []) if v.get("display_value") not in (None, "-None-")),
                        key=lambda v: v.get("sequence_number") or 0)
        return [v["display_value"] for v in values] or self.s.crm.deal_stages

    async def changed(self, module: str, since: datetime | None) -> list[dict]:
        """Records changed since `since` (all records when None)."""
        header = since.strftime("%Y-%m-%dT%H:%M:%S+00:00") if since else None
        raw = await self.api.list_records(self.module_names[module], self._fields(module), modified_since=header)
        return [row for row in (self.row(module, r) for r in raw) if row]

    async def one(self, module: str, zoho_id: str) -> dict | None:
        if module == "agents":
            user = await self.api.get_user(zoho_id)
            return {"zoho_id": str(user["id"]), "full_name": user.get("full_name"), "email": user.get("email"),
                    "phone": user.get("mobile") or user.get("phone"), "active": True} if user else None
        record = await self.api.get_record(self.module_names[module], zoho_id, self._fields(module))
        return self.row(module, record) if record else None


class MockSource:
    """Reads the sample data of MockCrm (demo mode and tests)."""

    def __init__(self, settings: Settings, mock: Any):
        self.s = settings
        self.mock = mock

    def _all(self, module: str) -> list[dict]:
        data = self.mock.data
        if module == "contacts":
            return [{"zoho_id": c["id"], "first_name": c.get("firstName"), "last_name": split_name(c["name"])[1], "full_name": c["name"],
                     "email": c["email"].lower(), "phone": c.get("phone"), "mobile": None, "owner_zoho_id": c.get("ownerId")}
                    for c in data["contacts"].values()]
        if module == "properties":
            return [{"zoho_id": p["id"], "name": p["name"], "address": p.get("address"), "city": p.get("city"), "price": dec(p.get("price")),
                     "property_type": p.get("propertyType"), "listing_type": p.get("listingType"), "bedrooms": whole(p.get("bedrooms")),
                     "bathrooms": dec(p.get("bathrooms")), "floor_area": whole(p.get("floorArea")), "status": p.get("status"),
                     "description": p.get("description"), "photo_url": p.get("photoUrl"), "featured": bool(p.get("featured")),
                     "listed_date": parse_date(p.get("listedDate"))} for p in data["properties"]]
        if module == "deals":
            return [{"zoho_id": d["id"], "zoho_modified_at": parse_dt(d.get("modifiedAt")), "deal_name": d["name"], "stage": d.get("stage"),
                     "amount": dec(d.get("amount")), "closing_date": parse_date(d.get("closingDate")), "type": d.get("type"),
                     "description": d.get("description"), "contact_zoho_id": d.get("contactId"), "property_zoho_id": d.get("propertyId"),
                     "owner_zoho_id": d.get("agentId")} for d in data["deals"]]
        if module == "leads":
            rows = []
            for r in data["referrals"]:
                first, last = split_name(r["name"])
                referrer = data["contacts"].get(r["referrerId"]) or {}
                rows.append({"zoho_id": r["id"], "kind": "referral", "first_name": first, "last_name": last, "email": r.get("email"),
                             "phone": r.get("phone"), "lead_source": self.s.crm.referral.lead_source, "lead_status": r.get("leadStatus"),
                             "inquiry_type": r.get("interest"), "match_criteria": None, "description": r.get("notes"),
                             "referred_by_zoho_id": r["referrerId"], "owner_zoho_id": referrer.get("ownerId"), "created_time": parse_dt(r.get("createdAt"))})
            for lead in data["leads"]:
                rows.append({"zoho_id": lead["id"], "kind": "signup", "first_name": lead.get("firstName"), "last_name": lead.get("lastName") or "",
                             "email": lead.get("email"), "phone": lead.get("phone"), "lead_source": self.s.crm.signup.lead_source,
                             "lead_status": self.s.crm.referral.new_status, "inquiry_type": None, "match_criteria": lead.get("criteria"),
                             "description": lead.get("description"), "referred_by_zoho_id": None, "owner_zoho_id": None,
                             "created_time": parse_dt(lead.get("createdAt"))})
            return rows
        if module == "messages":
            return [{"zoho_id": m["id"], "contact_zoho_id": m["contactId"], "deal_zoho_id": m.get("dealId"), "property_zoho_id": m.get("propertyId"),
                     "direction": m["from"], "subject": m["subject"], "body": m.get("body"), "author_name": m.get("author"),
                     "created_time": parse_dt(m.get("createdAt"))} for m in data["messages"]]
        if module == "tasks":
            return [dict(t) for t in data.get("tasks", [])]
        raise ValueError(module)

    async def agents(self) -> list[dict]:
        return [{"zoho_id": a["id"], "full_name": a["name"], "email": a.get("email"), "phone": a.get("phone"), "active": True}
                for a in self.mock.data["agents"].values()]

    async def stages(self) -> list[str]:
        return self.s.crm.deal_stages

    async def changed(self, module: str, since: datetime | None) -> list[dict]:
        rows = self._all(module)
        if since:
            # Sample records without a modified time are always included.
            rows = [r for r in rows if not r.get("zoho_modified_at") or r["zoho_modified_at"] > since]
        return rows

    async def one(self, module: str, zoho_id: str) -> dict | None:
        if module == "agents":
            return next((a for a in await self.agents() if a["zoho_id"] == zoho_id), None)
        return next((r for r in self._all(module) if r["zoho_id"] == zoho_id), None)
