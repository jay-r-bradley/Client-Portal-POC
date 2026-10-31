"""Database models and engine.

Two groups of tables, all in the private `portal` schema (PostgreSQL / Supabase):

* Portal-owned: logins, consents, one-time codes and the audit trail. Only the
  portal holds these.
* CRM copy (`crm_*`): a synced, read-optimised copy of the Zoho CRM records the
  portal shows (agents, contacts, properties, deals, stages, leads, messages,
  tasks). Zoho stays the source of truth: the portal writes to Zoho first and
  then updates its copy; changes made in Zoho flow back by webhook and a
  periodic catch-up sync. Every crm_* row keeps its Zoho record id, and column
  comments name the Zoho field each column comes from.

SQLite is used for local development and tests; PostgreSQL in production
(see docs/DATABASE.md, docs/DATA_MODEL.md and db/schema.sql).
"""

from __future__ import annotations

import uuid
from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Any

from sqlalchemy import (JSON, BigInteger, Boolean, CheckConstraint, Date, DateTime, ForeignKey, Index, Integer, MetaData,
                        Numeric, String, Text, UniqueConstraint, event)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column
from sqlalchemy.pool import StaticPool

SCHEMA = "portal"
JsonType = JSON().with_variant(JSONB(), "postgresql")
# SQLite only auto-increments INTEGER primary keys; PostgreSQL gets a BIGINT identity.
SeqType = BigInteger().with_variant(Integer(), "sqlite")
Money = Numeric(14, 2)


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def new_id() -> str:
    return str(uuid.uuid4())


class Base(DeclarativeBase):
    # A private schema: Supabase's auto-generated Data API only exposes `public`.
    metadata = MetaData(schema=SCHEMA, naming_convention={
        "pk": "pk_%(table_name)s", "fk": "fk_%(table_name)s_%(column_0_name)s", "uq": "uq_%(table_name)s_%(column_0_name)s",
        "ix": "ix_%(table_name)s_%(column_0_name)s", "ck": "ck_%(table_name)s_%(constraint_name)s",
    })


def fk(target: str, *, ondelete: str = "SET NULL") -> ForeignKey:
    """References inside the CRM copy point at Zoho record ids and are checked at
    commit, so a sync batch can arrive in any order."""
    return ForeignKey(f"{SCHEMA}.{target}", ondelete=ondelete, deferrable=True, initially="DEFERRED")


def zoho(field: str, note: str = "") -> str:
    return f"Zoho: {field}" + (f". {note}" if note else "")


# ============================================================================
# Portal-owned tables
# ============================================================================

class User(Base):
    """A portal login. Roles: admin (brokerage staff), client (linked to a Zoho
    Contact with an active deal), guest (signed up; a Zoho Lead)."""

    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    email: Mapped[str] = mapped_column(String(254), unique=True, index=True, comment="Sign-in email (lower case)")
    password_hash: Mapped[str] = mapped_column(String(255), comment="scrypt hash; never the password")
    role: Mapped[str] = mapped_column(String(16), index=True, comment="admin | client | guest")
    status: Mapped[str] = mapped_column(String(16), default="active", comment="active | disabled | erased")
    name: Mapped[str | None] = mapped_column(String(120))
    phone: Mapped[str | None] = mapped_column(String(40))
    zoho_contact_id: Mapped[str | None] = mapped_column(String(40), unique=True, comment="Clients: their Zoho Contact (crm_contacts.zoho_id)")
    zoho_lead_id: Mapped[str | None] = mapped_column(String(40), comment="Guests: the Zoho Lead created at sign-up (crm_leads.zoho_id)")
    must_change_password: Mapped[bool] = mapped_column(Boolean, default=False)
    # Bumped to sign the user out everywhere (password change/reset, disable).
    session_version: Mapped[int] = mapped_column(Integer, default=1, comment="Bumped to sign the user out everywhere")
    email_verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    converted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_by: Mapped[str | None] = mapped_column(String(36), ForeignKey(f"{SCHEMA}.users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)

    __table_args__ = (
        CheckConstraint("role IN ('admin', 'client', 'guest')", name="role"),
        CheckConstraint("status IN ('active', 'disabled', 'erased')", name="status"),
        CheckConstraint("role <> 'client' OR zoho_contact_id IS NOT NULL OR status = 'erased'", name="client_contact"),
    )


class Consent(Base):
    """What a user agreed to, when, and under which privacy policy version."""

    __tablename__ = "consents"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey(f"{SCHEMA}.users.id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String(40), comment="privacy_policy | contact_about_properties")
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
    purpose: Mapped[str] = mapped_column(String(20), comment="login | signup | password_reset")
    email: Mapped[str] = mapped_column(String(254), index=True)
    user_id: Mapped[str | None] = mapped_column(String(36), ForeignKey(f"{SCHEMA}.users.id", ondelete="CASCADE"))
    code_hash: Mapped[str] = mapped_column(String(128), comment="HMAC of the code; the code itself is never stored")
    # Pending sign-up details (name, budget, password hash...) until the email is verified.
    payload: Mapped[dict[str, Any] | None] = mapped_column(JsonType)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    resends: Mapped[int] = mapped_column(Integer, default=0)
    last_sent_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    ip: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    __table_args__ = (CheckConstraint("purpose IN ('login', 'signup', 'password_reset')", name="purpose"),)


class ActivityEvent(Base):
    """Append-only audit trail of sign-ins, searches, views, messages, referrals
    and admin actions. Each row is hash-chained to the previous one, so any edit
    or deletion shows up in verification."""

    __tablename__ = "activity_events"

    seq: Mapped[int] = mapped_column(SeqType, primary_key=True, autoincrement=True)
    id: Mapped[str] = mapped_column(String(36), unique=True, default=new_id)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    action: Mapped[str] = mapped_column(String(60), index=True, comment="e.g. auth.login, property.viewed, admin.user_invited")
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
    hash: Mapped[str] = mapped_column(String(64), comment="Chains this row to the previous one (tamper evidence)")
    redacted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (Index("ix_activity_events_actor_at", "actor_user_id", "at"),)


# ============================================================================
# CRM copy: synced from Zoho CRM (source of truth)
# ============================================================================

class CrmSynced:
    """Columns every CRM-copy table has."""

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id, comment="Portal surrogate key")
    zoho_id: Mapped[str] = mapped_column(String(40), unique=True, comment="Zoho record id (natural key, used for sync and links)")
    zoho_modified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), comment=zoho("Modified_Time", "drives incremental sync"))
    synced_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, comment="When the portal last refreshed this row")


class CrmAgent(CrmSynced, Base):
    """Brokerage agents: Zoho CRM users who own contacts, deals and leads."""

    __tablename__ = "crm_agents"

    full_name: Mapped[str | None] = mapped_column(String(120), comment=zoho("Users.full_name"))
    email: Mapped[str | None] = mapped_column(String(254), comment=zoho("Users.email"))
    phone: Mapped[str | None] = mapped_column(String(40), comment=zoho("Users.mobile / Users.phone"))
    active: Mapped[bool] = mapped_column(Boolean, default=True, comment=zoho("Users.status"))


class CrmContact(CrmSynced, Base):
    """Clients. A client login links to exactly one contact."""

    __tablename__ = "crm_contacts"

    first_name: Mapped[str | None] = mapped_column(String(80), comment=zoho("Contacts.First_Name"))
    last_name: Mapped[str] = mapped_column(String(80), comment=zoho("Contacts.Last_Name"))
    full_name: Mapped[str | None] = mapped_column(String(160), comment=zoho("Contacts.Full_Name"))
    email: Mapped[str | None] = mapped_column(String(254), index=True, comment=zoho("Contacts.Email", "matches the portal login"))
    phone: Mapped[str | None] = mapped_column(String(40), comment=zoho("Contacts.Phone"))
    mobile: Mapped[str | None] = mapped_column(String(40), comment=zoho("Contacts.Mobile"))
    owner_zoho_id: Mapped[str | None] = mapped_column(String(40), fk("crm_agents.zoho_id"), index=True,
                                                      comment=zoho("Contacts.Owner", "the client's agent"))


class CrmProperty(CrmSynced, Base):
    """Listings (custom Properties module): search, matcher and showcase."""

    __tablename__ = "crm_properties"

    name: Mapped[str] = mapped_column(String(200), comment=zoho("Properties.Name"))
    address: Mapped[str | None] = mapped_column(String(255), comment=zoho("Properties.Address"))
    city: Mapped[str | None] = mapped_column(String(120), index=True, comment=zoho("Properties.City"))
    price: Mapped[Decimal | None] = mapped_column(Money, comment=zoho("Properties.Price", "monthly rent for rentals"))
    property_type: Mapped[str | None] = mapped_column(String(60), comment=zoho("Properties.Property_Type"))
    listing_type: Mapped[str | None] = mapped_column(String(20), comment=zoho("Properties.Listing_Type", "Sale or Rent"))
    bedrooms: Mapped[int | None] = mapped_column(Integer, comment=zoho("Properties.Bedrooms"))
    bathrooms: Mapped[Decimal | None] = mapped_column(Numeric(4, 1), comment=zoho("Properties.Bathrooms"))
    floor_area: Mapped[int | None] = mapped_column(Integer, comment=zoho("Properties.Floor_Area", "sq ft"))
    status: Mapped[str | None] = mapped_column(String(40), index=True, comment=zoho("Properties.Status", "only Available is shown to clients"))
    description: Mapped[str | None] = mapped_column(Text, comment=zoho("Properties.Description"))
    photo_url: Mapped[str | None] = mapped_column(String(500), comment=zoho("Properties.Photo_URL"))
    featured: Mapped[bool] = mapped_column(Boolean, default=False, comment=zoho("Properties.Featured"))
    listed_date: Mapped[date | None] = mapped_column(Date, comment=zoho("Properties.Listed_Date"))

    __table_args__ = (Index("ix_crm_properties_search", "status", "listing_type", "city", "price"),)


class CrmDealStage(Base):
    """The Deals pipeline, in Zoho's picklist order."""

    __tablename__ = "crm_deal_stages"

    name: Mapped[str] = mapped_column(String(80), primary_key=True, comment=zoho("Deals.Stage picklist value"))
    sequence: Mapped[int] = mapped_column(Integer, comment=zoho("pick_list_values.sequence_number"))
    is_won: Mapped[bool] = mapped_column(Boolean, default=False, comment="Closing stage counted as won")
    is_lost: Mapped[bool] = mapped_column(Boolean, default=False, comment="Closing stage counted as lost")
    synced_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class CrmDeal(CrmSynced, Base):
    """A client's purchase, lease or offer."""

    __tablename__ = "crm_deals"

    deal_name: Mapped[str] = mapped_column(String(200), comment=zoho("Deals.Deal_Name"))
    stage: Mapped[str | None] = mapped_column(String(80), fk("crm_deal_stages.name", ondelete="RESTRICT"), comment=zoho("Deals.Stage"))
    amount: Mapped[Decimal | None] = mapped_column(Money, comment=zoho("Deals.Amount"))
    closing_date: Mapped[date | None] = mapped_column(Date, comment=zoho("Deals.Closing_Date"))
    type: Mapped[str | None] = mapped_column(String(60), comment=zoho("Deals.Type"))
    description: Mapped[str | None] = mapped_column(Text, comment=zoho("Deals.Description", "shown to the client as the latest update"))
    contact_zoho_id: Mapped[str | None] = mapped_column(String(40), fk("crm_contacts.zoho_id", ondelete="CASCADE"), index=True,
                                                        comment=zoho("Deals.Contact_Name", "the client; clients only see their own deals"))
    property_zoho_id: Mapped[str | None] = mapped_column(String(40), fk("crm_properties.zoho_id"), index=True, comment=zoho("Deals.Property"))
    owner_zoho_id: Mapped[str | None] = mapped_column(String(40), fk("crm_agents.zoho_id"), comment=zoho("Deals.Owner", "agent for this deal"))


class CrmLead(CrmSynced, Base):
    """Guest sign-ups (hot leads) and client referrals."""

    __tablename__ = "crm_leads"

    kind: Mapped[str] = mapped_column(String(20), comment="signup | referral | other (from Lead_Source)")
    first_name: Mapped[str | None] = mapped_column(String(80), comment=zoho("Leads.First_Name"))
    last_name: Mapped[str] = mapped_column(String(80), comment=zoho("Leads.Last_Name"))
    email: Mapped[str | None] = mapped_column(String(254), index=True, comment=zoho("Leads.Email"))
    phone: Mapped[str | None] = mapped_column(String(40), comment=zoho("Leads.Phone"))
    lead_source: Mapped[str | None] = mapped_column(String(60), comment=zoho("Leads.Lead_Source"))
    lead_status: Mapped[str | None] = mapped_column(String(60), comment=zoho("Leads.Lead_Status"))
    inquiry_type: Mapped[str | None] = mapped_column(String(60), comment=zoho("Leads.Inquiry_Type", "referrals"))
    match_criteria: Mapped[str | None] = mapped_column(Text, comment=zoho("Leads.Portal_Match_Criteria", "guests' latest search"))
    description: Mapped[str | None] = mapped_column(Text, comment=zoho("Leads.Description"))
    referred_by_zoho_id: Mapped[str | None] = mapped_column(String(40), fk("crm_contacts.zoho_id"), index=True,
                                                            comment=zoho("Leads.Referred_By", "referring client"))
    owner_zoho_id: Mapped[str | None] = mapped_column(String(40), fk("crm_agents.zoho_id"), comment=zoho("Leads.Owner"))
    portal_user_id: Mapped[str | None] = mapped_column(String(36), ForeignKey(f"{SCHEMA}.users.id", ondelete="SET NULL"), index=True,
                                                       comment="Guest account created by this sign-up")
    created_time: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), comment=zoho("Leads.Created_Time"))

    __table_args__ = (CheckConstraint("kind IN ('signup', 'referral', 'other')", name="kind"),)


class CrmMessage(CrmSynced, Base):
    """Portal conversation: Notes on the client's Contact titled with the portal
    prefixes. Internal agent notes are never copied."""

    __tablename__ = "crm_messages"

    contact_zoho_id: Mapped[str] = mapped_column(String(40), fk("crm_contacts.zoho_id", ondelete="CASCADE"), index=True,
                                                 comment=zoho("Notes.Parent_Id (Contact)"))
    deal_zoho_id: Mapped[str | None] = mapped_column(String(40), fk("crm_deals.zoho_id"), comment="Deal the message is about (from the note text)")
    property_zoho_id: Mapped[str | None] = mapped_column(String(40), fk("crm_properties.zoho_id"), comment="Property the message is about")
    direction: Mapped[str] = mapped_column(String(10), comment="client (\"[Client Portal]\" note) | agent (\"[Portal Reply]\" note)")
    subject: Mapped[str] = mapped_column(String(255), comment=zoho("Notes.Note_Title", "without the prefix"))
    body: Mapped[str | None] = mapped_column(Text, comment=zoho("Notes.Note_Content"))
    author_name: Mapped[str | None] = mapped_column(String(120), comment=zoho("Notes.Owner", "agent replies"))
    created_time: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), comment=zoho("Notes.Created_Time"))

    __table_args__ = (CheckConstraint("direction IN ('client', 'agent')", name="direction"),)


class CrmTask(CrmSynced, Base):
    """Follow-up Task created for the agent for each client message."""

    __tablename__ = "crm_tasks"

    message_zoho_id: Mapped[str | None] = mapped_column(String(40), fk("crm_messages.zoho_id"), comment="The message that created it")
    subject: Mapped[str] = mapped_column(String(255), comment=zoho("Tasks.Subject"))
    status: Mapped[str | None] = mapped_column(String(40), comment=zoho("Tasks.Status"))
    priority: Mapped[str | None] = mapped_column(String(20), comment=zoho("Tasks.Priority"))
    due_date: Mapped[date | None] = mapped_column(Date, comment=zoho("Tasks.Due_Date"))
    owner_zoho_id: Mapped[str | None] = mapped_column(String(40), fk("crm_agents.zoho_id"), comment=zoho("Tasks.Owner"))
    contact_zoho_id: Mapped[str | None] = mapped_column(String(40), fk("crm_contacts.zoho_id", ondelete="CASCADE"), comment=zoho("Tasks.Who_Id"))
    deal_zoho_id: Mapped[str | None] = mapped_column(String(40), fk("crm_deals.zoho_id"), comment=zoho("Tasks.What_Id"))


class SyncState(Base):
    """Progress of the Zoho -> portal sync for each module."""

    __tablename__ = "sync_state"

    module: Mapped[str] = mapped_column(String(40), primary_key=True, comment="Zoho module, e.g. Deals")
    last_modified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), comment="Newest Modified_Time copied (incremental cursor)")
    last_run_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_status: Mapped[str | None] = mapped_column(String(20), comment="ok | error")
    last_error: Mapped[str | None] = mapped_column(Text)
    records_synced: Mapped[int] = mapped_column(Integer, default=0)


class Database:
    def __init__(self, url: str):
        self.url = url
        kwargs: dict[str, Any] = {}
        if url.startswith("sqlite"):
            kwargs["connect_args"] = {"check_same_thread": False}
            if ":memory:" in url:
                kwargs["poolclass"] = StaticPool  # one shared in-memory database (tests)
        if url.startswith("sqlite"):
            # SQLite has no schemas: the tables live in the main database.
            kwargs["execution_options"] = {"schema_translate_map": {SCHEMA: None}}
        self.engine: AsyncEngine = create_async_engine(url, **kwargs)
        if url.startswith("sqlite"):
            event.listen(self.engine.sync_engine, "connect", _sqlite_pragmas)
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)

    @property
    def is_postgres(self) -> bool:
        return self.url.startswith("postgresql")

    async def create_all(self) -> None:
        async with self.engine.begin() as conn:
            if self.is_postgres:
                await conn.exec_driver_sql(f"CREATE SCHEMA IF NOT EXISTS {SCHEMA}")
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
