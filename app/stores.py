"""Data access: users, consents, one-time codes and the audit trail."""

from __future__ import annotations

import asyncio
import hashlib
import json
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import String, cast, delete, func, or_, select, update

from .config import Settings
from .db import ActivityEvent, Consent, Database, OtpChallenge, User, new_id, utcnow
from .security.otp import code_matches, generate_code, hash_code
from .security.passwords import hash_password

ROLES = ("admin", "client", "guest")


def as_utc(value: datetime | None) -> datetime | None:
    """SQLite hands back naive datetimes; everything is stored in UTC."""
    if value is None:
        return None
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def iso(value: datetime | None) -> str | None:
    value = as_utc(value)
    return value.isoformat().replace("+00:00", "Z") if value else None


def public_user(user: User | None) -> dict | None:
    """The account fields that are safe to send to a browser (admins only see these)."""
    if not user:
        return None
    return {
        "id": user.id, "email": user.email, "role": user.role, "status": user.status, "name": user.name, "phone": user.phone,
        "contactId": user.zoho_contact_id, "leadId": user.zoho_lead_id, "mustChangePassword": user.must_change_password,
        "emailVerifiedAt": iso(user.email_verified_at), "lastLoginAt": iso(user.last_login_at), "convertedAt": iso(user.converted_at),
        "createdAt": iso(user.created_at), "createdBy": user.created_by,
    }


# ---- Users ---------------------------------------------------------------------

class UserStore:
    def __init__(self, db: Database):
        self.db = db

    async def by_email(self, email: str) -> User | None:
        async with self.db.session() as s:
            return await s.scalar(select(User).where(User.email == email.strip().lower()))

    async def by_id(self, user_id: str) -> User | None:
        async with self.db.session() as s:
            return await s.get(User, user_id)

    async def by_contact(self, contact_id: str) -> User | None:
        async with self.db.session() as s:
            return await s.scalar(select(User).where(User.zoho_contact_id == contact_id))

    async def all(self) -> list[User]:
        async with self.db.session() as s:
            return list(await s.scalars(select(User).where(User.status != "erased").order_by(User.created_at)))

    async def create(self, *, email: str, password: str | None = None, password_hash: str | None = None, role: str = "client",
                     name: str | None = None, phone: str | None = None, contact_id: str | None = None, lead_id: str | None = None,
                     must_change_password: bool = False, created_by: str | None = None, email_verified: bool = False) -> User:
        if role not in ROLES:
            raise ValueError(f"Unknown role: {role}")
        if role == "client" and not contact_id:
            raise ValueError("A client account must be linked to a Zoho Contact.")
        user = User(
            email=email.strip().lower(), password_hash=password_hash or await hash_password(password or ""), role=role, name=name,
            phone=phone, zoho_contact_id=contact_id, zoho_lead_id=lead_id, must_change_password=must_change_password,
            created_by=created_by, email_verified_at=utcnow() if email_verified else None,
        )
        async with self.db.session() as s, s.begin():
            s.add(user)
        return user

    async def update(self, user_id: str, *, revoke_sessions: bool = False, **changes: Any) -> User | None:
        """Bumping the session version signs the user out everywhere."""
        async with self.db.session() as s, s.begin():
            user = await s.get(User, user_id)
            if not user:
                return None
            for key, value in changes.items():
                setattr(user, key, value)
            if revoke_sessions:
                user.session_version += 1
        return user

    async def set_password(self, user_id: str, password: str, *, must_change_password: bool = False) -> User | None:
        return await self.update(user_id, password_hash=await hash_password(password), must_change_password=must_change_password, revoke_sessions=True)

    async def erase(self, user_id: str) -> User | None:
        """Right to erasure: remove personal data from the account and sign it out.
        The row is kept (anonymised) so audit entries still resolve."""
        return await self.update(user_id, revoke_sessions=True, email=f"erased-{user_id}@invalid", name=None, phone=None,
                                 password_hash="erased", status="erased", zoho_contact_id=None)


# ---- Consents --------------------------------------------------------------------

class ConsentStore:
    def __init__(self, db: Database):
        self.db = db

    async def grant(self, user_id: str, kinds: list[str], *, policy_version: str, ip: str | None, user_agent: str | None) -> None:
        async with self.db.session() as s, s.begin():
            for kind in kinds:
                s.add(Consent(user_id=user_id, kind=kind, policy_version=policy_version, ip=ip, user_agent=(user_agent or "")[:200]))

    async def for_user(self, user_id: str) -> list[dict]:
        async with self.db.session() as s:
            rows = await s.scalars(select(Consent).where(Consent.user_id == user_id).order_by(Consent.granted_at))
            return [{"kind": c.kind, "policyVersion": c.policy_version, "grantedAt": iso(c.granted_at), "withdrawnAt": iso(c.withdrawn_at)} for c in rows]


# ---- One-time codes ----------------------------------------------------------------

class OtpError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


class OtpStore:
    def __init__(self, db: Database, settings: Settings):
        self.db = db
        self.settings = settings

    @property
    def _cfg(self):
        return self.settings.security

    async def create(self, *, purpose: str, email: str, user_id: str | None = None, payload: dict | None = None, ip: str | None = None) -> tuple[OtpChallenge, str]:
        challenge = OtpChallenge(id=new_id(), purpose=purpose, email=email, user_id=user_id, payload=payload, ip=ip,
                                 code_hash="", expires_at=utcnow() + timedelta(minutes=self._cfg.otp_ttl_minutes))
        code = generate_code()
        challenge.code_hash = hash_code(code, challenge_id=challenge.id, secret=self.settings.session_secret)
        async with self.db.session() as s, s.begin():
            # A new code replaces any earlier unused one for the same purpose and email.
            await s.execute(update(OtpChallenge).where(OtpChallenge.email == email, OtpChallenge.purpose == purpose,
                                                       OtpChallenge.consumed_at.is_(None)).values(consumed_at=utcnow()))
            s.add(challenge)
        return challenge, code

    async def verify(self, challenge_id: str, code: str, *, purpose: str) -> OtpChallenge:
        error: OtpError | None = None
        async with self.db.session() as s, s.begin():
            challenge = await s.get(OtpChallenge, challenge_id, with_for_update=True)
            if not challenge or challenge.purpose != purpose or challenge.consumed_at:
                raise OtpError("This code is no longer valid. Please start again.", 410)
            if as_utc(challenge.expires_at) < utcnow():
                raise OtpError("This code has expired. Please request a new one.", 410)
            if challenge.attempts >= self._cfg.otp_max_attempts:
                raise OtpError("Too many incorrect codes. Please start again.", 429)
            if code_matches(str(code).strip(), challenge_id=challenge.id, secret=self.settings.session_secret, expected_hash=challenge.code_hash):
                challenge.consumed_at = utcnow()
            else:
                # Counted and committed before the error is raised, so guesses are really limited.
                challenge.attempts += 1
                left = self._cfg.otp_max_attempts - challenge.attempts
                error = OtpError(f"That code is incorrect. {left} attempt{'s' if left != 1 else ''} left." if left
                                 else "Too many incorrect codes. Please start again.", 400 if left else 429)
        if error:
            raise error
        return challenge

    async def resend(self, challenge_id: str) -> tuple[OtpChallenge, str]:
        async with self.db.session() as s, s.begin():
            challenge = await s.get(OtpChallenge, challenge_id, with_for_update=True)
            if not challenge or challenge.consumed_at or challenge.attempts >= self._cfg.otp_max_attempts:
                raise OtpError("This code is no longer valid. Please start again.", 410)
            wait = self._cfg.otp_resend_cooldown_seconds - (utcnow() - as_utc(challenge.last_sent_at)).total_seconds()
            if wait > 0:
                raise OtpError(f"Please wait {int(wait) + 1} seconds before requesting another code.", 429)
            if challenge.resends >= self._cfg.otp_max_resends:
                raise OtpError("You've requested the maximum number of codes. Please start again.", 429)
            code = generate_code()
            challenge.code_hash = hash_code(code, challenge_id=challenge.id, secret=self.settings.session_secret)
            challenge.resends += 1
            challenge.attempts = 0
            challenge.last_sent_at = utcnow()
            challenge.expires_at = utcnow() + timedelta(minutes=self._cfg.otp_ttl_minutes)
            return challenge, code

    async def purge(self) -> int:
        """Codes are only kept for a day."""
        async with self.db.session() as s, s.begin():
            result = await s.execute(delete(OtpChallenge).where(OtpChallenge.created_at < utcnow() - timedelta(days=1)))
            return result.rowcount or 0


# ---- Audit trail -------------------------------------------------------------------

def _canonical(e: ActivityEvent) -> str:
    return json.dumps({
        "id": e.id, "at": iso(e.at), "action": e.action, "actor": [e.actor_user_id, e.actor_email, e.actor_name, e.actor_role],
        "target": e.target, "details": e.details, "ip": e.ip, "ua": e.user_agent,
    }, sort_keys=True, separators=(",", ":"), default=str)


def _sha(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def event_dict(e: ActivityEvent) -> dict:
    return {
        "id": e.id, "at": iso(e.at), "action": e.action,
        "actor": {"id": e.actor_user_id, "email": e.actor_email, "name": e.actor_name, "role": e.actor_role} if e.actor_user_id else None,
        "target": e.target, "details": e.details or {}, "ip": e.ip, "userAgent": e.user_agent, "redacted": e.redacted_at is not None,
    }


class ActivityLog:
    """Append-only, hash-chained audit trail. Admins can read it; nobody can edit it
    through the portal."""

    def __init__(self, db: Database):
        self.db = db
        self._lock = asyncio.Lock()  # one writer at a time keeps the chain linear

    async def record(self, *, action: str, actor: User | None = None, target: dict | None = None, details: dict | None = None,
                     ip: str | None = None, user_agent: str | None = None, at: datetime | None = None) -> ActivityEvent:
        event = ActivityEvent(
            id=new_id(), at=(at or utcnow()).replace(microsecond=0), action=action,
            actor_user_id=actor.id if actor else None, actor_email=actor.email if actor else None,
            actor_name=actor.name if actor else None, actor_role=actor.role if actor else None,
            target=target, details=details or {}, ip=ip, user_agent=(user_agent or None) and user_agent[:200],
        )
        async with self._lock, self.db.session() as s, s.begin():
            prev = await s.scalar(select(ActivityEvent.hash).order_by(ActivityEvent.seq.desc()).limit(1))
            event.content_hash = _sha(_canonical(event))
            event.prev_hash = prev
            event.hash = _sha(f"{prev or ''}:{event.content_hash}")
            s.add(event)
        return event

    def _filtered(self, *, user_id: str | None = None, action: str | None = None, start: datetime | None = None,
                  end: datetime | None = None, q: str | None = None):
        stmt = select(ActivityEvent)
        if user_id:
            stmt = stmt.where(or_(ActivityEvent.actor_user_id == user_id, cast(ActivityEvent.target, String).contains(user_id)))
        if action:
            stmt = stmt.where(or_(ActivityEvent.action == action, ActivityEvent.action.startswith(f"{action}.")))
        if start:
            stmt = stmt.where(ActivityEvent.at >= start)
        if end:
            stmt = stmt.where(ActivityEvent.at < end)
        if q:
            needle = f"%{q.lower()}%"
            stmt = stmt.where(or_(func.lower(ActivityEvent.actor_email).like(needle), func.lower(ActivityEvent.actor_name).like(needle),
                                  func.lower(cast(ActivityEvent.target, String)).like(needle), func.lower(cast(ActivityEvent.details, String)).like(needle)))
        return stmt

    async def query(self, *, before: str | None = None, limit: int = 50, **filters: Any) -> dict:
        async with self.db.session() as s:
            stmt = self._filtered(**filters)
            if before:
                seq = await s.scalar(select(ActivityEvent.seq).where(ActivityEvent.id == before))
                if seq is not None:
                    stmt = stmt.where(ActivityEvent.seq < seq)
            rows = list(await s.scalars(stmt.order_by(ActivityEvent.seq.desc()).limit(limit)))
        return {"items": [event_dict(e) for e in rows], "next": rows[-1].id if len(rows) == limit else None}

    async def since(self, seconds: float) -> list[dict]:
        cutoff = utcnow() - timedelta(seconds=seconds)
        async with self.db.session() as s:
            rows = await s.scalars(select(ActivityEvent).where(ActivityEvent.at >= cutoff).order_by(ActivityEvent.seq.desc()))
            return [event_dict(e) for e in rows]

    async def count(self) -> int:
        async with self.db.session() as s:
            return await s.scalar(select(func.count()).select_from(ActivityEvent)) or 0

    async def verify_chain(self) -> dict:
        """Recomputes every hash. Any edited, inserted or deleted row breaks it."""
        prev: str | None = None
        checked = 0
        async with self.db.session() as s:
            result = await s.stream_scalars(select(ActivityEvent).order_by(ActivityEvent.seq))
            async for e in result:
                if checked == 0:
                    prev = e.prev_hash  # after retention pruning the chain starts at the oldest kept row
                if e.prev_hash != prev:
                    return {"ok": False, "checked": checked, "brokenAt": e.id, "reason": "A row is missing or out of order."}
                if e.redacted_at is None and _sha(_canonical(e)) != e.content_hash:
                    return {"ok": False, "checked": checked, "brokenAt": e.id, "reason": "A row's content was changed."}
                if _sha(f"{prev or ''}:{e.content_hash}") != e.hash:
                    return {"ok": False, "checked": checked, "brokenAt": e.id, "reason": "A row's hash was changed."}
                prev = e.hash
                checked += 1
        return {"ok": True, "checked": checked}

    async def redact_user(self, user_id: str) -> int:
        """Erasure: blank a person's details in their events. Hashes are kept, so the
        chain still verifies; the redaction is itself logged by the caller."""
        async with self._lock, self.db.session() as s, s.begin():
            result = await s.execute(update(ActivityEvent).where(ActivityEvent.actor_user_id == user_id).values(
                actor_email=None, actor_name=None, ip=None, user_agent=None, details={}, redacted_at=utcnow()))
            return result.rowcount or 0

    async def prune(self, retention_days: int) -> int:
        """Retention: events older than the retention period are deleted. The chain
        then starts at the oldest kept row (verification starts from its prev_hash)."""
        cutoff = utcnow() - timedelta(days=retention_days)
        async with self._lock, self.db.session() as s, s.begin():
            result = await s.execute(delete(ActivityEvent).where(ActivityEvent.at < cutoff))
            return result.rowcount or 0
