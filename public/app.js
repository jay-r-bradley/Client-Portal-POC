'use strict';

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

const app = document.getElementById('app');
const state = { config: null, me: null };

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

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/auth/login' && path !== '/auth/me') {
    state.me = null;
    navigate('#/login');
    throw new Error(data.error || 'Please sign in.');
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
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
  render(html`<div class="card">${alertBox('error', err.message)}<a href="#/dashboard">Back to my deals</a></div>`);
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

function propertyPhoto(property, extraClass = '') {
  const url = safeImageUrl(property.photoUrl);
  return html`<div class="property-photo ${extraClass}">
    ${url ? html`<img src="${url}" alt="" loading="lazy">` : property.propertyType || 'Property'}
    ${property.listingType ? html`<span class="badge">For ${property.listingType}</span>` : ''}
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

function propertyCard(p) {
  return html`<article class="card property-card">
    ${propertyPhoto(p)}
    <div class="property-body">
      <div class="property-price">${priceLabel(p)}</div>
      <h3>${p.name}</h3>
      <div class="muted small">${[p.address, p.city].filter(Boolean).join(', ')}</div>
      ${propertySpecs(p)}
    </div>
    <div class="property-actions actions">
      <a class="btn btn-secondary btn-sm" href="#/properties/${encodeURIComponent(p.id)}">View details</a>
      <a class="btn btn-sm" href="#/messages?propertyId=${encodeURIComponent(p.id)}">I'm interested</a>
    </div>
  </article>`;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

function loginView() {
  render(html`<div class="login-wrap">
    <div class="card login-card">
      <div class="brand"><span class="brand-mark" aria-hidden="true"></span>${state.config.brandName}</div>
      <h1>Sign in</h1>
      <p class="muted">Track your deals, search properties and talk to your agent.</p>
      <div id="login-error"></div>
      <form class="form" id="login-form">
        <label>Email<input type="email" name="email" autocomplete="username" required></label>
        <label>Password<input type="password" name="password" autocomplete="current-password" required></label>
        <button class="btn btn-block" type="submit">Sign in</button>
      </form>
      ${state.config.mode === 'mock' ? html`<p class="muted small">Demo login: alex@client.example / demo1234</p>` : ''}
      <p class="muted small">Don't have access yet? Ask your agent to invite you.</p>
    </div>
  </div>`);

  document.getElementById('login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.target.querySelector('button');
    setBusy(button, true, 'Signing in…');
    try {
      await api('/auth/login', { method: 'POST', body: formData(event.target) });
      await loadMe();
      navigate('#/dashboard');
    } catch (err) {
      document.getElementById('login-error').innerHTML = String(alertBox('error', err.message));
      setBusy(button, false, 'Sign in');
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
        <div class="section-head"><h2>My deals</h2><span class="muted small">${summary.total} total</span></div>
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
      <aside>${agentCard(state.me?.agent)}</aside>
    </div>`);
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
}

const SEARCH_KEY = 'portal.lastSearch';

function loadSavedSearch() {
  try {
    return JSON.parse(sessionStorage.getItem(SEARCH_KEY) || 'null');
  } catch {
    return null;
  }
}

function saveSearch(criteria) {
  try {
    sessionStorage.setItem(SEARCH_KEY, JSON.stringify(criteria));
  } catch {
    // Storage unavailable (private mode): the search still works, it just isn't remembered.
  }
}

async function searchView() {
  const options = await api('/properties/options');
  const saved = loadSavedSearch() || {};
  const val = (key) => saved[key] ?? '';
  const select = (name, label, values, anyLabel) => html`<label>${label}
    <select name="${name}">
      <option value="">${anyLabel}</option>
      ${values.map((v) => html`<option value="${v}" ${saved[name] === v ? new Raw('selected') : ''}>${v}</option>`)}
    </select></label>`;

  render(html`
    <div class="page-head">
      <div>
        <h1>Find a property</h1>
        <p class="muted">Tell us your budget, preferred locations and must-haves. We'll match them against our available listings.</p>
      </div>
    </div>
    <div class="layout-search">
      <form class="card form" id="search-form" novalidate>
        <h2>Your criteria</h2>
        <div id="search-error"></div>
        <div class="form-row">
          <label>Min budget<input type="number" name="budgetMin" min="0" step="1000" inputmode="numeric" value="${val('budgetMin')}"></label>
          <label>Max budget<input type="number" name="budgetMax" min="0" step="1000" inputmode="numeric" value="${val('budgetMax')}"></label>
        </div>
        <label>Preferred location<input type="text" name="preferredLocation" placeholder="e.g. Austin" value="${val('preferredLocation')}"></label>
        <label>Other locations <span class="hint muted">Comma-separated</span>
          <input type="text" name="otherLocations" placeholder="e.g. Dallas, Plano" value="${val('otherLocations')}"></label>
        ${select('listingType', 'Buy or rent', options.listingTypes, 'Either')}
        ${select('propertyType', 'Property type', options.propertyTypes, 'Any type')}
        <div class="form-row">
          <label>Min bedrooms<input type="number" name="minBedrooms" min="0" value="${val('minBedrooms')}"></label>
          <label>Min bathrooms<input type="number" name="minBathrooms" min="0" step="0.5" value="${val('minBathrooms')}"></label>
        </div>
        <label>Min floor area (sq ft)<input type="number" name="minFloorArea" min="0" step="50" value="${val('minFloorArea')}"></label>
        <label>Other requirements <span class="hint muted">Keywords, e.g. pool garage</span>
          <input type="text" name="keywords" value="${val('keywords')}"></label>
        <label>Sort by
          <select name="sort">
            ${[['price_asc', 'Price: low to high'], ['price_desc', 'Price: high to low'], ['bedrooms_desc', 'Most bedrooms'], ['area_desc', 'Largest floor area']]
              .map(([v, l]) => html`<option value="${v}" ${saved.sort === v ? new Raw('selected') : ''}>${l}</option>`)}
          </select></label>
        <div class="actions">
          <button class="btn" type="submit">Search properties</button>
          <button class="btn btn-ghost" type="reset" id="search-reset">Clear</button>
        </div>
      </form>
      <section id="results">
        <div class="card empty"><p>Fill in your criteria and press <strong>Search properties</strong> to see matching listings.</p></div>
      </section>
    </div>`);

  const form = document.getElementById('search-form');
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    runSearch(formData(form));
  });
  document.getElementById('search-reset').addEventListener('click', () => {
    saveSearch(null);
    setTimeout(() => form.querySelectorAll('input').forEach((input) => { input.value = ''; }));
  });
  if (Object.keys(saved).length) runSearch(saved);
}

async function runSearch(criteria) {
  const results = document.getElementById('results');
  const errorBox = document.getElementById('search-error');
  const button = document.querySelector('#search-form button[type=submit]');
  errorBox.innerHTML = '';
  setBusy(button, true, 'Searching…');
  results.innerHTML = String(html`<div class="loading">Searching available listings…</div>`);
  try {
    const data = await api('/properties/search', { method: 'POST', body: criteria });
    saveSearch(criteria);
    results.innerHTML = String(data.count
      ? html`<div class="section-head"><h2>${data.count} matching ${data.count === 1 ? 'property' : 'properties'}</h2></div>
             <div class="grid grid-cards">${data.properties.map(propertyCard)}</div>`
      : html`<div class="card empty">
          <p><strong>No available properties match all of your criteria.</strong></p>
          <p>Try widening your budget or adding more locations, or let your agent know what you're looking for.</p>
          <a class="btn" href="#/messages?search=1">Ask my agent to find one</a>
        </div>`);
  } catch (err) {
    errorBox.innerHTML = String(alertBox('error', err.message));
    results.innerHTML = '';
  } finally {
    setBusy(button, false, 'Search properties');
  }
}

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
        <div class="card">
          <h3>Interested?</h3>
          <p class="muted small">Send your agent a message to book a viewing or ask a question about this property.</p>
          <a class="btn btn-block" href="#/messages?propertyId=${encodeURIComponent(p.id)}">Contact my agent</a>
        </div>
        ${agentCard(state.me?.agent, { withButton: false })}
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
    const locations = [saved.preferredLocation, saved.otherLocations].filter(Boolean).join(', ');
    subject = 'Help me find a property';
    body = [
      "I couldn't find a match in the portal. Here is what I'm looking for:",
      saved.budgetMin || saved.budgetMax ? `Budget: ${saved.budgetMin ? money(saved.budgetMin) : 'any'} – ${saved.budgetMax ? money(saved.budgetMax) : 'any'}` : null,
      locations ? `Locations: ${locations}` : null,
      saved.listingType ? `Looking to: ${saved.listingType === 'Rent' ? 'rent' : 'buy'}` : null,
      saved.propertyType ? `Type: ${saved.propertyType}` : null,
      saved.minBedrooms ? `Bedrooms: ${saved.minBedrooms}+` : null,
      saved.keywords ? `Other: ${saved.keywords}` : null,
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

const routes = [
  [/^\/login$/, loginView, { public: true }],
  [/^\/dashboard$/, dashboardView],
  [/^\/deals\/([^/]+)$/, dealView],
  [/^\/search$/, searchView],
  [/^\/properties\/([^/]+)$/, propertyView],
  [/^\/messages$/, messagesView, { withParams: true }],
];

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
  const signedIn = Boolean(state.me);
  document.getElementById('topbar').hidden = !signedIn;
  document.getElementById('user-name').textContent = state.me?.user.name || '';
  const section = path.split('/')[1];
  const navKey = { deals: 'dashboard', properties: 'search' }[section] || section;
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === navKey));
}

async function handleRoute() {
  const [path, query = ''] = (location.hash.slice(1) || '/dashboard').split('?');
  const match = routes.map(([re, view, opts = {}]) => ({ m: path.match(re), view, opts })).find((r) => r.m);
  if (!match) return navigate('#/dashboard');
  if (!match.opts.public && !state.me) return navigate('#/login');
  if (match.opts.public && state.me) return navigate('#/dashboard');

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

document.getElementById('logout').addEventListener('click', async () => {
  await api('/auth/logout', { method: 'POST', body: {} }).catch(() => {});
  state.me = null;
  try { sessionStorage.removeItem(SEARCH_KEY); } catch { /* ignore */ }
  navigate('#/login');
});

(async function init() {
  state.config = await api('/config');
  document.title = state.config.brandName;
  document.getElementById('brand-name').textContent = state.config.brandName;
  document.getElementById('demo-banner').hidden = state.config.mode !== 'mock';
  await loadMe();
  window.addEventListener('hashchange', handleRoute);
  handleRoute();
})();
