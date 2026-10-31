"""Builds docs/presentation/data-model.html (client presentation of the data
model and data flow) from app/db.py.  Run: python docs/presentation/build.py"""

from __future__ import annotations

import html
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from app.cli import DESCRIPTIONS, GROUPS, _type  # noqa: E402
from app.db import Base  # noqa: E402

TABLES = {t.name: t for t in Base.metadata.sorted_tables}
esc = html.escape

# ---- ER diagram (hand-placed boxes, orthogonal links) ------------------------------
W, HEAD, ROW, PAD = 210, 30, 21, 10
COLS = {1: 30, 2: 290, 3: 550, 4: 810}
BOXES = {  # name: (col, top, group, rows)
    "crm_properties": (1, 70, "crm", [("PK", "id"), ("UK", "zoho_id"), ("", "city · price · status"), ("", "listing_type · bedrooms"), ("", "featured · listed_date")]),
    "crm_deals": (2, 70, "crm", [("PK", "id"), ("UK", "zoho_id"), ("FK", "contact_zoho_id"), ("FK", "property_zoho_id"), ("FK", "stage"), ("FK", "owner_zoho_id"), ("", "amount · closing_date")]),
    "crm_deal_stages": (3, 70, "crm", [("PK", "name"), ("", "sequence"), ("", "is_won · is_lost")]),
    "sync_state": (4, 70, "crm", [("PK", "module"), ("", "last_modified_at"), ("", "last_status · records")]),
    "crm_messages": (1, 340, "crm", [("PK", "id"), ("UK", "zoho_id"), ("FK", "contact_zoho_id"), ("FK", "deal_zoho_id"), ("FK", "property_zoho_id"), ("", "direction · subject · body")]),
    "crm_contacts": (2, 340, "crm", [("PK", "id"), ("UK", "zoho_id"), ("", "first_name · last_name"), ("", "email · phone"), ("FK", "owner_zoho_id")]),
    "crm_leads": (3, 340, "crm", [("PK", "id"), ("UK", "zoho_id"), ("", "kind: signup | referral"), ("FK", "referred_by_zoho_id"), ("FK", "owner_zoho_id"), ("FK", "portal_user_id"), ("", "lead_status · match_criteria")]),
    "crm_agents": (4, 340, "crm", [("PK", "id"), ("UK", "zoho_id"), ("", "full_name"), ("", "email · phone")]),
    "crm_tasks": (1, 600, "crm", [("PK", "id"), ("UK", "zoho_id"), ("FK", "message_zoho_id"), ("FK", "owner_zoho_id"), ("FK", "contact · deal"), ("", "status · due_date")]),
    "consents": (1, 870, "own", [("PK", "id"), ("FK", "user_id"), ("", "kind · policy_version"), ("", "granted_at · ip")]),
    "users": (2, 870, "own", [("PK", "id"), ("UK", "email"), ("", "role · status"), ("", "zoho_contact_id ⇢ contacts"), ("", "zoho_lead_id ⇢ leads"), ("", "session_version")]),
    "otp_challenges": (3, 870, "own", [("PK", "id"), ("FK", "user_id"), ("", "purpose · code_hash"), ("", "attempts · expires_at")]),
    "activity_events": (4, 870, "own", [("PK", "seq"), ("UK", "id"), ("", "actor_user_id ⇢ users"), ("", "action · details · ip"), ("", "prev_hash → hash")]),
}
# (points from child to parent, label, label position)
LINKS = [
    ([(290, 150), (240, 150)], "property", (265, 141)),
    ([(500, 120), (550, 120)], "stage", (525, 111)),
    ([(395, 257), (395, 340)], "client", (418, 300)),
    ([(480, 257), (480, 288), (940, 288), (940, 340)], "deal owner", (700, 281)),
    ([(135, 340), (135, 215)], "about", (158, 270)),
    ([(200, 340), (200, 305), (320, 305), (320, 257)], "about", (260, 298)),
    ([(240, 400), (290, 400)], "on", (265, 391)),
    ([(460, 340), (460, 320), (880, 320), (880, 340)], "client's agent", (700, 313)),
    ([(550, 400), (500, 400)], "referrer", (525, 391)),
    ([(760, 400), (810, 400)], "owner", (785, 391)),
    ([(135, 600), (135, 506)], "from", (158, 556)),
    ([(240, 640), (380, 640), (380, 485)], "who", (310, 633)),
    ([(240, 700), (915, 700), (915, 464)], "task owner", (790, 693)),
    ([(700, 527), (700, 845), (470, 845), (470, 870)], "guest account", (600, 838)),
    ([(240, 930), (290, 930)], "user", (265, 921)),
    ([(550, 930), (500, 930)], "user", (525, 921)),
]


def box(name: str) -> str:
    col, top, group, rows = BOXES[name]
    x = COLS[col]
    h = HEAD + ROW * len(rows) + PAD
    out = [f'<g class="ent ent-{group}">',
           f'<rect x="{x}" y="{top}" width="{W}" height="{h}" rx="6" class="ent-body"/>',
           f'<path d="M{x} {top + 6} a6 6 0 0 1 6 -6 h{W - 12} a6 6 0 0 1 6 6 v{HEAD - 6} h-{W} z" class="ent-head"/>',
           f'<text x="{x + 12}" y="{top + 20}" class="ent-name">{esc(name)}</text>']
    for i, (key, label) in enumerate(rows):
        y = top + HEAD + ROW * i + 16
        if key:
            out.append(f'<text x="{x + 12}" y="{y}" class="ent-key key-{key.lower()}">{key}</text>')
        out.append(f'<text x="{x + 40}" y="{y}" class="ent-col">{esc(label)}</text>')
    out.append("</g>")
    return "\n".join(out)


def link(points, label, pos) -> str:
    d = "M" + " L".join(f"{x} {y}" for x, y in points)
    lx, ly = pos
    return (f'<path d="{d}" class="rel" marker-start="url(#many)" marker-end="url(#one)"/>'
            f'<text x="{lx}" y="{ly}" class="rel-label" text-anchor="middle">{esc(label)}</text>')


def erd_svg() -> str:
    return f'''<svg viewBox="0 0 1050 1060" role="img" aria-label="Entity relationship diagram of the 13 tables: nine copied from Zoho CRM and four owned by the portal, with their primary keys, unique Zoho ids and foreign keys." class="erd">
<defs>
  <marker id="many" viewBox="0 0 12 12" refX="12" refY="6" markerWidth="12" markerHeight="12" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
    <path d="M0 6 L12 0 M0 6 L12 6 M0 6 L12 12" fill="none" stroke="currentColor" stroke-width="1.4"/></marker>
  <marker id="one" viewBox="0 0 12 12" refX="12" refY="6" markerWidth="12" markerHeight="12" markerUnits="userSpaceOnUse" orient="auto">
    <path d="M7 0 L7 12" fill="none" stroke="currentColor" stroke-width="1.6"/></marker>
</defs>
<rect x="10" y="12" width="1030" height="786" rx="10" class="zone zone-crm"/>
<text x="30" y="40" class="zone-label">CRM COPY · synced from Zoho CRM (source of truth)</text>
<rect x="10" y="812" width="1030" height="240" rx="10" class="zone zone-own"/>
<text x="30" y="840" class="zone-label">PORTAL-OWNED · held only in the portal database</text>
{"".join(link(*l) for l in LINKS)}
{"".join(box(n) for n in BOXES)}
</svg>'''


# ---- Data flow diagram ------------------------------------------------------------------
def flow_svg() -> str:
    def node(x, y, w, h, title, sub, cls=""):
        return (f'<g class="node {cls}"><rect x="{x}" y="{y}" width="{w}" height="{h}" rx="8"/>'
                f'<text x="{x + w / 2}" y="{y + h / 2 - 4}" text-anchor="middle" class="node-title">{esc(title)}</text>'
                f'<text x="{x + w / 2}" y="{y + h / 2 + 14}" text-anchor="middle" class="node-sub">{esc(sub)}</text></g>')

    def arrow(d, label, lx, ly, cls=""):
        return (f'<path d="{d}" class="flow {cls}" marker-end="url(#arrow)"/>'
                f'<text x="{lx}" y="{ly}" text-anchor="middle" class="flow-label">{esc(label)}</text>')

    return f'''<svg viewBox="0 0 1000 430" role="img" aria-label="Data flow: the browser talks only to the portal. The portal writes to Zoho CRM first, Zoho sends changes back to the portal by webhook plus a catch-up sync, and the portal keeps its Supabase copy updated and reads from it. AI lookups and sign-in emails also go through the portal." class="flowsvg">
<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" orient="auto-start-reverse">
<path d="M0 0 L10 5 L0 10 z" fill="currentColor"/></marker></defs>
{node(20, 180, 150, 70, "Client's browser", "portal pages")}
{node(300, 165, 200, 100, "Portal app", "Zoho Catalyst", "accent")}
{node(700, 25, 250, 90, "Zoho CRM", "source of truth · Zoho MCP")}
{node(700, 315, 250, 90, "Supabase PostgreSQL", "portal schema: copy + own data")}
{node(300, 20, 200, 60, "Zoho ZeptoMail", "sign-in codes")}
{node(300, 350, 200, 60, "OpenAI", "AI matcher and insights")}
{arrow("M170 205 L298 205", "requests", 234, 197)}
{arrow("M298 228 L172 228", "pages", 234, 246)}
{arrow("M500 185 L698 80", "1 · writes first; AI lookups (MCP)", 580, 118)}
{arrow("M745 117 L520 205", "2 · webhook on change + catch-up every 10 min", 668, 182, "accent")}
{arrow("M500 245 L698 350", "3 · updates its copy", 620, 286)}
{arrow("M698 375 L502 262", "reads in milliseconds", 560, 348)}
{arrow("M400 163 L400 82", "codes", 424, 128)}
{arrow("M400 267 L400 348", "AI requests", 437, 310)}
</svg>'''


# ---- Data dictionary -------------------------------------------------------------------------
def dictionary() -> str:
    parts = []
    for gname, gdesc, names in GROUPS:
        parts.append(f'<h3 class="group-title">{esc(gname)} <span>{esc(gdesc)}</span></h3><div class="dict-grid">')
        for name in names:
            t = TABLES[name]
            rows = []
            for c in t.columns:
                keys = []
                if c.primary_key:
                    keys.append('<span class="pill pk">PK</span>')
                if c.unique:
                    keys.append('<span class="pill uk">UK</span>')
                for f in c.foreign_keys:
                    keys.append(f'<span class="pill fk" title="references {esc(f.column.table.name)}.{esc(f.column.name)}">FK → {esc(f.column.table.name)}</span>')
                comment = c.comment or ""
                src = ""
                if comment.startswith("Zoho: "):
                    zoho, _, rest = comment[6:].partition(". ")
                    src = f'<code class="zoho">{esc(zoho)}</code>'
                    comment = rest
                rows.append(f'<tr><td><code>{esc(c.name)}</code></td><td class="type">{esc(_type(c))}{"" if c.nullable or c.primary_key else " · required"}</td>'
                            f'<td>{"".join(keys)}</td><td>{src}{" " if src and comment else ""}{esc(comment)}</td></tr>')
            parts.append(f'''<section class="dict-card" id="t-{name}"><header><h4><code>{esc(name)}</code></h4><p>{esc(DESCRIPTIONS[name])}</p></header>
<div class="scroll"><table><thead><tr><th>Column</th><th>Type</th><th>Key</th><th>Zoho source / meaning</th></tr></thead><tbody>{"".join(rows)}</tbody></table></div></section>''')
        parts.append("</div>")
    return "\n".join(parts)


n_crm = sum(1 for n in TABLES if n.startswith("crm_") or n == "sync_state")
n_cols = sum(len(t.columns) for t in TABLES.values())
n_fk = sum(len(t.foreign_keys) for t in TABLES.values())

PAGE = f'''<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Client Portal Data Model</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Serif:wght@500;600&display=swap" rel="stylesheet">
<style>
:root {{
  /* Layout: a technical brief. Narrow reading column, full-width figures. Blue = data copied from Zoho, amber = data the portal owns. */
  --ink: #17212b; --muted: #5a6875; --paper: #f7f8f6; --surface: #ffffff; --line: #d9dee2;
  --crm: #2c5d8f; --crm-soft: #e6eef6; --own: #a5621a; --own-soft: #f8ecdc; --good: #2f7a52;
  --display: "IBM Plex Serif", Georgia, serif; --body: "IBM Plex Sans", system-ui, sans-serif; --mono: "IBM Plex Mono", ui-monospace, monospace;
  color-scheme: light;
}}
@media (prefers-color-scheme: dark) {{ :root:not([data-theme="light"]) {{
  --ink: #e6ebef; --muted: #9aa8b4; --paper: #11161b; --surface: #182029; --line: #2b3742;
  --crm: #7fb0e3; --crm-soft: #1b2b3c; --own: #e2a35d; --own-soft: #33251a; --good: #6cc394; color-scheme: dark; }} }}
:root[data-theme="dark"] {{
  --ink: #e6ebef; --muted: #9aa8b4; --paper: #11161b; --surface: #182029; --line: #2b3742;
  --crm: #7fb0e3; --crm-soft: #1b2b3c; --own: #e2a35d; --own-soft: #33251a; --good: #6cc394; color-scheme: dark; }}
* {{ box-sizing: border-box; }}
body {{ margin: 0; background: var(--paper); color: var(--ink); font: 16px/1.6 var(--body); }}
main {{ max-width: 1120px; margin: 0 auto; padding: 40px 20px 80px; display: grid; gap: 56px; }}
h1, h2, h3, h4 {{ text-wrap: balance; margin: 0; line-height: 1.2; }}
h1 {{ font: 600 2.4rem/1.15 var(--display); }}
h2 {{ font: 600 1.6rem/1.2 var(--display); margin-bottom: 8px; }}
p {{ margin: 0; max-width: 68ch; }}
code {{ font-family: var(--mono); font-size: 0.86em; }}
.muted {{ color: var(--muted); }}
.eyebrow {{ font: 600 0.75rem/1 var(--mono); letter-spacing: 0.12em; text-transform: uppercase; color: var(--crm); margin-bottom: 12px; }}
header.top {{ display: grid; gap: 14px; }}
.facts {{ display: flex; flex-wrap: wrap; gap: 10px; margin-top: 8px; }}
.fact {{ background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 10px 14px; min-width: 130px; }}
.fact b {{ display: block; font: 600 1.5rem/1.1 var(--display); font-variant-numeric: tabular-nums; }}
.fact span {{ font-size: 0.82rem; color: var(--muted); }}
section > .lead {{ margin-bottom: 20px; color: var(--muted); }}
figure {{ margin: 0; background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 20px; }}
figure .scroll {{ overflow-x: auto; }}
figcaption {{ margin-top: 12px; font-size: 0.9rem; color: var(--muted); max-width: 90ch; }}
svg {{ display: block; width: 100%; height: auto; color: var(--ink); font-family: var(--body); }}
.erd {{ min-width: 820px; }}
.flowsvg {{ min-width: 720px; }}
.zone {{ stroke: none; }} .zone-crm {{ fill: var(--crm-soft); }} .zone-own {{ fill: var(--own-soft); }}
.zone-label {{ font: 600 11px var(--mono); letter-spacing: 0.08em; fill: var(--muted); }}
.ent-body {{ fill: var(--surface); stroke: var(--line); }}
.ent-crm .ent-head {{ fill: var(--crm); }} .ent-own .ent-head {{ fill: var(--own); }}
.ent-name {{ font: 600 12.5px var(--mono); fill: #fff; }}
.ent-col {{ font: 12px var(--mono); fill: var(--ink); }}
.ent-key {{ font: 600 10px var(--mono); }} .key-pk {{ fill: var(--own); }} .key-uk {{ fill: var(--good); }} .key-fk {{ fill: var(--crm); }}
.rel {{ fill: none; stroke: currentColor; stroke-width: 1.3; opacity: 0.75; }}
.rel-label, .flow-label {{ font: 11px var(--body); fill: var(--muted); paint-order: stroke; stroke: var(--surface); stroke-width: 4px; }}
.node rect {{ fill: var(--surface); stroke: var(--ink); stroke-width: 1.2; }}
.node.accent rect {{ stroke: var(--crm); stroke-width: 2; fill: var(--crm-soft); }}
.node-title {{ font: 600 13px var(--body); fill: var(--ink); }}
.node-sub {{ font: 11.5px var(--body); fill: var(--muted); }}
.flow {{ fill: none; stroke: currentColor; stroke-width: 1.4; }}
.flow.accent {{ stroke: var(--crm); color: var(--crm); }}
.legend {{ display: flex; flex-wrap: wrap; gap: 16px; font-size: 0.85rem; color: var(--muted); margin-top: 10px; }}
.legend span::before {{ content: ""; display: inline-block; width: 12px; height: 12px; border-radius: 3px; margin-right: 6px; vertical-align: -1px; }}
.legend .l-crm::before {{ background: var(--crm); }} .legend .l-own::before {{ background: var(--own); }}
.cards {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 14px; margin-top: 18px; }}
.card {{ background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 16px 18px; display: grid; gap: 6px; align-content: start; }}
.card h3 {{ font: 600 1rem var(--body); }}
.card .stat {{ font: 600 1.15rem var(--display); color: var(--crm); }}
.card p {{ font-size: 0.93rem; color: var(--muted); }}
table {{ width: 100%; border-collapse: collapse; font-size: 0.9rem; }}
th {{ text-align: left; font: 600 0.72rem var(--mono); letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); padding: 8px 10px; border-bottom: 1px solid var(--line); }}
td {{ padding: 8px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }}
tbody tr:last-child td {{ border-bottom: 0; }}
.where-table {{ background: var(--surface); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }}
.where-table td:first-child {{ font-weight: 600; }}
.tag {{ display: inline-block; font: 600 0.72rem var(--mono); padding: 2px 8px; border-radius: 999px; white-space: nowrap; }}
.tag-crm {{ background: var(--crm-soft); color: var(--crm); }} .tag-own {{ background: var(--own-soft); color: var(--own); }} .tag-no {{ background: transparent; color: var(--muted); border: 1px solid var(--line); }}
.group-title {{ font: 600 1.15rem var(--display); margin: 28px 0 12px; }}
.group-title span {{ font: 400 0.9rem var(--body); color: var(--muted); margin-left: 8px; }}
.dict-grid {{ display: grid; gap: 14px; }}
.dict-card {{ background: var(--surface); border: 1px solid var(--line); border-radius: 10px; }}
.dict-card header {{ padding: 14px 16px 6px; display: grid; gap: 2px; }}
.dict-card h4 code {{ font-size: 1rem; }}
.dict-card header p {{ font-size: 0.9rem; color: var(--muted); }}
.dict-card .scroll {{ overflow-x: auto; padding: 0 6px 6px; }}
.dict-card td {{ font-size: 0.86rem; }}
.dict-card td.type {{ font-family: var(--mono); font-size: 0.8rem; color: var(--muted); white-space: nowrap; }}
.pill {{ display: inline-block; font: 600 0.68rem var(--mono); padding: 1px 6px; border-radius: 4px; margin: 0 4px 2px 0; white-space: nowrap; }}
.pill.pk {{ background: var(--own-soft); color: var(--own); }} .pill.uk {{ background: transparent; color: var(--good); border: 1px solid currentColor; }} .pill.fk {{ background: var(--crm-soft); color: var(--crm); }}
code.zoho {{ color: var(--crm); font-weight: 600; }}
.status {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 14px; }}
.status .card h3::before {{ content: ""; display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 8px; background: var(--good); }}
.status .card.next h3::before {{ background: var(--own); }}
.status ul {{ margin: 4px 0 0; padding-left: 18px; font-size: 0.92rem; color: var(--muted); display: grid; gap: 4px; }}
footer {{ font-size: 0.85rem; color: var(--muted); border-top: 1px solid var(--line); padding-top: 16px; }}
a {{ color: var(--crm); }}
:focus-visible {{ outline: 2px solid var(--crm); outline-offset: 2px; }}
@media (max-width: 640px) {{ h1 {{ font-size: 1.8rem; }} main {{ gap: 40px; padding-top: 24px; }} }}
</style>
</head>
<body>
<main>
<header class="top">
  <div class="eyebrow">Client Portal · Database design · Proposed v1</div>
  <h1>What the portal stores, and how it stays in step with Zoho CRM</h1>
  <p class="muted">The portal runs on Zoho Catalyst with a Supabase PostgreSQL database. Zoho CRM remains the master record for every client,
    deal, listing and lead. The database keeps the portal's own data plus a synced copy of the Zoho records it shows, so pages load fast
    without hammering the Zoho API.</p>
  <div class="facts">
    <div class="fact"><b>{len(TABLES)}</b><span>tables</span></div>
    <div class="fact"><b>{n_crm}</b><span>synced from Zoho</span></div>
    <div class="fact"><b>{len(TABLES) - n_crm}</b><span>owned by the portal</span></div>
    <div class="fact"><b>{n_cols}</b><span>columns</span></div>
    <div class="fact"><b>{n_fk}</b><span>foreign keys</span></div>
  </div>
</header>

<section>
  <h2>How data moves</h2>
  <p class="lead">Clients only ever talk to the portal. Every change is written to Zoho first; Zoho then tells the portal what changed.</p>
  <figure><div class="scroll">{flow_svg()}</div>
    <figcaption>Reads come from the portal's own copy in Supabase. Writes (messages, referrals, sign-ups, guests' search criteria) go to Zoho CRM
      first and update the copy straight after. Changes agents make in Zoho reach the portal by webhook within seconds, with a catch-up sync every
      10 minutes as a safety net. The AI never touches Zoho directly: it asks the portal, which looks records up through Zoho MCP for that client only.</figcaption></figure>
  <div class="cards">
    <div class="card"><h3>Fast pages</h3><div class="stat">Database reads, not API calls</div>
      <p>A dashboard is one indexed query on the copy, instead of several Zoho API calls (contact, related deals, each deal's agent) per page view.</p></div>
    <div class="card"><h3>Zoho stays in charge</h3><div class="stat">Write to Zoho, then copy</div>
      <p>The portal never edits its copy on its own. If a Zoho write fails, nothing changes and the client is asked to retry.</p></div>
    <div class="card"><h3>Fresh within seconds</h3><div class="stat">Webhook + 10-minute catch-up</div>
      <p>Each copied row keeps Zoho's record id and Modified_Time, so the sync only fetches what changed since its last run.</p></div>
    <div class="card"><h3>Within Zoho's API limits</h3><div class="stat">Calls scale with changes, not visits</div>
      <p>Zoho CRM limits API calls per day. Reading from the copy means 1,000 clients refreshing their dashboard costs no extra Zoho calls.</p></div>
  </div>
</section>

<section>
  <h2>What is stored where</h2>
  <p class="lead">Only what the portal shows is copied. Internal agent notes and everything else in Zoho stay in Zoho.</p>
  <div class="where-table"><div class="scroll" style="overflow-x:auto"><table>
    <thead><tr><th>Data</th><th>Master record</th><th>In the portal database</th><th>Why</th></tr></thead>
    <tbody>
      <tr><td>Clients, agents, deals, pipeline stages</td><td>Zoho CRM</td><td><span class="tag tag-crm">Synced copy</span></td><td>My Deals, deal status and AI insights load instantly</td></tr>
      <tr><td>Property listings</td><td>Zoho CRM (Properties)</td><td><span class="tag tag-crm">Synced copy</span></td><td>Search, filters and the featured showcase run as database queries</td></tr>
      <tr><td>Guest sign-ups and referrals</td><td>Zoho CRM (Leads)</td><td><span class="tag tag-crm">Synced copy</span></td><td>Referral progress and admin reports without API calls</td></tr>
      <tr><td>Portal messages and follow-up tasks</td><td>Zoho CRM (Notes, Tasks)</td><td><span class="tag tag-crm">Synced copy</span></td><td>The conversation thread; internal notes are never copied</td></tr>
      <tr><td>Logins, roles, consents, sign-in codes</td><td>Portal</td><td><span class="tag tag-own">Portal-owned</span></td><td>Security data Zoho has no place for</td></tr>
      <tr><td>Activity log</td><td>Portal</td><td><span class="tag tag-own">Portal-owned</span></td><td>Tamper-evident audit trail, admins only</td></tr>
      <tr><td>Everything else in Zoho (accounts, internal notes, other modules)</td><td>Zoho CRM</td><td><span class="tag tag-no">Not stored</span></td><td>Not shown in the portal</td></tr>
    </tbody></table></div></div>
</section>

<section>
  <h2>Database diagram</h2>
  <p class="lead">Every table has a primary key. Copied tables keep a portal id plus the unique Zoho record id, and link to each other through it.</p>
  <figure><div class="scroll">{erd_svg()}</div>
    <figcaption>Crow's foot marks the "many" side of each link. PK = primary key, UK = unique key (the Zoho record id), FK = foreign key.
      Dotted arrows inside a box (⇢) are links matched on Zoho ids but not enforced, because logins and the CRM copy are written at different times.
      Not drawn to keep the picture readable: <code>crm_tasks</code> also references the deal. All links are listed in the data dictionary below.</figcaption>
    <div class="legend"><span class="l-crm">Copied from Zoho CRM</span><span class="l-own">Owned by the portal</span></div>
  </figure>
</section>

<section>
  <h2>Data dictionary</h2>
  <p class="lead">Each column, its type and keys, and the Zoho field it comes from. Generated from the code, so it always matches the real schema.</p>
  {dictionary()}
</section>

<section>
  <h2>Where we are</h2>
  <div class="status">
    <div class="card"><h3>Built and tested</h3><ul>
      <li>All {len(TABLES)} tables, keys and rules, in a private <code>portal</code> schema</li>
      <li>Schema applied and the full test suite passing on PostgreSQL 16 (Supabase runs PostgreSQL)</li>
      <li>Supabase lockdown: no access through Supabase's public Data API</li>
      <li>Portal-owned tables in use: logins, consents, sign-in codes, audit trail</li></ul></div>
    <div class="card next"><h3>Next to build</h3><ul>
      <li>The Zoho → portal sync: webhook receiver and 10-minute catch-up, filling the copied tables</li>
      <li>Switch page reads (deals, listings, referrals, messages) from live Zoho calls to the copy</li>
      <li>Connect a live Zoho CRM org and Supabase project, then measure page load times</li></ul></div>
  </div>
</section>

<footer>Source: <code>app/db.py</code> in the Client Portal repository. SQL: <code>db/schema.sql</code>. Field mapping: <code>docs/ZOHO_FIELDS.md</code>.</footer>
</main>
</body>
</html>
'''

out = Path(__file__).with_name("data-model.html")
out.write_text(PAGE)
print(f"Wrote {out.relative_to(ROOT)}")
