"""Validation and matching for property search. The same normalized criteria
drive the live COQL query and the sample-data filter."""

from __future__ import annotations

import math
from typing import Any

MAX_LOCATIONS = 5
SORTS = {
    "price_asc": ("price", "asc"),
    "price_desc": ("price", "desc"),
    "bedrooms_desc": ("bedrooms", "desc"),
    "area_desc": ("floorArea", "desc"),
}


class CriteriaError(ValueError):
    pass


def _number(value: Any, label: str) -> float | None:
    if value is None or value == "":
        return None
    try:
        n = float(value)
    except (TypeError, ValueError):
        raise CriteriaError(f"{label} must be a positive number.") from None
    if not math.isfinite(n) or n < 0:
        raise CriteriaError(f"{label} must be a positive number.")
    return int(n) if n.is_integer() else n


def _text(value: Any, max_length: int = 80) -> str | None:
    if value is None:
        return None
    text = str(value).strip()[:max_length]
    return text or None


def normalize_criteria(data: dict[str, Any] | None) -> dict[str, Any]:
    data = data or {}
    budget_min = _number(data.get("budgetMin"), "Minimum budget")
    budget_max = _number(data.get("budgetMax"), "Maximum budget")
    if budget_min is not None and budget_max is not None and budget_min > budget_max:
        raise CriteriaError("Minimum budget cannot be greater than maximum budget.")

    raw = data.get("locations")
    if not isinstance(raw, list):
        raw = [data.get("preferredLocation"), *str(data.get("otherLocations") or "").split(",")]
    locations: list[str] = []
    for loc in raw:
        text = _text(loc)
        if text and text not in locations:
            locations.append(text)
    if len(locations) > MAX_LOCATIONS:
        raise CriteriaError(f"Please list at most {MAX_LOCATIONS} locations.")

    sort = data.get("sort")
    return {
        "budgetMin": budget_min,
        "budgetMax": budget_max,
        "locations": locations,
        "propertyType": _text(data.get("propertyType")),
        "listingType": _text(data.get("listingType")),
        "minBedrooms": _number(data.get("minBedrooms"), "Bedrooms"),
        "minBathrooms": _number(data.get("minBathrooms"), "Bathrooms"),
        "minFloorArea": _number(data.get("minFloorArea"), "Floor area"),
        "keywords": _text(data.get("keywords"), 120),
        "sort": sort if sort in SORTS else "price_asc",
    }


def _has(haystack: Any, needle: str) -> bool:
    return needle.lower() in str(haystack or "").lower()


def matches_keywords(p: dict[str, Any], keywords: str | None) -> bool:
    """Keyword matching runs here rather than in COQL, because Zoho does not
    allow LIKE on long-text fields such as Description."""
    if not keywords:
        return True
    fields = (p.get("name"), p.get("address"), p.get("city"), p.get("description"))
    return all(any(_has(f, word) for f in fields) for word in keywords.split())


def _at_least(value: Any, minimum: float | None) -> bool:
    return minimum is None or (value is not None and value >= minimum)


def matches_criteria(p: dict[str, Any], c: dict[str, Any]) -> bool:
    if c["budgetMin"] is not None and not (p.get("price") is not None and p["price"] >= c["budgetMin"]):
        return False
    if c["budgetMax"] is not None and not (p.get("price") is not None and p["price"] <= c["budgetMax"]):
        return False
    if c["locations"] and not any(_has(p.get("city"), loc) for loc in c["locations"]):
        return False
    if c["propertyType"] and p.get("propertyType") != c["propertyType"]:
        return False
    if c["listingType"] and p.get("listingType") != c["listingType"]:
        return False
    if not (_at_least(p.get("bedrooms"), c["minBedrooms"]) and _at_least(p.get("bathrooms"), c["minBathrooms"])
            and _at_least(p.get("floorArea"), c["minFloorArea"])):
        return False
    return matches_keywords(p, c["keywords"])


def sort_properties(properties: list[dict[str, Any]], sort_key: str) -> list[dict[str, Any]]:
    field, direction = SORTS.get(sort_key, SORTS["price_asc"])
    return sorted(properties, key=lambda p: p.get(field) or 0, reverse=direction == "desc")
