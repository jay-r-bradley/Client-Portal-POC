"""Admin console API (brokerage staff only): portfolio-wide activity, user access
management, referrals, the Zoho connection / field check, and governance
(audit-log verification, data export and erasure)."""

from __future__ import annotations

import asyncio
import csv
import io
import json
import secrets
from collections import Counter
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Body, Depends, Path, Query, Request
from fastapi.responses import Response

from ..db import User, utcnow
from ..referrals import referral_progress
from ..stores import public_user
from ..web import DATE_PATTERN, UUID_PATTERN, ApiError, RequireUser, Services, audit, services, text, valid_email
from ..zoho.field_catalog import field_catalog

router = APIRouter(prefix="/api/admin")
admin_only = RequireUser("admin")
DAY = 86400
ACTIVITY_CATEGORIES = {"auth", "deal", "property", "message", "referral", "portal", "admin"}

def temporary_password() -> str:
    """Readable one-time password; the user must replace it at first sign-in."""
    return secrets.token_urlsafe(9)

def csv_cell(value) -> str:
    """Spreadsheet apps run cells starting with these characters as formulas."""
    text_value = "" if value is None else value if isinstance(value, str) else json.dumps(value)
    return f"'{text_value}" if text_value[:1] in ("=", "+", "-", "@", "\t", "\r") else text_value

def _parse_iso(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))

def _filters(user_id: str | None, action: str | None, start: str | None, end: str | None, q: str | None) -> dict:
    return {
        "user_id": user_id, "action": action if action in ACTIVITY_CATEGORIES or (action or "").count(".") == 1 else None,
        "start": datetime.fromisoformat(start).replace(tzinfo=timezone.utc) if start else None,
        # A bare "to" date includes that whole day.
        "end": datetime.fromisoformat(end).replace(tzinfo=timezone.utc) + timedelta(days=1) if end else None,
        "q": q.strip()[:100] if q and q.strip() else None,
    }

async def _find_user(svc: Services, user_id: str) -> User:
    user = await svc.users.by_id(user_id)
    if not user or user.status == "erased":
        raise ApiError(404, "User not found.")
    return user

def _is_open(deal: dict, svc: Services) -> bool:
    return deal["stage"] not in svc.settings.crm.won_stages and deal["stage"] not in svc.settings.crm.lost_stages

async def _contact_with_active_deal(svc: Services, email: str) -> tuple[dict, list[dict]]:
    """Client access requires a Zoho Contact with this email and an open deal."""
    contact = await svc.crm.find_contact_by_email(email)
    if not contact:
        raise ApiError(404, "No Zoho CRM Contact has that email. Add them in Zoho (or convert their Lead) first.")
    open_deals = [d for d in await svc.crm.list_deals(contact["id"]) if _is_open(d, svc)]
    if not open_deals:
        raise ApiError(422, f"{contact['name']} has no active deal in Zoho. Client access is given once they have an open deal.")
    return contact, open_deals

# ---- Overview ---------------------------------------------------------------------

@router.get("/overview")
async def overview(admin: User = Depends(admin_only), svc: Services = Depends(services)):
    now = datetime.now(timezone.utc)
    last30 = await svc.activity.since(30 * DAY)
    last7 = [e for e in last30 if (now - _parse_iso(e["at"])).total_seconds() <= 7 * DAY]
    client_events = [e for e in last30 if (e["actor"] or {}).get("role") == "client"]

    def count(events: list[dict], *actions: str) -> int:
        return sum(e["action"] in actions for e in events)

    users = await svc.users.all()
    days = [(now - timedelta(days=13 - i)).date().isoformat() for i in range(14)]
    per_day = Counter(e["at"][:10] for e in client_events)
    by_user = Counter(e["actor"]["id"] for e in client_events)
    by_id = {u.id: u for u in users}

    properties = Counter()
    names = {}
    for e in client_events:
        target = e.get("target") or {}
        if e["action"] == "property.viewed" or (e["action"] == "message.sent" and target.get("propertyId")):
            properties[target["propertyId"]] += 1
            names[target["propertyId"]] = target.get("name")
    locations = Counter(loc.strip().title() for e in client_events for loc in ((e["details"] or {}).get("criteria") or {}).get("locations") or [])

    return {
        "kpis": {
            "clients": sum(u.role == "client" for u in users),
            "activeClients30d": len(by_user),
            "signIns7d": count(last7, "auth.login"),
            "failedSignIns7d": count(last7, "auth.login_failed", "auth.otp_failed"),
            "searches7d": count(last7, "property.searched", "property.ai_searched"),
            "propertyViews7d": count(last7, "property.viewed"),
            "messages7d": count(last7, "message.sent"),
            "referrals30d": count(last30, "referral.submitted"),
            "guestSignups30d": count(last30, "auth.signed_up"),
            "guests": sum(u.role == "guest" for u in users),
        },
        "activityByDay": [{"date": d, "events": per_day.get(d, 0)} for d in days],
        # Demand signals: what clients look at and where they want to live.
        "topProperties": [{"propertyId": pid, "name": names[pid], "interactions": n} for pid, n in properties.most_common(5)],
        "topLocations": [{"location": loc, "searches": n} for loc, n in locations.most_common(5)],
        "mostActiveClients": [
            {"id": uid, "name": getattr(by_id.get(uid), "name", None), "email": getattr(by_id.get(uid), "email", None), "events": n,
             "lastLoginAt": public_user(by_id[uid])["lastLoginAt"] if uid in by_id else None}
            for uid, n in by_user.most_common(5)
        ],
        "recent": (await svc.activity.query(limit=10))["items"],
    }

# ---- Activity log ---------------------------------------------------------------------

@router.get("/activity")
async def activity(
    userId: str | None = Query(None, pattern=UUID_PATTERN), action: str | None = Query(None, max_length=60, pattern=r"^[a-z_.]+$"),
    from_: str | None = Query(None, alias="from", pattern=DATE_PATTERN), to: str | None = Query(None, pattern=DATE_PATTERN),
    q: str | None = Query(None, max_length=100), before: str | None = Query(None, pattern=UUID_PATTERN),
    limit: int = Query(50, ge=1, le=200), admin: User = Depends(admin_only), svc: Services = Depends(services),
):
    return await svc.activity.query(before=before, limit=limit, **_filters(userId, action, from_, to, q))

@router.get("/activity.csv")
async def activity_csv(
    request: Request, userId: str | None = Query(None, pattern=UUID_PATTERN), action: str | None = Query(None, max_length=60, pattern=r"^[a-z_.]+$"),
    from_: str | None = Query(None, alias="from", pattern=DATE_PATTERN), to: str | None = Query(None, pattern=DATE_PATTERN),
    q: str | None = Query(None, max_length=100), admin: User = Depends(admin_only), svc: Services = Depends(services),
):
    filters = _filters(userId, action, from_, to, q)
    items = (await svc.activity.query(limit=10000, **filters))["items"]
    await audit(request, "admin.activity_exported", actor=admin, details={"filters": {"userId": userId, "action": action, "from": from_, "to": to, "q": q}, "rows": len(items)})
    out = io.StringIO()
    writer = csv.writer(out, lineterminator="\r\n")
    writer.writerow(["Time (UTC)", "Action", "User", "Email", "Role", "Target", "Details", "IP"])
    for e in items:
        actor, target = e["actor"] or {}, e["target"] or {}
        writer.writerow([csv_cell(v) for v in (e["at"], e["action"], actor.get("name"), actor.get("email"), actor.get("role"),
                                              target.get("name") or target.get("email"), e["details"], e["ip"])])
    filename = f"portal-activity-{datetime.now(timezone.utc).date().isoformat()}.csv"
    return Response(out.getvalue(), media_type="text/csv; charset=utf-8", headers={"Content-Disposition": f'attachment; filename="{filename}"'})

# ---- Users ----------------------------------------------------------------------------------

@router.get("/users")
async def list_users(admin: User = Depends(admin_only), svc: Services = Depends(services)):
    events30 = Counter((e["actor"] or {}).get("id") for e in await svc.activity.since(30 * DAY))
    users = [{**public_user(u), "events30d": events30.get(u.id, 0)} for u in await svc.users.all()]
    users.sort(key=lambda u: (u["role"], (u["name"] or u["email"]).lower()))
    return {"users": users}

@router.get("/users/{user_id}")
async def user_detail(user_id: str = Path(pattern=UUID_PATTERN), admin: User = Depends(admin_only), svc: Services = Depends(services)):
    user = await _find_user(svc, user_id)
    contact = deals = None
    if user.role == "client":
        contact, deals = await asyncio.gather(svc.crm.get_contact(user.zoho_contact_id), svc.crm.list_deals(user.zoho_contact_id), return_exceptions=True)
        contact = None if isinstance(contact, Exception) else contact
        deals = None if isinstance(deals, Exception) else deals
    return {
        "user": public_user(user), "contact": contact,
        "deals": [{k: d.get(k) for k in ("id", "name", "stage", "amount", "closingDate")} for d in deals] if deals else deals,
        "consents": await svc.consents.for_user(user.id),
        "activity": (await svc.activity.query(user_id=user.id, limit=100))["items"],
    }

@router.post("/users", status_code=201)
async def invite(request: Request, body: dict = Body(...), admin: User = Depends(admin_only), svc: Services = Depends(services)):
    email = valid_email(body.get("email"))
    role = text(body.get("role") or "client", 10)
    if role not in ("client", "admin"):
        raise ApiError(400, "Invite a client or an admin. Guests sign up on their own.")
    existing = await svc.users.by_email(email)
    if existing and existing.role == "guest":
        raise ApiError(409, 'That email already has a guest account. Use "Convert to client" on it instead.')
    if existing:
        raise ApiError(409, "That email already has portal access.")
    contact_id, name, open_deals = None, text(body.get("name"), 120) or None, 0
    if role == "client":
        contact, deals = await _contact_with_active_deal(svc, email)
        if await svc.users.by_contact(contact["id"]):
            raise ApiError(409, "Another portal account is already linked to that Zoho Contact.")
        contact_id, name, open_deals = contact["id"], contact["name"], len(deals)
    elif not name:
        raise ApiError(400, "Enter the admin's name.")
    password = temporary_password()
    user = await svc.users.create(email=email, password=password, role=role, name=name, contact_id=contact_id,
                                  must_change_password=True, created_by=admin.id)
    await audit(request, "admin.user_invited", actor=admin, target={"userId": user.id, "email": user.email, "name": user.name},
                details={"role": role, "contactId": contact_id, "openDeals": open_deals})
    return {"user": public_user(user), "temporaryPassword": password}

@router.post("/users/{user_id}/convert-to-client")
async def convert(request: Request, user_id: str = Path(pattern=UUID_PATTERN), admin: User = Depends(admin_only), svc: Services = Depends(services)):
    """A guest becomes a client once their Lead is a Contact with an open deal.
    Same login; they see their deals on the next page load."""
    user = await _find_user(svc, user_id)
    if user.role != "guest":
        raise ApiError(400, "Only guest accounts can be converted.")
    contact, open_deals = await _contact_with_active_deal(svc, user.email)
    linked = await svc.users.by_contact(contact["id"])
    if linked and linked.id != user.id:
        raise ApiError(409, "Another portal account is already linked to that Zoho Contact.")
    updated = await svc.users.update(user.id, role="client", zoho_contact_id=contact["id"], name=contact["name"], converted_at=utcnow())
    await audit(request, "admin.user_converted", actor=admin, target={"userId": user.id, "email": user.email, "name": contact["name"]},
                details={"contactId": contact["id"], "leadId": user.zoho_lead_id, "openDeals": len(open_deals)})
    return {"user": public_user(updated)}

@router.post("/users/{user_id}/status")
async def set_status(request: Request, body: dict = Body(...), user_id: str = Path(pattern=UUID_PATTERN),
                     admin: User = Depends(admin_only), svc: Services = Depends(services)):
    user = await _find_user(svc, user_id)
    status = body.get("status")
    if status not in ("active", "disabled"):
        raise ApiError(400, "Status must be active or disabled.")
    if user.id == admin.id:
        raise ApiError(400, "You cannot change the status of your own account.")
    updated = await svc.users.update(user.id, status=status, revoke_sessions=status == "disabled")
    await audit(request, "admin.user_disabled" if status == "disabled" else "admin.user_enabled", actor=admin,
                target={"userId": user.id, "email": user.email, "name": user.name})
    return {"user": public_user(updated)}

@router.post("/users/{user_id}/reset-password")
async def reset_password(request: Request, user_id: str = Path(pattern=UUID_PATTERN), admin: User = Depends(admin_only), svc: Services = Depends(services)):
    user = await _find_user(svc, user_id)
    if user.id == admin.id:
        raise ApiError(400, 'Use "Change password" for your own account.')
    password = temporary_password()
    updated = await svc.users.set_password(user.id, password, must_change_password=True)
    await audit(request, "admin.password_reset", actor=admin, target={"userId": user.id, "email": user.email, "name": user.name})
    return {"user": public_user(updated), "temporaryPassword": password}

# ---- Data protection --------------------------------------------------------------------------

@router.get("/users/{user_id}/export")
async def export_user(request: Request, user_id: str = Path(pattern=UUID_PATTERN), admin: User = Depends(admin_only), svc: Services = Depends(services)):
    """Subject access request: everything the portal itself holds about a person.
    Their deals, leads and messages live in Zoho and are exported from Zoho."""
    user = await _find_user(svc, user_id)
    data = {
        "exportedAt": datetime.now(timezone.utc).isoformat(), "exportedBy": admin.email,
        "account": public_user(user), "consents": await svc.consents.for_user(user.id),
        "activity": (await svc.activity.query(user_id=user.id, limit=100000))["items"],
        "note": "Deals, Leads, Notes and other CRM records for this person are held in Zoho CRM and must be exported there.",
    }
    await audit(request, "admin.user_data_exported", actor=admin, target={"userId": user.id})
    return Response(json.dumps(data, indent=2), media_type="application/json",
                    headers={"Content-Disposition": f'attachment; filename="user-data-{user.id}.json"'})

@router.post("/users/{user_id}/erase")
async def erase_user(request: Request, body: dict = Body(...), user_id: str = Path(pattern=UUID_PATTERN),
                     admin: User = Depends(admin_only), svc: Services = Depends(services)):
    """Right to erasure: removes the person's details from the portal and the
    activity log (the log's integrity chain is preserved)."""
    user = await _find_user(svc, user_id)
    if user.id == admin.id:
        raise ApiError(400, "You cannot erase your own account.")
    if body.get("confirm") != user.email:
        raise ApiError(400, "Type the user's email address to confirm erasure.")
    redacted = await svc.activity.redact_user(user.id)
    await svc.users.erase(user.id)
    # Logged without the person's details.
    await audit(request, "admin.user_erased", actor=admin, target={"userId": user.id}, details={"eventsRedacted": redacted, "role": user.role})
    return {"ok": True, "eventsRedacted": redacted}

# ---- Referrals --------------------------------------------------------------------------------

@router.get("/referrals")
async def all_referrals(admin: User = Depends(admin_only), svc: Services = Depends(services)):
    by_contact = {u.zoho_contact_id: u for u in await svc.users.all() if u.zoho_contact_id}
    out = []
    for r in await svc.crm.list_all_referrals():
        referrer = r.get("referrer")
        user = by_contact.get(referrer["contactId"]) if referrer else None
        out.append({**r, "progress": referral_progress(r.get("leadStatus")),
                    "referrer": {**referrer, "name": referrer.get("name") or getattr(user, "name", None), "userId": getattr(user, "id", None)} if referrer else None})
    return {"leadSource": svc.settings.crm.referral.lead_source, "referrals": out}

# ---- Zoho integration & security ----------------------------------------------------------------

@router.get("/integration")
async def integration(admin: User = Depends(admin_only), svc: Services = Depends(services)):
    catalog = field_catalog(svc.settings)
    connection, checks = await asyncio.gather(svc.crm.test_connection(), svc.crm.check_fields(catalog))
    status = {f"{m['module']}.{f['apiName']}": f["status"] for m in checks for f in m["fields"]}
    errors = {m["module"]: m.get("error") for m in checks}
    s = svc.settings
    return {
        "mode": s.zoho_mode,
        "crm": {**connection, "apiDomain": s.zoho.api_domain if s.zoho_mode == "live" else None, "apiVersion": s.zoho.api_version},
        "mcp": {"configured": svc.mcp is not None, "usedByAi": getattr(svc.ai, "source", None) == "Zoho MCP"},
        "ai": {"enabled": svc.ai is not None, "model": s.ai.model if svc.ai else None, "crmAccess": getattr(svc.ai, "source", None)},
        "modules": [{**m, "error": errors.get(m["module"]),
                     "fields": [{**f, "status": status.get(f"{m['module']}.{f['apiName']}", "unknown")} for f in m["fields"]]} for m in catalog],
    }

@router.post("/integration/test-mcp")
async def test_mcp(request: Request, admin: User = Depends(admin_only), svc: Services = Depends(services)):
    if not svc.mcp:
        raise ApiError(400, "Zoho MCP is not configured. Set ZOHO_MCP_URL (with ZOHO_MODE=live).")
    try:
        tools = await svc.mcp.list_tools()
    except Exception as err:  # noqa: BLE001
        await audit(request, "admin.integration_tested", actor=admin, details={"target": "Zoho MCP", "ok": False})
        return {"ok": False, "error": str(err)}
    await audit(request, "admin.integration_tested", actor=admin, details={"target": "Zoho MCP", "ok": True, "tools": len(tools)})
    return {"ok": True, "tools": [t.name for t in tools]}

@router.get("/security")
async def security(admin: User = Depends(admin_only), svc: Services = Depends(services)):
    s, sec = svc.settings, svc.settings.security
    return {
        "emailOtp": sec.email_otp, "mailProvider": s.mail.provider, "otpTtlMinutes": sec.otp_ttl_minutes, "otpMaxAttempts": sec.otp_max_attempts,
        "sessionIdleMinutes": sec.session_idle_minutes, "sessionMaxHours": sec.session_max_hours,
        "requestTimeoutSeconds": sec.request_timeout_seconds, "maxBodyKb": sec.max_body_bytes // 1024,
        "activityRetentionDays": sec.activity_retention_days, "privacyPolicyVersion": sec.privacy_policy_version,
        "privacyContactEmail": sec.privacy_contact_email, "production": s.is_production,
        "database": s.database_url.split(":", 1)[0].split("+")[0], "auditEvents": await svc.activity.count(),
    }

@router.post("/security/verify-audit-log")
async def verify_audit_log(request: Request, admin: User = Depends(admin_only), svc: Services = Depends(services)):
    result = await svc.activity.verify_chain()
    await audit(request, "admin.audit_log_verified", actor=admin, details={"ok": result["ok"], "checked": result["checked"]})
    return result
