"""Demo mode: sample logins and two weeks of plausible activity, so the admin
console has something to show on first run. Only used with ZOHO_MODE=mock;
real deployments start empty."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from .stores import ActivityLog, UserStore

DEMO_LOGINS = [
    {"email": "admin@brokerage.example", "password": "admin1234", "name": "Dana Brooks", "role": "admin"},
    {"email": "alex@client.example", "password": "demo1234", "name": "Alex Rivera", "role": "client", "contact_id": "c1"},
    {"email": "priya@client.example", "password": "demo1234", "name": "Priya Shah", "role": "client", "contact_id": "c2"},
]


async def seed_demo(users: UserStore, activity: ActivityLog) -> None:
    for login in DEMO_LOGINS:
        if not await users.by_email(login["email"]):
            await users.create(**login, email_verified=True)
    if await activity.count():
        return
    alex = await users.by_email("alex@client.example")
    priya = await users.by_email("priya@client.example")
    admin = await users.by_email("admin@brokerage.example")
    now = datetime.now(timezone.utc)
    events: list[tuple] = []

    def at(days_ago: int, hour: int, minute: int = 0) -> datetime:
        return (now - timedelta(days=days_ago)).replace(hour=hour, minute=minute, second=0, microsecond=0)

    def search(locations, budget_max, beds):
        return {"criteria": {"budgetMin": None, "budgetMax": budget_max, "locations": locations, "listingType": "Sale", "propertyType": None,
                             "minBedrooms": beds, "minBathrooms": None, "minFloorArea": None, "keywords": None}}

    events.append((at(13, 9), admin, "auth.login", None, {"method": "password+email_code"}, "198.51.100.4"))
    for d in (12, 10, 9, 7, 6, 4, 3, 2, 1, 0):
        events.append((at(d, 19), alex, "auth.login", None, {"method": "password+email_code"}, "203.0.113.10"))
        events.append((at(d, 19, 1), alex, "portal.dashboard_viewed", None, {"deals": 4}, "203.0.113.10"))
        if d % 2 == 0:
            events.append((at(d, 19, 3), alex, "deal.viewed", {"dealId": "d1", "name": "Rivera - Lakeview Townhouse purchase"}, {"stage": "Negotiation"}, "203.0.113.10"))
        if d <= 9:
            details = {**search(["Austin"], 650000, 3), "results": 3}
            if d % 3 == 0:
                details["query"] = "3-bed home in Austin under 650k with a home office"
            events.append((at(d, 19, 6), alex, "property.ai_searched" if d % 3 == 0 else "property.searched", None, details, "203.0.113.10"))
        prop = ("p18", "Mueller Park Rowhome") if d < 5 else ("p15", "Zilker Park Townhome")
        events.append((at(d, 19, 8), alex, "property.viewed", {"propertyId": prop[0], "name": prop[1]}, {"city": "Austin"}, "203.0.113.10"))
    events.append((at(4, 19, 12), alex, "message.sent", {"propertyId": "p18", "name": "Mueller Park Rowhome"}, {"subject": "Interested in Mueller Park Rowhome"}, "203.0.113.10"))
    events.append((at(1, 20), alex, "message.sent", {"dealId": "d1", "name": "Rivera - Lakeview Townhouse purchase"}, {"subject": "Any word from the seller?"}, "203.0.113.10"))
    for d in (11, 8, 5, 3, 1):
        events.append((at(d, 12), priya, "auth.login", None, {"method": "password+email_code"}, "192.0.2.44"))
        events.append((at(d, 12, 2), priya, "deal.viewed", {"dealId": "d5", "name": "Shah - Uptown Skyline Condo"}, {"stage": "Under Contract"}, "192.0.2.44"))
        events.append((at(d, 12, 5), priya, "property.searched", None, {**search(["Dallas", "Plano"], 900000, 2), "results": 0}, "192.0.2.44"))
        prop = ("p6", "Lakewood Craftsman", "Dallas") if d > 4 else ("p17", "Barton Creek Estate", "Austin")
        events.append((at(d, 12, 7), priya, "property.viewed", {"propertyId": prop[0], "name": prop[1]}, {"city": prop[2]}, "192.0.2.44"))
    events.append((at(3, 12, 9), priya, "referral.submitted", {"referralId": "r2", "name": "Grace Kim"}, {"interest": "Buying a home"}, "192.0.2.44"))
    for minute in (40, 41):
        events.append((at(2, 23, minute), None, "auth.login_failed", {"userId": priya.id, "email": priya.email}, {"email": priya.email}, "45.67.89.10"))

    for when, actor, action, target, details, ip in sorted(events, key=lambda e: e[0]):
        await activity.record(action=action, actor=actor, target=target, details={**details, "demo": True}, ip=ip,
                              user_agent="Mozilla/5.0 (demo)", at=when)
    for user in (alex, priya, admin):
        logins = [e[0] for e in events if e[1] is user and e[2] == "auth.login"]
        if logins:
            await users.update(user.id, last_login_at=max(logins))
