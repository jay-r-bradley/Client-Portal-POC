// Thin HTTP client for the Zoho CRM REST API (v8 by default).
// Handles OAuth 2.0 refresh-token exchange, access-token caching and a single
// retry when Zoho reports the token has expired.

class ZohoApiError extends Error {
  constructor(message, { status, code, details } = {}) {
    super(message);
    this.name = 'ZohoApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

class ZohoApi {
  constructor({ accountsUrl, apiDomain, apiVersion, clientId, clientSecret, refreshToken, fetchImpl = fetch }) {
    if (!clientId || !clientSecret || !refreshToken) {
      throw new Error('ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET and ZOHO_REFRESH_TOKEN are required when ZOHO_MODE=live.');
    }
    this.accountsUrl = accountsUrl.replace(/\/$/, '');
    this.apiDomain = apiDomain.replace(/\/$/, '');
    this.apiVersion = apiVersion;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.refreshToken = refreshToken;
    this.fetch = fetchImpl;

    this.accessToken = null;
    this.accessTokenExpiresAt = 0;
    this.pendingRefresh = null;
  }

  async getAccessToken({ force = false } = {}) {
    if (!force && this.accessToken && Date.now() < this.accessTokenExpiresAt) return this.accessToken;
    // Collapse concurrent refreshes into one request; Zoho rate-limits token calls.
    if (!this.pendingRefresh) {
      this.pendingRefresh = this.refreshAccessToken().finally(() => {
        this.pendingRefresh = null;
      });
    }
    return this.pendingRefresh;
  }

  async refreshAccessToken() {
    const params = new URLSearchParams({
      refresh_token: this.refreshToken,
      client_id: this.clientId,
      client_secret: this.clientSecret,
      grant_type: 'refresh_token',
    });
    const res = await this.fetch(`${this.accountsUrl}/oauth/v2/token`, { method: 'POST', body: params });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.access_token) {
      throw new ZohoApiError(`Zoho token refresh failed: ${body.error || res.status}`, { status: res.status, code: body.error });
    }
    this.accessToken = body.access_token;
    // Refresh a minute early so in-flight requests never carry a stale token.
    this.accessTokenExpiresAt = Date.now() + (Number(body.expires_in || 3600) - 60) * 1000;
    if (body.api_domain) this.apiDomain = body.api_domain.replace(/\/$/, '');
    return this.accessToken;
  }

  async request(method, path, { query, body } = {}, retried = false) {
    const url = new URL(`${this.apiDomain}/crm/${this.apiVersion}${path}`);
    for (const [key, value] of Object.entries(query || {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    const token = await this.getAccessToken();
    const res = await this.fetch(url, {
      method,
      headers: {
        Authorization: `Zoho-oauthtoken ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    // Zoho answers 204 for searches, related lists and COQL queries with no rows.
    if (res.status === 204) return null;

    const payload = await res.json().catch(() => null);
    if (res.status === 401 && !retried && payload?.code === 'INVALID_TOKEN') {
      await this.getAccessToken({ force: true });
      return this.request(method, path, { query, body }, true);
    }
    if (!res.ok) {
      throw new ZohoApiError(payload?.message || `Zoho API ${method} ${path} failed with ${res.status}`, {
        status: res.status,
        code: payload?.code,
        details: payload?.details,
      });
    }
    return payload;
  }

  // ---- Convenience wrappers -------------------------------------------------

  async getRecord(module, id, fields) {
    const res = await this.request('GET', `/${module}/${encodeURIComponent(id)}`, {
      query: fields ? { fields: fields.join(',') } : undefined,
    }).catch((err) => {
      if (err.status === 404 || err.code === 'INVALID_DATA') return null;
      throw err;
    });
    return res?.data?.[0] || null;
  }

  async getRelatedRecords(module, id, relatedList, fields, { perPage = 200 } = {}) {
    const res = await this.request('GET', `/${module}/${encodeURIComponent(id)}/${relatedList}`, {
      query: { fields: fields.join(','), per_page: perPage },
    });
    return res?.data || [];
  }

  async searchByEmail(module, email) {
    const res = await this.request('GET', `/${module}/search`, { query: { email } });
    return res?.data || [];
  }

  async coql(selectQuery) {
    const res = await this.request('POST', '/coql', { body: { select_query: selectQuery } });
    return res?.data || [];
  }

  async createRecord(module, record) {
    const res = await this.request('POST', `/${module}`, { body: { data: [record] } });
    const result = res?.data?.[0];
    if (result?.status !== 'success') {
      throw new ZohoApiError(result?.message || `Failed to create ${module} record`, {
        code: result?.code,
        details: result?.details,
      });
    }
    return result.details;
  }

  async getUser(id) {
    const res = await this.request('GET', `/users/${encodeURIComponent(id)}`);
    return res?.users?.[0] || null;
  }

  async getFields(module) {
    const res = await this.request('GET', '/settings/fields', { query: { module } });
    return res?.fields || [];
  }
}

module.exports = { ZohoApi, ZohoApiError };
