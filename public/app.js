'use strict';

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

const app = document.getElementById('app');
const state = { config: null, me: null, notice: null };

class Raw {
  constructor(value) { this.value = value; }
  toString() { return this.value; }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function interpolate(value) {
  if (value === null || value === undefined || value === false) return '';
  if (value instanceof Raw) return value.value;
  if (Array.isArray(value)) return value.map(interpolate).join('');
  return escapeHtml(value);
}

// Tagged template that HTML-escapes every interpolated value. CRM data is
// untrusted, so all markup goes through this.
function html(strings, ...values) {
  return new Raw(strings.reduce((out, str, i) => out + str + (i < values.length ? interpolate(values[i]) : ''), ''));
}

function render(view) {
  app.innerHTML = String(view);
}

const PUBLIC_AUTH_PATHS = /^\/auth\/(login|signup|password|otp|me)/;

// Every request has a time limit (longer for AI), so a stalled network never
// leaves the page hanging.
async function api(path, { method = 'GET', body, timeoutMs } = {}) {
  const controller = new AbortController();
  const limit = timeoutMs || (path.startsWith('/ai/') ? 120000 : 30000);
  const timer = setTimeout(() => controller.abort(), limit);
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
      signal: controller.signal,
    });
  } catch (err) {
    throw new Error(err.name === 'AbortError'
      ? 'This is taking longer than expected. Please check your connection and try again.'
      : 'Could not reach the server. Please check your connection and try again.');
  } finally {
    clearTimeout(timer);
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && state.me && !PUBLIC_AUTH_PATHS.test(path)) {
    signOut('expired');
    throw new Error(data.error || 'Please sign in.');
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  idle.lastServerContact = Date.now();
  return data;
}

function money(amount) {
  if (amount === null || amount === undefined) return '—';
  return new Intl.NumberFormat(state.config?.locale || 'en-US', {
    style: 'currency', currency: state.config?.currency || 'USD', maximumFractionDigits: 0,
  }).format(amount);
}

function formatDate(value, withTime = false) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(state.config?.locale || 'en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
    ...(withTime ? { hour: 'numeric', minute: '2-digit' } : {}),
  });
}

function initials(name) {
  return String(name || '?').split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
}

function safeImageUrl(url) {
  try {
    return new URL(url).protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function setBusy(button, busy, label) {
  button.disabled = busy;
  if (label) button.textContent = label;
}

function alertBox(kind, message) {
  return html`<div class="alert alert-${kind}" role="${kind === 'error' ? 'alert' : 'status'}">${message}</div>`;
}

function showError(err) {
  render(html`<div class="card">${alertBox('error', err.message)}<a href="${homeHash()}">Back to the start page</a></div>`);
}

// ---------------------------------------------------------------------------
// Shared components
// ---------------------------------------------------------------------------

function stageClass(stage, { wonStages, lostStages }) {
  if (wonStages.includes(stage)) return 'won';
  if (lostStages.includes(stage)) return 'lost';
  return 'active';
}

function stageBadge(stage, ctx) {
  const kind = stageClass(stage, ctx);
  const cls = kind === 'won' ? 'badge-won' : kind === 'lost' ? 'badge-lost' : '';
  return html`<span class="badge ${cls}">${stage || 'No stage'}</span>`;
}

// The open pipeline excludes terminal stages, so "Closed Lost" is not drawn as
// a step past "Closed Won".
function openStages(stages, ctx) {
  return stages.filter((s) => !ctx.wonStages.includes(s) && !ctx.lostStages.includes(s));
}

function pipelineBar(deal, stages, ctx) {
  const steps = openStages(stages, ctx);
  const kind = stageClass(deal.stage, ctx);
  const reached = kind === 'won' ? steps.length : steps.indexOf(deal.stage) + 1;
  const total = steps.length + 1; // + the closing step
  return html`<ol class="pipeline ${kind}" aria-label="Deal progress: ${deal.stage}">
    ${Array.from({ length: total }, (_, i) => html`<li class="${i < reached || kind === 'won' ? 'done' : ''}"></li>`)}
  </ol>`;
}

function stageStepper(deal, stages, ctx) {
  const kind = stageClass(deal.stage, ctx);
  const steps = [...openStages(stages, ctx), kind === 'lost' ? deal.stage : ctx.wonStages[0] || 'Closed'];
  const currentIndex = kind === 'won' ? steps.length - 1 : steps.indexOf(deal.stage);
  return html`<ol class="stepper">
    ${steps.map((step, i) => {
      const cls = [i <= currentIndex && kind !== 'lost' ? 'done' : '', i === currentIndex ? 'current' : ''].join(' ');
      return html`<li class="${cls}"><span>${step}${i === currentIndex ? ' — current stage' : ''}</span></li>`;
    })}
  </ol>`;
}

function agentCard(agent, { withButton = true } = {}) {
  if (!agent) return html`<div class="card"><h3>Your agent</h3><p class="muted">No agent has been assigned yet.</p></div>`;
  return html`<div class="card">
    <h3>Your agent</h3>
    <div class="agent">
      <div class="avatar" aria-hidden="true">${initials(agent.name)}</div>
      <div><div><strong>${agent.name}</strong></div><div class="muted small">Real estate agent</div></div>
    </div>
    <div class="agent-links">
      ${agent.email ? html`<a href="mailto:${agent.email}">${agent.email}</a>` : ''}
      ${agent.phone ? html`<a href="tel:${agent.phone.replace(/[^+\d]/g, '')}">${agent.phone}</a>` : ''}
    </div>
    ${withButton ? html`<p></p><a class="btn btn-block" href="#/messages">Send a message</a>` : ''}
  </div>`;
}

const ICONS = {
  house: new Raw('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" aria-hidden="true"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9v12h14V9"/><path d="M10 21v-6h4v6"/></svg>'),
  building: new Raw('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="3" width="14" height="18" rx="1"/><path d="M9 7h2M13 7h2M9 11h2M13 11h2M9 15h2M13 15h2M11 21v-3h2v3"/></svg>'),
};
const NEW_LISTING_DAYS = 30;

function isNewListing(p) {
  if (!p.listedDate) return false;
  const age = (Date.now() - new Date(p.listedDate)) / 86400000;
  return age >= 0 && age <= NEW_LISTING_DAYS;
}

function propertyPhoto(property, extraClass = '') {
  const url = safeImageUrl(property.photoUrl);
  const multiUnit = /condo|apartment|commercial|multi/i.test(property.propertyType || '');
  return html`<div class="property-photo ${extraClass}">
    ${url
      ? html`<img src="${url}" alt="" loading="lazy">`
      : html`<div class="photo-placeholder">${multiUnit ? ICONS.building : ICONS.house}<span>${property.city || property.propertyType || ''}</span></div>`}
    <div class="photo-badges">
      ${property.listingType ? html`<span class="badge badge-light">For ${property.listingType.toLowerCase()}</span>` : ''}
      <span class="photo-badges-end">
        ${property.featured ? html`<span class="badge badge-featured">Featured</span>` : ''}
        ${isNewListing(property) ? html`<span class="badge badge-new">New</span>` : ''}
      </span>
    </div>
  </div>`;
}

function propertySpecs(p) {
  return html`<div class="property-specs">
    ${p.bedrooms !== null ? html`<span>${p.bedrooms} bd</span>` : ''}
    ${p.bathrooms !== null ? html`<span>${p.bathrooms} ba</span>` : ''}
    ${p.floorArea !== null ? html`<span>${p.floorArea.toLocaleString()} sq ft</span>` : ''}
    ${p.propertyType ? html`<span>${p.propertyType}</span>` : ''}
  </div>`;
}

function priceLabel(p) {
  return html`${money(p.price)}${p.listingType === 'Rent' ? html`<span class="muted small"> / month</span>` : ''}`;
}

function propertyCard(p, match = null) {
  return html`<article class="card property-card">
    ${propertyPhoto(p)}
    <div class="property-body">
      <div class="property-price">${priceLabel(p)}</div>
      <h3>${p.name}</h3>
      <div class="muted small">${[p.address, p.city].filter(Boolean).join(', ')}</div>
      ${propertySpecs(p)}
      ${p.listedDate ? html`<div class="listed-date">Listed ${formatDate(p.listedDate)}</div>` : ''}
      ${match?.reason ? html`<div class="ai-reason">
        <span class="badge badge-ai">${match.score}% match</span>
        <span>${match.reason}</span>
      </div>` : ''}
    </div>
    <div class="property-actions actions">
      <a class="btn btn-secondary btn-sm" href="#/properties/${encodeURIComponent(p.id)}">View details</a>
      ${isGuest() ? '' : html`<a class="btn btn-sm" href="#/messages?propertyId=${encodeURIComponent(p.id)}">I'm interested</a>`}
    </div>
  </article>`;
}

// AI panels render immediately with a placeholder and fill in when the model
// answers, so a slow AI response never blocks the page itself.
function aiPanel(id, title) {
  if (!state.config.aiEnabled) return '';
  return html`<section class="card ai-card" id="${id}" aria-live="polite">
    <div class="ai-label">AI insight</div>
    <h2>${title}</h2>
    <div class="ai-body"><p class="ai-loading">Analysing your deal records…</p></div>
  </section>`;
}

async function fillAiPanel(id, path, renderBody) {
  const panel = document.getElementById(id);
  if (!panel) return;
  const body = panel.querySelector('.ai-body');
  try {
    const data = await api(path);
    if (panel.isConnected) body.innerHTML = String(renderBody(data));
  } catch (err) {
    if (panel.isConnected) body.innerHTML = String(html`<p class="muted small">${err.message}</p>`);
  }
}

const AI_DISCLAIMER = html`<p class="ai-disclaimer">Generated by AI from your deal records. Please confirm anything important with your agent.</p>`;

function bulletList(title, items) {
  return items?.length ? html`<h3>${title}</h3><ul class="ai-list">${items.map((i) => html`<li>${i}</li>`)}</ul>` : '';
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

function loginView() {
  render(html`<div class="login-wrap">
    <div class="card login-card">
      <div class="brand"><span class="brand-mark" aria-hidden="true"></span>${state.config.brandName}</div>
      <div id="login-step">
      <h1>Sign in</h1>
      <p class="muted">Track your deals, search properties and talk to your agent.</p>
      ${state.notice ? alertBox('success', state.notice) : ''}
      <div id="login-error"></div>
      <form class="form" id="login-form">
        <label>Email<input type="email" name="email" autocomplete="username" required></label>
        <label>Password<input type="password" name="password" autocomplete="current-password" required></label>
        <button class="btn btn-block" type="submit">Continue</button>
      </form>
      <p class="muted small"><a href="#/forgot">Forgot your password?</a></p>
      </div>
      ${state.config.mode === 'mock' ? html`<p class="muted small">Demo logins: client <strong>alex@client.example</strong> / demo1234 ·
        admin <strong>admin@brokerage.example</strong> / admin1234</p>` : ''}
      <p class="muted small">New here? <a href="#/signup">Create a free account</a> to browse our available properties.</p>
      <p class="muted small"><a href="#/privacy">Privacy notice</a></p>
    </div>
  </div>`);
  state.notice = null;

  const finish = async () => {
    await loadMe();
    navigate(homeHash());
  };
  document.getElementById('login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.target.querySelector('button');
    setBusy(button, true, 'Checking…');
    try {
      const result = await api('/auth/login', { method: 'POST', body: formData(event.target) });
      if (!result.otpRequired) return finish();
      showCodeStep(document.getElementById('login-step'), result, {
        title: 'Check your email',
        onCancel: () => loginView(),
        verify: async (challengeId, code) => {
          await api('/auth/login/verify', { method: 'POST', body: { challengeId, code } });
          await finish();
        },
      });
    } catch (err) {
      document.getElementById('login-error').innerHTML = String(alertBox('error', err.message));
      setBusy(button, false, 'Continue');
    }
  });
}

async function dashboardView() {
  const data = await api('/dashboard');
  const ctx = { wonStages: data.wonStages, lostStages: data.lostStages };
  const { summary } = data;
  const firstName = state.me?.user.firstName || state.me?.user.name || '';

  render(html`
    <div class="page-head">
      <div>
        <h1>Welcome back${firstName ? `, ${firstName}` : ''}</h1>
        <p class="muted">Here is where each of your property deals stands today.</p>
      </div>
      <a class="btn" href="#/search">Find a property</a>
    </div>

    <div class="grid grid-stats">
      <div class="card stat"><div class="stat-label">Total deals</div><div class="stat-value">${summary.total}</div></div>
      <div class="card stat"><div class="stat-label">In progress</div><div class="stat-value">${summary.active}</div></div>
      <div class="card stat"><div class="stat-label">Closed won</div><div class="stat-value">${summary.won}</div></div>
      <div class="card stat"><div class="stat-label">Closed lost</div><div class="stat-value">${summary.lost}</div></div>
    </div>

    <div class="layout-2 section">
      <section>
        ${data.deals.length ? aiPanel('ai-overview', 'Your deals at a glance') : ''}
        <div class="section-head ${state.config.aiEnabled && data.deals.length ? 'section' : ''}"><h2>My deals</h2><span class="muted small">${summary.total} total</span></div>
        ${data.deals.length
          ? html`<div class="deal-list">${data.deals.map((deal) => html`
              <a class="card deal-row" href="#/deals/${encodeURIComponent(deal.id)}">
                <div class="deal-row-head">
                  <div>
                    <h3>${deal.name}</h3>
                    ${deal.property ? html`<div class="muted small">${deal.property.name}</div>` : ''}
                  </div>
                  ${stageBadge(deal.stage, ctx)}
                </div>
                ${pipelineBar(deal, data.stages, ctx)}
                <div class="deal-meta">
                  <span>Amount <strong>${money(deal.amount)}</strong></span>
                  <span>Target close <strong>${formatDate(deal.closingDate)}</strong></span>
                  ${deal.type ? html`<span>Type <strong>${deal.type}</strong></span>` : ''}
                </div>
              </a>`)}</div>`
          : html`<div class="card empty"><p>You don't have any deals yet.</p><a class="btn" href="#/search">Start a property search</a></div>`}
      </section>
      <aside class="grid">${agentCard(state.me?.agent)}
        <div class="card referral-cta">
          <h3>Know someone looking for land or a home?</h3>
          <p class="muted small">Refer them to your agent and track how it's going.</p>
          <a class="btn btn-secondary btn-block" href="#/referrals">Refer a friend</a>
        </div>
      </aside>
    </div>

    <section class="section" id="showcase" hidden>
      <div class="section-head">
        <div><h2>New to our portfolio</h2><p class="muted small">Featured properties we've recently acquired.</p></div>
        <a href="#/search">Browse all listings →</a>
      </div>
      <div class="grid grid-cards" id="showcase-grid"></div>
    </section>`);

  api('/properties/featured?limit=3').then(({ properties }) => {
    const section = document.getElementById('showcase');
    if (!section || !properties.length) return;
    document.getElementById('showcase-grid').innerHTML = String(html`${properties.map((p) => propertyCard(p))}`);
    section.hidden = false;
  }).catch(() => {});

  fillAiPanel('ai-overview', '/ai/insights', (insight) => html`
    <p>${insight.overview}</p>
    ${insight.priorities.length ? html`<h3>Needs your attention</h3>
      <ul class="ai-list">${insight.priorities.map((p) => html`
        <li><a href="#/deals/${encodeURIComponent(p.dealId)}">${p.dealName}</a>: ${p.note}</li>`)}</ul>` : ''}
    ${AI_DISCLAIMER}`);
}

async function dealView(id) {
  const { deal, property, stages, wonStages, lostStages } = await api(`/deals/${encodeURIComponent(id)}`);
  const ctx = { wonStages, lostStages };

  render(html`
    <a class="back" href="#/dashboard">← Back to my deals</a>
    <div class="page-head">
      <div><h1>${deal.name}</h1>${stageBadge(deal.stage, ctx)}</div>
      <a class="btn" href="#/messages?dealId=${encodeURIComponent(deal.id)}">Ask about this deal</a>
    </div>

    <div class="layout-2">
      <div class="grid">
        <section class="card">
          <h2>Deal details</h2>
          <dl class="details">
            <div><dt>Amount</dt><dd>${money(deal.amount)}</dd></div>
            <div><dt>Target closing date</dt><dd>${formatDate(deal.closingDate)}</dd></div>
            <div><dt>Deal type</dt><dd>${deal.type || '—'}</dd></div>
            <div><dt>Last updated</dt><dd>${formatDate(deal.modifiedAt)}</dd></div>
          </dl>
          ${deal.description ? html`<h3>Latest update</h3><p>${deal.description}</p>` : ''}
        </section>

        ${aiPanel('ai-deal', 'What this means for you')}

        ${property ? html`<section class="card property-card">
          ${propertyPhoto(property)}
          <div class="property-body">
            <div class="property-price">${priceLabel(property)}</div>
            <h3>${property.name}</h3>
            <div class="muted small">${[property.address, property.city].filter(Boolean).join(', ')}</div>
            ${propertySpecs(property)}
          </div>
          <div class="property-actions"><a class="btn btn-secondary btn-sm" href="#/properties/${encodeURIComponent(property.id)}">View property</a></div>
        </section>` : ''}
      </div>

      <aside class="grid">
        <section class="card"><h2>Deal status</h2>${stageStepper(deal, stages, ctx)}</section>
        ${agentCard(deal.agent || state.me?.agent)}
      </aside>
    </div>`);

  fillAiPanel('ai-deal', `/ai/deals/${encodeURIComponent(deal.id)}/insights`, (insight) => html`
    <h3 class="ai-headline">${insight.headline}</h3>
    <p>${insight.summary}</p>
    ${bulletList('Next steps', insight.nextSteps)}
    ${bulletList('Keep an eye on', insight.watchOuts)}
    ${bulletList('Questions you could ask your agent', insight.questionsToAsk)}
    ${insight.questionsToAsk.length ? html`<a class="btn btn-secondary btn-sm" href="#/messages?dealId=${encodeURIComponent(deal.id)}">Ask my agent</a>` : ''}
    ${AI_DISCLAIMER}`);
}

// ---------------------------------------------------------------------------
// Property search: one search bar (AI-powered when enabled) plus a filter bar.
// The AI fills the same filters a client can set by hand, so there is a single
// set of criteria and the client can always see and adjust what was searched.
// ---------------------------------------------------------------------------

const SEARCH_KEY = 'portal.search.v2';
const EMPTY_FILTERS = {
  budgetMin: null, budgetMax: null, locations: [], listingType: null, propertyType: null,
  minBedrooms: null, minBathrooms: null, minFloorArea: null, keywords: null,
};
const SORTS = {
  best: { label: 'Best match' },
  price_asc: { label: 'Price: low to high', key: 'price', dir: 1 },
  price_desc: { label: 'Price: high to low', key: 'price', dir: -1 },
  newest: { label: 'Newest listings', key: 'listedDate', dir: -1 },
  bedrooms_desc: { label: 'Most bedrooms', key: 'bedrooms', dir: -1 },
  area_desc: { label: 'Largest floor area', key: 'floorArea', dir: -1 },
};
const LISTING_LABELS = { Sale: 'Buy', Rent: 'Rent' };

const search = {
  query: '',
  filters: { ...EMPTY_FILTERS },
  sort: 'price_asc',
  options: { propertyTypes: [], listingTypes: [] },
  items: null, // [{ property, score, reason }] or null before the first search
  ai: null, // AI interpretation for the current results, if they came from AI search
  note: null,
  chips: [],
};

function loadSavedSearch() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(SEARCH_KEY) || 'null');
    return saved && typeof saved === 'object' ? saved : null;
  } catch {
    return null;
  }
}

function saveSearch() {
  try {
    sessionStorage.setItem(SEARCH_KEY, JSON.stringify({ query: search.query, filters: search.filters, sort: search.sort }));
  } catch {
    // Storage unavailable (private mode): the search still works, it just isn't remembered.
  }
}

function clearSavedSearch() {
  try {
    sessionStorage.removeItem(SEARCH_KEY);
  } catch {
    // ignore
  }
}

function compactMoney(amount) {
  return new Intl.NumberFormat(state.config?.locale || 'en-US', {
    style: 'currency', currency: state.config?.currency || 'USD', notation: 'compact', maximumFractionDigits: 1,
  }).format(amount);
}

function priceSummary(f) {
  if (f.budgetMin !== null && f.budgetMax !== null) return `${compactMoney(f.budgetMin)} – ${compactMoney(f.budgetMax)}`;
  if (f.budgetMax !== null) return `Up to ${compactMoney(f.budgetMax)}`;
  if (f.budgetMin !== null) return `From ${compactMoney(f.budgetMin)}`;
  return null;
}

function hasFilters(f) {
  return f.locations.length > 0 || Object.keys(EMPTY_FILTERS).some((k) => k !== 'locations' && f[k] !== null);
}

// Removable chips describing every active filter.
function filterChips(f) {
  const chips = f.locations.map((loc) => ({ label: loc, clear: () => { f.locations = f.locations.filter((l) => l !== loc); } }));
  const price = priceSummary(f);
  if (price) chips.push({ label: price, clear: () => { f.budgetMin = null; f.budgetMax = null; } });
  if (f.listingType) chips.push({ label: f.listingType === 'Rent' ? 'For rent' : `For ${f.listingType.toLowerCase()}`, clear: () => { f.listingType = null; } });
  if (f.propertyType) chips.push({ label: f.propertyType, clear: () => { f.propertyType = null; } });
  if (f.minBedrooms !== null) chips.push({ label: `${f.minBedrooms}+ beds`, clear: () => { f.minBedrooms = null; } });
  if (f.minBathrooms !== null) chips.push({ label: `${f.minBathrooms}+ baths`, clear: () => { f.minBathrooms = null; } });
  if (f.minFloorArea !== null) chips.push({ label: `${Number(f.minFloorArea).toLocaleString()}+ sq ft`, clear: () => { f.minFloorArea = null; } });
  if (f.keywords) chips.push({ label: `“${f.keywords}”`, clear: () => { f.keywords = null; } });
  return chips;
}

function numberOrNull(value) {
  if (value === '' || value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function filterDropdown(name, label, value, body) {
  return html`<details class="filter ${value ? 'is-active' : ''}" data-filter="${name}">
    <summary><span class="filter-label">${label}</span>${value ? html`<span class="filter-value">${value}</span>` : ''}</summary>
    <div class="filter-pop">${body}</div>
  </details>`;
}

function optionButtons(attr, options, current) {
  return html`<div class="option-grid">${options.map(([value, label]) => html`
    <button type="button" class="option ${String(current ?? '') === String(value) ? 'is-selected' : ''}" data-${new Raw(attr)}="${value}">${label}</button>`)}</div>`;
}

function renderFilterBar() {
  const f = search.filters;
  const { listingTypes, propertyTypes } = search.options;
  const bar = document.getElementById('filter-bar');
  bar.innerHTML = String(html`
    <div class="segmented" role="group" aria-label="Buy or rent">
      ${[['', 'All'], ...listingTypes.map((t) => [t, LISTING_LABELS[t] || t])].map(([value, label]) => html`
        <button type="button" data-listing="${value}" aria-pressed="${String((f.listingType || '') === value)}">${label}</button>`)}
    </div>
    ${filterDropdown('location', 'Location', f.locations.length ? `${f.locations[0]}${f.locations.length > 1 ? ` +${f.locations.length - 1}` : ''}` : null, html`
      <label>Cities or areas<input type="text" name="locations" placeholder="e.g. Austin, Dallas" value="${f.locations.join(', ')}"></label>
      <p class="hint muted">Separate several with commas.</p>
      <div class="filter-actions"><button type="button" class="btn btn-sm" data-apply="location">Apply</button></div>`)}
    ${filterDropdown('price', 'Price', priceSummary(f), html`
      <div class="form-row">
        <label>Min<input type="number" name="budgetMin" min="0" step="1000" inputmode="numeric" placeholder="No min" value="${f.budgetMin ?? ''}"></label>
        <label>Max<input type="number" name="budgetMax" min="0" step="1000" inputmode="numeric" placeholder="No max" value="${f.budgetMax ?? ''}"></label>
      </div>
      <p class="hint muted">Rental prices are per month.</p>
      <div class="filter-actions"><button type="button" class="btn btn-sm" data-apply="price">Apply</button></div>`)}
    ${filterDropdown('beds', 'Beds', f.minBedrooms !== null ? `${f.minBedrooms}+` : null,
      optionButtons('beds', [['', 'Any'], [1, '1+'], [2, '2+'], [3, '3+'], [4, '4+'], [5, '5+']], f.minBedrooms))}
    ${filterDropdown('type', 'Home type', f.propertyType,
      optionButtons('type', [['', 'Any type'], ...propertyTypes.map((t) => [t, t])], f.propertyType))}
    ${filterDropdown('more', 'More', [f.minBathrooms !== null, f.minFloorArea !== null, Boolean(f.keywords)].filter(Boolean).length || null, html`
      <label>Bathrooms
        <select name="minBathrooms">
          ${[['', 'Any'], [1, '1+'], [1.5, '1.5+'], [2, '2+'], [3, '3+'], [4, '4+']].map(([v, l]) => html`
            <option value="${v}" ${String(f.minBathrooms ?? '') === String(v) ? new Raw('selected') : ''}>${l}</option>`)}
        </select></label>
      <label>Min floor area (sq ft)<input type="number" name="minFloorArea" min="0" step="50" value="${f.minFloorArea ?? ''}"></label>
      <label>Keywords<input type="text" name="keywords" placeholder="e.g. garage, pool" value="${f.keywords ?? ''}"></label>
      <div class="filter-actions"><button type="button" class="btn btn-sm" data-apply="more">Apply</button></div>`)}
  `);

  search.chips = filterChips(f);
  document.getElementById('active-filters').innerHTML = String(search.chips.length ? html`
    ${search.chips.map((chip, i) => html`<button type="button" class="filter-chip" data-chip="${i}" aria-label="Remove filter ${chip.label}">
      ${chip.label}<span aria-hidden="true">×</span></button>`)}
    <button type="button" class="link-button" data-clear-all>Clear all</button>` : '');
}

function applyDropdown(name, pop) {
  const f = search.filters;
  const value = (field) => pop.querySelector(`[name=${field}]`)?.value;
  if (name === 'location') {
    f.locations = [...new Set(value('locations').split(',').map((s) => s.trim()).filter(Boolean))].slice(0, 5);
  } else if (name === 'price') {
    f.budgetMin = numberOrNull(value('budgetMin'));
    f.budgetMax = numberOrNull(value('budgetMax'));
  } else if (name === 'more') {
    f.minBathrooms = numberOrNull(value('minBathrooms'));
    f.minFloorArea = numberOrNull(value('minFloorArea'));
    f.keywords = value('keywords').trim() || null;
  }
}

function sortedItems() {
  const sort = SORTS[search.sort];
  if (!sort?.key) return search.items; // "best": keep the AI ranking
  return [...search.items].sort((a, b) => {
    const x = a.property[sort.key];
    const y = b.property[sort.key];
    if (x === y) return 0;
    if (x === null || x === undefined) return 1;
    if (y === null || y === undefined) return -1;
    return (x > y ? 1 : -1) * sort.dir;
  });
}

function skeletonGrid() {
  return html`<div class="grid grid-cards" aria-hidden="true">${Array.from({ length: 6 }, () => html`
    <div class="card property-card skeleton"><div class="property-photo"></div><div class="property-body">
      <div class="skeleton-line w40"></div><div class="skeleton-line w80"></div><div class="skeleton-line w60"></div></div></div>`)}</div>`;
}

function renderResults() {
  const results = document.getElementById('results');
  if (search.items === null) return showcase(results);

  const count = search.items.length;
  const sortOptions = Object.entries(SORTS).filter(([key]) => key !== 'best' || search.ai);
  results.innerHTML = String(html`
    ${search.ai ? html`<div class="ai-banner">
      <div class="ai-label">AI search</div>
      <p>${search.ai.interpretation}</p>
      ${search.ai.preferences.length ? html`<div class="chips"><span class="muted small">Also looking for:</span>${search.ai.preferences.map((p) => html`<span class="chip">${p}</span>`)}</div>` : ''}
      ${search.ai.relaxed && count ? html`<div class="alert alert-warning">Nothing matched every requirement, so these are the closest options. Each one notes what it's missing.</div>` : ''}
      ${search.ai.overview ? html`<p class="muted">${search.ai.overview}</p>` : ''}
    </div>` : ''}
    ${search.note ? html`<p class="results-note muted small">${search.note}</p>` : ''}
    <div class="results-head">
      <h2>${count} ${search.ai?.relaxed ? 'near ' : ''}${count === 1 ? 'property' : 'properties'}</h2>
      ${count > 1 ? html`<label class="sort-control">Sort by
        <select id="sort-select">${sortOptions.map(([key, s]) => html`
          <option value="${key}" ${search.sort === key ? new Raw('selected') : ''}>${s.label}</option>`)}</select></label>` : ''}
    </div>
    ${count
      ? html`<div class="grid grid-cards">${sortedItems().map((item) => propertyCard(item.property, item.reason ? item : null))}</div>`
      : html`<div class="card empty">
          <p><strong>No available properties match these filters.</strong></p>
          <p>Try removing a filter above, or let your agent know what you're looking for.</p>
          ${isGuest() ? html`<p class="muted small">Our agents have your search details and will reach out with options.</p>` : html`<a class="btn" href="#/messages?search=1">Ask my agent to find one</a>`}
        </div>`}`);
}

async function showcase(container) {
  container.innerHTML = String(skeletonGrid());
  try {
    const { properties } = await api('/properties/featured?limit=6');
    if (!container.isConnected || search.items !== null) return;
    container.innerHTML = String(properties.length ? html`
      <div class="results-head"><div>
        <h2>Featured &amp; newly acquired</h2>
        <p class="muted small">The latest additions to our portfolio. Search above to find your perfect match.</p>
      </div></div>
      <div class="grid grid-cards">${properties.map((p) => propertyCard(p))}</div>` : '');
  } catch {
    container.innerHTML = '';
  }
}

async function runFilteredSearch({ note = null } = {}) {
  const results = document.getElementById('results');
  search.ai = null;
  search.note = note;
  if (search.sort === 'best') search.sort = 'price_asc';
  renderFilterBar();
  saveSearch();
  if (!hasFilters(search.filters)) {
    search.items = null;
    return renderResults();
  }
  results.innerHTML = String(skeletonGrid());
  try {
    const data = await api('/properties/search', { method: 'POST', body: search.filters });
    search.items = data.properties.map((property) => ({ property }));
    renderResults();
  } catch (err) {
    results.innerHTML = String(alertBox('error', err.message));
  }
}

async function runAiSearch(query) {
  const results = document.getElementById('results');
  const button = document.getElementById('search-submit');
  setBusy(button, true, 'Searching…');
  results.innerHTML = String(html`<p class="ai-working"><span class="ai-label">AI search</span> Reading your request and checking our listings…</p>${skeletonGrid()}`);
  try {
    const data = await api('/ai/property-search', { method: 'POST', body: { query } });
    search.filters = { ...EMPTY_FILTERS, ...(data.criteria || {}), keywords: null };
    search.items = data.results;
    search.ai = { interpretation: data.interpretation, preferences: data.preferences, overview: data.overview, relaxed: data.relaxed };
    search.note = null;
    search.sort = 'best';
    renderFilterBar();
    saveSearch();
    renderResults();
  } catch (err) {
    results.innerHTML = String(alertBox('error', err.message));
  } finally {
    setBusy(button, false, 'Search');
  }
}

async function searchView() {
  search.options = await api('/properties/options');
  const saved = loadSavedSearch();
  search.query = saved?.query || '';
  search.filters = { ...EMPTY_FILTERS, ...(saved?.filters || {}) };
  search.sort = saved?.sort && SORTS[saved.sort] && saved.sort !== 'best' ? saved.sort : 'price_asc';
  search.items = null;
  search.ai = null;
  search.note = null;
  const aiOn = state.config.aiEnabled;

  render(html`
    <section class="search-hero">
      <h1>Find your next property</h1>
      <p>${aiOn
        ? 'Describe what you want in your own words, or narrow things down with the filters.'
        : 'Search by city, then narrow things down with the filters.'}</p>
      <form class="search-box" id="search-form" role="search">
        <label class="visually-hidden" for="search-query">${aiOn ? 'Describe the property you are looking for' : 'City or area'}</label>
        <input id="search-query" name="query" type="search" autocomplete="off" maxlength="500" value="${search.query}"
          placeholder="${aiOn ? 'e.g. 3-bed family home in Austin or Dallas under $650k, ideally with a pool' : 'City or area, e.g. Austin, Dallas'}">
        <button class="btn" type="submit" id="search-submit">Search</button>
      </form>
      ${aiOn ? html`<p class="search-hint"><span class="ai-dot" aria-hidden="true"></span>AI search understands budgets, locations, bedrooms and wishes like "quiet street" or "home office".</p>` : ''}
    </section>
    ${isGuest() ? html`<div class="guest-note" role="note"><strong>Welcome, ${state.me.user.name.split(' ')[0]}.</strong>
      You're browsing as a guest. One of our agents will follow up on what you're searching for, and once you're working on a deal with us, it will appear right here in your portal.</div>` : ''}
    <div class="filter-toolbar">
      <div class="filter-bar" id="filter-bar" role="toolbar" aria-label="Search filters"></div>
      <div class="active-filters" id="active-filters"></div>
    </div>
    <section id="results" aria-live="polite"></section>`);

  renderFilterBar();
  if (hasFilters(search.filters)) runFilteredSearch();
  else renderResults();

  document.getElementById('search-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const query = event.target.query.value.trim();
    search.query = query;
    if (!query) return runFilteredSearch();
    if (aiOn) return runAiSearch(query);
    search.filters.locations = [...new Set(query.split(',').map((s) => s.trim()).filter(Boolean))].slice(0, 5);
    runFilteredSearch();
  });

  const toolbar = document.querySelector('.filter-toolbar');
  const afterManualChange = () => runFilteredSearch({ note: search.ai ? 'Filters changed, so these are exact matches for your filters rather than the AI ranking.' : null });

  toolbar.addEventListener('click', (event) => {
    const target = event.target.closest('button');
    if (!target) return;
    const f = search.filters;
    if (target.dataset.listing !== undefined) {
      f.listingType = target.dataset.listing || null;
    } else if (target.dataset.beds !== undefined) {
      f.minBedrooms = numberOrNull(target.dataset.beds);
    } else if (target.dataset.type !== undefined) {
      f.propertyType = target.dataset.type || null;
    } else if (target.dataset.apply) {
      applyDropdown(target.dataset.apply, target.closest('.filter-pop'));
    } else if (target.dataset.chip !== undefined) {
      search.chips[Number(target.dataset.chip)]?.clear();
    } else if (target.dataset.clearAll !== undefined) {
      search.filters = { ...EMPTY_FILTERS };
      search.query = '';
      document.getElementById('search-query').value = '';
      clearSavedSearch();
    } else {
      return;
    }
    afterManualChange();
  });

  // Enter inside a dropdown applies it.
  toolbar.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.target.tagName !== 'INPUT') return;
    event.preventDefault();
    const pop = event.target.closest('.filter-pop');
    const name = pop?.closest('.filter')?.dataset.filter;
    if (!name) return;
    applyDropdown(name, pop);
    afterManualChange();
  });

  // Only one dropdown open at a time.
  toolbar.addEventListener('toggle', (event) => {
    if (!event.target.open) return;
    toolbar.querySelectorAll('details.filter[open]').forEach((d) => { if (d !== event.target) d.open = false; });
    event.target.querySelector('input, select, button.option')?.focus();
  }, true);

  document.getElementById('results').addEventListener('change', (event) => {
    if (event.target.id !== 'sort-select') return;
    search.sort = event.target.value;
    saveSearch();
    renderResults();
  });
}

// Close filter dropdowns on outside click or Escape.
document.addEventListener('click', (event) => {
  document.querySelectorAll('details.filter[open]').forEach((d) => { if (!d.contains(event.target)) d.open = false; });
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  document.querySelectorAll('details.filter[open]').forEach((d) => {
    d.open = false;
    d.querySelector('summary').focus();
  });
});

async function propertyView(id) {
  const { property: p } = await api(`/properties/${encodeURIComponent(id)}`);
  render(html`
    <a class="back" href="#/search">← Back to search</a>
    ${propertyPhoto(p, 'property-hero')}
    <div class="layout-2">
      <section class="card">
        <div class="page-head">
          <div>
            <h1>${p.name}</h1>
            <div class="muted">${[p.address, p.city].filter(Boolean).join(', ')}</div>
          </div>
          <div class="property-price">${priceLabel(p)}</div>
        </div>
        <dl class="details">
          <div><dt>Bedrooms</dt><dd>${p.bedrooms ?? '—'}</dd></div>
          <div><dt>Bathrooms</dt><dd>${p.bathrooms ?? '—'}</dd></div>
          <div><dt>Floor area</dt><dd>${p.floorArea !== null ? `${p.floorArea.toLocaleString()} sq ft` : '—'}</dd></div>
          <div><dt>Type</dt><dd>${p.propertyType || '—'}</dd></div>
          <div><dt>Listing</dt><dd>${p.listingType ? `For ${p.listingType}` : '—'}</dd></div>
          <div><dt>Status</dt><dd>${p.status || '—'}</dd></div>
        </dl>
        ${p.description ? html`<h3>About this property</h3><p>${p.description}</p>` : ''}
      </section>
      <aside class="grid">
        ${isGuest()
          ? html`<div class="card"><h3>Interested?</h3>
              <p class="muted small">Our agents can see the properties and budget you're searching for and will reach out with next steps, including viewings.</p></div>`
          : html`<div class="card">
              <h3>Interested?</h3>
              <p class="muted small">Send your agent a message to book a viewing or ask a question about this property.</p>
              <a class="btn btn-block" href="#/messages?propertyId=${encodeURIComponent(p.id)}">Contact my agent</a>
            </div>
            ${agentCard(state.me?.agent, { withButton: false })}`}
      </aside>
    </div>`);
}

async function messagesView(params) {
  const dealId = params.get('dealId');
  const propertyId = params.get('propertyId');
  const [{ agent, messages }, dashboard, propertyData] = await Promise.all([
    api('/messages'),
    api('/dashboard'),
    propertyId ? api(`/properties/${encodeURIComponent(propertyId)}`).catch(() => null) : null,
  ]);
  const property = propertyData?.property;
  const deal = dashboard.deals.find((d) => d.id === dealId);

  let subject = '';
  let body = '';
  if (property) {
    subject = `Interested in ${property.name}`;
    body = `Hi ${agent?.name?.split(' ')[0] || 'there'},\n\nI'm interested in ${property.name}${property.address ? ` at ${property.address}` : ''}. Could we arrange a viewing?\n\nThanks`;
  } else if (deal) {
    subject = `Question about ${deal.name}`;
  } else if (params.get('search')) {
    const saved = loadSavedSearch() || {};
    const f = { ...EMPTY_FILTERS, ...(saved.filters || {}) };
    subject = 'Help me find a property';
    body = [
      "I couldn't find a match in the portal. Here is what I'm looking for:",
      saved.query ? `In my words: ${saved.query}` : null,
      f.budgetMin !== null || f.budgetMax !== null ? `Budget: ${f.budgetMin !== null ? money(f.budgetMin) : 'any'} – ${f.budgetMax !== null ? money(f.budgetMax) : 'any'}` : null,
      f.locations.length ? `Locations: ${f.locations.join(', ')}` : null,
      f.listingType ? `Looking to: ${f.listingType === 'Rent' ? 'rent' : 'buy'}` : null,
      f.propertyType ? `Type: ${f.propertyType}` : null,
      f.minBedrooms !== null ? `Bedrooms: ${f.minBedrooms}+` : null,
      f.keywords ? `Other: ${f.keywords}` : null,
    ].filter(Boolean).join('\n');
  }

  render(html`
    <div class="page-head">
      <div>
        <h1>Contact your agent</h1>
        <p class="muted">Messages go straight to your agent's CRM and they'll reply here or by email/phone.</p>
      </div>
    </div>
    <div class="layout-2">
      <div class="grid">
        <section class="card">
          <h2>Conversation</h2>
          <div class="thread" id="thread">
            ${messages.length
              ? messages.map(messageBubble)
              : html`<p class="muted" id="no-messages">No messages yet. Say hello!</p>`}
          </div>
        </section>
        <section class="card">
          <h2>New message</h2>
          <div id="message-status"></div>
          <form class="form" id="message-form">
            ${property ? html`<div id="property-context">
              <input type="hidden" name="propertyId" value="${property.id}">
              <div class="alert alert-success">About property: <strong>${property.name}</strong></div>
            </div>` : ''}
            <label>Related deal <span class="hint muted">Optional</span>
              <select name="dealId">
                <option value="">General question</option>
                ${dashboard.deals.map((d) => html`<option value="${d.id}" ${d.id === dealId ? new Raw('selected') : ''}>${d.name} (${d.stage})</option>`)}
              </select></label>
            <label>Subject<input type="text" name="subject" maxlength="120" required value="${subject}"></label>
            <label>Message<textarea name="body" maxlength="4000" required>${body}</textarea></label>
            <div><button class="btn" type="submit">Send message</button></div>
          </form>
        </section>
      </div>
      <aside>${agentCard(agent, { withButton: false })}</aside>
    </div>`);

  const thread = document.getElementById('thread');
  thread.scrollTop = thread.scrollHeight;

  const form = document.getElementById('message-form');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = form.querySelector('button');
    const status = document.getElementById('message-status');
    const payload = formData(form);
    if (!payload.dealId) delete payload.dealId;
    setBusy(button, true, 'Sending…');
    try {
      const { message } = await api('/messages', { method: 'POST', body: payload });
      document.getElementById('no-messages')?.remove();
      thread.insertAdjacentHTML('beforeend', String(messageBubble(message)));
      thread.scrollTop = thread.scrollHeight;
      // The property/deal context applied to that message only.
      document.getElementById('property-context')?.remove();
      form.reset();
      form.querySelector('[name=dealId]').value = '';
      form.querySelector('[name=subject]').value = '';
      form.querySelector('[name=body]').value = '';
      status.innerHTML = String(alertBox('success', 'Message sent. Your agent has been notified.'));
    } catch (err) {
      status.innerHTML = String(alertBox('error', err.message));
    } finally {
      setBusy(button, false, 'Send message');
    }
  });
}

function messageBubble(m) {
  return html`<div class="msg msg-from-${m.from}">
    <div class="msg-head"><span>${m.from === 'client' ? 'You' : m.author || 'Your agent'}</span><span>${formatDate(m.createdAt, true)}</span></div>
    ${m.subject ? html`<div class="msg-subject">${m.subject}</div>` : ''}
    <div class="msg-body">${m.body}</div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Routing & bootstrap
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Referral program
// ---------------------------------------------------------------------------

const REFERRAL_STEPS = [['received', 'Received'], ['in_touch', 'Agent in touch'], ['qualified', 'Qualified']];

function referralProgressBar(progress) {
  if (progress.step === 'closed') return html`<span class="badge badge-neutral">Closed</span>`;
  const reached = REFERRAL_STEPS.findIndex(([step]) => step === progress.step);
  return html`<ol class="referral-steps" aria-label="Status: ${progress.label}">
    ${REFERRAL_STEPS.map(([, label], i) => html`<li class="${i <= reached ? 'done' : ''} ${i === reached ? 'current' : ''}">${label}</li>`)}
  </ol>`;
}

function referralItem(r) {
  return html`<li class="referral-item">
    <div class="referral-head">
      <div><strong>${r.name}</strong><div class="muted small">${r.interest} · referred ${formatDate(r.createdAt)}</div></div>
    </div>
    ${referralProgressBar(r.progress)}
  </li>`;
}

async function referralsView() {
  const data = await api('/referrals');
  render(html`
    <section class="referral-hero">
      <div>
        <h1>Refer a friend</h1>
        <p>Know someone looking for land, a home, or a place to rent, or thinking of selling? Introduce them and ${state.me?.agent?.name || 'your agent'} will take it from there.</p>
        ${data.rewardText ? html`<p class="referral-reward">${data.rewardText}</p>` : ''}
      </div>
    </section>
    <div class="layout-2">
      <section class="card">
        <h2>Who would you like to refer?</h2>
        <div id="referral-status"></div>
        <form class="form" id="referral-form">
          <fieldset class="interest-picker">
            <legend>They're interested in</legend>
            <div class="option-grid">${data.interests.map((interest, i) => html`
              <label class="option-radio"><input type="radio" name="interest" value="${interest}" ${i === 0 ? new Raw('checked') : ''}><span>${interest}</span></label>`)}</div>
          </fieldset>
          <label>Full name<input type="text" name="name" maxlength="120" required autocomplete="off"></label>
          <div class="form-row">
            <label>Email<input type="email" name="email" maxlength="200" autocomplete="off"></label>
            <label>Phone<input type="tel" name="phone" maxlength="40" autocomplete="off"></label>
          </div>
          <p class="hint muted small">Give at least one way for the agent to reach them.</p>
          <label>Anything the agent should know? <span class="hint muted">Optional</span>
            <textarea name="notes" maxlength="1000" placeholder="e.g. Looking for 2–5 acres outside the city to build on, budget around $250k"></textarea></label>
          <label class="checkbox"><input type="checkbox" name="consent" required>
            <span>They've agreed that I can share their details and that an agent may contact them.</span></label>
          <div><button class="btn" type="submit">Send referral</button></div>
        </form>
      </section>
      <aside class="card">
        <h2>Your referrals</h2>
        <ul class="referral-list" id="referral-list">${data.referrals.length
          ? data.referrals.map(referralItem)
          : html`<li class="muted small" id="no-referrals">You haven't referred anyone yet.</li>`}</ul>
      </aside>
    </div>`);

  const form = document.getElementById('referral-form');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const status = document.getElementById('referral-status');
    const button = form.querySelector('button[type=submit]');
    const values = formData(form);
    values.consent = form.elements.consent.checked;
    setBusy(button, true, 'Sending…');
    try {
      const { referral } = await api('/referrals', { method: 'POST', body: values });
      document.getElementById('no-referrals')?.remove();
      document.getElementById('referral-list').insertAdjacentHTML('afterbegin', String(referralItem(referral)));
      form.reset();
      status.innerHTML = String(alertBox('success', `Thank you! ${referral.name} has been passed to your agent.`));
    } catch (err) {
      status.innerHTML = String(alertBox('error', err.message));
    } finally {
      setBusy(button, false, 'Send referral');
    }
  });
}

function signupView() {
  render(html`<div class="signup-wrap">
    <section class="signup-pitch">
      <div class="brand"><span class="brand-mark" aria-hidden="true"></span>${state.config.brandName}</div>
      <h1>Find your next property</h1>
      <p>Create a free account to explore our available listings and get matched to homes and land that fit your budget.</p>
      <ul class="signup-points">
        <li>Browse every property we currently have available</li>
        <li>${state.config.aiEnabled ? 'Describe what you want in plain English and get matched' : 'Search by budget, location and size'}</li>
        <li>See our newest acquisitions first</li>
        <li>One of our agents follows up on what you're looking for</li>
      </ul>
    </section>
    <section class="card signup-card">
      <h2>Create your free account</h2>
      <div id="signup-error"></div>
      <form class="form" id="signup-form" novalidate>
        <label>Full name<input type="text" name="name" autocomplete="name" maxlength="120" required></label>
        <div class="form-row">
          <label>Email<input type="email" name="email" autocomplete="email" maxlength="200" required></label>
          <label>Phone <span class="hint muted">Optional</span><input type="tel" name="phone" autocomplete="tel" maxlength="40"></label>
        </div>
        <label>Password <span class="hint muted">At least 10 characters</span><input type="password" name="password" autocomplete="new-password" minlength="10" required></label>
        <fieldset class="interest-picker">
          <legend>I'm looking to</legend>
          <div class="option-grid">
            <label class="option-radio"><input type="radio" name="listingType" value="Sale" checked><span>Buy</span></label>
            <label class="option-radio"><input type="radio" name="listingType" value="Rent"><span>Rent</span></label>
          </div>
        </fieldset>
        <div class="form-row">
          <label>Budget up to <span class="hint muted">Optional</span><input type="number" name="budgetMax" min="0" step="1000" inputmode="numeric" placeholder="e.g. 650000"></label>
          <label>Preferred location <span class="hint muted">Optional</span><input type="text" name="location" maxlength="80" placeholder="e.g. Austin"></label>
        </div>
        <label class="checkbox"><input type="checkbox" name="consent" required>
          <span>I agree that ${state.config.brandName} may contact me about properties that match what I'm looking for, and I've read the <a href="#/privacy" target="_blank" rel="noopener">privacy notice</a>.</span></label>
        <button class="btn btn-block" type="submit">Create account</button>
      </form>
      <p class="muted small signup-switch">Already have an account? <a href="#/login">Sign in</a></p>
    </section>
  </div>`);

  document.getElementById('signup-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.target;
    const values = { ...formData(form), consent: form.elements.consent.checked };
    const button = form.querySelector('button[type=submit]');
    setBusy(button, true, 'Creating your account…');
    try {
      // Nothing is created until the email is confirmed with the code.
      const challenge = await api('/auth/signup', { method: 'POST', body: values });
      const card = document.querySelector('.signup-card');
      showCodeStep(card, challenge, {
        title: 'Confirm your email',
        onCancel: () => signupView(),
        verify: async (challengeId, code) => {
          const { initialFilters } = await api('/auth/signup/verify', { method: 'POST', body: { challengeId, code } });
          // Start the guest's first search from what they told us.
          try {
            sessionStorage.setItem(SEARCH_KEY, JSON.stringify({ query: '', filters: { ...EMPTY_FILTERS, ...initialFilters }, sort: 'price_asc' }));
          } catch {
            // Storage unavailable: they start from the showcase instead.
          }
          await loadMe();
          navigate(homeHash());
        },
      });
    } catch (err) {
      document.getElementById('signup-error').innerHTML = String(alertBox('error', err.message));
      setBusy(button, false, 'Create account');
    }
  });
}

// ---------------------------------------------------------------------------
// Sign-in security: emailed one-time codes, password reset, idle sign-out
// ---------------------------------------------------------------------------

// Shows the "enter the code we emailed you" step inside `container`.
// `verify(code)` completes the flow; it throws with a message on a wrong code.
function showCodeStep(container, challenge, { title, verify, onCancel }) {
  let current = challenge;
  container.innerHTML = String(html`
    <h1>${title}</h1>
    <p class="muted">We emailed a 6-digit code to <strong>${current.sentTo}</strong>. It expires in ${current.expiresInMinutes} minutes.</p>
    <div id="code-error"></div>
    <form class="form" id="code-form" novalidate>
      <label>Verification code
        <input class="code-input" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required autofocus></label>
      <button class="btn btn-block" type="submit">Verify</button>
    </form>
    <p class="muted small code-actions">
      <button type="button" class="link-button" id="code-resend">Send a new code</button> ·
      <button type="button" class="link-button" id="code-cancel">Start again</button>
    </p>
    <p class="muted small demo-code" id="demo-code" ${current.devCode ? '' : new Raw('hidden')}>Demo mode: your code is <strong>${current.devCode || ''}</strong> (emails are printed to the server log).</p>`);

  const form = container.querySelector('#code-form');
  const input = form.elements.code;
  input.focus();
  input.addEventListener('input', () => { input.value = input.value.replace(/\D/g, '').slice(0, 6); });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = form.querySelector('button');
    setBusy(button, true, 'Verifying…');
    try {
      await verify(current.challengeId, input.value);
    } catch (err) {
      container.querySelector('#code-error').innerHTML = String(alertBox('error', err.message));
      setBusy(button, false, 'Verify');
      input.select();
    }
  });
  container.querySelector('#code-resend').addEventListener('click', async (event) => {
    event.target.disabled = true;
    try {
      current = { ...current, ...(await api('/auth/otp/resend', { method: 'POST', body: { challengeId: current.challengeId } })) };
      container.querySelector('#code-error').innerHTML = String(alertBox('success', 'A new code is on its way.'));
      const demo = container.querySelector('#demo-code');
      if (current.devCode) demo.querySelector('strong').textContent = current.devCode;
    } catch (err) {
      container.querySelector('#code-error').innerHTML = String(alertBox('error', err.message));
    } finally {
      setTimeout(() => { event.target.disabled = false; }, 30000);
    }
  });
  container.querySelector('#code-cancel').addEventListener('click', onCancel);
}

function forgotPasswordView() {
  render(html`<div class="login-wrap"><div class="card login-card" id="forgot-card">
    <div class="brand"><span class="brand-mark" aria-hidden="true"></span>${state.config.brandName}</div>
    <h1>Reset your password</h1>
    <p class="muted">Enter your email and we'll send you a code to set a new password.</p>
    <div id="forgot-error"></div>
    <form class="form" id="forgot-form">
      <label>Email<input type="email" name="email" autocomplete="username" required></label>
      <button class="btn btn-block" type="submit">Send code</button>
    </form>
    <p class="muted small"><a href="#/login">Back to sign in</a></p>
  </div></div>`);

  document.getElementById('forgot-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.target.querySelector('button');
    setBusy(button, true, 'Sending…');
    try {
      const challenge = await api('/auth/password/forgot', { method: 'POST', body: formData(event.target) });
      const card = document.getElementById('forgot-card');
      showCodeStep(card, challenge, {
        title: 'Check your email',
        onCancel: () => forgotPasswordView(),
        verify: async (challengeId, code) => {
          // Ask for the new password only once the code has been typed.
          card.innerHTML = String(html`<h1>Choose a new password</h1>
            <div id="reset-error"></div>
            <form class="form" id="reset-form">
              <label>New password <span class="hint muted">At least 10 characters</span><input type="password" name="newPassword" autocomplete="new-password" minlength="10" required></label>
              <label>Confirm new password<input type="password" name="confirmPassword" autocomplete="new-password" required></label>
              <button class="btn btn-block" type="submit">Save password</button>
            </form>`);
          document.getElementById('reset-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const values = formData(e.target);
            const box = document.getElementById('reset-error');
            if (values.newPassword !== values.confirmPassword) {
              box.innerHTML = String(alertBox('error', 'The new passwords do not match.'));
              return;
            }
            try {
              await api('/auth/password/reset', { method: 'POST', body: { challengeId, code, newPassword: values.newPassword } });
              state.notice = 'Your password has been changed. Please sign in.';
              navigate('#/login');
            } catch (err) {
              box.innerHTML = String(alertBox('error', err.message));
              if (/code/i.test(err.message)) setTimeout(() => forgotPasswordView(), 2500);
            }
          });
        },
      });
    } catch (err) {
      document.getElementById('forgot-error').innerHTML = String(alertBox('error', err.message));
      setBusy(button, false, 'Send code');
    }
  });
}

function privacyView() {
  const c = state.config;
  render(html`<article class="card prose">
    <a class="back" href="${state.me ? homeHash() : '#/login'}">← Back</a>
    <h1>Privacy notice</h1>
    <p class="muted small">Version ${c.privacyPolicyVersion}. Template text for the proof of concept: have it reviewed for your jurisdiction before launch.</p>
    <h2>What we collect</h2>
    <ul>
      <li><strong>Account details:</strong> your name, email, phone (if given) and a securely hashed password.</li>
      <li><strong>What you're looking for:</strong> budget, locations and property searches, so our agents can help you.</li>
      <li><strong>Activity:</strong> sign-ins, pages and properties viewed, searches and messages (subject only), with IP address and browser, for security and service quality.</li>
      <li><strong>Your deals and messages</strong> are held in our CRM (Zoho CRM), not in this portal.</li>
    </ul>
    <h2>How we use it</h2>
    <p>To give you access to your deals, match you with properties, let our agents contact you about what you asked for, and keep the portal secure. ${c.aiEnabled ? 'AI features send search requests and deal facts (never your contact details) to our AI provider to produce matches and summaries.' : ''}</p>
    <h2>Who can see it</h2>
    <p>Only you and our staff. Activity logs are visible to our administrators only, never to other clients.</p>
    <h2>How long we keep it</h2>
    <p>Activity logs are deleted after the retention period set by ${c.brandName}. Sign-in codes are deleted within a day.</p>
    <h2>Your rights</h2>
    <p>You can ask for a copy of your data, a correction, or for your data to be erased, and you can withdraw consent to be contacted. Email <a href="mailto:${c.privacyContactEmail}">${c.privacyContactEmail}</a>.</p>
  </article>`);
}

// Signs the user out after a period without mouse, keyboard, touch or scroll
// activity (shared across tabs), with a warning two minutes before. The server
// enforces the same idle limit on its side.
const idle = {
  lastActivity: Date.now(),
  lastServerContact: Date.now(),
  timer: null,
  warning: null,
};
const IDLE_ACTIVITY_KEY = 'portal.lastActivity';

function markActivity() {
  const now = Date.now();
  if (now - idle.lastActivity < 5000) return;
  idle.lastActivity = now;
  try { localStorage.setItem(IDLE_ACTIVITY_KEY, String(now)); } catch { /* storage unavailable */ }
}

function lastActivityAnyTab() {
  let shared = 0;
  try { shared = Number(localStorage.getItem(IDLE_ACTIVITY_KEY)) || 0; } catch { /* storage unavailable */ }
  return Math.max(idle.lastActivity, shared);
}

function hideIdleWarning() {
  idle.warning?.remove();
  idle.warning = null;
}

function showIdleWarning(secondsLeft) {
  if (!idle.warning) {
    idle.warning = document.createElement('div');
    idle.warning.className = 'idle-backdrop';
    idle.warning.innerHTML = String(html`<div class="card idle-dialog" role="alertdialog" aria-modal="true" aria-labelledby="idle-title" aria-describedby="idle-text">
      <h2 id="idle-title">Are you still there?</h2>
      <p id="idle-text">For your security, you'll be signed out in <strong class="idle-count"></strong> because of inactivity.</p>
      <div class="actions"><button type="button" class="btn" id="idle-stay">Stay signed in</button>
        <button type="button" class="btn btn-ghost" id="idle-leave">Sign out</button></div></div>`);
    document.body.append(idle.warning);
    idle.warning.querySelector('#idle-stay').addEventListener('click', async () => {
      idle.lastActivity = 0;
      markActivity();
      hideIdleWarning();
      await api('/auth/session').catch(() => {});
    });
    idle.warning.querySelector('#idle-leave').addEventListener('click', () => signOut('user'));
    idle.warning.querySelector('#idle-stay').focus();
  }
  const m = Math.floor(secondsLeft / 60);
  idle.warning.querySelector('.idle-count').textContent = `${m}:${String(secondsLeft % 60).padStart(2, '0')}`;
}

function checkIdle() {
  if (!state.me) return;
  const limit = (state.config.sessionIdleMinutes || 30) * 60 * 1000;
  const idleFor = Date.now() - lastActivityAnyTab();
  if (idleFor >= limit) {
    signOut('idle');
  } else if (idleFor >= limit - 120000) {
    showIdleWarning(Math.ceil((limit - idleFor) / 1000));
  } else {
    hideIdleWarning();
    // Someone reading a page makes no API calls: keep their server session alive too.
    if (Date.now() - idle.lastServerContact > 4 * 60 * 1000 && idleFor < 60000) api('/auth/session').catch(() => {});
  }
}

function startIdleWatch() {
  for (const type of ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart', 'wheel']) {
    window.addEventListener(type, markActivity, { passive: true });
  }
  idle.timer = setInterval(checkIdle, 1000);
}

async function signOut(reason) {
  hideIdleWarning();
  await api(`/auth/logout?reason=${reason === 'idle' ? 'idle' : 'user'}`, { method: 'POST', body: {} }).catch(() => {});
  state.me = null;
  clearSavedSearch();
  if (reason === 'idle') state.notice = 'You were signed out after a period of inactivity, to keep your account safe.';
  if (reason === 'expired') state.notice = 'Your session has ended. Please sign in again.';
  navigate('#/login');
}

async function changePasswordView() {
  const forced = state.me.user.mustChangePassword;
  render(html`<div class="login-wrap">
    <div class="card login-card">
      <h1>${forced ? 'Set your password' : 'Change password'}</h1>
      <p class="muted">${forced
        ? 'Welcome! You signed in with a temporary password. Choose your own to continue.'
        : 'You will stay signed in here and be signed out on other devices.'}</p>
      <div id="password-error"></div>
      <form class="form" id="password-form">
        <label>${forced ? 'Temporary password' : 'Current password'}<input type="password" name="currentPassword" autocomplete="current-password" required></label>
        <label>New password <span class="hint muted">At least 10 characters</span><input type="password" name="newPassword" autocomplete="new-password" minlength="10" required></label>
        <label>Confirm new password<input type="password" name="confirmPassword" autocomplete="new-password" required></label>
        <button class="btn btn-block" type="submit">Save password</button>
        ${forced ? '' : html`<a class="btn btn-ghost btn-block" href="${homeHash()}">Cancel</a>`}
      </form>
    </div>
  </div>`);
  document.getElementById('password-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const values = formData(event.target);
    const errorBox = document.getElementById('password-error');
    if (values.newPassword !== values.confirmPassword) {
      errorBox.innerHTML = String(alertBox('error', 'The new passwords do not match.'));
      return;
    }
    const button = event.target.querySelector('button[type=submit]');
    setBusy(button, true, 'Saving…');
    try {
      await api('/auth/change-password', { method: 'POST', body: { currentPassword: values.currentPassword, newPassword: values.newPassword } });
      await loadMe();
      navigate(homeHash());
    } catch (err) {
      errorBox.innerHTML = String(alertBox('error', err.message));
      setBusy(button, false, 'Save password');
    }
  });
}

// role: which kind of account may open the route ('any' = signed in, either role).
const routes = [
  [/^\/login$/, loginView, { public: true }],
  [/^\/signup$/, signupView, { public: true }],
  [/^\/forgot$/, forgotPasswordView, { public: true }],
  [/^\/privacy$/, privacyView, { open: true }],
  [/^\/admin\/security$/, adminSecurityView, { role: 'admin' }],
  [/^\/account\/password$/, changePasswordView, { role: 'any' }],
  [/^\/dashboard$/, dashboardView, { role: 'client' }],
  [/^\/deals\/([^/]+)$/, dealView, { role: 'client' }],
  [/^\/search$/, searchView, { role: ['client', 'guest'] }],
  [/^\/properties\/([^/]+)$/, propertyView, { role: ['client', 'guest'] }],
  [/^\/messages$/, messagesView, { role: 'client', withParams: true }],
  [/^\/referrals$/, referralsView, { role: 'client' }],
  [/^\/admin\/referrals$/, adminReferralsView, { role: 'admin' }],
  [/^\/admin$/, adminOverviewView, { role: 'admin' }],
  [/^\/admin\/activity$/, adminActivityView, { role: 'admin', withParams: true }],
  [/^\/admin\/users$/, adminUsersView, { role: 'admin', withParams: true }],
  [/^\/admin\/users\/([^/]+)$/, adminUserView, { role: 'admin' }],
  [/^\/admin\/integration$/, adminIntegrationView, { role: 'admin' }],
];

function homeHash() {
  if (!state.me) return '#/login';
  if (state.me.user.mustChangePassword) return '#/account/password';
  return { admin: '#/admin', guest: '#/search' }[state.me.user.role] || '#/dashboard';
}

function isGuest() {
  return state.me?.user.role === 'guest';
}

function navigate(hash) {
  if (location.hash === hash) handleRoute();
  else location.hash = hash;
}

async function loadMe() {
  try {
    state.me = await api('/auth/me');
  } catch {
    state.me = null;
  }
}

function updateChrome(path) {
  const role = state.me?.user.role;
  const pending = state.me?.user.mustChangePassword;
  document.getElementById('topbar').hidden = !state.me;
  document.getElementById('user-name').textContent = state.me?.user.name || '';
  document.getElementById('brand-link').href = homeHash();
  const tag = document.getElementById('brand-tag');
  tag.hidden = role !== 'admin' && role !== 'guest';
  tag.textContent = role === 'guest' ? 'Guest' : 'Admin';
  tag.classList.toggle('brand-tag-guest', role === 'guest');
  document.querySelectorAll('nav[data-role]').forEach((nav) => { nav.hidden = pending || nav.dataset.role !== role; });
  const parts = path.split('/').filter(Boolean);
  const navKey = parts[0] === 'admin'
    ? (parts[1] ? `admin/${parts[1]}` : 'admin')
    : ({ deals: 'dashboard', properties: 'search' }[parts[0]] || parts[0]);
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === navKey));
}

async function handleRoute() {
  const [path, query = ''] = (location.hash.slice(1) || '/').split('?');
  const match = routes.map(([re, view, opts = {}]) => ({ m: path.match(re), view, opts })).find((r) => r.m);
  if (!match) return navigate(homeHash());
  if (match.opts.open) {
    // Pages anyone can read, signed in or not (privacy notice).
    updateChrome(path);
    return match.view();
  }
  if (!match.opts.public && !state.me) return navigate('#/login');
  if (match.opts.public && state.me) return navigate(homeHash());
  // A temporary password must be replaced before anything else.
  if (state.me?.user.mustChangePassword && match.view !== changePasswordView) return navigate('#/account/password');
  if (match.opts.role && match.opts.role !== 'any' && ![].concat(match.opts.role).includes(state.me.user.role)) return navigate(homeHash());

  updateChrome(path);
  render(html`<div class="loading">Loading…</div>`);
  try {
    const args = match.opts.withParams ? [new URLSearchParams(query)] : match.m.slice(1).map(decodeURIComponent);
    await match.view(...args);
    app.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  } catch (err) {
    if (state.me) showError(err);
  }
}

document.getElementById('logout').addEventListener('click', () => signOut('user'));

(async function init() {
  state.config = await api('/config');
  document.title = state.config.brandName;
  document.getElementById('brand-name').textContent = state.config.brandName;
  document.getElementById('demo-banner').hidden = state.config.mode !== 'mock';
  await loadMe();
  window.addEventListener('hashchange', handleRoute);
  startIdleWatch();
  handleRoute();
})();
