"""User hierarchy, guests, referrals, the activity log and governance."""

from __future__ import annotations

import json

from sqlalchemy import update

from app.db import ActivityEvent
from app.guests import criteria_text
from app.referrals import referral_progress
from app.routes.admin import csv_cell

admin_login = ("admin@brokerage.example", "admin-pass-1")


async def _admin(portal):
    return await portal.sign_in(*admin_login)


# ---- Roles --------------------------------------------------------------------------------

async def test_admins_and_clients_each_see_only_their_side(portal):
    admin, client = await _admin(portal), await portal.sign_in("alex@client.example", "demo1234")
    assert (await admin.get("/api/dashboard")).status_code == 403
    assert (await client.get("/api/admin/overview")).status_code == 403
    assert (await admin.get("/api/admin/overview")).status_code == 200
    assert (await admin.get("/api/auth/me")).json()["user"]["role"] == "admin"


# ---- Activity log ----------------------------------------------------------------------------

async def test_client_actions_are_logged_without_private_content(portal):
    c = await portal.sign_in("alex@client.example", "demo1234")
    await c.get("/api/deals/d1")
    await c.post("/api/properties/search", json={"preferredLocation": "Austin", "budgetMax": 600000})
    await c.get("/api/properties/p15")
    await c.post("/api/messages", json={"subject": "Viewing please", "body": "Private message text", "propertyId": "p15"})
    alex = await portal.svc.users.by_email("alex@client.example")
    items = (await portal.svc.activity.query(user_id=alex.id, limit=20))["items"]
    actions = {e["action"] for e in items}
    assert {"auth.otp_sent", "auth.login", "deal.viewed", "property.searched", "property.viewed", "message.sent"} <= actions
    assert next(e for e in items if e["action"] == "auth.login")["details"]["method"] == "password+email_code"
    assert "Private message text" not in json.dumps(items)
    assert next(e for e in items if e["action"] == "property.searched")["details"]["criteria"]["locations"] == ["Austin"]


async def test_failed_sign_ins_are_logged_without_the_password(portal):
    await portal.client().post("/api/auth/login", json={"email": "priya@client.example", "password": "guess-123"})
    failed = (await portal.svc.activity.query(action="auth.login_failed", limit=1))["items"][0]
    assert failed["details"]["email"] == "priya@client.example" and failed["actor"] is None
    assert "guess-123" not in json.dumps(failed)


async def test_admin_filters_pages_and_exports_activity(portal):
    alex = await portal.sign_in("alex@client.example", "demo1234")
    await alex.post("/api/properties/search", json={"preferredLocation": "Austin"})
    await alex.get("/api/properties/p15")
    admin = await _admin(portal)
    alex_id = (await portal.svc.users.by_email("alex@client.example")).id
    filtered = (await admin.get(f"/api/admin/activity?userId={alex_id}&action=property")).json()
    assert len(filtered["items"]) >= 2 and all(e["actor"]["id"] == alex_id and e["action"].startswith("property.") for e in filtered["items"])
    page1 = (await admin.get("/api/admin/activity?limit=2")).json()
    page2 = (await admin.get(f"/api/admin/activity?limit=2&before={page1['next']}")).json()
    assert len(page1["items"]) == 2 and page2["items"][0]["id"] != page1["items"][0]["id"]
    csv = await admin.get("/api/admin/activity.csv?action=auth")
    assert csv.status_code == 200 and csv.headers["content-type"].startswith("text/csv")
    assert csv.text.splitlines()[0].startswith("Time (UTC),Action,User") and "auth.login" in csv.text


def test_csv_cells_cannot_run_as_formulas():
    assert csv_cell('=HYPERLINK("x")') == "'=HYPERLINK(\"x\")"
    assert csv_cell("plain") == "plain"


async def test_overview_reports_kpis_and_demand(portal):
    alex = await portal.sign_in("alex@client.example", "demo1234")
    await alex.post("/api/properties/search", json={"preferredLocation": "austin"})
    await alex.get("/api/properties/p15")
    body = (await (await _admin(portal)).get("/api/admin/overview")).json()
    assert body["kpis"]["clients"] == 2 and body["kpis"]["signIns7d"] >= 1 and len(body["activityByDay"]) == 14
    assert any(l["location"] == "Austin" for l in body["topLocations"])
    assert any(p["propertyId"] == "p15" for p in body["topProperties"])


# ---- Audit log integrity & data protection -------------------------------------------------------

async def test_the_audit_log_detects_tampering(portal):
    await portal.sign_in("alex@client.example", "demo1234")
    admin = await _admin(portal)
    assert (await admin.post("/api/admin/security/verify-audit-log", json={})).json()["ok"] is True
    async with portal.svc.db.session() as s, s.begin():
        await s.execute(update(ActivityEvent).where(ActivityEvent.action == "auth.login").values(ip="10.0.0.99"))
    result = (await admin.post("/api/admin/security/verify-audit-log", json={})).json()
    assert result["ok"] is False and "changed" in result["reason"]


async def test_export_and_erasure_of_a_users_data(portal):
    priya = await portal.sign_in("priya@client.example", "demo1234")
    await priya.get("/api/deals/d5")
    admin = await _admin(portal)
    user = await portal.svc.users.by_email("priya@client.example")

    export = await admin.get(f"/api/admin/users/{user.id}/export")
    assert export.status_code == 200 and "attachment" in export.headers["content-disposition"]
    data = export.json()
    assert data["account"]["email"] == "priya@client.example" and data["activity"]
    assert "passwordHash" not in export.text and "password_hash" not in export.text

    assert (await admin.post(f"/api/admin/users/{user.id}/erase", json={"confirm": "wrong@x"})).status_code == 400
    erased = await admin.post(f"/api/admin/users/{user.id}/erase", json={"confirm": "priya@client.example"})
    assert erased.status_code == 200 and erased.json()["eventsRedacted"] > 0
    assert (await priya.get("/api/dashboard")).status_code == 401
    assert await portal.svc.users.by_email("priya@client.example") is None
    logged = (await admin.get(f"/api/admin/activity?userId={user.id}")).json()["items"]
    assert "priya@client.example" not in json.dumps([e for e in logged if e["action"] != "admin.user_erased"])
    assert (await admin.post("/api/admin/security/verify-audit-log", json={})).json()["ok"] is True, "erasure keeps the chain valid"
    assert (await portal.client().post("/api/auth/login", json={"email": "priya@client.example", "password": "demo1234"})).status_code == 401


async def test_security_summary_for_admins(portal):
    body = (await (await _admin(portal)).get("/api/admin/security")).json()
    assert body["emailOtp"] is True and body["sessionIdleMinutes"] == 30 and body["database"] in ("sqlite", "postgresql")


# ---- Invites, guests and conversion -----------------------------------------------------------------

async def test_invites_need_an_active_deal_and_temporary_passwords_must_be_changed(portal):
    admin = await _admin(portal)
    assert (await admin.post("/api/admin/users", json={"email": "nobody@client.example", "role": "client"})).status_code == 404
    chris = await admin.post("/api/admin/users", json={"email": "chris@client.example", "role": "client"})
    assert chris.status_code == 422 and "no active deal" in chris.json()["error"]
    assert (await admin.post("/api/admin/users", json={"email": "alex@client.example", "role": "client"})).status_code == 409
    assert (await admin.post("/api/admin/users", json={"email": "g@guest.example", "role": "guest"})).status_code == 400

    invite = await admin.post("/api/admin/users", json={"email": "jordan@client.example", "role": "client"})
    assert invite.status_code == 201 and invite.json()["user"]["contactId"] == "c3"
    jordan = await portal.sign_in("jordan@client.example", invite.json()["temporaryPassword"])
    assert (await jordan.get("/api/dashboard")).status_code == 403
    assert (await jordan.get("/api/auth/me")).json()["user"]["mustChangePassword"] is True
    changed = await jordan.post("/api/auth/change-password", json={"currentPassword": invite.json()["temporaryPassword"], "newPassword": "jordan-long-password"})
    assert changed.status_code == 200
    assert (await jordan.get("/api/dashboard")).status_code == 200


async def test_disable_and_reset_take_effect_immediately(portal):
    admin = await _admin(portal)
    priya_session = await portal.sign_in("priya@client.example", "demo1234")
    priya = await portal.svc.users.by_email("priya@client.example")
    assert (await admin.post(f"/api/admin/users/{priya.id}/status", json={"status": "disabled"})).status_code == 200
    assert (await priya_session.get("/api/dashboard")).status_code == 401
    assert (await portal.client().post("/api/auth/login", json={"email": "priya@client.example", "password": "demo1234"})).status_code == 403
    await admin.post(f"/api/admin/users/{priya.id}/status", json={"status": "active"})
    reset = await admin.post(f"/api/admin/users/{priya.id}/reset-password", json={})
    assert reset.status_code == 200
    assert (await portal.client().post("/api/auth/login", json={"email": "priya@client.example", "password": "demo1234"})).status_code == 401
    me = await portal.svc.users.by_email("admin@brokerage.example")
    assert (await admin.post(f"/api/admin/users/{me.id}/status", json={"status": "disabled"})).status_code == 400


async def _signup(portal, **overrides):
    c = portal.client()
    body = {"name": "Taylor Morgan", "email": "taylor@guest.example", "phone": "+1 555 0100", "password": "guest-password-1",
            "listingType": "Sale", "budgetMax": 600000, "location": "Austin", "consent": True, **overrides}
    started = await c.post("/api/auth/signup", json=body)
    if started.status_code != 200:
        return c, started
    return c, await c.post("/api/auth/signup/verify", json={"challengeId": started.json()["challengeId"], "code": started.json()["devCode"]})


async def test_guest_sign_up_confirms_the_email_before_creating_the_lead(portal):
    c = portal.client()
    started = await c.post("/api/auth/signup", json={"name": "Taylor Morgan", "email": "taylor@guest.example", "password": "guest-password-1",
                                                     "budgetMax": 600000, "location": "Austin", "listingType": "Sale", "consent": True})
    assert started.status_code == 200 and started.json()["otpRequired"]
    assert portal.crm.data["leads"] == [] and await portal.svc.users.by_email("taylor@guest.example") is None, "nothing before the code"
    done = await c.post("/api/auth/signup/verify", json={"challengeId": started.json()["challengeId"], "code": started.json()["devCode"]})
    assert done.status_code == 201
    assert done.json()["initialFilters"] == {"budgetMax": 600000, "locations": ["Austin"], "listingType": "Sale"}
    lead = portal.crm.data["leads"][0]
    assert lead["source"] == "Portal Sign-up" and lead["lastName"] == "Morgan" and "Budget up to $600,000" in lead["description"]
    user = await portal.svc.users.by_email("taylor@guest.example")
    assert user.zoho_lead_id == lead["id"] and user.email_verified_at is not None
    assert {c["kind"] for c in await portal.svc.consents.for_user(user.id)} == {"privacy_policy", "contact_about_properties"}


async def test_sign_up_validation(portal):
    _, dup = await _signup(portal, email="alex@client.example")
    assert dup.status_code == 409
    _, consent = await _signup(portal, email="n1@guest.example", consent=False)
    assert "agree to be contacted" in consent.json()["error"]
    _, short = await _signup(portal, email="n2@guest.example", password="short")
    assert short.status_code == 400


async def test_guests_browse_and_match_but_never_see_deals(portal):
    guest, _ = await _signup(portal)
    assert (await guest.get("/api/properties/featured")).status_code == 200
    search = await guest.post("/api/properties/search", json={"locations": ["Austin"], "budgetMax": 600000, "listingType": "Sale"})
    assert search.status_code == 200 and search.json()["count"] > 0
    assert (await guest.get("/api/properties/p15")).status_code == 200
    for path in ("/api/dashboard", "/api/deals/d1", "/api/messages", "/api/referrals", "/api/admin/overview", "/api/admin/activity"):
        assert (await guest.get(path)).status_code == 403, path
    assert (await guest.get("/api/properties/p16")).status_code == 404
    import asyncio
    await asyncio.sleep(0.05)
    assert "Locations: Austin" in portal.crm.data["leads"][0]["criteria"], "the search is written to the Lead"


async def test_admin_converts_a_guest_with_an_active_deal(portal):
    jordan, _ = await _signup(portal, name="Jordan Lee", email="jordan@client.example")
    assert (await jordan.get("/api/dashboard")).status_code == 403
    admin = await _admin(portal)
    user = await portal.svc.users.by_email("jordan@client.example")
    converted = await admin.post(f"/api/admin/users/{user.id}/convert-to-client", json={})
    assert converted.status_code == 200 and converted.json()["user"]["role"] == "client"
    assert [d["id"] for d in (await jordan.get("/api/dashboard")).json()["deals"]] == ["d6"]
    _, _ = await _signup(portal, name="Chris Wong", email="chris@client.example")
    chris = await portal.svc.users.by_email("chris@client.example")
    assert (await admin.post(f"/api/admin/users/{chris.id}/convert-to-client", json={})).status_code == 422


def test_criteria_summary_reads_well_on_the_lead():
    from datetime import datetime, timezone
    from app.config import Settings
    summary = criteria_text({"budgetMax": 650000, "locations": ["Austin", "Dallas"], "listingType": "Sale", "minBedrooms": 3}, Settings(),
                            query="3 bed with a yard", at=datetime(2026, 10, 31, tzinfo=timezone.utc))
    assert summary == ('Looking to: buy\nBudget up to: $650,000\nLocations: Austin, Dallas\nBedrooms: 3+\n'
                       'In their words: "3 bed with a yard"\nLast searched on the portal: 2026-10-31')


# ---- Referrals ------------------------------------------------------------------------------------

def _friend(**overrides):
    return {"name": "Morgan Diaz", "email": "morgan@example.net", "phone": "", "interest": "Land or a lot",
            "notes": "Wants acreage near Dripping Springs", "consent": True, **overrides}


async def test_referrals_end_to_end(portal):
    alex = await portal.sign_in("alex@client.example", "demo1234")
    created = await alex.post("/api/referrals", json=_friend())
    assert created.status_code == 201 and created.json()["referral"]["progress"]["label"] == "Received"
    mine = (await alex.get("/api/referrals")).json()
    assert [r["name"] for r in mine["referrals"]] == ["Morgan Diaz", "Sam Patel"]
    assert (await alex.post("/api/referrals", json=_friend())).status_code == 409
    assert "agreed to be contacted" in (await alex.post("/api/referrals", json=_friend(email="x@example.net", consent=False))).json()["error"]
    assert (await alex.post("/api/referrals", json=_friend(email="", phone=""))).status_code == 400

    event = (await portal.svc.activity.query(action="referral", limit=1))["items"][0]
    assert event["target"]["name"] == "Morgan Diaz" and "morgan@example.net" not in json.dumps(event)

    priya = await portal.sign_in("priya@client.example", "demo1234")
    assert not any(r["name"] == "Morgan Diaz" for r in (await priya.get("/api/referrals")).json()["referrals"])
    admin_view = (await (await _admin(portal)).get("/api/admin/referrals")).json()
    morgan = next(r for r in admin_view["referrals"] if r["name"] == "Morgan Diaz")
    assert morgan["referrer"]["name"] == "Alex Rivera" and morgan["referrer"]["userId"]


def test_lead_statuses_map_to_client_progress():
    assert [referral_progress(s)["label"] for s in ("Not Contacted", "Attempted to Contact", "Pre-Qualified", "Junk Lead")] == \
        ["Received", "Agent in touch", "Qualified", "Closed"]


async def test_integration_page_lists_every_zoho_field(portal):
    body = (await (await _admin(portal)).get("/api/admin/integration")).json()
    assert body["mode"] == "mock" and body["crm"]["ok"] is True
    props = next(m for m in body["modules"] if m["label"] == "Properties")
    assert any(f["apiName"] == "Featured" and f["type"] == "Checkbox" for f in props["fields"])
    leads = next(m for m in body["modules"] if m["label"] == "Leads")
    assert any(f["apiName"] == "Portal_Match_Criteria" for f in leads["fields"])
