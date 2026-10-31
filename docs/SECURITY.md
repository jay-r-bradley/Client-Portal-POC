# Security, privacy and governance

This document describes how the Client Portal protects accounts and personal data. The server-side controls are covered by the automated tests in `tests/` (run against SQLite and PostgreSQL 16). The browser idle sign-out was checked in a browser walkthrough.

## Who can do what

| | Guest | Client | Admin |
|---|---|---|---|
| How they get an account | Sign up on the portal (email confirmed by code); becomes a Zoho **Lead** | Invited by an admin; needs a Zoho Contact **with an active deal** | Created by another admin or the CLI |
| Available listings, featured showcase, search, AI matcher | ✓ | ✓ | n/a |
| Own deals, deal status, AI deal insights | n/a | ✓ (own only) | n/a |
| Message agent, refer a friend | n/a | ✓ | n/a |
| Activity log, users, referrals, Zoho setup, security page | n/a | n/a | ✓ |

All of this is enforced on the server for every request. Clients and guests can never read activity logs, their own included: only admins can.

## Sign-in

- **Two-step sign-in for every role.** Password, then a 6-digit code emailed to the account address.
- **Code limits.** A code expires after 10 minutes and allows 5 attempts. A new code replaces the previous one, and resends have a 30-second cooldown and a limit of 3.
- **Codes are never stored.** Only a keyed HMAC-SHA256 of each code is kept, bound to its challenge id.
- **Sign-up confirms the email first.** No account and no Zoho Lead exist until the emailed code is entered. Guests are never linked to an existing Zoho Contact automatically; an admin converts them.
- **Forgot password works by code.** The response is identical whether or not the email has an account (no account enumeration). A reset signs the user out everywhere.
- **Passwords.**
  - At least 10 characters, and not the user's email.
  - Hashed with scrypt.
  - Unknown emails are checked against a dummy hash, so timing doesn't reveal which emails exist.
- **Throttling.** Failed sign-ins are limited per IP + email (10 per 15 minutes), sign-ups to 5 per hour per IP, and password resets to 5 per hour per IP and per email.
- **Temporary passwords** from invites and admin resets must be changed at first sign-in.

## Sessions

- **The session cookie** is HMAC-signed, `HttpOnly`, `SameSite=Lax`, and `Secure` in production.
- **Idle timeout: 30 minutes**, enforced twice:
  - **In the browser:** mouse, keyboard, touch and scroll activity, shared across tabs. A warning with "Stay signed in" appears 2 minutes before sign-out.
  - **On the server:** the session expiry slides forward with activity and is rejected once idle.
- **Absolute limit: 12 hours** per session, whatever the activity.
- **Re-checked on every request.** Disabling an account, resetting or changing a password, or erasing a user signs them out everywhere immediately (session versioning).

## Requests

- **Cross-site request forgery (CSRF):** state-changing requests must be JSON from the same origin. `Origin` and `Sec-Fetch-Site` are checked.
- **URL and input injection:**
  - Ids in URLs must match a strict pattern. Dates, user ids, filters and page sizes are validated.
  - Invalid input gets a generic "Invalid request." and is never echoed back.
  - Ids are URL-encoded in calls to Zoho, and every value in a Zoho COQL query is escaped.
- **Limits:** request bodies are limited to 64 KB.
- **Timeouts:**
  - Each request has a 30-second budget (2 minutes for AI).
  - Calls to Zoho, OpenAI, MCP and email each have their own timeout.
  - The browser aborts after the same limits and shows a friendly message.
- **Headers:**
  - Content-Security-Policy, which allows only the portal's own scripts and styles (no inline scripts).
  - Clickjacking protection (`frame-ancestors 'none'`, `X-Frame-Options: DENY`), `nosniff`, Referrer-Policy, Permissions-Policy, COOP.
  - HSTS in production, and `no-store` on API responses.
- **Zoho webhook:** `/api/sync/zoho-webhook` accepts server-to-server calls without the browser checks above, so it needs a shared secret (`ZOHO_WEBHOOK_SECRET`, compared in constant time) and is off without one. It only names a record; the portal reads that record from Zoho itself, so a forged call cannot inject data. The 64 KB limit still applies.
- **No public API documentation:** `/docs` and `/openapi.json` are disabled.
- **Errors:** internal and provider errors are logged on the server and shown to users as a generic message.

## AI

- **Bounded access:** the model only reaches the portal through client-scoped tools. It cannot read another client's records, and it never receives contact details or the Zoho MCP key.
- **Checked output:** answers are schema-validated, listing ids are matched back to CRM records, and usage is capped per account per hour.
- **Read-only MCP:** the Zoho MCP connection used by the AI cannot create or change records.

## Audit trail

- **What is recorded:** sign-ins (including failed and blocked attempts, codes sent and failed codes), dashboard, deal and property views, searches, messages, referrals, sign-ups, password changes and every admin action, with IP address and browser.
- **What is never recorded:** passwords, codes, message bodies, or a referred person's contact details.
- **Tamper evidence:** the log is append-only and hash-chained. Admins can verify it from **Security → Verify audit log now** (see `docs/DATABASE.md`).
- **Export:** admins can filter and export the log to CSV. Cells are guarded against spreadsheet formula injection, and exports are themselves logged.

## Personal data

| Data | Where | Retention |
|---|---|---|
| Deals, contacts, leads, listings, messages | Zoho CRM | Your Zoho retention policy |
| Copy of those records (for speed) | Portal database | Follows Zoho: updates and deletions sync back, and a daily full sync removes anything deleted in Zoho |
| Portal accounts and consents | Portal database | Until erased |
| One-time codes and pending sign-ups | Portal database | Deleted after 1 day |
| Activity log | Portal database | `ACTIVITY_RETENTION_DAYS` (default 730), then deleted automatically |

- **Consent:** sign-up records consent to the privacy notice and to being contacted, with time, policy version, IP and browser.
- **Access requests:** **Users → [person] → Export their data** downloads everything the portal holds about them.
- **Erasure:** **Erase personal data** removes their details from their account and from the activity log, signs them out, and keeps the log's integrity chain valid. Their Zoho CRM records are handled in Zoho.
- **Privacy notice:** a template is at `#/privacy`. Have it reviewed for your jurisdiction (for example GDPR, CCPA/CPRA, the Philippines Data Privacy Act, or Australia's Privacy Act) and set `PRIVACY_CONTACT_EMAIL`.

## Production checklist

- [ ] `APP_ENV=production`, a long random `SESSION_SECRET`, served only over HTTPS
- [ ] `MAIL_PROVIDER=smtp` or `zeptomail`, with SPF/DKIM set up for the sending domain
- [ ] PostgreSQL with encryption at rest, automated backups and point-in-time recovery, reached over TLS (`sslmode=require`)
- [ ] App database role without UPDATE/DELETE on `activity_events` beyond erasure and retention (see `db/schema.sql`)
- [ ] Secrets in the hosting platform's secret store
- [ ] Rate limits moved to Redis if running more than one instance
- [ ] Run uvicorn with `--proxy-headers` behind your load balancer so client IPs are correct
- [ ] Privacy notice reviewed; `PRIVACY_CONTACT_EMAIL` set
- [ ] Zoho OAuth scopes narrowed to what the portal uses (see `docs/ZOHO_FIELDS.md`)
- [ ] Error monitoring and uptime alerts
