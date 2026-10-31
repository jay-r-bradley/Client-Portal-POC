"""Client referral program: validation and the mapping between Zoho Lead
statuses and the simple progress a referring client sees."""

from __future__ import annotations

import re
from typing import Any

INTERESTS = ["Buying a home", "Land or a lot", "Selling a property", "Renting", "Investment property"]
EMAIL = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")


class ReferralError(ValueError):
    pass


def _text(value: Any, limit: int) -> str:
    return str(value if value is not None else "").strip()[:limit]


def consent_given(value: Any) -> bool:
    return value is True or value in ("on", "true")


def split_name(name: str) -> tuple[str | None, str]:
    parts = name.split()
    return (" ".join(parts[:-1]) or None, parts[-1])


def normalize_referral(data: dict[str, Any]) -> dict[str, Any]:
    name, email = _text(data.get("name"), 120), _text(data.get("email"), 200).lower()
    phone, interest, notes = _text(data.get("phone"), 40), _text(data.get("interest"), 60), _text(data.get("notes"), 1000)
    if not name:
        raise ReferralError("Enter your friend's name.")
    if not email and not phone:
        raise ReferralError("Enter an email address or phone number so the agent can reach them.")
    if email and not EMAIL.match(email):
        raise ReferralError("That email address does not look right.")
    if interest not in INTERESTS:
        raise ReferralError("Choose what they are interested in.")
    if not consent_given(data.get("consent")):
        raise ReferralError("Please confirm they have agreed to be contacted.")
    first, last = split_name(name)
    return {"name": name, "firstName": first, "lastName": last, "email": email or None, "phone": phone or None,
            "interest": interest, "notes": notes or None}


# Zoho's default Lead Status values, folded into four client-friendly steps.
_STEPS = {
    "received": {"Not Contacted", "New", None, ""},
    "in_touch": {"Attempted to Contact", "Contacted", "Contact in Future"},
    "qualified": {"Pre-Qualified", "Qualified", "Converted"},
    "closed": {"Junk Lead", "Lost Lead", "Not Qualified"},
}
_LABELS = {"received": "Received", "in_touch": "Agent in touch", "qualified": "Qualified", "closed": "Closed"}


def referral_progress(lead_status: str | None) -> dict[str, str]:
    step = next((k for k, values in _STEPS.items() if lead_status in values), "in_touch")
    return {"step": step, "label": _LABELS[step]}
