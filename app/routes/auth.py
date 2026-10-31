"""Sign-in (password + emailed one-time code), guest sign-up (email verified by
code before the account and Zoho Lead exist), password reset by code, sign-out
and password change."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Body, Depends, Request, Response

from ..db import User, utcnow
from ..guests import SignupError, normalize_signup, signup_description
from ..mailer import MailError, otp_email
from ..security.otp import mask_email
from ..security.passwords import DUMMY_HASH, hash_password, password_problem, verify_password
from ..stores import OtpError
from ..web import ApiError, RequireUser, Services, audit, clear_session_cookie, client_ip, services, set_session_cookie, text, user_agent, valid_email

log = logging.getLogger("portal.auth")
router = APIRouter(prefix="/api/auth")
any_user_pending_ok = RequireUser(allow_pending_password=True)


def _user_summary(user: User) -> dict:
    return {"name": user.name, "email": user.email, "role": user.role, "mustChangePassword": user.must_change_password}


async def _send_code(svc: Services, *, email: str, code: str, purpose: str) -> None:
    try:
        await svc.mailer.send(otp_email(to=email, code=code, purpose=purpose, brand=svc.settings.brand_name,
                                        minutes=svc.settings.security.otp_ttl_minutes))
    except MailError as err:
        log.error("Could not send %s code: %s", purpose, err)
        raise ApiError(502, "We couldn't send your code right now. Please try again shortly.") from err


def _challenge_response(svc: Services, challenge_id: str, email: str, code: str | None) -> dict:
    out: dict[str, Any] = {"otpRequired": True, "challengeId": challenge_id, "sentTo": mask_email(email),
                           "expiresInMinutes": svc.settings.security.otp_ttl_minutes}
    if svc.settings.show_dev_codes and code:
        out["devCode"] = code  # local demo only: never in production (no console mailer there)
    return out


def _otp_error(err: OtpError) -> ApiError:
    return ApiError(err.status, str(err))


async def _complete_login(request: Request, response: Response, svc: Services, user: User, *, method: str) -> dict:
    await svc.users.update(user.id, last_login_at=utcnow(), email_verified_at=user.email_verified_at or (utcnow() if method != "password" else None))
    await audit(request, "auth.login", actor=user, details={"method": method})
    set_session_cookie(response, svc, user)
    return {"otpRequired": False, "user": _user_summary(user)}


@router.post("/login")
async def login(request: Request, response: Response, body: dict = Body(...), svc: Services = Depends(services)):
    email, password = text(body.get("email"), 254).lower(), body.get("password")
    if not email or not isinstance(password, str) or not password:
        raise ApiError(400, "Email and password are required.")
    throttle_key = f"{client_ip(request)}|{email}"
    if not svc.login_failures.allowed(throttle_key):
        raise ApiError(429, "Too many sign-in attempts. Please try again later.",
                       headers={"Retry-After": str(svc.login_failures.retry_after(throttle_key))})

    user = await svc.users.by_email(email)
    valid = await verify_password(password[:200], user.password_hash if user else DUMMY_HASH)
    if not user or not valid or user.status == "erased":
        svc.login_failures.hit(throttle_key)
        await audit(request, "auth.login_failed", target={"userId": user.id, "email": user.email} if user else None, details={"email": email})
        raise ApiError(401, "Incorrect email or password.")
    svc.login_failures.reset(throttle_key)

    if user.status != "active":
        await audit(request, "auth.login_blocked", actor=user, details={"reason": "Account disabled"})
        raise ApiError(403, "Your portal access has been disabled. Please contact your agent.")
    # For clients, the Zoho Contact is the source of truth: if it has been deleted, so is access.
    if user.role == "client":
        contact = await svc.crm.get_contact(user.zoho_contact_id)
        if not contact:
            await audit(request, "auth.login_blocked", actor=user, details={"reason": "Zoho Contact not found"})
            raise ApiError(403, "Your portal access is no longer active. Please contact your agent.")
        if contact.get("name") and contact["name"] != user.name:
            await svc.users.update(user.id, name=contact["name"])

    if not svc.settings.security.email_otp:
        return await _complete_login(request, response, svc, user, method="password")
    challenge, code = await svc.otps.create(purpose="login", email=user.email, user_id=user.id, ip=client_ip(request))
    await _send_code(svc, email=user.email, code=code, purpose="login")
    await audit(request, "auth.otp_sent", actor=user, details={"purpose": "login"})
    return _challenge_response(svc, challenge.id, user.email, code)


@router.post("/login/verify")
async def verify_login(request: Request, response: Response, body: dict = Body(...), svc: Services = Depends(services)):
    challenge_id, code = text(body.get("challengeId"), 64), text(body.get("code"), 12)
    try:
        challenge = await svc.otps.verify(challenge_id, code, purpose="login")
    except OtpError as err:
        await audit(request, "auth.otp_failed", details={"purpose": "login", "reason": str(err)[:80]})
        raise _otp_error(err) from None
    user = await svc.users.by_id(challenge.user_id)
    if not user or user.status != "active":
        raise ApiError(403, "Your portal access is not active.")
    return await _complete_login(request, response, svc, user, method="password+email_code")


@router.post("/otp/resend")
async def resend_code(request: Request, body: dict = Body(...), svc: Services = Depends(services)):
    try:
        challenge, code = await svc.otps.resend(text(body.get("challengeId"), 64))
    except OtpError as err:
        raise _otp_error(err) from None
    if challenge.purpose != "password_reset" or challenge.user_id:
        await _send_code(svc, email=challenge.email, code=code, purpose=challenge.purpose)
    return _challenge_response(svc, challenge.id, challenge.email, code if (challenge.purpose != "password_reset" or challenge.user_id) else None)


# ---- Guest sign-up ---------------------------------------------------------------------

@router.post("/signup")
async def signup(request: Request, body: dict = Body(...), svc: Services = Depends(services)):
    ip = client_ip(request) or "unknown"
    if not svc.signups.allowed(ip):
        raise ApiError(429, "Too many sign-ups from this network. Please try again later.")
    try:
        guest = normalize_signup(body)
    except SignupError as err:
        raise ApiError(400, str(err)) from None
    problem = password_problem(body.get("password"), guest["email"])
    if problem:
        raise ApiError(400, problem)
    if await svc.users.by_email(guest["email"]):
        raise ApiError(409, "An account with this email already exists. Please sign in instead.")

    # Nothing is created until the email is confirmed; the pending details wait on the challenge.
    payload = {**guest, "passwordHash": await hash_password(body["password"]), "consentAt": utcnow().isoformat(),
               "policyVersion": svc.settings.security.privacy_policy_version}
    challenge, code = await svc.otps.create(purpose="signup", email=guest["email"], payload=payload, ip=ip)
    svc.signups.hit(ip)
    await _send_code(svc, email=guest["email"], code=code, purpose="signup")
    return _challenge_response(svc, challenge.id, guest["email"], code)


@router.post("/signup/verify", status_code=201)
async def verify_signup(request: Request, response: Response, body: dict = Body(...), svc: Services = Depends(services)):
    try:
        challenge = await svc.otps.verify(text(body.get("challengeId"), 64), text(body.get("code"), 12), purpose="signup")
    except OtpError as err:
        raise _otp_error(err) from None
    guest = dict(challenge.payload or {})
    if await svc.users.by_email(guest["email"]):
        raise ApiError(409, "An account with this email already exists. Please sign in instead.")
    try:
        lead = await svc.crm.create_signup_lead({**guest, "description": signup_description(guest, svc.settings)})
    except Exception as err:  # noqa: BLE001
        log.error("Sign-up Lead could not be created in Zoho: %s", err)
        raise ApiError(502, "We could not create your account right now. Please try again shortly.") from err

    user = await svc.users.create(email=guest["email"], password_hash=guest["passwordHash"], role="guest", name=guest["name"],
                                  phone=guest.get("phone"), lead_id=lead["id"], email_verified=True)
    await svc.users.update(user.id, last_login_at=utcnow())
    if svc.sync:
        await svc.sync.link_lead_user(lead["id"], user.id)
    await svc.consents.grant(user.id, ["privacy_policy", "contact_about_properties"], policy_version=guest["policyVersion"],
                             ip=client_ip(request), user_agent=user_agent(request))
    await audit(request, "auth.signed_up", actor=user, target={"leadId": lead["id"]},
                details={"listingType": guest.get("listingType"), "budgetMax": guest.get("budgetMax"), "location": guest.get("location")})
    set_session_cookie(response, svc, user)
    return {
        "user": _user_summary(user),
        # The sign-up answers seed the guest's first property search.
        "initialFilters": {"budgetMax": guest.get("budgetMax"), "locations": [guest["location"]] if guest.get("location") else [],
                           "listingType": guest.get("listingType")},
    }


# ---- Password reset by code ----------------------------------------------------------------

@router.post("/password/forgot")
async def forgot_password(request: Request, body: dict = Body(...), svc: Services = Depends(services)):
    email = valid_email(body.get("email"))
    ip = client_ip(request) or "unknown"
    if not (svc.password_resets.allowed(ip) and svc.password_resets.allowed(email)):
        raise ApiError(429, "Too many reset requests. Please try again later.")
    svc.password_resets.hit(ip)
    svc.password_resets.hit(email)
    user = await svc.users.by_email(email)
    real = bool(user and user.status == "active")
    # The response is the same whether or not the email has an account.
    challenge, code = await svc.otps.create(purpose="password_reset", email=email, user_id=user.id if real else None, ip=ip)
    if real:
        await _send_code(svc, email=email, code=code, purpose="password_reset")
        await audit(request, "auth.otp_sent", actor=user, details={"purpose": "password_reset"})
    return _challenge_response(svc, challenge.id, email, code if real else None)


@router.post("/password/reset")
async def reset_password(request: Request, body: dict = Body(...), svc: Services = Depends(services)):
    try:
        challenge = await svc.otps.verify(text(body.get("challengeId"), 64), text(body.get("code"), 12), purpose="password_reset")
    except OtpError as err:
        raise _otp_error(err) from None
    user = await svc.users.by_id(challenge.user_id) if challenge.user_id else None
    if not user or user.status != "active":
        raise ApiError(400, "That code is incorrect.")
    problem = password_problem(body.get("newPassword"), user.email)
    if problem:
        raise ApiError(400, problem)
    await svc.users.set_password(user.id, body["newPassword"])  # signs out every session
    await svc.users.update(user.id, email_verified_at=user.email_verified_at or utcnow())
    await audit(request, "auth.password_reset", actor=user)
    return {"ok": True}


# ---- Session ----------------------------------------------------------------------------------

@router.post("/logout")
async def logout(request: Request, response: Response, svc: Services = Depends(services)):
    try:
        user = await any_user_pending_ok(request, response)
        await audit(request, "auth.logout", actor=user, details={"reason": text(request.query_params.get("reason"), 20) or "user"})
    except ApiError:
        pass
    clear_session_cookie(response, svc)
    return {"ok": True}


@router.get("/session")
async def session(user: User = Depends(any_user_pending_ok), svc: Services = Depends(services)):
    """Used by the browser's "Stay signed in" button: any authenticated call extends the idle timer."""
    return {"ok": True, "idleMinutes": svc.settings.security.session_idle_minutes}


@router.post("/change-password")
async def change_password(request: Request, response: Response, body: dict = Body(...),
                          user: User = Depends(any_user_pending_ok), svc: Services = Depends(services)):
    current, new = body.get("currentPassword"), body.get("newPassword")
    if not isinstance(current, str) or not await verify_password(current[:200], user.password_hash):
        raise ApiError(400, "Your current password is incorrect.")
    problem = password_problem(new, user.email)
    if problem:
        raise ApiError(400, problem)
    if new == current:
        raise ApiError(400, "Choose a password different from your current one.")
    updated = await svc.users.set_password(user.id, new)  # signs out other sessions
    await audit(request, "auth.password_changed", actor=updated)
    set_session_cookie(response, svc, updated)
    return {"ok": True}


@router.get("/me")
async def me(user: User = Depends(any_user_pending_ok), svc: Services = Depends(services)):
    base = {**_user_summary(user), "id": user.id}
    if user.role != "client":
        return {"user": base, "agent": None}
    contact = await svc.crm.get_contact(user.zoho_contact_id)
    if not contact:
        raise ApiError(401, "Please sign in.")
    agent = await svc.crm.get_agent(user.zoho_contact_id)
    return {"user": {**base, "name": contact["name"], "firstName": contact.get("firstName"), "phone": contact.get("phone")}, "agent": agent}
