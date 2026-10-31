// Minimal OpenAI Chat Completions client: tool calling plus Structured Outputs
// (strict JSON schema), so the portal never has to parse free text.

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

  // One model turn. Returns the assistant message, which either carries
  // tool_calls or the final content matching `output.schema`.
  async chat({ messages, tools, toolChoice, output }) {
    const res = await this.fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages,
        ...(tools?.length ? { tools, tool_choice: toolChoice || 'auto', parallel_tool_calls: true } : {}),
        ...(output ? { response_format: { type: 'json_schema', json_schema: { name: output.name, strict: true, schema: output.schema } } } : {}),
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    }).catch((err) => {
      throw new AiError(`OpenAI request failed: ${err.message}`);
    });

    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new AiError(body.error?.message || `OpenAI returned ${res.status}`, { status: res.status, code: body.error?.code });
    }
    const choice = body.choices?.[0];
    if (choice?.message?.refusal) throw new AiError(`OpenAI declined the request: ${choice.message.refusal}`, { code: 'refusal' });
    if (choice?.finish_reason === 'length') throw new AiError('OpenAI response was truncated.', { code: 'length' });
    if (!choice?.message) throw new AiError('OpenAI returned no message.');
    return choice.message;
  }

  // Single-shot structured answer with no tools.
  async completeJson({ name, schema, system, user }) {
    const message = await this.chat({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: typeof user === 'string' ? user : JSON.stringify(user) },
      ],
      output: { name, schema },
    });
    return parseJson(message.content);
  }
}

function parseJson(content) {
  try {
    return JSON.parse(content);
  } catch {
    throw new AiError('OpenAI returned a response that was not valid JSON.');
  }
}

module.exports = { OpenAiClient, AiError, parseJson };
