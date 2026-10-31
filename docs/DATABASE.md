# Database design and hosting

## What the database is for

Zoho CRM stays the system of record for everything about the business: contacts, deals, listings, leads, referrals and messages. The portal's own database holds only what Zoho does not:

| Table | Holds | Personal data? |
|---|---|---|
| `users` | Portal logins: email, scrypt password hash, role (admin / client / guest), status, the linked Zoho Contact or Lead id | Yes: name, email, phone |
| `consents` | What each person agreed to (privacy notice, being contacted), when, under which policy version, from which IP | Yes: IP address |
| `otp_challenges` | Pending one-time sign-in / sign-up / password-reset codes (hashed only). Pending sign-ups wait here until the email is confirmed. Deleted after a day. | Yes: email; pending sign-up details |
| `activity_events` | The audit trail: who did what and when, with IP and browser, hash-chained for tamper evidence | Yes: actor name/email, IP |

**PostgreSQL 16+** is the production database. SQLite is used only for local development and automated tests. The full test suite has been run against both PostgreSQL 16 and SQLite.

## Schema

The exact DDL is in [`db/schema.sql`](../db/schema.sql), generated from `app/db.py` with `python -m app.cli schema-sql`.

```mermaid
erDiagram
    users ||--o{ consents : "agrees to"
    users ||--o{ otp_challenges : "is sent"
    users ||--o{ activity_events : "performs"
    users ||--o{ users : "invited by"

    users {
        varchar id PK "UUID"
        varchar email UK
        varchar password_hash "scrypt"
        varchar role "admin | client | guest"
        varchar status "active | disabled | erased"
        varchar name
        varchar phone
        varchar zoho_contact_id UK "clients"
        varchar zoho_lead_id "guests"
        boolean must_change_password
        int session_version "bumped to sign out everywhere"
        timestamptz email_verified_at
        timestamptz last_login_at
        timestamptz converted_at "guest to client"
        varchar created_by FK
        timestamptz created_at
        timestamptz updated_at
    }
    consents {
        varchar id PK
        varchar user_id FK
        varchar kind "privacy_policy | contact_about_properties"
        varchar policy_version
        timestamptz granted_at
        timestamptz withdrawn_at
        varchar ip
        varchar user_agent
    }
    otp_challenges {
        varchar id PK
        varchar purpose "login | signup | password_reset"
        varchar email
        varchar user_id FK
        varchar code_hash "HMAC-SHA256, never the code"
        jsonb payload "pending sign-up"
        int attempts "max 5"
        int resends "max 3"
        timestamptz expires_at "10 minutes"
        timestamptz consumed_at
    }
    activity_events {
        bigint seq PK "append order"
        varchar id UK
        timestamptz at
        varchar action "e.g. auth.login, property.viewed"
        varchar actor_user_id
        varchar actor_email
        varchar actor_name
        varchar actor_role
        jsonb target
        jsonb details
        varchar ip
        varchar user_agent
        varchar content_hash
        varchar prev_hash
        varchar hash "chains to the previous row"
        timestamptz redacted_at "set on erasure"
    }
```

Rules enforced by the database itself:

- **Unique and valid values:** emails and Zoho Contact ids are unique. Roles, statuses and code purposes are limited to the allowed values by CHECK constraints.
- **Clients have a Contact:** a client account must have a Zoho Contact id, unless the account has been erased.
- **Deleting a user cascades:** their consents and codes are deleted with them. The audit trail keeps the user id but holds no foreign key, so history survives.

### Tamper-evident audit trail

Each `activity_events` row stores two hashes:

- **`content_hash`:** a hash of the row's own content.
- **`hash`:** a hash of the previous row's `hash` combined with this row's `content_hash`, which chains the rows together.

**Verify audit log** on the admin Security page recomputes the chain. An edited, inserted or deleted row shows up as a broken link.

**Erasing a person** blanks their details and sets `redacted_at` while keeping both hashes, so the chain still verifies.

**Retention** deletes the oldest rows, and verification then starts from the oldest row that remains.

For defence in depth in production, the app's database role should not be able to UPDATE or DELETE audit rows except for the erasure and retention columns. Example GRANTs are at the end of `db/schema.sql`.

### Size

These tables stay small. Assume about 1 KB per audit event and 1,000 active clients at about 50 events a month each. That is roughly 600,000 rows and well under 1 GB a year. The smallest managed PostgreSQL tier of any provider is enough for a long time.

## Creating the database

1. **Create a PostgreSQL 16+ database** and an application user, with your host's console or `psql`:
   ```sql
   CREATE DATABASE portal;
   CREATE USER portal_app WITH PASSWORD 'a-long-random-password';
   GRANT CONNECT ON DATABASE portal TO portal_app;
   \c portal
   GRANT USAGE, CREATE ON SCHEMA public TO portal_app;
   ```
2. **Create the tables:** apply `db/schema.sql` (`psql -f db/schema.sql`), or let the app create them on first start.
3. **Point the app at it:** in `.env` or your host's secret settings:
   ```
   DATABASE_URL=postgresql+psycopg://portal_app:PASSWORD@HOST:5432/portal?sslmode=require
   ```
4. **Turn on backups:** automated daily backups with point-in-time recovery, plus encryption at rest. Most managed providers enable both by default.
5. **Before production, add migrations:** once the schema starts changing between releases, add Alembic so changes are applied safely.

## Where to host it

Host the database **in the same region as the app**. Pick the region that matches the brokerage's Zoho data centre and where clients are, for data residency: US, EU, India, Australia, and so on.

| Option | App runs on | Database | Good for | Trade-offs |
|---|---|---|---|---|
| **AWS** | App Runner or ECS Fargate | Amazon RDS for PostgreSQL (or Aurora Serverless v2) | Enterprise production: private networking, KMS encryption, IAM, mature backups, compliance reports | Most setup; needs someone comfortable with AWS |
| **Microsoft Azure** | Azure Container Apps | Azure Database for PostgreSQL – Flexible Server | Organisations already on Microsoft 365 / Entra ID | Similar setup effort to AWS |
| **Google Cloud** | Cloud Run | Cloud SQL for PostgreSQL | Simple container hosting with a managed database | Similar setup effort; fewer real estate / CRM integrations |
| **DigitalOcean** | App Platform | Managed PostgreSQL | Pilot and early production: quick to set up, predictable pricing, backups included | Fewer enterprise controls than the big three |
| **Render** | Web Service | Render PostgreSQL | Fastest path from this repo to a live URL | Fewer regions and enterprise controls |
| **Neon / Supabase** | Any of the above | Serverless PostgreSQL | Cheap, scales to zero between uses | Separate vendor from the app host; check latency and region |
| **Zoho Catalyst** | AppSail | Catalyst Data Store | Keeping everything with Zoho, close to Zoho CRM | Its data store is not PostgreSQL (it uses its own query language), so the data layer would need an adapter. Check Catalyst's current features before choosing it. |

**Recommendation:** for the pilot, **DigitalOcean App Platform with Managed PostgreSQL**, or Render, in the region nearest your clients. That gets the Dockerfile in this repo live quickly with managed backups. For enterprise production, **AWS (App Runner + RDS PostgreSQL)**, or Azure if the company already runs on Microsoft. The app is a standard container plus PostgreSQL, so moving between these later is straightforward.

Whichever you choose, also plan for:

- **HTTPS:** the platform's managed certificates, or a load balancer in front.
- **Secrets:** `SESSION_SECRET`, Zoho, OpenAI and mail credentials go in the platform's secret store, never in the repo.
- **More than one app instance:** move the in-memory rate limits to Redis (any managed Redis).
- **Monitoring:** error logs and uptime alerts.
