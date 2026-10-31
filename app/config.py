"""Environment-driven settings. Every Zoho module and field API name the portal
touches is configurable, because Zoho orgs customise them."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def load_env_file(path: Path) -> None:
    """Minimal .env loader: KEY=value lines; real environment variables win."""
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def _env(key: str, default: str | None = None) -> str | None:
    value = os.environ.get(key)
    return value if value not in (None, "") else default


def _list(key: str, default: list[str]) -> list[str]:
    value = _env(key)
    return [s.strip() for s in value.split(",") if s.strip()] if value else default


def _int(key: str, default: int) -> int:
    return int(_env(key, str(default)))


def _bool(key: str, default: bool) -> bool:
    value = _env(key)
    return default if value is None else value.lower() in ("1", "true", "yes", "on")


@dataclass
class DealFields:
    name: str = "Deal_Name"
    stage: str = "Stage"
    amount: str = "Amount"
    closing_date: str = "Closing_Date"
    contact: str = "Contact_Name"
    property: str = "Property"
    type: str = "Type"
    description: str = "Description"


@dataclass
class PropertyFields:
    name: str = "Name"
    address: str = "Address"
    city: str = "City"
    price: str = "Price"
    type: str = "Property_Type"
    listing_type: str = "Listing_Type"
    bedrooms: str = "Bedrooms"
    bathrooms: str = "Bathrooms"
    floor_area: str = "Floor_Area"
    status: str = "Status"
    description: str = "Description"
    photo_url: str = "Photo_URL"
    featured: str = "Featured"
    listed_date: str = "Listed_Date"

    def values(self) -> list[str]:
        return list(dict.fromkeys(vars(self).values()))


@dataclass
class ReferralSettings:
    lead_source: str = "Client Referral"
    referred_by_field: str = "Referred_By"
    interest_field: str = "Inquiry_Type"
    new_status: str = "Not Contacted"
    reward_text: str = ""


@dataclass
class SignupSettings:
    lead_source: str = "Portal Sign-up"
    lead_owner_id: str | None = None
    criteria_field: str = "Portal_Match_Criteria"


@dataclass
class CrmSettings:
    contacts_module: str = "Contacts"
    deals_module: str = "Deals"
    properties_module: str = "Properties"
    leads_module: str = "Leads"
    deal: DealFields = field(default_factory=DealFields)
    property: PropertyFields = field(default_factory=PropertyFields)
    available_status: str = "Available"
    deal_stages: list[str] = field(default_factory=lambda: [
        "Inquiry", "Viewing Scheduled", "Offer Made", "Negotiation", "Under Contract", "Closed Won", "Closed Lost",
    ])
    won_stages: list[str] = field(default_factory=lambda: ["Closed Won"])
    lost_stages: list[str] = field(default_factory=lambda: ["Closed Lost"])
    # Notes created by the portal carry this prefix so clients only ever see
    # portal messages; agents reply in Zoho with a note titled with the reply prefix.
    portal_note_prefix: str = "[Client Portal]"
    portal_reply_prefix: str = "[Portal Reply]"
    signup: SignupSettings = field(default_factory=SignupSettings)
    referral: ReferralSettings = field(default_factory=ReferralSettings)


@dataclass
class ZohoSettings:
    accounts_url: str = "https://accounts.zoho.com"
    api_domain: str = "https://www.zohoapis.com"
    api_version: str = "v8"
    client_id: str | None = None
    client_secret: str | None = None
    refresh_token: str | None = None
    timeout_seconds: float = 20.0


@dataclass
class ZohoMcpSettings:
    url: str | None = None
    authorization: str | None = None
    tool_map_path: Path = ROOT / "config" / "zoho-mcp-tools.json"
    timeout_seconds: float = 20.0


@dataclass
class AiSettings:
    api_key: str | None = None
    # OpenAI's low-cost "mini" tier by default; any model with tool calling and
    # Structured Outputs works.
    model: str = "gpt-5-mini"
    base_url: str = "https://api.openai.com/v1"
    timeout_seconds: float = 45.0
    max_requests_per_hour: int = 30
    guest_max_requests_per_hour: int = 10
    cache_minutes: int = 60
    max_steps: int = 6

    @property
    def enabled(self) -> bool:
        return bool(self.api_key)


@dataclass
class MailSettings:
    # console: print emails to the server log (development only)
    # smtp: any SMTP server (Zoho Mail, ZeptoMail SMTP, Amazon SES, ...)
    # zeptomail: Zoho ZeptoMail HTTP API
    provider: str = "console"
    from_address: str = "no-reply@example.com"
    from_name: str = "Client Portal"
    smtp_host: str | None = None
    smtp_port: int = 587
    smtp_username: str | None = None
    smtp_password: str | None = None
    zeptomail_token: str | None = None
    zeptomail_url: str = "https://api.zeptomail.com/v1.1/email"
    timeout_seconds: float = 15.0


@dataclass
class SecuritySettings:
    # Sign-in requires an emailed one-time code after the password.
    email_otp: bool = True
    otp_ttl_minutes: int = 10
    otp_max_attempts: int = 5
    otp_resend_cooldown_seconds: int = 30
    otp_max_resends: int = 3
    # Sessions end after this much inactivity, and in any case after max hours.
    session_idle_minutes: int = 30
    session_max_hours: int = 12
    request_timeout_seconds: float = 30.0
    ai_request_timeout_seconds: float = 120.0
    max_body_bytes: int = 64 * 1024
    activity_retention_days: int = 730
    privacy_policy_version: str = "2026-11-01"
    privacy_contact_email: str = "privacy@example.com"


@dataclass
class Settings:
    port: int = 3000
    is_production: bool = False
    brand_name: str = "Client Portal"
    currency: str = "USD"
    locale: str = "en-US"
    session_secret: str = "dev-only-insecure-secret-change-me"
    database_url: str = f"sqlite+aiosqlite:///{ROOT / 'data' / 'portal.db'}"
    zoho_mode: str = "mock"
    zoho: ZohoSettings = field(default_factory=ZohoSettings)
    zoho_mcp: ZohoMcpSettings = field(default_factory=ZohoMcpSettings)
    crm: CrmSettings = field(default_factory=CrmSettings)
    ai: AiSettings = field(default_factory=AiSettings)
    mail: MailSettings = field(default_factory=MailSettings)
    security: SecuritySettings = field(default_factory=SecuritySettings)
    public_dir: Path = ROOT / "public"

    @property
    def show_dev_codes(self) -> bool:
        """In local demos with the console mailer, one-time codes are also shown on screen."""
        return not self.is_production and self.mail.provider == "console"


def load_settings() -> Settings:
    load_env_file(ROOT / ".env")
    deal = DealFields(
        name=_env("CRM_DEAL_NAME_FIELD", "Deal_Name"), stage=_env("CRM_DEAL_STAGE_FIELD", "Stage"),
        amount=_env("CRM_DEAL_AMOUNT_FIELD", "Amount"), closing_date=_env("CRM_DEAL_CLOSING_DATE_FIELD", "Closing_Date"),
        contact=_env("CRM_DEAL_CONTACT_FIELD", "Contact_Name"), property=_env("CRM_DEAL_PROPERTY_FIELD", "Property"),
        type=_env("CRM_DEAL_TYPE_FIELD", "Type"), description=_env("CRM_DEAL_DESCRIPTION_FIELD", "Description"),
    )
    prop = PropertyFields(
        name=_env("CRM_PROPERTY_NAME_FIELD", "Name"), address=_env("CRM_PROPERTY_ADDRESS_FIELD", "Address"),
        city=_env("CRM_PROPERTY_CITY_FIELD", "City"), price=_env("CRM_PROPERTY_PRICE_FIELD", "Price"),
        type=_env("CRM_PROPERTY_TYPE_FIELD", "Property_Type"), listing_type=_env("CRM_PROPERTY_LISTING_TYPE_FIELD", "Listing_Type"),
        bedrooms=_env("CRM_PROPERTY_BEDROOMS_FIELD", "Bedrooms"), bathrooms=_env("CRM_PROPERTY_BATHROOMS_FIELD", "Bathrooms"),
        floor_area=_env("CRM_PROPERTY_FLOOR_AREA_FIELD", "Floor_Area"), status=_env("CRM_PROPERTY_STATUS_FIELD", "Status"),
        description=_env("CRM_PROPERTY_DESCRIPTION_FIELD", "Description"), photo_url=_env("CRM_PROPERTY_PHOTO_FIELD", "Photo_URL"),
        featured=_env("CRM_PROPERTY_FEATURED_FIELD", "Featured"), listed_date=_env("CRM_PROPERTY_LISTED_DATE_FIELD", "Listed_Date"),
    )
    crm = CrmSettings(
        contacts_module=_env("CRM_CONTACTS_MODULE", "Contacts"), deals_module=_env("CRM_DEALS_MODULE", "Deals"),
        properties_module=_env("CRM_PROPERTIES_MODULE", "Properties"), leads_module=_env("CRM_LEADS_MODULE", "Leads"),
        deal=deal, property=prop, available_status=_env("CRM_PROPERTY_AVAILABLE_STATUS", "Available"),
        deal_stages=_list("CRM_DEAL_STAGES", CrmSettings().deal_stages),
        won_stages=_list("CRM_WON_STAGES", ["Closed Won"]), lost_stages=_list("CRM_LOST_STAGES", ["Closed Lost"]),
        portal_note_prefix=_env("CRM_PORTAL_NOTE_PREFIX", "[Client Portal]"),
        portal_reply_prefix=_env("CRM_PORTAL_REPLY_PREFIX", "[Portal Reply]"),
        signup=SignupSettings(
            lead_source=_env("CRM_SIGNUP_LEAD_SOURCE", "Portal Sign-up"), lead_owner_id=_env("CRM_SIGNUP_LEAD_OWNER_ID"),
            criteria_field=_env("CRM_SIGNUP_CRITERIA_FIELD", "Portal_Match_Criteria"),
        ),
        referral=ReferralSettings(
            lead_source=_env("CRM_REFERRAL_LEAD_SOURCE", "Client Referral"),
            referred_by_field=_env("CRM_REFERRAL_REFERRED_BY_FIELD", "Referred_By"),
            interest_field=_env("CRM_REFERRAL_INTEREST_FIELD", "Inquiry_Type"),
            new_status=_env("CRM_REFERRAL_NEW_STATUS", "Not Contacted"),
            reward_text=_env("PORTAL_REFERRAL_REWARD", ""),
        ),
    )
    settings = Settings(
        port=_int("PORT", 3000),
        is_production=_env("APP_ENV", _env("NODE_ENV", "development")) == "production",
        brand_name=_env("PORTAL_BRAND_NAME", "Client Portal"),
        currency=_env("PORTAL_CURRENCY", "USD"),
        locale=_env("PORTAL_LOCALE", "en-US"),
        session_secret=_env("SESSION_SECRET", "dev-only-insecure-secret-change-me"),
        database_url=_env("DATABASE_URL", Settings().database_url),
        zoho_mode=_env("ZOHO_MODE", "mock").lower(),
        zoho=ZohoSettings(
            accounts_url=_env("ZOHO_ACCOUNTS_URL", "https://accounts.zoho.com"),
            api_domain=_env("ZOHO_API_DOMAIN", "https://www.zohoapis.com"),
            api_version=_env("ZOHO_API_VERSION", "v8"),
            client_id=_env("ZOHO_CLIENT_ID"), client_secret=_env("ZOHO_CLIENT_SECRET"), refresh_token=_env("ZOHO_REFRESH_TOKEN"),
        ),
        zoho_mcp=ZohoMcpSettings(
            url=_env("ZOHO_MCP_URL"), authorization=_env("ZOHO_MCP_AUTHORIZATION"),
            tool_map_path=Path(_env("ZOHO_MCP_TOOL_MAP", str(ROOT / "config" / "zoho-mcp-tools.json"))),
        ),
        crm=crm,
        ai=AiSettings(
            api_key=_env("OPENAI_API_KEY"), model=_env("OPENAI_MODEL", "gpt-5-mini"),
            base_url=_env("OPENAI_BASE_URL", "https://api.openai.com/v1"),
            timeout_seconds=float(_env("OPENAI_TIMEOUT_SECONDS", "45")),
            max_requests_per_hour=_int("AI_MAX_REQUESTS_PER_HOUR", 30),
            guest_max_requests_per_hour=_int("AI_GUEST_MAX_REQUESTS_PER_HOUR", 10),
            cache_minutes=_int("AI_CACHE_MINUTES", 60), max_steps=_int("AI_MAX_STEPS", 6),
        ),
        mail=MailSettings(
            provider=_env("MAIL_PROVIDER", "console").lower(),
            from_address=_env("MAIL_FROM_ADDRESS", "no-reply@example.com"),
            from_name=_env("MAIL_FROM_NAME", _env("PORTAL_BRAND_NAME", "Client Portal")),
            smtp_host=_env("SMTP_HOST"), smtp_port=_int("SMTP_PORT", 587),
            smtp_username=_env("SMTP_USERNAME"), smtp_password=_env("SMTP_PASSWORD"),
            zeptomail_token=_env("ZEPTOMAIL_TOKEN"),
            zeptomail_url=_env("ZEPTOMAIL_URL", "https://api.zeptomail.com/v1.1/email"),
        ),
        security=SecuritySettings(
            email_otp=_bool("AUTH_EMAIL_OTP", True),
            session_idle_minutes=_int("SESSION_IDLE_MINUTES", 30),
            session_max_hours=_int("SESSION_MAX_HOURS", 12),
            request_timeout_seconds=float(_env("REQUEST_TIMEOUT_SECONDS", "30")),
            activity_retention_days=_int("ACTIVITY_RETENTION_DAYS", 730),
            privacy_policy_version=_env("PRIVACY_POLICY_VERSION", "2026-11-01"),
            privacy_contact_email=_env("PRIVACY_CONTACT_EMAIL", "privacy@example.com"),
        ),
    )
    if settings.is_production:
        if settings.session_secret.startswith("dev-only"):
            raise RuntimeError("SESSION_SECRET must be set in production.")
        if settings.mail.provider == "console" and settings.security.email_otp:
            raise RuntimeError("Set MAIL_PROVIDER (smtp or zeptomail) in production so sign-in codes can be emailed.")
    return settings
