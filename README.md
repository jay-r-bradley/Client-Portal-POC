# Client Portal for Zoho CRM

A white-label client portal for real estate brokerages that already manage their deals in **Zoho CRM**. The brokerage's clients sign in and can:

- **Track their deals.** See how many deals they have, where each one is in the pipeline (stage tracker), the amount, target closing date, latest update and the linked property.
- **Search properties.** One search bar plus a filter bar (Buy/Rent, Location, Price, Beds, Home type, More). With AI on, the client can type what they want in plain English and the AI sets the same filters, so there is one set of criteria they can see and adjust. Active filters show as removable chips, and results can be sorted. Only **available** listings from the CRM are shown.
- **See featured, newly acquired properties.** A "New to our portfolio" section on the dashboard and a "Featured & newly acquired" showcase on the search page, driven by a Featured checkbox in Zoho. Listings added in the last 30 days get a "New" badge.
- **Contact their agent.** Message the agent from inside the portal (in general, about a specific deal, or "I'm interested" on a listing). Each message lands in Zoho as a Note on the client's Contact and a high-priority Task for the agent. The agent's replies show up in the portal thread.

- **AI assistant (optional).** Plain-English property search and deal insights, powered by OpenAI and reading Zoho CRM through Zoho MCP. See [AI features](#ai-features-openai--zoho-mcp) below.

- **Refer a friend.** Clients refer someone looking for land, a home, a rental, a sale or an investment. Each referral becomes a Zoho **Lead** owned by the client's agent, and the client can follow its progress (Received → Agent in touch → Qualified).

### Two kinds of users

| Role | Who | What they can do |
|---|---|---|
| **Client** | A buyer or tenant, linked to their Zoho Contact | My Deals, Find a Property, Contact Agent, Refer a Friend. Only ever sees their own records. |
| **Admin** | Brokerage staff | The admin console: **Overview** (KPIs, client activity chart, most active clients, most viewed properties, most searched locations), **Activity log** (every sign-in, search, view, message, referral and admin action, with filters and CSV export), **Users** (invite clients or admins, disable, reset passwords, per-user timeline with their Zoho deals), **Referrals**, and **Zoho setup** (connection status and field check). |

Invited users get a one-time temporary password and must set their own on first sign-in. Disabling an account or resetting its password signs the user out everywhere immediately. Admins have no access to client pages, and clients have none to the admin console; both are enforced on the server.

**What the activity log records:** who, what, when, IP address and browser for sign-ins (including failed and blocked ones), dashboard and deal views, property searches (filters or the AI request) and views, messages (subject only, never the body), referrals (name and interest only, never contact details) and every admin action. Passwords are never logged.

Zoho CRM stays the single source of truth. The portal stores nothing about deals or properties. It only keeps login accounts, and each one points at a Zoho Contact.

## Quick start (demo data, no Zoho needed)

```bash
npm install
npm start
# open http://localhost:3000
# client: alex@client.example / demo1234   (or priya@client.example / demo1234)
# admin:  admin@brokerage.example / admin1234
```

`ZOHO_MODE=mock` (the default) runs on built-in sample deals and listings in `src/zoho/mockData.js`.

```bash
npm test     # API, security and Zoho-integration tests
npm run dev  # auto-restart on file changes
```

Requires Node.js 20.12 or later.

## Connecting a real Zoho CRM org

### 1. CRM data model

**The full field list, with labels, types and which ones to create, is in [`docs/ZOHO_FIELDS.md`](docs/ZOHO_FIELDS.md)** (regenerate with `npm run docs:fields`). The admin console's **Zoho setup** page shows the same list and, once connected, checks your org for each field.

| Zoho module | Used for | Fields the portal reads (default API names) |
|---|---|---|
| **Contacts** (standard) | The client. Their **Owner** is "your agent". | `Full_Name`, `Email`, `Phone`/`Mobile`, `Owner` |
| **Deals** (standard) | The client's deals, linked via `Contact_Name` | `Deal_Name`, `Stage`, `Amount`, `Closing_Date`, `Type`, `Description`, `Owner`, plus a `Property` lookup |
| **Properties** (custom module) | Listings for search and the showcase | `Name`, `Address`, `City`, `Price`, `Property_Type`, `Listing_Type` (Sale/Rent), `Bedrooms`, `Bathrooms`, `Floor_Area`, `Status`, `Description`, `Photo_URL`, `Featured` (checkbox), `Listed_Date` (date) |
| **Notes**, **Tasks** (standard) | Portal messages | written by the portal |
| **Leads** (standard) | Client referrals | written by the portal; needs a `Referred_By` lookup and an `Inquiry_Type` picklist |

Many real estate orgs already have a listings module under a different name, or different field names. Every module and field API name can be overridden in `.env` (see `.env.example` and `src/config.js`), so there's no need to rename anything in Zoho. Only listings whose `Status` equals `CRM_PROPERTY_AVAILABLE_STATUS` (default `Available`) appear in search. A client can still open an off-market property if they have a deal on it.

**Featuring a property:** tick **Featured** on the listing in Zoho, and it appears in the showcase, newest `Listed_Date` first. If nothing is ticked, the showcase shows the newest available listings instead. Set `Listed_Date` to the acquisition or listing date; listings from the last 30 days get a "New" badge.

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

### 3. Create the first admin, then invite clients

```bash
npm run create-user -- --role admin --email you@brokerage.com --name "Your Name" --password 'a-strong-password'
```

Sign in as that admin and invite clients from **Users → Invite user**. A client's email must match a Contact in Zoho. You can also grant client access from the command line:

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

## AI features (OpenAI + Zoho MCP)

Set `OPENAI_API_KEY` in `.env` to switch these on. Without a key the portal works exactly as before and the AI panels are hidden.

| Feature | Where | What it does |
|---|---|---|
| **AI property search** | Find a Property | The client describes what they want in plain English ("3-bed in Austin or Dallas under 650k, ideally with a pool"). The AI runs listing searches itself, loosening them step by step if nothing fits, then ranks the results with a match score and a short reason. The filters it applied are filled into the form so the client can see and adjust them. Near matches say what they miss ("about 8% over budget"). |
| **Deals at a glance** | My Deals | An overview across the client's deals, plus which open deals need their attention first and why. |
| **What this means for you** | Each deal | A plain-language explanation of the current stage, the usual next steps, things to watch (for example, a closing date coming up or no update in weeks), and questions the client could ask their agent. |

### How it works

```
Client ─▶ Portal server ─▶ OpenAI (mini model)
              ▲                │ tool calls
              │                ▼
              │      Portal tools, locked to the signed-in client
              │      list_my_deals · get_deal · search_listings · get_listing
              │                │
              │                ▼
              └──── Zoho CRM via Zoho MCP (read-only COQL)
```

1. **The AI is an agent.** It decides which lookups it needs and calls the portal's tools (`src/ai/portalTools.js`), up to `AI_MAX_STEPS` rounds.
2. **The tools are locked to the client in code.** Each request gets a fresh set of tools bound to the signed-in client's Contact ID. The model never receives a raw Zoho tool, so no prompt can make it read another client's deals.
3. **The tools read Zoho through MCP.** With `ZOHO_MCP_URL` set (and `ZOHO_MODE=live`), every AI lookup is a COQL query sent to your Zoho MCP server. The MCP server key stays on the portal server and is never sent to OpenAI. Without `ZOHO_MCP_URL`, the AI uses the same CRM connection as the pages (REST, or sample data in mock mode).
4. **The pages still use Zoho's REST API.** Deal lists, status, search and messages keep using REST, which is fast and predictable.

### Connecting Zoho MCP

1. In Zoho CRM go to **Setup > Developer Hub > MCP for AI Agents**. Create or open a server with **read-only** CRM tools (data insights / COQL), and copy its URL. The URL contains the server's key, so treat it like a password.
2. Add it to `.env`:
   ```
   ZOHO_MODE=live
   ZOHO_MCP_URL=https://...zohomcp.../mcp/...
   ```
3. Run `npm run mcp:check -- --schemas`. It lists your server's tools and their arguments, checks them against `config/zoho-mcp-tools.json`, and runs one test COQL query.
4. **Edit `config/zoho-mcp-tools.json` to match.** The tool names and argument shapes shipped there are placeholders, because Zoho doesn't publish them; they depend on your server. Only the COQL tool is required. `getUser` (agent details) and `getFields` (stage order, filter choices) are optional, and without them the configured defaults are used.

### Choosing the model

`OPENAI_MODEL` defaults to `gpt-5-mini`, OpenAI's low-cost "mini" tier. Change it at any time; any current OpenAI model with tool calling and Structured Outputs works. `OPENAI_BASE_URL` points the portal at any OpenAI-compatible endpoint (for example, a gateway).

Zoho's own model, Zia LLM, is currently only available inside Zoho's apps, with no public API that an outside portal can call. If Zoho opens one up, it can be added as another provider behind the same interface (`chat()` in `src/ai/openaiClient.js`).

### Safety and cost

- **Your data stays the source of truth.** The model only interprets and explains. Prices, addresses and stages shown on screen come from the CRM records the tools returned. A listing ID the model invents is discarded. A listing from the final search that the model left out is still shown, just without a reason.
- **Structured output only.** Every final answer uses a strict JSON schema, and dashboard priorities can only name the client's own deal IDs.
- **Minimal data sent.** The tools return deal and listing facts only, never the client's email, phone or the agent's contact details. CRM text is passed as data, and the prompts tell the model not to follow instructions inside it. Tool errors reach the model as a generic message; details stay in the server log.
- **Client-facing guardrails.** The model is told not to invent facts or give legal or financial advice, and every AI panel carries a "confirm with your agent" note.
- **Cost control.** Each client is limited to `AI_MAX_REQUESTS_PER_HOUR` (default 30) and each request to `AI_MAX_STEPS` model rounds (default 6). Deal insights are cached until the deal changes or the day rolls over. A slow or failed AI call never blocks the page.

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
    index.js         Wires the AI: model client + which CRM path it reads through
    openaiClient.js  OpenAI Chat Completions client (tool calls, Structured Outputs)
    agent.js         Tool-calling loop with a step limit
    portalTools.js   The AI's only tools, locked to the signed-in client
    prompts.js       System prompts + JSON schemas for every AI feature
    aiService.js     AI search, deal insights, caching and per-client limits
  mcp/
    mcpConnection.js MCP client (Streamable HTTP, official SDK)
    zohoMcpApi.js    Read-only Zoho CRM access as COQL over Zoho MCP
  routes/ai.js       /api/ai/* endpoints (hidden when no OpenAI key is set)
  store/userStore.js Portal logins (email -> password hash -> Zoho Contact id)
config/zoho-mcp-tools.json  Maps portal reads to your Zoho MCP server's tools
scripts/create-user.js
scripts/zoho-mcp-check.js   npm run mcp:check
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
