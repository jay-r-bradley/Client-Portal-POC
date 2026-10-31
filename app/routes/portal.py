"""Client- and guest-facing routes. Client requests are scoped to the signed-in
client's Zoho Contact; guests only reach the property routes. Meaningful
requests are written to the activity log."""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, Body, Depends, Path, Query, Request

from ..criteria import CriteriaError, normalize_criteria
from ..db import User
from ..referrals import INTERESTS, ReferralError, normalize_referral, referral_progress
from ..web import ID_PATTERN, ApiError, RequireUser, Services, audit, services, text

router = APIRouter(prefix="/api")
client_or_guest = RequireUser("client", "guest")
client_only = RequireUser("client")


def summarize(deals: list[dict], won: list[str], lost: list[str]) -> dict:
    by_stage: dict[str, int] = {}
    for d in deals:
        by_stage[d.get("stage") or "Unassigned"] = by_stage.get(d.get("stage") or "Unassigned", 0) + 1
    n_won = sum(d["stage"] in won for d in deals)
    n_lost = sum(d["stage"] in lost for d in deals)
    return {"total": len(deals), "active": len(deals) - n_won - n_lost, "won": n_won, "lost": n_lost, "byStage": by_stage}


@router.get("/dashboard")
async def dashboard(request: Request, user: User = Depends(client_only), svc: Services = Depends(services)):
    deals, stages = await asyncio.gather(svc.crm.list_deals(user.zoho_contact_id), svc.crm.get_stages())
    deals.sort(key=lambda d: d.get("modifiedAt") or "", reverse=True)
    await audit(request, "portal.dashboard_viewed", actor=user, details={"deals": len(deals)})
    crm = svc.settings.crm
    return {"summary": summarize(deals, crm.won_stages, crm.lost_stages), "stages": stages,
            "wonStages": crm.won_stages, "lostStages": crm.lost_stages, "deals": deals}


@router.get("/deals/{deal_id}")
async def deal(request: Request, deal_id: str = Path(pattern=ID_PATTERN), user: User = Depends(client_only), svc: Services = Depends(services)):
    found = await svc.crm.get_deal(user.zoho_contact_id, deal_id)
    if not found:
        raise ApiError(404, "Deal not found.")
    await audit(request, "deal.viewed", actor=user, target={"dealId": found["id"], "name": found["name"]}, details={"stage": found["stage"]})
    prop_id = (found.get("property") or {}).get("id")
    prop, stages = await asyncio.gather(svc.crm.get_property(prop_id) if prop_id else asyncio.sleep(0), svc.crm.get_stages())
    crm = svc.settings.crm
    return {"deal": found, "property": prop, "stages": stages, "wonStages": crm.won_stages, "lostStages": crm.lost_stages}


@router.get("/properties/featured")
async def featured(limit: int = Query(6, ge=1, le=12), user: User = Depends(client_or_guest), svc: Services = Depends(services)):
    return {"properties": await svc.crm.list_featured_properties(limit)}


@router.get("/properties/options")
async def options(user: User = Depends(client_or_guest), svc: Services = Depends(services)):
    return await svc.crm.get_property_filter_options()


@router.post("/properties/search")
async def search(request: Request, body: dict = Body(...), user: User = Depends(client_or_guest), svc: Services = Depends(services)):
    try:
        criteria = normalize_criteria(body)
    except CriteriaError as err:
        raise ApiError(400, str(err)) from None
    properties = await svc.crm.search_properties(criteria)
    await audit(request, "property.searched", actor=user, details={"criteria": criteria, "results": len(properties)})
    svc.lead_sync(user, criteria)
    return {"criteria": criteria, "count": len(properties), "properties": properties}


@router.get("/properties/{property_id}")
async def property_detail(request: Request, property_id: str = Path(pattern=ID_PATTERN), user: User = Depends(client_or_guest),
                          svc: Services = Depends(services)):
    prop = await svc.crm.get_property(property_id)
    if not prop:
        raise ApiError(404, "Property not found.")
    # Off-market listings are only visible to clients who have a deal on them.
    if prop.get("status") != svc.settings.crm.available_status:
        if user.role != "client":
            raise ApiError(404, "Property not found.")
        deals = await svc.crm.list_deals(user.zoho_contact_id)
        if not any((d.get("property") or {}).get("id") == prop["id"] for d in deals):
            raise ApiError(404, "Property not found.")
    await audit(request, "property.viewed", actor=user, target={"propertyId": prop["id"], "name": prop["name"]},
                details={"price": prop.get("price"), "city": prop.get("city")})
    return {"property": prop}


@router.get("/messages")
async def messages(user: User = Depends(client_only), svc: Services = Depends(services)):
    msgs, agent = await asyncio.gather(svc.crm.list_messages(user.zoho_contact_id), svc.crm.get_agent(user.zoho_contact_id))
    return {"agent": agent, "messages": msgs}


@router.post("/messages", status_code=201)
async def send_message(request: Request, body: dict = Body(...), user: User = Depends(client_only), svc: Services = Depends(services)):
    subject, message = text(body.get("subject"), 500), text(body.get("body"), 10000)
    if not subject or len(subject) > 120:
        raise ApiError(400, "Please enter a subject (up to 120 characters).")
    if not message or len(message) > 4000:
        raise ApiError(400, "Please enter a message (up to 4000 characters).")
    deal_id, prop_id = text(body.get("dealId"), 64), text(body.get("propertyId"), 64)
    try:
        found_deal = await svc.crm.get_deal(user.zoho_contact_id, deal_id) if deal_id else None
        prop = await svc.crm.get_property(prop_id) if prop_id else None
    except ValueError:
        raise ApiError(404, "Not found.") from None
    if deal_id and not found_deal:
        raise ApiError(404, "Deal not found.")
    if prop_id and not prop:
        raise ApiError(404, "Property not found.")
    sent = await svc.crm.send_message(user.zoho_contact_id, subject=subject, body=message, deal=found_deal, property=prop)
    # The subject and context are logged; the message body stays in Zoho only.
    target = ({"dealId": found_deal["id"], "name": found_deal["name"]} if found_deal
              else {"propertyId": prop["id"], "name": prop["name"]} if prop else None)
    await audit(request, "message.sent", actor=user, target=target, details={"subject": subject})
    return {"message": sent}


# ---- Referral program ----------------------------------------------------------------------

def _client_referral(r: dict) -> dict:
    keys = ("id", "name", "email", "phone", "interest", "notes", "createdAt")
    return {**{k: r.get(k) for k in keys}, "progress": referral_progress(r.get("leadStatus"))}


@router.get("/referrals")
async def referrals(user: User = Depends(client_only), svc: Services = Depends(services)):
    rows = await svc.crm.list_referrals(user.zoho_contact_id)
    return {"referrals": [_client_referral(r) for r in rows], "interests": INTERESTS,
            "rewardText": svc.settings.crm.referral.reward_text or None}


@router.post("/referrals", status_code=201)
async def refer(request: Request, body: dict = Body(...), user: User = Depends(client_only), svc: Services = Depends(services)):
    try:
        referral = normalize_referral(body)
    except ReferralError as err:
        raise ApiError(400, str(err)) from None
    if not svc.referrals.allowed(user.id):
        raise ApiError(429, "You have sent the maximum number of referrals for today. Please try again tomorrow.")
    existing = await svc.crm.list_referrals(user.zoho_contact_id)
    if referral["email"] and any((r.get("email") or "").lower() == referral["email"] for r in existing):
        raise ApiError(409, "You have already referred someone with that email.")
    created = await svc.crm.create_referral(user.zoho_contact_id, referral)
    svc.referrals.hit(user.id)
    # The referred person's contact details stay in Zoho; the log keeps the name and interest only.
    await audit(request, "referral.submitted", actor=user, target={"referralId": created["id"], "name": referral["name"]},
                details={"interest": referral["interest"]})
    return {"referral": _client_referral(created)}
