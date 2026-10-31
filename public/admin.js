'use strict';

// Admin console views. Loaded before app.js and uses its helpers (html, api,
// render, …) only when a view runs, never at load time.

// ---------------------------------------------------------------------------
// Activity vocabulary
// ---------------------------------------------------------------------------

const ACTIVITY_LABELS = {
  'auth.login': 'Signed in',
  'auth.login_failed': 'Failed sign-in',
  'auth.login_blocked': 'Sign-in blocked',
  'auth.logout': 'Signed out',
  'auth.password_changed': 'Changed password',
  'portal.dashboard_viewed': 'Viewed dashboard',
  'deal.viewed': 'Viewed deal',
  'property.searched': 'Searched listings',
  'property.ai_searched': 'AI search',
  'property.viewed': 'Viewed property',
  'message.sent': 'Messaged agent',
  'referral.submitted': 'Referred a friend',
  'admin.user_invited': 'Invited user',
  'admin.user_disabled': 'Disabled user',
  'admin.user_enabled': 'Re-enabled user',
  'admin.password_reset': 'Reset password',
  'admin.activity_exported': 'Exported activity',
  'admin.integration_tested': 'Tested integration',
};

const ACTIVITY_CATEGORIES = [
  ['', 'All activity'],
  ['auth', 'Sign-ins & security'],
  ['deal', 'Deal views'],
  ['property', 'Searches & property views'],
  ['message', 'Messages to agents'],
  ['referral', 'Referrals'],
  ['portal', 'Dashboard visits'],
  ['admin', 'Admin actions'],
];

// Tone drives the small colored marker beside each activity (always paired with its label).
function activityTone(action) {
  if (action === 'auth.login_failed' || action === 'auth.login_blocked' || action === 'admin.user_disabled') return 'warn';
  if (action.startsWith('admin.')) return 'admin';
  if (action === 'message.sent' || action === 'referral.submitted') return 'message';
  if (action.startsWith('property.')) return 'property';
  return 'neutral';
}

function criteriaSummary(c) {
  if (!c) return '';
  const parts = [];
  if (c.locations?.length) parts.push(c.locations.join(', '));
  if (c.budgetMin !== null && c.budgetMin !== undefined && c.budgetMax !== null && c.budgetMax !== undefined) {
    parts.push(`${compactMoney(c.budgetMin)}–${compactMoney(c.budgetMax)}`);
  } else if (c.budgetMax !== null && c.budgetMax !== undefined) parts.push(`≤ ${compactMoney(c.budgetMax)}`);
  else if (c.budgetMin !== null && c.budgetMin !== undefined) parts.push(`≥ ${compactMoney(c.budgetMin)}`);
  if (c.minBedrooms) parts.push(`${c.minBedrooms}+ bd`);
  if (c.listingType) parts.push(c.listingType === 'Rent' ? 'rent' : 'buy');
  if (c.propertyType) parts.push(c.propertyType);
  return parts.join(' · ') || 'No filters';
}

function describeActivity(e) {
  const d = e.details || {};
  const t = e.target || {};
  switch (e.action) {
    case 'deal.viewed': return `${t.name || t.dealId}${d.stage ? ` (${d.stage})` : ''}`;
    case 'property.searched': return `${criteriaSummary(d.criteria)} · ${d.results ?? 0} results`;
    case 'property.ai_searched': return `“${d.query}” · ${d.results ?? 0} results`;
    case 'property.viewed': return [t.name, d.city].filter(Boolean).join(', ');
    case 'message.sent': return `“${d.subject}”${t.name ? ` about ${t.name}` : ''}`;
    case 'referral.submitted': return `${t.name} · ${d.interest}`;
    case 'auth.login_failed': return d.email || '';
    case 'auth.login_blocked': return d.reason || '';
    case 'admin.user_invited': return `${t.name || t.email} as ${d.role}`;
    case 'admin.user_disabled':
    case 'admin.user_enabled':
    case 'admin.password_reset': return t.name || t.email || '';
    case 'admin.activity_exported': return `${d.rows} rows`;
    case 'admin.integration_tested': return `${d.target}: ${d.ok ? 'OK' : 'failed'}`;
    default: return '';
  }
}

function relativeTime(iso) {
  const seconds = (Date.now() - Date.parse(iso)) / 1000;
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  if (seconds < 7 * 86400) return `${Math.floor(seconds / 86400)} d ago`;
  return formatDate(iso);
}

function actorLabel(e) {
  if (!e.actor) return html`<span class="muted">Unknown visitor</span>`;
  return html`<a href="#/admin/users/${encodeURIComponent(e.actor.id)}">${e.actor.name || e.actor.email}</a>
    ${e.actor.role === 'admin' ? html`<span class="badge badge-role-admin">Admin</span>` : ''}`;
}

function activityRows(items, { showUser = true } = {}) {
  return items.map((e) => html`<tr>
    <td class="nowrap" title="${new Date(e.at).toLocaleString()}">${formatDate(e.at, true)}</td>
    ${showUser ? html`<td>${actorLabel(e)}</td>` : ''}
    <td class="nowrap"><span class="tone tone-${activityTone(e.action)}" aria-hidden="true"></span>${ACTIVITY_LABELS[e.action] || e.action}</td>
    <td class="activity-detail">${describeActivity(e)}</td>
    <td class="nowrap muted small">${e.ip || ''}</td>
  </tr>`);
}

function activityTable(items, opts = {}) {
  const showUser = opts.showUser !== false;
  return html`<div class="table-wrap"><table class="data-table">
    <thead><tr><th>Time</th>${showUser ? html`<th>User</th>` : ''}<th>Activity</th><th>Details</th><th>IP address</th></tr></thead>
    <tbody>${items.length ? activityRows(items, opts) : html`<tr><td colspan="${showUser ? 5 : 4}" class="empty-cell">No activity matches these filters.</td></tr>`}</tbody>
  </table></div>`;
}

function statusBadge(user) {
  return user.status === 'active'
    ? html`<span class="badge badge-won">Active</span>`
    : html`<span class="badge badge-lost">Disabled</span>`;
}

function roleBadge(role) {
  return role === 'admin' ? html`<span class="badge badge-role-admin">Admin</span>` : html`<span class="badge badge-neutral">Client</span>`;
}

// ---------------------------------------------------------------------------
// Chart: client activity per day (single series, one hue, hover tooltips)
// ---------------------------------------------------------------------------

function niceMax(value) {
  if (value <= 4) return 4;
  const step = 10 ** Math.floor(Math.log10(value));
  return Math.ceil(value / step) * step;
}

function activityChart(points) {
  const W = 640;
  const H = 200;
  const pad = { top: 12, right: 8, bottom: 26, left: 30 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;
  const max = niceMax(Math.max(...points.map((p) => p.events), 1));
  const slot = plotW / points.length;
  const barW = Math.max(6, slot - 6);
  const y = (v) => pad.top + plotH - (v / max) * plotH;
  const ticks = [0, max / 2, max];
  const short = (date) => new Date(`${date}T12:00:00Z`).toLocaleDateString(state.config?.locale || 'en-US', { month: 'short', day: 'numeric' });

  // Bar with a 4px rounded top, square at the baseline.
  const bar = (x, top, w, bottom) => {
    const r = Math.min(4, w / 2, bottom - top);
    if (bottom - top <= 0) return '';
    return `M${x},${bottom}V${top + r}Q${x},${top} ${x + r},${top}H${x + w - r}Q${x + w},${top} ${x + w},${top + r}V${bottom}Z`;
  };

  return html`<div class="chart" data-chart>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Client actions per day over the last 14 days">
      ${ticks.map((t) => html`<g class="chart-grid">
        <line x1="${pad.left}" x2="${W - pad.right}" y1="${y(t)}" y2="${y(t)}"></line>
        <text x="${pad.left - 8}" y="${y(t) + 4}" text-anchor="end">${t}</text>
      </g>`)}
      ${points.map((p, i) => {
        const x = pad.left + i * slot + (slot - barW) / 2;
        return html`<g class="chart-bar" data-tip="${short(p.date)}: ${p.events} client ${p.events === 1 ? 'action' : 'actions'}">
          <rect class="chart-hit" x="${pad.left + i * slot}" y="${pad.top}" width="${slot}" height="${plotH}"></rect>
          <path d="${bar(x, y(p.events), barW, pad.top + plotH)}"></path>
          ${i % 2 === 1 || i === points.length - 1 ? html`<text class="chart-x" x="${x + barW / 2}" y="${H - 8}" text-anchor="middle">${short(p.date)}</text>` : ''}
        </g>`;
      })}
    </svg>
    <div class="chart-tip" role="status" hidden></div>
    <details class="chart-table"><summary>View as table</summary>
      <table class="data-table compact"><thead><tr><th>Date</th><th>Client actions</th></tr></thead>
        <tbody>${points.map((p) => html`<tr><td>${short(p.date)}</td><td>${p.events}</td></tr>`)}</tbody></table>
    </details>
  </div>`;
}

function wireChartTooltips(root) {
  root.querySelectorAll('[data-chart]').forEach((chart) => {
    const tip = chart.querySelector('.chart-tip');
    chart.querySelectorAll('.chart-bar').forEach((bar) => {
      bar.addEventListener('pointerenter', () => {
        const box = bar.querySelector('path').getBoundingClientRect();
        const host = chart.getBoundingClientRect();
        tip.textContent = bar.dataset.tip;
        tip.hidden = false;
        tip.style.left = `${box.left - host.left + box.width / 2}px`;
        tip.style.top = `${Math.max(0, box.top - host.top - 8)}px`;
        bar.classList.add('is-hover');
      });
      bar.addEventListener('pointerleave', () => {
        tip.hidden = true;
        bar.classList.remove('is-hover');
      });
    });
  });
}

// Ranked list with a proportional bar (single measure).
function rankList(items, { label, value, href, unit }) {
  if (!items.length) return html`<p class="muted small">No data yet.</p>`;
  const max = Math.max(...items.map(value));
  return html`<ol class="rank-list">${items.map((item) => html`<li>
    <div class="rank-row">
      ${href ? html`<a href="${href(item)}">${label(item)}</a>` : html`<span>${label(item)}</span>`}
      <span class="rank-value">${value(item)} ${unit}</span>
    </div>
    <div class="rank-track"><div class="rank-fill" data-pct="${Math.round((value(item) / max) * 100)}"></div></div>
  </li>`)}</ol>`;
}

function applyRankWidths(root) {
  root.querySelectorAll('.rank-fill').forEach((el) => { el.style.width = `${el.dataset.pct}%`; });
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

function adminHead(title, subtitle, actions = '') {
  return html`<div class="page-head"><div><h1>${title}</h1>${subtitle ? html`<p class="muted">${subtitle}</p>` : ''}</div>${actions}</div>`;
}

async function adminOverviewView() {
  const data = await api('/admin/overview');
  const k = data.kpis;
  const tile = (label, value, sub) => html`<div class="card stat"><div class="stat-label">${label}</div><div class="stat-value">${value}</div>${sub ? html`<div class="stat-sub">${sub}</div>` : ''}</div>`;

  render(html`
    ${adminHead('Portal overview', 'How clients are using the portal across all accounts.', html`<a class="btn" href="#/admin/users?invite=1">Invite user</a>`)}
    <div class="grid grid-stats grid-stats-5">
      ${tile('Clients with access', k.clients, `${k.activeClients30d} active in the last 30 days`)}
      ${tile('Sign-ins, 7 days', k.signIns7d, k.failedSignIns7d ? html`<a href="#/admin/activity?action=auth">${k.failedSignIns7d} failed attempts</a>` : 'No failed attempts')}
      ${tile('Searches, 7 days', k.searches7d, 'Filter and AI searches')}
      ${tile('Property views, 7 days', k.propertyViews7d, null)}
      ${tile('Messages to agents, 7 days', k.messages7d, null)}
      ${tile('Referrals, 30 days', k.referrals30d, html`<a href="#/admin/referrals">View referrals</a>`)}
    </div>

    <div class="admin-grid section">
      <section class="card">
        <div class="section-head"><h2>Client activity, last 14 days</h2></div>
        ${activityChart(data.activityByDay)}
      </section>
      <section class="card">
        <div class="section-head"><h2>Most active clients</h2><span class="muted small">30 days</span></div>
        ${data.mostActiveClients.length ? html`<ul class="people-list">${data.mostActiveClients.map((c) => html`<li>
          <div class="avatar avatar-sm" aria-hidden="true">${initials(c.name || c.email)}</div>
          <div class="people-main"><a href="#/admin/users/${encodeURIComponent(c.id)}">${c.name || c.email}</a>
            <div class="muted small">Last sign-in ${c.lastLoginAt ? relativeTime(c.lastLoginAt) : 'never'}</div></div>
          <span class="people-count">${c.events} actions</span>
        </li>`)}</ul>` : html`<p class="muted small">No client activity yet.</p>`}
      </section>
    </div>

    <div class="admin-grid admin-grid-even section">
      <section class="card">
        <div class="section-head"><h2>Most viewed properties</h2><span class="muted small">30 days</span></div>
        ${rankList(data.topProperties, { label: (p) => p.name, value: (p) => p.interactions, unit: 'views & inquiries' })}
      </section>
      <section class="card">
        <div class="section-head"><h2>Most searched locations</h2><span class="muted small">30 days</span></div>
        ${rankList(data.topLocations, { label: (l) => l.location, value: (l) => l.searches, unit: 'searches' })}
      </section>
    </div>

    <section class="card section">
      <div class="section-head"><h2>Recent activity</h2><a href="#/admin/activity">View full activity log →</a></div>
      ${activityTable(data.recent)}
    </section>`);
  wireChartTooltips(app);
  applyRankWidths(app);
}

function activityQuery(filters, extra = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...filters, ...extra })) if (value) params.set(key, value);
  return params.toString();
}

async function adminActivityView(params) {
  const filters = {
    q: params.get('q') || '', userId: params.get('userId') || '', action: params.get('action') || '',
    from: params.get('from') || '', to: params.get('to') || '',
  };
  const [{ users }, first] = await Promise.all([api('/admin/users'), api(`/admin/activity?${activityQuery(filters, { limit: 50 })}`)]);
  let next = first.next;

  render(html`
    ${adminHead('Activity log', 'Every sign-in, search, view, message and admin action across the portal.',
      html`<a class="btn btn-secondary" id="export-csv" href="/api/admin/activity.csv?${activityQuery(filters)}">Export CSV</a>`)}
    <form class="card filters-row" id="activity-filters">
      <label class="grow">Search<input type="search" name="q" placeholder="Name, email, property, search term…" value="${filters.q}"></label>
      <label>User<select name="userId"><option value="">All users</option>
        ${users.map((u) => html`<option value="${u.id}" ${filters.userId === u.id ? new Raw('selected') : ''}>${u.name || u.email}${u.role === 'admin' ? ' (admin)' : ''}</option>`)}
      </select></label>
      <label>Activity<select name="action">
        ${ACTIVITY_CATEGORIES.map(([v, l]) => html`<option value="${v}" ${filters.action === v ? new Raw('selected') : ''}>${l}</option>`)}
      </select></label>
      <label>From<input type="date" name="from" value="${filters.from}"></label>
      <label>To<input type="date" name="to" value="${filters.to}"></label>
      <div class="filters-actions"><button class="btn" type="submit">Apply</button>
        ${Object.values(filters).some(Boolean) ? html`<a class="btn btn-ghost" href="#/admin/activity">Reset</a>` : ''}</div>
    </form>
    <section class="card section" id="activity-results">
      ${activityTable(first.items)}
      <div class="load-more" id="load-more" ${next ? '' : new Raw('hidden')}><button type="button" class="btn btn-secondary">Load more</button></div>
    </section>`);

  document.getElementById('activity-filters').addEventListener('submit', (event) => {
    event.preventDefault();
    const query = activityQuery(formData(event.target));
    navigate(`#/admin/activity${query ? `?${query}` : ''}`);
  });
  document.querySelector('#load-more button').addEventListener('click', async (event) => {
    setBusy(event.target, true, 'Loading…');
    try {
      const page = await api(`/admin/activity?${activityQuery(filters, { limit: 50, before: next })}`);
      document.querySelector('#activity-results tbody').insertAdjacentHTML('beforeend', String(html`${activityRows(page.items)}`));
      next = page.next;
      document.getElementById('load-more').hidden = !next;
    } finally {
      setBusy(event.target, false, 'Load more');
    }
  });
}

function temporaryPasswordNotice(user, password) {
  return html`<div class="temp-password" role="status">
    <h3>Share these sign-in details with ${user.name || user.email}</h3>
    <p class="muted small">This temporary password is shown only once. They'll be asked to choose their own password when they first sign in.</p>
    <dl class="details">
      <div><dt>Email</dt><dd>${user.email}</dd></div>
      <div><dt>Temporary password</dt><dd><code id="temp-password">${password}</code>
        <button type="button" class="btn btn-ghost btn-sm" data-copy="${password}">Copy</button></dd></div>
    </dl>
  </div>`;
}

function wireCopyButtons(root) {
  root.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-copy]');
    if (!button) return;
    try {
      await navigator.clipboard.writeText(button.dataset.copy);
      button.textContent = 'Copied';
    } catch {
      button.textContent = 'Select and copy';
    }
  });
}

// Disable / enable / reset buttons, shared by the user list and user detail pages.
function userActions(user) {
  if (user.id === state.me.user.id) return html`<span class="muted small">This is you</span>`;
  return html`<div class="actions">
    <button type="button" class="btn btn-ghost btn-sm" data-user-action="reset" data-user-id="${user.id}" data-user-name="${user.name || user.email}">Reset password</button>
    <button type="button" class="btn btn-ghost btn-sm ${user.status === 'active' ? 'btn-danger' : ''}" data-user-action="${user.status === 'active' ? 'disable' : 'enable'}"
      data-user-id="${user.id}" data-user-name="${user.name || user.email}">${user.status === 'active' ? 'Disable' : 'Enable'}</button>
  </div>`;
}

function wireUserActions(root, onDone) {
  root.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-user-action]');
    if (!button) return;
    const { userAction, userId, userName } = button.dataset;
    const prompts = {
      reset: `Reset ${userName}'s password? They will be signed out and need the new temporary password to sign in.`,
      disable: `Disable ${userName}'s portal access? They will be signed out immediately.`,
      enable: `Re-enable ${userName}'s portal access?`,
    };
    if (!window.confirm(prompts[userAction])) return;
    button.disabled = true;
    try {
      const result = userAction === 'reset'
        ? await api(`/admin/users/${encodeURIComponent(userId)}/reset-password`, { method: 'POST', body: {} })
        : await api(`/admin/users/${encodeURIComponent(userId)}/status`, { method: 'POST', body: { status: userAction === 'disable' ? 'disabled' : 'active' } });
      onDone(result);
    } catch (err) {
      window.alert(err.message);
      button.disabled = false;
    }
  });
}

async function adminUsersView(params) {
  const { users } = await api('/admin/users');
  const clients = users.filter((u) => u.role === 'client');

  render(html`
    ${adminHead('Users', `${clients.length} client${clients.length === 1 ? '' : 's'} and ${users.length - clients.length} admin${users.length - clients.length === 1 ? '' : 's'} with portal access.`,
      html`<button type="button" class="btn" id="invite-toggle">Invite user</button>`)}
    <div id="invite-result"></div>
    <section class="card invite-card" id="invite-card" ${params.get('invite') ? '' : new Raw('hidden')}>
      <h2>Invite a user</h2>
      <p class="muted small">Clients must already exist as a Contact in Zoho CRM with the same email. Their portal account is linked to that Contact.</p>
      <div id="invite-error"></div>
      <form class="form invite-form" id="invite-form">
        <label>Role<select name="role" id="invite-role"><option value="client">Client</option><option value="admin">Admin (brokerage staff)</option></select></label>
        <label>Email<input type="email" name="email" required autocomplete="off" placeholder="client@example.com"></label>
        <label id="invite-name" hidden>Full name<input type="text" name="name" maxlength="120"></label>
        <div class="actions"><button class="btn" type="submit">Create access</button><button class="btn btn-ghost" type="button" id="invite-cancel">Cancel</button></div>
      </form>
    </section>
    <section class="card section">
      <div class="table-wrap"><table class="data-table">
        <thead><tr><th>Name</th><th>Role</th><th>Zoho Contact</th><th>Status</th><th>Last sign-in</th><th>Actions, 30 days</th><th><span class="visually-hidden">Manage</span></th></tr></thead>
        <tbody>${users.map((u) => html`<tr>
          <td><a href="#/admin/users/${encodeURIComponent(u.id)}"><strong>${u.name || u.email}</strong></a><div class="muted small">${u.email}</div></td>
          <td>${roleBadge(u.role)}</td>
          <td class="muted small">${u.contactId || '—'}</td>
          <td>${statusBadge(u)}${u.mustChangePassword ? html`<div class="muted small">Invite pending</div>` : ''}</td>
          <td class="nowrap">${u.lastLoginAt ? relativeTime(u.lastLoginAt) : html`<span class="muted">Never</span>`}</td>
          <td>${u.events30d}</td>
          <td>${userActions(u)}</td>
        </tr>`)}</tbody>
      </table></div>
    </section>`);

  const card = document.getElementById('invite-card');
  const role = document.getElementById('invite-role');
  document.getElementById('invite-toggle').addEventListener('click', () => { card.hidden = false; card.querySelector('[name=email]').focus(); });
  document.getElementById('invite-cancel').addEventListener('click', () => { card.hidden = true; });
  role.addEventListener('change', () => {
    const nameField = document.getElementById('invite-name');
    nameField.hidden = role.value !== 'admin';
    nameField.querySelector('input').required = role.value === 'admin';
  });
  document.getElementById('invite-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.target.querySelector('button[type=submit]');
    setBusy(button, true, 'Creating…');
    document.getElementById('invite-error').innerHTML = '';
    try {
      const { user, temporaryPassword } = await api('/admin/users', { method: 'POST', body: formData(event.target) });
      await adminUsersView(new URLSearchParams());
      document.getElementById('invite-result').innerHTML = String(temporaryPasswordNotice(user, temporaryPassword));
    } catch (err) {
      document.getElementById('invite-error').innerHTML = String(alertBox('error', err.message));
      setBusy(button, false, 'Create access');
    }
  });
  wireCopyButtons(document.getElementById('invite-result'));
  wireUserActions(app.querySelector('.data-table'), async (result) => {
    await adminUsersView(new URLSearchParams());
    if (result.temporaryPassword) document.getElementById('invite-result').innerHTML = String(temporaryPasswordNotice(result.user, result.temporaryPassword));
  });
}

async function adminUserView(id) {
  const { user, contact, deals, activity } = await api(`/admin/users/${encodeURIComponent(id)}`);

  render(html`
    <a class="back" href="#/admin/users">← All users</a>
    <div class="page-head">
      <div class="agent">
        <div class="avatar" aria-hidden="true">${initials(user.name || user.email)}</div>
        <div><h1>${user.name || user.email}</h1><div class="actions">${roleBadge(user.role)} ${statusBadge(user)}</div></div>
      </div>
      ${userActions(user)}
    </div>
    <div id="invite-result"></div>
    <div class="admin-grid admin-grid-even">
      <section class="card">
        <h2>Account</h2>
        <dl class="details">
          <div><dt>Email</dt><dd>${user.email}</dd></div>
          <div><dt>Created</dt><dd>${formatDate(user.createdAt)}</dd></div>
          <div><dt>Last sign-in</dt><dd>${user.lastLoginAt ? formatDate(user.lastLoginAt, true) : 'Never'}</dd></div>
          <div><dt>Password</dt><dd>${user.mustChangePassword ? 'Temporary (not yet changed)' : 'Set by user'}</dd></div>
          ${user.role === 'client' ? html`<div><dt>Zoho Contact ID</dt><dd>${user.contactId}</dd></div>
            <div><dt>Phone (Zoho)</dt><dd>${contact?.phone || '—'}</dd></div>` : ''}
        </dl>
        ${user.role === 'client' && !contact ? alertBox('error', 'The linked Zoho Contact was not found, so this client cannot sign in.') : ''}
      </section>
      ${user.role === 'client' ? html`<section class="card">
        <h2>Deals in Zoho</h2>
        ${deals?.length ? html`<ul class="plain-list">${deals.map((d) => html`<li>
          <div><strong>${d.name}</strong><div class="muted small">${money(d.amount)} · closing ${formatDate(d.closingDate)}</div></div>
          <span class="badge">${d.stage}</span></li>`)}</ul>` : html`<p class="muted small">No deals linked to this contact.</p>`}
      </section>` : ''}
    </div>
    <section class="card section">
      <div class="section-head"><h2>Activity</h2><a href="#/admin/activity?userId=${encodeURIComponent(user.id)}">Open in activity log →</a></div>
      ${activityTable(activity, { showUser: false })}
    </section>`);

  wireCopyButtons(document.getElementById('invite-result'));
  wireUserActions(app.querySelector('.page-head'), async (result) => {
    await adminUserView(id);
    if (result.temporaryPassword) document.getElementById('invite-result').innerHTML = String(temporaryPasswordNotice(result.user, result.temporaryPassword));
  });
}

async function adminReferralsView() {
  const { referrals, leadSource } = await api('/admin/referrals');
  render(html`
    ${adminHead('Referrals', `People clients have referred. Each one is a Zoho Lead with Lead Source "${leadSource}", owned by the referring client's agent.`)}
    <section class="card">
      <div class="table-wrap"><table class="data-table">
        <thead><tr><th>Referred person</th><th>Interested in</th><th>Referred by</th><th>Lead status (Zoho)</th><th>Client sees</th><th>Agent</th><th>Date</th></tr></thead>
        <tbody>${referrals.length ? referrals.map((r) => html`<tr>
          <td><strong>${r.name}</strong><div class="muted small">${[r.email, r.phone].filter(Boolean).join(' · ')}</div>
            ${r.notes ? html`<div class="small referral-notes">${r.notes}</div>` : ''}</td>
          <td>${r.interest || '—'}</td>
          <td>${r.referrer?.userId ? html`<a href="#/admin/users/${encodeURIComponent(r.referrer.userId)}">${r.referrer.name}</a>` : r.referrer?.name || '—'}</td>
          <td>${r.leadStatus || '—'}</td>
          <td><span class="badge ${r.progress.step === 'closed' ? 'badge-neutral' : r.progress.step === 'qualified' ? 'badge-won' : ''}">${r.progress.label}</span></td>
          <td>${r.agent?.name || '—'}</td>
          <td class="nowrap">${formatDate(r.createdAt)}</td>
        </tr>`) : html`<tr><td colspan="7" class="empty-cell">No referrals yet.</td></tr>`}</tbody>
      </table></div>
    </section>`);
}

const FIELD_STATUS = {
  found: ['badge-won', 'Found'],
  missing: ['badge-lost', 'Missing'],
  sample: ['badge-neutral', 'Sample data'],
  unknown: ['badge-warning', 'Not checked'],
};

async function adminIntegrationView() {
  const data = await api('/admin/integration');
  const fields = data.modules.flatMap((m) => m.fields);
  const missing = fields.filter((f) => f.status === 'missing');
  const statusPill = (ok, okText, badText) => (ok ? html`<span class="badge badge-won">${okText}</span>` : html`<span class="badge badge-lost">${badText}</span>`);

  render(html`
    ${adminHead('Zoho CRM setup', 'Connection status and every Zoho field the portal reads or writes.')}
    <div class="grid integration-grid">
      <section class="card">
        <div class="section-head"><h2>Zoho CRM</h2>${data.mode === 'mock' ? html`<span class="badge badge-warning">Demo data</span>` : statusPill(data.crm.ok, 'Connected', 'Not connected')}</div>
        <p class="muted small">${data.mode === 'mock'
          ? 'Running on built-in sample data. Set ZOHO_MODE=live with your OAuth credentials to connect your org.'
          : data.crm.ok ? `REST API ${data.crm.apiVersion} at ${data.crm.apiDomain}.` : data.crm.error}</p>
        <p class="small">Used by all portal pages.</p>
      </section>
      <section class="card">
        <div class="section-head"><h2>Zoho MCP</h2>${data.mcp.configured ? html`<span class="badge">Configured</span>` : html`<span class="badge badge-neutral">Not configured</span>`}</div>
        <p class="muted small">${data.mcp.configured ? 'The AI assistant reads the CRM through your Zoho MCP server.' : 'Optional. Set ZOHO_MCP_URL so the AI reads the CRM over MCP.'}</p>
        ${data.mcp.configured ? html`<button type="button" class="btn btn-secondary btn-sm" id="test-mcp">Test MCP connection</button><div id="mcp-result" class="small"></div>` : ''}
      </section>
      <section class="card">
        <div class="section-head"><h2>AI assistant</h2>${data.ai.enabled ? html`<span class="badge badge-won">On</span>` : html`<span class="badge badge-neutral">Off</span>`}</div>
        <p class="muted small">${data.ai.enabled ? `Model ${data.ai.model}. CRM access: ${data.ai.crmAccess}.` : 'Set OPENAI_API_KEY to enable AI search and deal insights.'}</p>
      </section>
    </div>

    <section class="section">
      <div class="section-head">
        <div><h2>Fields the portal needs</h2>
          <p class="muted small">${fields.length} fields across ${data.modules.length} modules.
            ${data.mode === 'live' ? (missing.length ? `${missing.length} missing in your org.` : 'All found in your org.') : 'Checked against your org once connected.'}
            Names can be changed in .env if your org uses different API names.</p></div>
      </div>
      ${data.modules.map((m) => html`<div class="card module-card">
        <div class="module-head">
          <div><h3>${m.label} <span class="muted small">(${m.module})</span></h3><p class="muted small">${m.purpose}</p></div>
          <span class="badge ${m.kind.startsWith('Custom') ? 'badge-warning' : 'badge-neutral'}">${m.kind}</span>
        </div>
        ${m.error ? alertBox('error', `Could not read this module's fields: ${m.error}`) : ''}
        ${m.fields.length ? html`<div class="table-wrap"><table class="data-table compact">
          <thead><tr><th>Field label</th><th>API name</th><th>Type</th><th>Required</th><th>Used for</th><th>Status</th></tr></thead>
          <tbody>${m.fields.map((f) => html`<tr>
            <td><strong>${f.label}</strong>${f.standard ? '' : html` <span class="badge badge-warning">Create</span>`}</td>
            <td><code>${f.apiName}</code></td>
            <td class="small">${f.type}</td>
            <td>${f.required ? 'Yes' : html`<span class="muted">Optional</span>`}</td>
            <td class="small">${f.purpose}</td>
            <td><span class="badge ${FIELD_STATUS[f.status][0]}">${FIELD_STATUS[f.status][1]}</span></td>
          </tr>`)}</tbody>
        </table></div>` : ''}
      </div>`)}
    </section>`);

  document.getElementById('test-mcp')?.addEventListener('click', async (event) => {
    setBusy(event.target, true, 'Testing…');
    const out = document.getElementById('mcp-result');
    try {
      const result = await api('/admin/integration/test-mcp', { method: 'POST', body: {} });
      out.textContent = result.ok ? `Connected. ${result.tools.length} tools available.` : `Failed: ${result.error}`;
    } catch (err) {
      out.textContent = err.message;
    } finally {
      setBusy(event.target, false, 'Test MCP connection');
    }
  });
}
