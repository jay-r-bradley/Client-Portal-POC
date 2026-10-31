"""The only tools the AI model can call. Each set is created per request and bound
to the signed-in client's Zoho Contact in code (guests get none of the deal
tools), so no prompt can make the model read another client's records. Lookups
go through `crm`, the Zoho MCP-backed service when ZOHO_MCP_URL is configured."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable

from ..config import Settings
from ..criteria import CriteriaError, normalize_criteria
from .agent import Tool, ToolError

MAX_LISTINGS_RETURNED = 25


def _nullable(type_: str) -> dict:
    return {"type": [type_, "null"]}


def _nullable_enum(values: list[str]) -> dict:
    return {"type": ["string", "null"], "enum": [*values, None]} if values else _nullable("string")


def _object(properties: dict) -> dict:
    return {"type": "object", "properties": properties, "required": list(properties), "additionalProperties": False}


def _parse(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _days_between(start: datetime | None, end: datetime | None) -> int | None:
    return round((end - start).total_seconds() / 86400) if start and end else None


def listing_for_model(p: dict) -> dict:
    keys = ("id", "name", "city", "address", "price", "listingType", "propertyType", "bedrooms", "bathrooms", "floorArea", "status", "description")
    return {k: p.get(k) for k in keys}


def deal_facts(deal: dict, stages: list[str], settings: Settings, now: datetime) -> dict:
    """Deal facts plus derived timing, without any contact details."""
    won, lost = settings.crm.won_stages, settings.crm.lost_stages
    open_stages = [s for s in stages if s not in won and s not in lost]
    status = "closed-won" if deal["stage"] in won else "closed-lost" if deal["stage"] in lost else "open"
    today = datetime.combine(now.date(), datetime.min.time(), tzinfo=timezone.utc)
    return {
        "id": deal["id"], "name": deal["name"], "type": deal.get("type"), "stage": deal["stage"], "status": status,
        "stagePosition": f"{open_stages.index(deal['stage']) + 1} of {len(open_stages)}" if status == "open" and deal["stage"] in open_stages else None,
        "pipeline": open_stages, "amount": deal.get("amount"), "targetClosingDate": deal.get("closingDate"),
        "daysUntilClosing": _days_between(today, _parse(deal.get("closingDate"))),
        "lastUpdated": deal.get("modifiedAt"), "daysSinceLastUpdate": _days_between(_parse(deal.get("modifiedAt")), now),
        "latestUpdateFromAgent": deal.get("description"),
        "propertyId": (deal.get("property") or {}).get("id"), "propertyName": (deal.get("property") or {}).get("name"),
    }


@dataclass
class PortalTools:
    tools: list[Tool]
    listings: dict[str, dict] = field(default_factory=dict)
    searches: list[dict] = field(default_factory=list)
    my_deals: Callable[[], Awaitable[list[dict]]] | None = None
    stages: Callable[[], Awaitable[list[str]]] | None = None

    def pick(self, *names: str) -> list[Tool]:
        return [t for t in self.tools if t.name in names]


async def create_portal_tools(*, crm: Any, contact_id: str | None, settings: Settings, now: Callable[[], datetime]) -> PortalTools:
    memo: dict[str, asyncio.Future] = {}

    async def once(key: str, fn: Callable[[], Awaitable[Any]]) -> Any:
        # Per-request memo: the model often asks for the same thing twice.
        if key not in memo:
            memo[key] = asyncio.ensure_future(fn())
        try:
            return await memo[key]
        except Exception:
            memo.pop(key, None)
            raise

    async def my_deals() -> list[dict]:
        return await once("deals", lambda: crm.list_deals(contact_id)) if contact_id else []  # guests have none

    async def stages() -> list[str]:
        return await once("stages", crm.get_stages)

    portal = PortalTools(tools=[], my_deals=my_deals, stages=stages)

    def remember(p: dict) -> dict:
        portal.listings[p["id"]] = p
        return listing_for_model(p)

    try:
        options = await crm.get_property_filter_options()
    except Exception:  # noqa: BLE001
        options = {"propertyTypes": [], "listingTypes": []}

    async def list_my_deals(_: dict) -> dict:
        deals, pipeline = await asyncio.gather(my_deals(), stages())
        return {"deals": [deal_facts(d, pipeline, settings, now()) for d in deals]}

    async def get_deal(args: dict) -> dict:
        deal = next((d for d in await my_deals() if d["id"] == str(args.get("deal_id"))), None)
        if not deal:
            raise ToolError("No deal with that id belongs to this client.")
        prop_id = (deal.get("property") or {}).get("id")
        pipeline, prop = await asyncio.gather(stages(), once(f"property:{prop_id}", lambda: crm.get_property(prop_id)) if prop_id else asyncio.sleep(0))
        return {"deal": deal_facts(deal, pipeline, settings, now()), "property": remember(prop) if prop else None}

    async def search_listings(args: dict) -> dict:
        try:
            criteria = normalize_criteria({
                "budgetMin": args.get("budget_min"), "budgetMax": args.get("budget_max"), "locations": (args.get("locations") or [])[:5],
                "listingType": args.get("listing_type"), "propertyType": args.get("property_type"), "minBedrooms": args.get("min_bedrooms"),
                "minBathrooms": args.get("min_bathrooms"), "minFloorArea": args.get("min_floor_area"),
            })
        except CriteriaError as err:
            raise ToolError(str(err)) from None
        results = await crm.search_properties(criteria)
        portal.searches.append({"criteria": criteria, "results": results})
        return {"count": len(results), "listings": [remember(p) for p in results[:MAX_LISTINGS_RETURNED]]}

    async def get_listing(args: dict) -> dict:
        listing_id = str(args.get("listing_id"))
        try:
            prop = await once(f"property:{listing_id}", lambda: crm.get_property(listing_id))
        except ValueError:
            prop = None  # not a valid record id
        # Off-market listings are only visible if the client has a deal on them.
        visible = prop and (prop.get("status") == settings.crm.available_status
                            or any((d.get("property") or {}).get("id") == prop["id"] for d in await my_deals()))
        if not visible:
            raise ToolError("No available listing with that id.")
        return {"listing": remember(prop)}

    portal.tools = [
        Tool("list_my_deals", "List all of the client's deals with stage, amount, dates and timing.", _object({}), list_my_deals),
        Tool("get_deal", "Get one of the client's deals by id, including full details of the linked property.",
             _object({"deal_id": {"type": "string"}}), get_deal),
        Tool("search_listings",
             "Search currently available listings. Every non-null argument is a hard filter. Locations match city names (any of them). "
             f"Prices are in {settings.currency}; rent is per month. Returns at most {MAX_LISTINGS_RETURNED} listings, cheapest first.",
             _object({
                 "budget_min": _nullable("number"), "budget_max": _nullable("number"),
                 "locations": {"type": "array", "items": {"type": "string"}},
                 "listing_type": _nullable_enum(options.get("listingTypes", [])), "property_type": _nullable_enum(options.get("propertyTypes", [])),
                 "min_bedrooms": _nullable("number"), "min_bathrooms": _nullable("number"), "min_floor_area": _nullable("number"),
             }), search_listings),
        Tool("get_listing", "Get full details of one listing by id.", _object({"listing_id": {"type": "string"}}), get_listing),
    ]
    return portal

