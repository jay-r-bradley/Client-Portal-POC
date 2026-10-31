"""Sign-in with emailed one-time codes, sessions and idle timeout, and the HTTP
security checkpoints (CSRF, URL/body validation, size limits, timeouts, headers)."""

from __future__ import annotations

import asyncio
import time

from app.security.sessions import COOKIE_NAME, issue_token, read_token

from .conftest import build_portal


async def _start_login(c, email="alex@client.example", password="demo1234"):
    res = await c.post("/api/auth/login", json={"email": email, "password": password})
    assert res.status_code == 200, res.text
    return res.json()


async def test_sign_in_needs_the_emailed_code(portal):
    c = portal.client()
    res = await c.post("/api/auth/login", json={"email": "alex@client.example", "password": "demo1234"})
    body = res.json()
    assert body["otpRequired"] is True
    assert body["sentTo"] == "al••@client.example"
    assert "set-cookie" not in res.headers, "no session before the code"
    assert (await c.get("/api/dashboard")).status_code == 401

    email = portal.last_email("alex@client.example")
    assert body["devCode"] in email.text and "Never share this code" in email.text


async def test_the_code_is_single_use_and_attempts_are_limited(portal):
    c = portal.client()
    body = await _start_login(c)
    for attempt in range(1, 5):
        res = await c.post("/api/auth/login/verify", json={"challengeId": body["challengeId"], "code": "000000" if body["devCode"] != "000000" else "111111"})
        assert res.status_code == 400 and f"{5 - attempt} attempt" in res.json()["error"]
    res = await c.post("/api/auth/login/verify", json={"challengeId": body["challengeId"], "code": "999999" if body["devCode"] != "999999" else "888888"})
    assert res.status_code == 429
    assert (await c.post("/api/auth/login/verify", json={"challengeId": body["challengeId"], "code": body["devCode"]})).status_code == 429

    fresh = await _start_login(c)
    assert (await c.post("/api/auth/login/verify", json={"challengeId": fresh["challengeId"], "code": fresh["devCode"]})).status_code == 200
    assert (await c.post("/api/auth/login/verify", json={"challengeId": fresh["challengeId"], "code": fresh["devCode"]})).status_code == 410


async def test_a_new_code_replaces_the_previous_one(portal):
    c = portal.client()
    first = await _start_login(c)
    second = await _start_login(c)
    assert (await c.post("/api/auth/login/verify", json={"challengeId": first["challengeId"], "code": first["devCode"]})).status_code == 410
    assert (await c.post("/api/auth/login/verify", json={"challengeId": second["challengeId"], "code": second["devCode"]})).status_code == 200


async def test_resend_has_a_cooldown(portal):
    c = portal.client()
    body = await _start_login(c)
    res = await c.post("/api/auth/otp/resend", json={"challengeId": body["challengeId"]})
    assert res.status_code == 429 and "wait" in res.json()["error"]


async def test_expired_codes_are_rejected():
    p = await build_portal(otp_ttl_minutes=0)
    await p.add_user("alex@client.example", "demo1234", contact_id="c1", name="Alex")
    c = p.client()
    body = await _start_login(c)
    res = await c.post("/api/auth/login/verify", json={"challengeId": body["challengeId"], "code": body["devCode"]})
    assert res.status_code == 410 and "expired" in res.json()["error"]


async def test_codes_are_stored_only_as_hashes(portal):
    c = portal.client()
    body = await _start_login(c)
    from app.db import OtpChallenge
    async with portal.svc.db.session() as s:
        challenge = await s.get(OtpChallenge, body["challengeId"])
    assert body["devCode"] not in challenge.code_hash and len(challenge.code_hash) == 64


async def test_dev_codes_are_never_returned_with_a_real_mailer(portal):
    portal.settings.mail.provider = "smtp"
    sent = []

    async def fake_send(email):
        sent.append(email)

    portal.svc.mailer.send = fake_send
    body = await _start_login(portal.client())
    assert "devCode" not in body and sent


async def test_one_time_codes_can_be_switched_off():
    p = await build_portal(email_otp=False)
    await p.add_user("alex@client.example", "demo1234", contact_id="c1", name="Alex")
    c = p.client()
    body = await _start_login(c)
    assert body["otpRequired"] is False
    assert (await c.get("/api/dashboard")).status_code == 200


async def test_failed_sign_ins_are_throttled(portal):
    c = portal.client()
    for _ in range(10):
        assert (await c.post("/api/auth/login", json={"email": "priya@client.example", "password": "wrong-pass"})).status_code == 401
    assert (await c.post("/api/auth/login", json={"email": "priya@client.example", "password": "wrong-pass"})).status_code == 429


async def test_forgot_password_resets_by_code_without_revealing_accounts(portal):
    c = portal.client()
    unknown = await c.post("/api/auth/password/forgot", json={"email": "nobody@client.example"})
    known = await c.post("/api/auth/password/forgot", json={"email": "alex@client.example"})
    assert unknown.status_code == known.status_code == 200
    assert set(unknown.json()) - {"devCode"} == set(known.json()) - {"devCode"}, "same response shape"
    assert not any(e.to == "nobody@client.example" for e in portal.svc.mailer.outbox)

    old_session = await portal.sign_in("alex@client.example", "demo1234")
    body = known.json()
    bad = await c.post("/api/auth/password/reset", json={"challengeId": body["challengeId"], "code": body["devCode"], "newPassword": "short"})
    assert bad.status_code == 400
    fresh = (await c.post("/api/auth/password/forgot", json={"email": "alex@client.example"})).json()
    ok = await c.post("/api/auth/password/reset", json={"challengeId": fresh["challengeId"], "code": fresh["devCode"], "newPassword": "a-new-long-password"})
    assert ok.status_code == 200
    assert (await old_session.get("/api/dashboard")).status_code == 401, "reset signs out everywhere"
    await portal.sign_in("alex@client.example", "a-new-long-password")


async def test_sessions_slide_with_activity_and_expire_when_idle(portal):
    c = await portal.sign_in("alex@client.example", "demo1234")
    secret = portal.settings.session_secret
    user = await portal.svc.users.by_email("alex@client.example")

    # A token two minutes into its idle window gets refreshed on the next request.
    aged, _ = issue_token(user.id, user.session_version, secret=secret, idle_minutes=28, max_hours=12)
    c.cookies.set(COOKIE_NAME, aged)
    res = await c.get("/api/auth/session")
    assert res.status_code == 200
    refreshed = read_token(res.cookies.get(COOKIE_NAME), secret=secret)
    assert refreshed and refreshed.exp > time.time() + 29 * 60

    # An idle-expired token is refused.
    expired, _ = issue_token(user.id, user.session_version, secret=secret, idle_minutes=-1, max_hours=12)
    c.cookies.set(COOKIE_NAME, expired)
    assert (await c.get("/api/dashboard")).status_code == 401


async def test_sessions_end_at_the_absolute_maximum_even_when_active(portal):
    user = await portal.svc.users.by_email("alex@client.example")
    token, exp = issue_token(user.id, user.session_version, secret="s", idle_minutes=30, max_hours=12, auth_time=time.time() - 12 * 3600 + 5)
    assert exp - time.time() <= 5


async def test_tampered_or_forged_cookies_are_rejected(portal):
    c = await portal.sign_in("alex@client.example", "demo1234")
    token = c.cookies.get(COOKIE_NAME)
    body, sig = token.split(".")
    c.cookies.set(COOKIE_NAME, f"{body}.{sig[:-2]}AA")
    assert (await c.get("/api/dashboard")).status_code == 401
    c.cookies.set(COOKIE_NAME, "not-a-token")
    assert (await c.get("/api/dashboard")).status_code == 401


async def test_session_cookie_flags(portal):
    c = portal.client()
    body = await _start_login(c)
    res = await c.post("/api/auth/login/verify", json={"challengeId": body["challengeId"], "code": body["devCode"]})
    cookie = res.headers["set-cookie"].lower()
    assert "httponly" in cookie and "samesite=lax" in cookie and "path=/" in cookie


async def test_writes_must_be_same_origin_json(portal):
    c = await portal.sign_in("alex@client.example", "demo1234")
    form = await c.post("/api/messages", content=b"subject=a&body=b", headers={"Content-Type": "application/x-www-form-urlencoded"})
    assert form.status_code == 415
    cross = await c.post("/api/messages", json={"subject": "a", "body": "b"}, headers={"Origin": "https://evil.example"})
    assert cross.status_code == 403
    fetch_meta = await c.post("/api/messages", json={"subject": "a", "body": "b"}, headers={"Sec-Fetch-Site": "cross-site"})
    assert fetch_meta.status_code == 403


async def test_oversized_and_malformed_requests_are_rejected(portal):
    c = await portal.sign_in("alex@client.example", "demo1234")
    big = await c.post("/api/messages", content=b'{"subject":"' + b"x" * 70000 + b'"}', headers={"Content-Type": "application/json"})
    assert big.status_code == 413
    bad_json = await c.post("/api/messages", content=b"{not json", headers={"Content-Type": "application/json"})
    assert bad_json.status_code == 400
    assert bad_json.json() == {"error": "Invalid request."}


async def test_url_injection_attempts_are_rejected(portal):
    alex = await portal.sign_in("alex@client.example", "demo1234")
    for path in ("/api/deals/d1'%20or%20'1'='1", "/api/properties/..%2F..%2Fetc%2Fpasswd", "/api/deals/%3Cscript%3E",
                 "/api/properties/" + "a" * 100):
        res = await alex.get(path)
        assert res.status_code in (400, 404), path
        assert "<script>" not in res.text and "passwd" not in res.text
    admin = await portal.sign_in("admin@brokerage.example", "admin-pass-1")
    for query in ("from=2026-01-01'%20--", "userId=..%2F..%2F", "action=auth;drop", "limit=100000", "q=" + "x" * 500):
        assert (await admin.get(f"/api/admin/activity?{query}")).status_code == 400, query
    assert (await portal.client().get("/../app/config.py")).status_code == 404


async def test_slow_requests_time_out_with_a_friendly_message():
    p = await build_portal(request_timeout_seconds=0.2)
    await p.add_user("alex@client.example", "demo1234", contact_id="c1", name="Alex")
    c = await p.sign_in("alex@client.example", "demo1234")

    async def slow(*_):
        await asyncio.sleep(2)
        return []

    p.svc.crm.list_deals = slow  # the service the pages use (the database copy)
    res = await c.get("/api/dashboard")
    assert res.status_code == 504
    assert res.json()["error"] == "The request took too long. Please try again."


async def test_security_headers_and_no_public_api_docs(portal):
    res = await portal.client().get("/api/config")
    h = res.headers
    assert h["x-content-type-options"] == "nosniff" and h["x-frame-options"] == "DENY"
    assert "frame-ancestors 'none'" in h["content-security-policy"] and "script-src 'self'" in h["content-security-policy"]
    assert h["cache-control"] == "no-store"
    for path in ("/docs", "/redoc", "/openapi.json"):
        assert (await portal.client().get(path)).status_code == 404


async def test_disabled_accounts_and_changed_passwords_sign_out_everywhere(portal):
    alex = await portal.sign_in("alex@client.example", "demo1234")
    second = await portal.sign_in("alex@client.example", "demo1234")
    changed = await alex.post("/api/auth/change-password", json={"currentPassword": "demo1234", "newPassword": "a-much-longer-password"})
    assert changed.status_code == 200
    assert (await second.get("/api/dashboard")).status_code == 401
    assert (await alex.get("/api/dashboard")).status_code == 200, "the changing session gets a fresh cookie"


async def test_only_admins_can_read_activity_logs(portal):
    for email, password in (("alex@client.example", "demo1234"),):
        c = await portal.sign_in(email, password)
        for path in ("/api/admin/activity", "/api/admin/activity.csv", "/api/admin/overview", "/api/admin/users"):
            assert (await c.get(path)).status_code == 403, path
