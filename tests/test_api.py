"""Client-facing API against the sample CRM."""

from __future__ import annotations


async def test_portal_endpoints_require_a_session(portal):
    c = portal.client()
    for path in ("/api/dashboard", "/api/deals/d1", "/api/messages", "/api/auth/me", "/api/referrals", "/api/admin/overview"):
        assert (await c.get(path)).status_code == 401, path


async def test_wrong_password_is_rejected_without_revealing_which_part(portal):
    c = portal.client()
    for email in ("alex@client.example", "nobody@client.example"):
        res = await c.post("/api/auth/login", json={"email": email, "password": "wrong-password"})
        assert res.status_code == 401
        assert res.json()["error"] == "Incorrect email or password."


async def test_dashboard_summarizes_the_clients_deals(portal):
    c = await portal.sign_in("alex@client.example", "demo1234")
    body = (await c.get("/api/dashboard")).json()
    assert {k: body["summary"][k] for k in ("total", "active", "won", "lost")} == {"total": 4, "active": 2, "won": 1, "lost": 1}
    assert all(d["contactId"] == "c1" for d in body["deals"])


async def test_a_client_cannot_open_another_clients_deal(portal):
    c = await portal.sign_in("alex@client.example", "demo1234")
    assert (await c.get("/api/deals/d5")).status_code == 404
    assert (await c.get("/api/deals/d1")).status_code == 200


async def test_search_matches_budget_locations_and_bedrooms(portal):
    c = await portal.sign_in("alex@client.example", "demo1234")
    res = await c.post("/api/properties/search", json={"budgetMax": 600000, "preferredLocation": "austin", "otherLocations": "Dallas",
                                                       "minBedrooms": 2, "listingType": "Sale"})
    assert res.status_code == 200
    assert [p["id"] for p in res.json()["properties"]] == ["p1", "p18", "p15"]


async def test_off_market_listings_are_only_visible_to_clients_with_a_deal_on_them(portal):
    alex = await portal.sign_in("alex@client.example", "demo1234")
    body = (await alex.post("/api/properties/search", json={"preferredLocation": "Cedar Park"})).json()
    assert body["count"] == 0
    assert (await alex.get("/api/properties/p16")).status_code == 200
    priya = await portal.sign_in("priya@client.example", "demo1234")
    assert (await priya.get("/api/properties/p16")).status_code == 404


async def test_invalid_search_criteria_return_400(portal):
    c = await portal.sign_in("alex@client.example", "demo1234")
    assert (await c.post("/api/properties/search", json={"budgetMin": 10, "budgetMax": 5})).status_code == 400


async def test_messages_are_sent_and_listed_per_client(portal):
    alex = await portal.sign_in("alex@client.example", "demo1234")
    sent = await alex.post("/api/messages", json={"subject": "Viewing", "body": "Can I see it Friday?", "propertyId": "p3"})
    assert sent.status_code == 201
    assert "Hill Country Family Home" in sent.json()["message"]["body"]
    mine = (await alex.get("/api/messages")).json()
    assert any(m["subject"] == "Viewing" for m in mine["messages"])
    assert mine["agent"]["name"] == "Maria Santos"
    priya = await portal.sign_in("priya@client.example", "demo1234")
    assert not any(m["subject"] == "Viewing" for m in (await priya.get("/api/messages")).json()["messages"])


async def test_cannot_attach_a_message_to_someone_elses_deal(portal):
    alex = await portal.sign_in("alex@client.example", "demo1234")
    assert (await alex.post("/api/messages", json={"subject": "x", "body": "y", "dealId": "d5"})).status_code == 404


async def test_featured_listings_newest_first(portal):
    alex = await portal.sign_in("alex@client.example", "demo1234")
    body = (await alex.get("/api/properties/featured?limit=3")).json()
    assert [p["id"] for p in body["properties"]] == ["p17", "p18", "p19"]
    assert all(p["featured"] and p["status"] == "Available" for p in body["properties"])


async def test_static_portal_is_served(portal):
    res = await portal.client().get("/")
    assert res.status_code == 200
    assert "<main id=\"app\"" in res.text
