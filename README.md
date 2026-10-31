# Client Portal for Zoho CRM

A secure client portal for real estate brokerages that run on **Zoho CRM**. It is built with **Python 3.13 + FastAPI**, a **PostgreSQL** database (SQLite for local development), and **OpenAI** for the AI features, with the AI reading Zoho through **Zoho MCP**.

## What it does

**Clients** (invited once they have an active deal in Zoho):
- **My Deals:** see their deals, where each stands in the pipeline, amounts, closing dates and the agent's latest update, with AI summaries of what happens next.
- **Find a Property:** one search bar with filters for buy/rent, location, price, beds, home type and more. With AI on, they can type what they want in plain English and the AI fills the filters and ranks the matches.
- **Contact Agent:** messages land in Zoho as a Note plus a Task for the agent.
- **Refer a Friend:** someone looking for land, a home, a rental, a sale or an investment becomes a Zoho Lead for the client's agent, and the client follows its progress.

**Guests** (anyone; they sign up themselves): see available listings, the featured showcase, search and the AI matcher. Each sign-up becomes a **hot Lead** in Zoho, and their latest budget and search are kept on the Lead for agents. Admins convert them to clients once they have an active deal.

**Admins** (brokerage staff):
- **Overview:** KPIs, a client activity chart, the most viewed properties and the most searched locations.
- **Activity log:** every sign-in, view, search, message and admin action, with filters and CSV export.
- **Users:** invite, disable, reset passwords, convert guests to clients, and export or erase personal data.
- **Referrals:** every referral and its status.
- **Zoho setup:** connection status, the sync status of the database copy (with "Sync now"), and a check for every Zoho field the portal needs.
- **Security:** settings summary and audit-log integrity verification.

Zoho CRM is the system of record. The portal's database holds logins, consents, one-time codes and the audit trail, plus a synced copy of the Zoho records the portal shows, so pages load in milliseconds instead of waiting on Zoho. Portal writes go to Zoho first; Zoho changes come back by webhook within seconds, with a catch-up sync every 10 minutes (see [docs/DATABASE.md](docs/DATABASE.md)).

## Security at a glance

- **Two-step sign-in** for everyone: password, then a 6-digit code emailed to the account address. Sign-up confirms the email by code, and forgot-password works by code.
- **Idle sign-out** after 30 minutes, with a warning in the browser (enforced by the server too), and a 12-hour maximum session.
- **Changes take effect at once:** disabling, password changes and erasure sign the user out everywhere.
- **Request protections:** CSRF protection, strict URL and input validation, escaped CRM queries, a 64 KB body limit, request timeouts, a strict Content-Security-Policy and security headers.
- **Audit trail:** append-only and hash-chained (tamper-evident). Only admins can read it, and it never holds passwords, codes or message bodies.
- **Privacy:** consent records, data export, erasure and retention.

Details: [docs/SECURITY.md](docs/SECURITY.md).

## Quick start (sample data, no Zoho needed)

```bash
uv venv --python 3.13 && uv pip install -e ".[dev,postgres]"   # or: python3.13 -m venv .venv && pip install -e ".[dev,postgres]"
.venv/bin/python -m app                                           # http://localhost:3000
```

Demo sign-ins (the emailed code is printed in the server log and shown on screen in demo mode):

| Role | Email | Password |
|---|---|---|
| Client | `alex@client.example` | `demo1234` |
| Admin | `admin@brokerage.example` | `admin1234` |
| Guest | sign up at `#/signup` | |

Tests: `.venv/bin/python -m pytest` (99 tests). Run them against PostgreSQL with `TEST_DATABASE_URL=postgresql+psycopg://...`.

## Going live

1. **Database:** create PostgreSQL and set `DATABASE_URL`. Schema, setup steps and hosting options are in [docs/DATABASE.md](docs/DATABASE.md).
2. **Email:** set `MAIL_PROVIDER=smtp` or `zeptomail` so sign-in codes are delivered.
3. **Zoho CRM:** create the fields in [docs/ZOHO_FIELDS.md](docs/ZOHO_FIELDS.md) (the admin **Zoho setup** page checks them). Then set `ZOHO_MODE=live` and the OAuth credentials (Zoho API console, self client, scopes listed in that doc).
   Optionally set `ZOHO_WEBHOOK_SECRET` and add the Zoho webhooks in [docs/DATABASE.md](docs/DATABASE.md#setting-up-the-zoho-webhook) so Zoho changes appear within seconds instead of within 10 minutes.
4. **Zoho MCP (optional, for the AI):** set `ZOHO_MCP_URL`, then run `python -m app.cli mcp-check --schemas` and match `config/zoho-mcp-tools.json` to your server's tools.
5. **AI (optional):** set `OPENAI_API_KEY` (default model `gpt-5-mini`; change with `OPENAI_MODEL`).
6. **First admin:** `python -m app.cli create-user --role admin --email you@brokerage.com --name "Your Name"`. After that, invite users from the admin console.
7. **Production settings:** `APP_ENV=production`, a long random `SESSION_SECRET`, HTTPS, and the checklist in [docs/SECURITY.md](docs/SECURITY.md).

Every setting is listed in [.env.example](.env.example). A production `Dockerfile` is included.

## Project layout

```
app/
  main.py            FastAPI app, startup, error handling
  middleware.py      Security headers, CSRF, body limit, request timeouts
  web.py             Services, signed-in user check (roles, idle timeout), validation helpers
  config.py          Settings from the environment, incl. every Zoho module/field name
  db.py              Database models: portal tables and the copy of Zoho records
  stores.py          Data access; hash-chained audit log
  security/          Passwords (scrypt), sessions, one-time codes, rate limits
  routes/            auth (sign-in, sign-up, reset), portal (client/guest), ai, admin, sync (Zoho webhook)
  sync/              Zoho → database sync engine, Zoho/sample sources, CachedCrm (pages read the copy)
  zoho/              REST client, LiveCrm, sample-data MockCrm, mappers/COQL, field catalogue
  mcp_zoho/          Zoho MCP client (official MCP Python SDK), read-only Zoho access
  ai/                OpenAI client, agent loop, client-scoped tools, prompts, AI service
  guests.py, referrals.py, mailer.py, demo.py, cli.py
public/              Browser app (no build step): app.js, admin.js, styles.css
db/schema.sql        PostgreSQL DDL
docs/                ZOHO_FIELDS.md, DATABASE.md, SECURITY.md
tests/               pytest suite
```
