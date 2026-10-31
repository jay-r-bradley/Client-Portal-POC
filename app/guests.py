"""Guest sign-up: validation, the Lead written to Zoho, and keeping the Lead's
"what they're looking for" field current as the guest searches."""

from __future__ import annotations

import asyncio
import logging
import math
import re
import time
from datetime import datetime, timezone
from typing import Any

from .config import Settings
from .money import money
from .referrals import consent_given, split_name

log = logging.getLogger("portal.guests")
EMAIL = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
CRITERIA_SYNC_INTERVAL_SECONDS = 600


class SignupError(ValueError):
    pass


def _text(value: Any, limit: int) -> str:
    return str(value if value is not None else "").strip()[:limit]


def normalize_signup(data: dict[str, Any]) -> dict[str, Any]:
    name, email = _text(data.get("name"), 120), _text(data.get("email"), 200).lower()
    phone, location = _text(data.get("phone"), 40) or None, _text(data.get("location"), 80) or None
    listing_type = data.get("listingType") if data.get("listingType") in ("Sale", "Rent") else None
    raw_budget = data.get("budgetMax")
    budget_max = None
    if raw_budget not in (None, ""):
        try:
            budget_max = float(raw_budget)
        except (TypeError, ValueError):
            budget_max = -1
        if not (math.isfinite(budget_max) and budget_max > 0):
            raise SignupError("Budget must be a positive number.")
        budget_max = int(budget_max) if budget_max.is_integer() else budget_max
    if not name:
        raise SignupError("Enter your name.")
    if not EMAIL.match(email):
        raise SignupError("Enter a valid email address.")
    if not consent_given(data.get("consent")):
        raise SignupError("Please agree to be contacted about properties so we can create your account.")
    first, last = split_name(name)
    return {"name": name, "firstName": first, "lastName": last, "email": email, "phone": phone,
            "listingType": listing_type, "budgetMax": budget_max, "location": location}


def signup_description(guest: dict, settings: Settings) -> str:
    parts = [
        f"Signed up on the {settings.brand_name} portal (email verified).",
        f"Looking to {'rent' if guest['listingType'] == 'Rent' else 'buy'}." if guest.get("listingType") else None,
        f"Budget up to {money(guest['budgetMax'], settings.currency)}." if guest.get("budgetMax") else None,
        f"Preferred location: {guest['location']}." if guest.get("location") else None,
    ]
    return " ".join(p for p in parts if p)


def criteria_text(c: dict | None, settings: Settings, *, query: str | None = None, at: datetime | None = None) -> str | None:
    """Plain-text summary of what a guest is looking for, as agents read it on the Lead."""
    if not c:
        return None
    cur = settings.currency
    parts = [
        f"Looking to: {'rent' if c['listingType'] == 'Rent' else 'buy'}" if c.get("listingType") else None,
        f"Budget from: {money(c['budgetMin'], cur)}" if c.get("budgetMin") is not None else None,
        f"Budget up to: {money(c['budgetMax'], cur)}" if c.get("budgetMax") is not None else None,
        f"Locations: {', '.join(c['locations'])}" if c.get("locations") else None,
        f"Type: {c['propertyType']}" if c.get("propertyType") else None,
        f"Bedrooms: {c['minBedrooms']}+" if c.get("minBedrooms") else None,
        f"Bathrooms: {c['minBathrooms']}+" if c.get("minBathrooms") else None,
        f"Floor area: {c['minFloorArea']}+ sq ft" if c.get("minFloorArea") else None,
        f'In their words: "{query}"' if query else None,
        f"Last searched on the portal: {(at or datetime.now(timezone.utc)).date().isoformat()}",
    ]
    return "\n".join(p for p in parts if p)


class LeadCriteriaSync:
    """Writes a guest's latest search to their Lead, at most every 10 minutes per
    guest, without slowing down or failing the search itself."""

    def __init__(self, crm: Any, settings: Settings):
        self.crm = crm
        self.settings = settings
        self.last: dict[str, float] = {}
        self.tasks: set[asyncio.Task] = set()

    def __call__(self, user: Any, criteria: dict | None, *, query: str | None = None) -> None:
        if user.role != "guest" or not user.zoho_lead_id or not criteria:
            return
        if time.monotonic() - self.last.get(user.id, -math.inf) < CRITERIA_SYNC_INTERVAL_SECONDS:
            return
        self.last[user.id] = time.monotonic()
        summary = criteria_text(criteria, self.settings, query=query)

        async def push() -> None:
            try:
                await self.crm.update_lead_criteria(user.zoho_lead_id, summary)
            except Exception as err:  # noqa: BLE001
                log.warning("Could not update Lead %s with search criteria: %s", user.zoho_lead_id, err)

        task = asyncio.create_task(push())
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)
