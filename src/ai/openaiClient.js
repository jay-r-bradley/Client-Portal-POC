// Minimal OpenAI Chat Completions client that always returns schema-validated
// JSON (Structured Outputs), so the portal never has to parse free text.

class AiError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = 'AiError';
    this.status = status;
    this.code = code;
  }
}

class OpenAiClient {
  constructor({ apiKey, model, baseUrl = 'https://api.openai.com/v1', timeoutMs = 30000, fetchImpl = fetch }) {
    if (!apiKey) throw new Error('OPENAI_API_KEY is required to enable AI features.');
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
  }

  // Returns the parsed JSON object matching `schema`.
  async completeJson({ name, schema, system, user }) {
    const res = await this.fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: typeof user === 'string' ? user : JSON.stringify(user) },
        ],
        response_format: { type: 'json_schema', json_schema: { name, strict: true, schema } },
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    }).catch((err) => {
      throw new AiError(`OpenAI request failed: ${err.message}`);
    });

    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new AiError(body.error?.message || `OpenAI returned ${res.status}`, { status: res.status, code: body.error?.code });
    }
    const message = body.choices?.[0]?.message;
    if (message?.refusal) throw new AiError(`OpenAI declined the request: ${message.refusal}`, { code: 'refusal' });
    if (body.choices?.[0]?.finish_reason === 'length') throw new AiError('OpenAI response was truncated.', { code: 'length' });
    try {
      return JSON.parse(message?.content);
    } catch {
      throw new AiError('OpenAI returned a response that was not valid JSON.');
    }
  }
}

module.exports = { OpenAiClient, AiError };
