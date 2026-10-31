"""Database models and engine.

The portal keeps only what Zoho CRM does not: login accounts, consent records,
one-time sign-in codes and the audit trail. Deals, contacts, listings, leads and
messages stay in Zoho. SQLite is used for local development and tests;
PostgreSQL in production (see docs/DATABASE.md and db/schema.sql).
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import JSON, BigInteger, Boolean, CheckConstraint, DateTime, ForeignKey, Index, Integer, String, event
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column
from sqlalchemy.pool import StaticPool

JsonType = JSON().with_variant(JSONB(), "postgresql")
# SQLite only auto-increments INTEGER primary keys; PostgreSQL gets a BIGINT identity.
SeqType = BigInteger().with_variant(Integer(), "sqlite")


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def new_id() -> str:
    return str(uuid.uuid4())


class Base(DeclarativeBase):
    pass


class User(Base):
    """A portal login. Roles: admin (brokerage staff), client (linked to a Zoho
    Contact with an active deal), guest (signed up; a Zoho Lead)."""

    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    email: Mapped[str] = mapped_column(String(254), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    role: Mapped[str] = mapped_column(String(16), index=True)
    status: Mapped[str] = mapped_column(String(16), default="active")  # active | disabled | erased
    name: Mapped[str | None] = mapped_column(String(120))
    phone: Mapped[str | None] = mapped_column(String(40))
    zoho_contact_id: Mapped[str | None] = mapped_column(String(40), unique=True)
    zoho_lead_id: Mapped[str | None] = mapped_column(String(40))
    must_change_password: Mapped[bool] = mapped_column(Boolean, default=False)
    # Bumped to sign the user out everywhere (password change/reset, disable).
    session_version: Mapped[int] = mapped_column(Integer, default=1)
    email_verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    converted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_by: Mapped[str | None] = mapped_column(String(36), ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)

    __table_args__ = (
        CheckConstraint("role IN ('admin', 'client', 'guest')", name="ck_users_role"),
        CheckConstraint("status IN ('active', 'disabled', 'erased')", name="ck_users_status"),
        CheckConstraint("role <> 'client' OR zoho_contact_id IS NOT NULL OR status = 'erased'", name="ck_users_client_contact"),
    )


class Consent(Base):
    """What a user agreed to, when, and under which privacy policy version."""

    __tablename__ = "consents"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String(40))  # privacy_policy | contact_about_properties
    policy_version: Mapped[str] = mapped_column(String(40))
    granted_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    withdrawn_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    ip: Mapped[str | None] = mapped_column(String(64))
    user_agent: Mapped[str | None] = mapped_column(String(200))


class OtpChallenge(Base):
    """A one-time code emailed for sign-in, sign-up verification or password reset.
    Only a hash of the code is stored."""

    __tablename__ = "otp_challenges"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    purpose: Mapped[str] = mapped_column(String(20))  # login | signup | password_reset
    email: Mapped[str] = mapped_column(String(254), index=True)
    user_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("users.id", ondelete="CASCADE"))
    code_hash: Mapped[str] = mapped_column(String(128))
    # Pending sign-up details (name, budget, password hash...) until the email is verified.
    payload: Mapped[dict[str, Any] | None] = mapped_column(JsonType)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    resends: Mapped[int] = mapped_column(Integer, default=0)
    last_sent_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    ip: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    __table_args__ = (CheckConstraint("purpose IN ('login', 'signup', 'password_reset')", name="ck_otp_purpose"),)


class ActivityEvent(Base):
    """Append-only audit trail of sign-ins, searches, views, messages, referrals
    and admin actions. Each row is hash-chained to the previous one, so any edit
    or deletion shows up in verification."""

    __tablename__ = "activity_events"

    seq: Mapped[int] = mapped_column(SeqType, primary_key=True, autoincrement=True)
    id: Mapped[str] = mapped_column(String(36), unique=True, default=new_id)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    action: Mapped[str] = mapped_column(String(60), index=True)
    actor_user_id: Mapped[str | None] = mapped_column(String(36), index=True)
    actor_email: Mapped[str | None] = mapped_column(String(254))
    actor_name: Mapped[str | None] = mapped_column(String(120))
    actor_role: Mapped[str | None] = mapped_column(String(16))
    target: Mapped[dict[str, Any] | None] = mapped_column(JsonType)
    details: Mapped[dict[str, Any] | None] = mapped_column(JsonType)
    ip: Mapped[str | None] = mapped_column(String(64))
    user_agent: Mapped[str | None] = mapped_column(String(200))
    # Tamper evidence: content_hash covers the row as written; hash chains it to
    # the previous row. Erasing personal data (redacted_at) keeps both hashes, so
    # the chain still verifies while the content is blanked.
    content_hash: Mapped[str] = mapped_column(String(64))
    prev_hash: Mapped[str | None] = mapped_column(String(64))
    hash: Mapped[str] = mapped_column(String(64))
    redacted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (Index("ix_activity_target_user", "actor_user_id", "at"),)


class Database:
    def __init__(self, url: str):
        self.url = url
        kwargs: dict[str, Any] = {}
        if url.startswith("sqlite"):
            kwargs["connect_args"] = {"check_same_thread": False}
            if ":memory:" in url:
                kwargs["poolclass"] = StaticPool  # one shared in-memory database (tests)
        self.engine: AsyncEngine = create_async_engine(url, **kwargs)
        if url.startswith("sqlite"):
            event.listen(self.engine.sync_engine, "connect", _sqlite_pragmas)
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)

    async def create_all(self) -> None:
        async with self.engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)

    def session(self) -> AsyncSession:
        return self.sessions()

    async def dispose(self) -> None:
        await self.engine.dispose()


def _sqlite_pragmas(dbapi_conn: Any, _record: Any) -> None:
    cursor = dbapi_conn.cursor()
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.execute("PRAGMA busy_timeout=5000")
    cursor.close()
