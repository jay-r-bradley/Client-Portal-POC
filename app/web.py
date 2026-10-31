"""Shared web plumbing: the services container, errors, the signed-in-user
dependency (with sliding idle timeout) and input validation helpers."""

from __future__ import annotations

import re
import time
from dataclasses import dataclass, field
from typing import Any

from fastapi import HTTPException, Request, Response

from .config import Settings
from .db import Database, User
from .guests import LeadCriteriaSync
from .mailer import Mailer
from .security.ratelimit import SlidingWindowLimiter
from .security.sessions import COOKIE_NAME, cookie_options, issue_token, read_token
from .stores import ActivityLog, ConsentStore, OtpStore, UserStore

# Identifiers accepted in URLs: Zoho record ids, portal UUIDs, sample-data ids.
ID_PATTERN = r"^[A-Za-z0-9_-]{1,64}$"
UUID_PATTERN = r"^[0-9a-fA-F-]{36}$"
DATE_PATTERN = r"^\d{4}-\d{2}-\d{2}$"
EMAIL = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")


class ApiError(HTTPException):
    """An error whose message is safe to show the user."""

    def __init__(self, status: int, message: str, headers: dict[str, str] | None = None):
        super().__init__(status_code=status, detail=message, headers=headers)


@dataclass
class Services:
    settings: Settings
    db: Database
    crm: Any
    mailer: Mailer
    ai: Any = None
    mcp: Any = None
    sync: Any = None  # SyncEngine: keeps the Zoho copy in the database up to date
    users: UserStore = field(init=False)
    consents: ConsentStore = field(init=False)
    otps: OtpStore = field(init=False)
    activity: ActivityLog = field(init=False)
    lead_sync: LeadCriteriaSync = field(init=False)
    # Single-instance rate limits; use a shared store (e.g. Redis) across instances.
    login_failures: SlidingWindowLimiter = field(default_factory=lambda: SlidingWindowLimiter(10, 15 * 60))
    signups: SlidingWindowLimiter = field(default_factory=lambda: SlidingWindowLimiter(5, 3600))
    password_resets: SlidingWindowLimiter = field(default_factory=lambda: SlidingWindowLimiter(5, 3600))
    referrals: SlidingWindowLimiter = field(default_factory=lambda: SlidingWindowLimiter(10, 24 * 3600))

    def __post_init__(self) -> None:
        self.users = UserStore(self.db)
        self.consents = ConsentStore(self.db)
        self.otps = OtpStore(self.db, self.settings)
        self.activity = ActivityLog(self.db)
        self.lead_sync = LeadCriteriaSync(self.crm, self.settings)


def services(request: Request) -> Services:
    return request.app.state.services


def client_ip(request: Request) -> str | None:
    # Behind a proxy, run uvicorn with --proxy-headers so this is the real client address.
    return request.client.host if request.client else None


def user_agent(request: Request) -> str | None:
    return (request.headers.get("user-agent") or "")[:200] or None


async def audit(request: Request, action: str, *, actor: User | None = None, target: dict | None = None, details: dict | None = None) -> None:
    await services(request).activity.record(action=action, actor=actor, target=target, details=details,
                                            ip=client_ip(request), user_agent=user_agent(request))


# ---- Sessions ----------------------------------------------------------------------

def set_session_cookie(response: Response, svc: Services, user: User, *, auth_time: float | None = None) -> None:
    sec = svc.settings.security
    token, exp = issue_token(user.id, user.session_version, secret=svc.settings.session_secret,
                             idle_minutes=sec.session_idle_minutes, max_hours=sec.session_max_hours, auth_time=auth_time)
    response.set_cookie(COOKIE_NAME, token, **cookie_options(secure=svc.settings.is_production, max_age=int(exp - time.time())))


def clear_session_cookie(response: Response, svc: Services) -> None:
    response.delete_cookie(COOKIE_NAME, **cookie_options(secure=svc.settings.is_production, max_age=None))


class RequireUser:
    """Resolves the signed-in user on every request, so disabling an account or
    resetting a password takes effect immediately. Refreshes the session's idle
    expiry on activity (at most once a minute)."""

    def __init__(self, *roles: str, allow_pending_password: bool = False):
        self.roles = roles
        self.allow_pending = allow_pending_password

    async def __call__(self, request: Request, response: Response) -> User:
        svc = services(request)
        claims = read_token(request.cookies.get(COOKIE_NAME), secret=svc.settings.session_secret)
        user = await svc.users.by_id(claims.uid) if claims else None
        if not user or user.status != "active" or claims.sv != user.session_version:
            raise ApiError(401, "Please sign in.")
        if self.roles and user.role not in self.roles:
            raise ApiError(403, "You do not have access to this page.")
        if user.must_change_password and not self.allow_pending:
            raise ApiError(403, "Please set a new password to continue.")
        idle = svc.settings.security.session_idle_minutes * 60
        if claims.exp - time.time() < idle - 60:
            set_session_cookie(response, svc, user, auth_time=claims.auth_time)
        request.state.user = user
        return user


# ---- Input helpers -------------------------------------------------------------------

def text(value: Any, limit: int) -> str:
    return str(value if value is not None else "").strip()[:limit]


def valid_email(value: Any) -> str:
    email = text(value, 254).lower()
    if not EMAIL.match(email):
        raise ApiError(400, "Enter a valid email address.")
    return email
