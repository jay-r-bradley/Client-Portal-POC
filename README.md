# Client Portal for Zoho CRM

A white-label client portal for real estate brokerages that already manage their deals in **Zoho CRM**. The brokerage's clients sign in and can:

- **Track their deals.** See how many deals they have, where each one is in the pipeline (stage tracker), the amount, target closing date, latest update and the linked property.
- **Search properties.** Fill in a form with budget range, a preferred location plus other locations, buy or rent, property type, minimum bedrooms, bathrooms and floor area, and free-text requirements. The portal returns the **available** listings from the CRM that match.
- **Contact their agent.** Message the agent from inside the portal (in general, about a specific deal, or "I'm interested" on a listing). Each message lands in Zoho as a Note on the client's Contact and a high-priority Task for the agent. The agent's replies show up in the portal thread.

- **AI assistant (OpenAI, optional).** See [AI features](#ai-features-openai) below.

Zoho CRM stays the single source of truth. The portal stores nothing about deals or properties. It only keeps login accounts, and each one points at a Zoho Contact.

## Quick start (demo data, no Zoho needed)

```bash
npm install
npm start
# open http://localhost:3000
# sign in as alex@client.example / demo1234  (or priya@client.example / demo1234)
```

`ZOHO_MODE=mock` (the default) runs on built-in sample deals and listings in `src/zoho/mockData.js`.

```bash
npm test     # API, security and Zoho-integration tests
npm run dev  # auto-restart on file changes
```

Requires Node.js 20.12 or later.

## Connecting a real Zoho CRM org

### 1. CRM data model

| Zoho module | Used for | Fields the portal reads (default API names) |
|---|---|---|
| **Contacts** (standard) | The client. Their **Owner** is "your agent". | `Full_Name`, `Email`, `Phone`/`Mobile`, `Owner` |
| **Deals** (standard) | The client's deals, linked via `Contact_Name` | `Deal_Name`, `Stage`, `Amount`, `Closing_Date`, `Type`, `Description`, `Owner`, plus a `Property` lookup |
| **Properties** (custom module) | Listings for search | `Name`, `Address`, `City`, `Price`, `Property_Type`, `Listing_Type` (Sale/Rent), `Bedrooms`, `Bathrooms`, `Floor_Area`, `Status`, `Description`, `Photo_URL` |
| **Notes**, **Tasks** (standard) | Portal messages | written by the portal |

Many real estate orgs already have a listings module under a different name, or different field names. Every module and field API name can be overridden in `.env` (see `.env.example` and `src/config.js`), so there's no need to rename anything in Zoho. Only listings whose `Status` equals `CRM_PROPERTY_AVAILABLE_STATUS` (default `Available`) appear in search. A client can still open an off-market property if they have a deal on it.

Pipeline stages are read live from the Deals **Stage** picklist, in Zoho's order. Set `CRM_WON_STAGES` and `CRM_LOST_STAGES` if your closing stages have different names.

### 2. OAuth credentials (server-based, one-time)

1. In the [Zoho API Console](https://api-console.zoho.com/) create a **Self Client** (or a Server-based client).
2. Generate a grant code with these scopes:
   ```
   ZohoCRM.modules.ALL,ZohoCRM.coql.READ,ZohoCRM.settings.fields.READ,ZohoCRM.users.READ
   ```
   (For least privilege, `ZohoCRM.modules.ALL` can be narrowed to read on Contacts, Deals and the custom module, plus create on Notes and Tasks.)
3. Exchange it for a refresh token:
   ```bash
   curl -X POST "https://accounts.zoho.com/oauth/v2/token" \
     -d grant_type=authorization_code -d client_id=... -d client_secret=... -d code=...
   ```
4. Copy `.env.example` to `.env`. Set `ZOHO_MODE=live`, the client id, secret and refresh token, and the accounts/API hosts for your data centre (US/EU/IN/AU…).

The portal exchanges the refresh token for short-lived access tokens automatically, caches them, and retries once if Zoho reports one expired.

### 3. Give a client access

```bash
npm run create-user -- --email client@example.com --password 'a-strong-password'
# or link to a specific Contact:
npm run create-user -- --email client@example.com --password '...' --contact-id 5725767000001234567
```

The script looks up the Contact by email in Zoho and links the login to it. If the Contact is later deleted in Zoho, that client can no longer sign in.

### 4. How agents use it (from inside Zoho)

- A client message appears as a Note titled `[Client Portal] <subject>` on the Contact, plus a Task assigned to the deal owner (or the contact owner for general questions).
- **To reply in the portal**, the agent adds a Note on the Contact titled `[Portal Reply] <subject>`. Only notes with these two prefixes are ever shown to clients. Internal notes stay private.
- Updating a Deal's Stage, Amount, Closing Date or Description is reflected in the portal immediately.

## AI features (OpenAI)

Set `OPENAI_API_KEY` (and `OPENAI_MODEL`) in `.env` to switch these on. Without a key the portal works exactly as before and the AI panels are hidden.

| Feature | Where | What it does |
|---|---|---|
| **AI property search** | Find a Property | The client describes what they want in plain English ("3-bed in Austin or Dallas under 650k, ideally with a pool"). The model turns it into search filters, which are filled into the form so the client can see and adjust them. The CRM search runs on those filters, then the model ranks the matches against the client's softer wishes and gives each a match score and a short reason. If nothing matches, it loosens the search (about 15% over budget, one fewer bedroom, then any location) and explains what each near match is missing. |
| **Deals at a glance** | My Deals | An overview across the client's deals, plus which open deals need their attention first and why. |
| **What this means for you** | Each deal | A plain-language explanation of the current stage, the usual next steps, things to watch (for example, a closing date coming up or no update in weeks), and questions the client could ask their agent. |

How it is kept safe and affordable:

- **Your data stays the source of truth.** The model only interprets and explains. Prices, addresses and stages shown on screen always come from the CRM. A ranked listing ID the model invents is discarded. A listing the model leaves out is still shown, just without a reason.
- **Structured output only.** Every call uses OpenAI Structured Outputs with a strict JSON schema. Listing and deal IDs are restricted to the client's own records.
- **Minimal data sent.** The model receives deal and listing facts only, never the client's email, phone or the agent's contact details. CRM text is passed as data, and the prompts tell the model not to follow instructions inside it.
- **Client-facing guardrails.** The model is told not to invent facts or give legal or financial advice, and every AI panel carries a "confirm with your agent" note.
- **Cost control.** Each client is limited to `AI_MAX_REQUESTS_PER_HOUR` (default 30). Deal insights are cached until the deal changes or the day rolls over. A slow or failed AI call never blocks the page; the panel shows a short error and the regular features keep working.

All prompts and schemas live in `src/ai/prompts.js`, so they can be tuned in one place.

## Architecture

```
public/              Single-page frontend (vanilla JS, no build step)
src/
  server.js          Entry point
  app.js             Express app, security headers, routing
  config.js          Env-driven config, incl. every Zoho module/field name
  routes/auth.js     Sign-in / sign-out / current user
  routes/portal.js   Dashboard, deals, property search, messages
  propertyCriteria.js  Search-form validation + matching
  zoho/
    zohoApi.js       Zoho REST client: OAuth refresh, retries, 204 handling
    liveCrm.js       Portal operations against Zoho (related lists, COQL, Notes, Tasks)
    mappers.js       Zoho record -> portal shape; COQL query builder
    mockCrm.js       Same interface, in-memory sample data
  ai/
    openaiClient.js  OpenAI Chat Completions client (Structured Outputs)
    prompts.js       System prompts + JSON schemas for every AI feature
    aiService.js     AI search, deal insights, caching and per-client limits
  routes/ai.js       /api/ai/* endpoints (hidden when no OpenAI key is set)
  store/userStore.js Portal logins (email -> password hash -> Zoho Contact id)
scripts/create-user.js
test/
```

**Zoho API calls used:** `GET /Contacts/{id}`, `GET /Contacts/{id}/Deals` (related list, so a client can only ever list their own deals), `GET /Deals/{id}` (ownership checked against `Contact_Name`), `POST /coql` (property search), `GET /settings/fields` (stage order, filter options), `GET /users/{id}` (agent details), `GET /Contacts/{id}/Notes`, `POST /Notes`, `POST /Tasks`.

### Security notes

- Passwords are hashed with scrypt. Sessions are HMAC-signed, expiring, HttpOnly SameSite cookies.
- Every deal, property and message request is scoped server-side to the signed-in client's Contact id.
- COQL string values are escaped, and numbers are validated before they go into a query.
- Writes must be JSON from the same origin (CSRF). A strict Content-Security-Policy is set, and all CRM text is HTML-escaped in the UI.
- Failed sign-ins are throttled per IP + email.

### Before production

This is a proof of concept. For production use:

- Move `data/users.json` to a real database, and add self-service onboarding: an invite email from a Zoho workflow, plus password reset.
- Run behind HTTPS with `NODE_ENV=production` and a strong `SESSION_SECRET`.
- For many brokerages (multi-tenant SaaS), store one Zoho OAuth connection per tenant, and consider a Zoho Marketplace extension for installation.
- Optionally email the agent on each new message with a Zoho workflow rule on Tasks.
