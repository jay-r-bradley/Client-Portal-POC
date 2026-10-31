"""The Zoho → database copy: full sync, webhooks, catch-up, write-through,
read-through, and that pages read from the copy return exactly what Zoho would."""

from __future__ import annotations

from sqlalchemy import func, select

from app.criteria import normalize_criteria
from app.db import CrmDeal, CrmLead, CrmMessage, CrmTask
from app.sync.cached_crm import CachedCrm

from .conftest import build_portal

SECRET = "hook-secret-hook-secret"


def _strip(rows):
    return [{k: v for k, v in r.items() if k != "modifiedAt"} for r in rows]


async def test_full_sync_copies_every_module(portal):
    status = {m["module"]: m for m in await portal.svc.sync.status()}
    assert status["contacts"]["rows"] == 4 and status["properties"]["rows"] == 19 and status["deals"]["rows"] == 7
    assert status["agents"]["rows"] >= 1 and status["stages"]["rows"] == len(portal.settings.crm.deal_stages)
    assert status["leads"]["rows"] == len(portal.crm.data["referrals"]) + len(portal.crm.data["leads"])
    assert all(m["lastStatus"] == "ok" for m in status.values()), status


async def test_pages_read_the_copy_and_match_zoho(portal):
    cached, zoho = portal.svc.crm, portal.crm
    assert isinstance(cached, CachedCrm)
    for contact in ("c1", "c2"):
        assert _strip(await cached.list_deals(contact)) == _strip(await zoho.list_deals(contact))
        assert await cached.get_agent(contact) == await zoho.get_agent(contact)
        assert await cached.list_referrals(contact) == await zoho.list_referrals(contact)
    for criteria in ({}, {"budgetMax": 500000, "locations": ["austin"]}, {"listingType": "Rent", "sort": "price_desc"},
                     {"minBedrooms": 3, "keywords": ["pool"]}, {"locations": ["100%_"]}):
        criteria = normalize_criteria(criteria)
        assert await cached.search_properties(criteria) == await zoho.search_properties(criteria), criteria
    assert await cached.list_featured_properties() == await zoho.list_featured_properties()
    assert await cached.get_property_filter_options() == await zoho.get_property_filter_options()
    assert await cached.get_property("p1") == await zoho.get_property("p1")
    assert await cached.get_stages() == await zoho.get_stages()
    assert await cached.get_deal("c2", "d1") is None, "another client's deal is never returned"


async def test_dashboard_is_served_from_the_copy(portal):
    portal.crm.data["deals"][0]["stage"] = "Closed Won"  # changed in Zoho, no webhook yet
    alex = await portal.sign_in("alex@client.example", "demo1234")
    deal = next(d for d in (await alex.get("/api/dashboard")).json()["deals"] if d["id"] == "d1")
    assert deal["stage"] == "Negotiation", "pages show the copy until the change arrives"


async def test_webhook_updates_and_deletes_one_record(portal):
    portal.settings.sync.webhook_secret = SECRET
    alex = await portal.sign_in("alex@client.example", "demo1234")
    portal.crm.data["deals"][0]["stage"] = "Closed Won"
    hook = portal.client()  # server to server: no Origin, form-encoded, as Zoho sends it
    res = await hook.post("/api/sync/zoho-webhook", content=f"module=Deals&id=d1&token={SECRET}",
                          headers={"content-type": "application/x-www-form-urlencoded"})
    assert res.status_code == 200 and res.json()["result"] == "updated", res.text
    deal = (await alex.get("/api/deals/d1")).json()["deal"]
    assert deal["stage"] == "Closed Won"

    res = await hook.post("/api/sync/zoho-webhook", json={"module": "Deals", "id": "d1", "event": "delete"},
                          headers={"x-portal-webhook-token": SECRET})
    assert res.json()["result"] == "removed"
    assert (await alex.get("/api/deals/d1")).status_code == 404


async def test_webhook_needs_the_secret(portal):
    hook = portal.client()
    body = {"module": "Deals", "id": "d1"}
    assert (await hook.post("/api/sync/zoho-webhook", json=body)).status_code == 404, "off until a secret is set"
    portal.settings.sync.webhook_secret = SECRET
    assert (await hook.post("/api/sync/zoho-webhook", json=body)).status_code == 401
    assert (await hook.post("/api/sync/zoho-webhook", json=body, headers={"x-portal-webhook-token": "nope"})).status_code == 401
    bad = {"module": "Deals", "id": "../../etc", "token": SECRET}
    assert (await hook.post("/api/sync/zoho-webhook", json=bad)).status_code == 400
    assert (await hook.post("/api/sync/zoho-webhook", json={"module": "Invoices", "id": "x1", "token": SECRET})).status_code == 400
    big = {"module": "Deals", "id": "d1", "token": SECRET, "pad": "x" * 70_000}
    assert (await hook.post("/api/sync/zoho-webhook", json=big)).status_code == 413


async def test_catch_up_brings_in_changes_and_full_run_removes_deleted(portal):
    deal = portal.crm.data["deals"][1]
    deal["stage"], deal["modifiedAt"] = "Closed Won", "2099-01-01T00:00:00Z"
    await portal.svc.sync.run()
    assert (await portal.svc.crm.list_deals(deal["contactId"]))
    copied = next(d for d in await portal.svc.crm.list_deals(deal["contactId"]) if d["id"] == deal["id"])
    assert copied["stage"] == "Closed Won"

    portal.crm.data["deals"] = [d for d in portal.crm.data["deals"] if d["id"] != "d7"]
    await portal.svc.sync.run(full=True)
    async with portal.svc.db.session() as s:
        assert await s.scalar(select(func.count()).select_from(CrmDeal).where(CrmDeal.zoho_id == "d7")) == 0


async def test_messages_write_to_zoho_then_the_copy(portal):
    alex = await portal.sign_in("alex@client.example", "demo1234")
    res = await alex.post("/api/messages", json={"subject": "Viewing", "body": "Can we see it Saturday?", "dealId": "d1"})
    assert res.status_code == 201, res.text
    msg_id = res.json()["message"]["id"]
    assert any(m["id"] == msg_id for m in portal.crm.data["messages"]), "written to Zoho"
    listed = (await alex.get("/api/messages")).json()["messages"]
    assert listed[-1]["id"] == msg_id, "and visible straight away from the copy"
    await portal.svc.sync.run()
    async with portal.svc.db.session() as s:
        assert (await s.scalar(select(CrmMessage).where(CrmMessage.zoho_id == msg_id))).deal_zoho_id == "d1"
        task = await s.scalar(select(CrmTask).where(CrmTask.message_zoho_id == msg_id))
        assert task and task.contact_zoho_id == "c1", "the agent's follow-up task is copied too"


async def test_referrals_and_signups_are_copied_and_linked(portal):
    alex = await portal.sign_in("alex@client.example", "demo1234")
    res = await alex.post("/api/referrals", json={"name": "Sam Lee", "email": "sam@friend.example", "interest": "Land or a lot",
                                                 "notes": "Looking for acreage", "consent": True})
    assert res.status_code == 201, res.text
    assert any(r["name"] == "Sam Lee" for r in (await alex.get("/api/referrals")).json()["referrals"])

    guest = portal.client()
    res = await guest.post("/api/auth/signup", json={"name": "Taylor Guest", "email": "taylor@guest.example", "password": "a-long-password",
                                                    "consent": True, "listingType": "Sale", "budgetMax": 400000, "location": "Austin"})
    assert res.status_code == 200, res.text
    res = await guest.post("/api/auth/signup/verify", json={"challengeId": res.json()["challengeId"], "code": res.json()["devCode"]})
    assert res.status_code == 201, res.text
    user = await portal.svc.users.by_email("taylor@guest.example")
    async with portal.svc.db.session() as s:
        lead = await s.scalar(select(CrmLead).where(CrmLead.zoho_id == user.zoho_lead_id))
    assert lead.kind == "signup" and lead.portal_user_id == user.id


async def test_records_missing_from_the_copy_are_fetched_once():
    p = await build_portal()
    data = p.crm.data
    data["contacts"]["c9"] = {"id": "c9", "name": "New Client", "firstName": "New", "email": "new@client.example", "ownerId": "u1"}
    data["deals"].append({**data["deals"][0], "id": "d9", "contactId": "c9", "name": "New - first deal"})
    await p.add_user("new@client.example", "demo1234", contact_id="c9", name="New Client")
    c = await p.sign_in("new@client.example", "demo1234")
    deals = (await c.get("/api/dashboard")).json()["deals"]
    assert [d["id"] for d in deals] == ["d9"], "invited before the next sync, still sees their deal"
    async with p.svc.db.session() as s:
        assert await s.scalar(select(CrmDeal).where(CrmDeal.zoho_id == "d9")), "and it is now in the copy"


async def test_admin_sync_status_and_run(portal):
    admin = await portal.sign_in("admin@brokerage.example", "admin-pass-1")
    status = (await admin.get("/api/admin/sync")).json()
    assert status["enabled"] and status["readFrom"] == "copy" and len(status["modules"]) == 8
    res = await admin.post("/api/admin/sync", json={"full": True})
    assert res.status_code == 200 and res.json()["summary"]["deals"]["ok"]
    events = (await admin.get("/api/admin/activity?action=admin.sync_run")).json()["items"]
    assert events and events[0]["details"]["full"] is True
    alex = await portal.sign_in("alex@client.example", "demo1234")
    assert (await alex.get("/api/admin/sync")).status_code == 403
    assert (await alex.post("/api/admin/sync", json={})).status_code == 403


# ---- live Zoho: paging, change cursor, field mapping ---------------------------------------

async def test_live_source_pages_through_zoho_and_maps_records():
    from datetime import datetime, timezone

    import httpx

    from app.config import Settings, ZohoSettings
    from app.sync.sources import LiveSource
    from app.zoho.api import ZohoApi

    seen = []

    def handler(request: httpx.Request):
        if "/oauth/" in str(request.url):
            return httpx.Response(200, json={"access_token": "t", "expires_in": 3600})
        seen.append((dict(request.url.params), request.headers.get("if-modified-since")))
        params = request.url.params
        if params.get("page") == "1":
            return httpx.Response(200, json={"data": [{"id": "1", "Deal_Name": "A", "Stage": "Offer", "Amount": 1000.5,
                                                       "Contact_Name": {"id": "c1", "name": "Alex"}, "Owner": {"id": "u1"},
                                                       "Modified_Time": "2026-10-30T10:00:00+08:00"}],
                                              "info": {"more_records": True, "next_page_token": "tok"}})
        if params.get("page_token") == "tok":
            return httpx.Response(200, json={"data": [{"id": "2", "Deal_Name": "B"}], "info": {"more_records": False}})
        return httpx.Response(304)  # nothing changed

    settings = Settings()
    api = ZohoApi(ZohoSettings(client_id="i", client_secret="s", refresh_token="r", timeout_seconds=1), transport=httpx.MockTransport(handler))
    rows = await LiveSource(settings, api).changed("deals", datetime(2026, 10, 1, tzinfo=timezone.utc))
    assert [r["zoho_id"] for r in rows] == ["1", "2"]
    first = rows[0]
    assert first["contact_zoho_id"] == "c1" and first["owner_zoho_id"] == "u1" and str(first["amount"]) == "1000.5"
    assert first["zoho_modified_at"] == datetime(2026, 10, 30, 2, tzinfo=timezone.utc)
    (p1, since1), (p2, _) = seen
    assert since1 == "2026-10-01T00:00:00+00:00" and p1["sort_by"] == "Modified_Time" and p1["page"] == "1"
    assert p2["page_token"] == "tok" and "page" not in p2, "page and page_token are never sent together"


def test_live_source_never_copies_internal_notes_or_other_tasks():
    from app.config import Settings
    from app.sync.sources import LiveSource

    src, crm = LiveSource(Settings(), api=None), Settings().crm
    note = {"id": "n1", "Note_Content": "x", "Parent_Id": {"id": "c1", "module": {"api_name": "Contacts"}}}
    assert src.row("messages", {**note, "Note_Title": "Call notes: client is price sensitive"}) is None
    assert src.row("messages", {**note, "Note_Title": f"{crm.portal_note_prefix} Viewing"})["direction"] == "client"
    assert src.row("tasks", {"id": "t1", "Subject": "Internal follow-up"}) is None
    assert src.row("leads", {"id": "l1", "Lead_Source": "Website"}) is None, "only portal sign-ups and referrals"
