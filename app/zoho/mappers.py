"""Converts raw Zoho CRM records into the portal's own shapes, and builds COQL.
Pure functions, unit tested."""

from __future__ import annotations

import math
import re
from typing import Any

from ..config import DealFields, PropertyFields
from ..criteria import SORTS

ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,40}$")


def num(value: Any) -> float | int | None:
    if value is None or value == "":
        return None
    try:
        n = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(n):
        return None
    return int(n) if n.is_integer() else n


def lookup(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict) or not value.get("id"):
        return None
    return {"id": str(value["id"]), "name": value.get("name")}


def map_user(user: dict[str, Any] | None) -> dict[str, Any] | None:
    if not user:
        return None
    name = user.get("full_name") or user.get("name") or " ".join(x for x in (user.get("first_name"), user.get("last_name")) if x) or None
    return {"id": str(user["id"]), "name": name, "email": user.get("email"), "phone": user.get("mobile") or user.get("phone")}


def map_contact(r: dict[str, Any]) -> dict[str, Any]:
    owner = r.get("Owner") or {}
    return {
        "id": str(r["id"]),
        "name": r.get("Full_Name") or " ".join(x for x in (r.get("First_Name"), r.get("Last_Name")) if x),
        "firstName": r.get("First_Name"),
        "email": r.get("Email"),
        "phone": r.get("Mobile") or r.get("Phone"),
        "ownerId": str(owner["id"]) if owner.get("id") else None,
    }


def map_deal(r: dict[str, Any], f: DealFields) -> dict[str, Any]:
    contact = r.get(f.contact) or {}
    return {
        "id": str(r["id"]),
        "name": r.get(f.name) or "Untitled deal",
        "stage": r.get(f.stage),
        "amount": num(r.get(f.amount)),
        "closingDate": r.get(f.closing_date),
        "type": r.get(f.type),
        "description": r.get(f.description),
        "contactId": str(contact["id"]) if isinstance(contact, dict) and contact.get("id") else None,
        "property": lookup(r.get(f.property)),
        "agent": map_user(r.get("Owner")) if r.get("Owner") else None,
        "modifiedAt": r.get("Modified_Time"),
    }


def map_property(r: dict[str, Any], f: PropertyFields) -> dict[str, Any]:
    featured = r.get(f.featured)
    return {
        "id": str(r["id"]),
        "name": r.get(f.name) or "Property",
        "address": r.get(f.address),
        "city": r.get(f.city),
        "price": num(r.get(f.price)),
        "propertyType": r.get(f.type),
        "listingType": r.get(f.listing_type),
        "bedrooms": num(r.get(f.bedrooms)),
        "bathrooms": num(r.get(f.bathrooms)),
        "floorArea": num(r.get(f.floor_area)),
        "status": r.get(f.status),
        "description": r.get(f.description),
        "photoUrl": r.get(f.photo_url),
        "featured": featured is True or featured == "true",
        "listedDate": r.get(f.listed_date),
    }


def quote(value: Any) -> str:
    """COQL string literal: escape backslashes and quotes so user input can never
    break out of the literal."""
    return "'" + str(value).replace("\\", "\\\\").replace("'", "\\'") + "'"


def assert_id(value: Any) -> str:
    text = str(value)
    if not ID_PATTERN.match(text):
        raise ValueError(f"Invalid record id: {text[:60]!r}")
    return text


def combine(conditions: list[str], operator: str) -> str:
    """COQL needs every pair of conditions parenthesised: (a and b), ((a and b) and c)."""
    out = ""
    for cond in conditions:
        out = f"({out} {operator} {cond})" if out else cond
    return out


def _n(value: float | int) -> str:
    n = float(value)
    return str(int(n)) if n.is_integer() else str(n)


def build_property_query(c: dict[str, Any], *, module: str, fields: PropertyFields, available_status: str, limit: int = 100) -> str:
    f = fields
    conditions = [f"{f.status} = {quote(available_status)}"]
    if c["budgetMin"] is not None:
        conditions.append(f"{f.price} >= {_n(c['budgetMin'])}")
    if c["budgetMax"] is not None:
        conditions.append(f"{f.price} <= {_n(c['budgetMax'])}")
    if c["locations"]:
        by_location = [f"{f.city} like {quote('%' + loc + '%')}" for loc in c["locations"]]
        conditions.append(combine(by_location, "or") if len(by_location) > 1 else by_location[0])
    if c["propertyType"]:
        conditions.append(f"{f.type} = {quote(c['propertyType'])}")
    if c["listingType"]:
        conditions.append(f"{f.listing_type} = {quote(c['listingType'])}")
    if c["minBedrooms"] is not None:
        conditions.append(f"{f.bedrooms} >= {_n(c['minBedrooms'])}")
    if c["minBathrooms"] is not None:
        conditions.append(f"{f.bathrooms} >= {_n(c['minBathrooms'])}")
    if c["minFloorArea"] is not None:
        conditions.append(f"{f.floor_area} >= {_n(c['minFloorArea'])}")
    field_name, direction = SORTS.get(c.get("sort"), SORTS["price_asc"])
    sort_field = {"price": f.price, "bedrooms": f.bedrooms, "floorArea": f.floor_area}[field_name]
    columns = ", ".join(f.values())
    return f"select {columns} from {module} where {combine(conditions, 'and')} order by {sort_field} {direction} limit {int(limit)}"


def build_featured_query(*, module: str, fields: PropertyFields, available_status: str, featured_only: bool, limit: int) -> str:
    """Featured listings newest first; without `featured_only`, the newest available listings."""
    available = f"{fields.status} = {quote(available_status)}"
    where = f"({available} and {fields.featured} = true)" if featured_only else available
    return f"select {', '.join(fields.values())} from {module} where {where} order by {fields.listed_date} desc limit {int(limit)}"
