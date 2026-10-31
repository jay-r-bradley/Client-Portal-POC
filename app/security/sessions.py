"""Stateless sessions: an HMAC-signed token in an HttpOnly cookie.

The token carries the user id, their session version (bumped to sign them out
everywhere), when they authenticated, and an expiry that slides forward with
activity: idle sessions end after `idle_minutes`, every session after `max_hours`.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from dataclasses import dataclass

COOKIE_NAME = "portal_session"


@dataclass
class SessionClaims:
    uid: str
    sv: int
    auth_time: float
    exp: float


def _sign(body: str, secret: str) -> str:
    digest = hmac.new(secret.encode(), body.encode(), hashlib.sha256).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode()


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def issue_token(uid: str, sv: int, *, secret: str, idle_minutes: int, max_hours: int, auth_time: float | None = None) -> tuple[str, float]:
    now = time.time()
    auth_time = auth_time or now
    exp = min(now + idle_minutes * 60, auth_time + max_hours * 3600)
    body = _b64(json.dumps({"uid": uid, "sv": sv, "at": auth_time, "exp": exp}, separators=(",", ":")).encode())
    return f"{body}.{_sign(body, secret)}", exp


def read_token(token: str | None, *, secret: str) -> SessionClaims | None:
    if not token or token.count(".") != 1:
        return None
    body, signature = token.split(".")
    if not hmac.compare_digest(signature, _sign(body, secret)):
        return None
    try:
        data = json.loads(_unb64(body))
        claims = SessionClaims(uid=str(data["uid"]), sv=int(data["sv"]), auth_time=float(data["at"]), exp=float(data["exp"]))
    except (ValueError, KeyError, TypeError):
        return None
    return claims if claims.exp > time.time() else None


def cookie_options(*, secure: bool, max_age: int | None) -> dict:
    return {"httponly": True, "samesite": "lax", "secure": secure, "path": "/", **({"max_age": max_age} if max_age is not None else {})}
