// Tool-calling loop: the model decides which portal tools to call, the portal
// runs them, and the model finishes with a schema-checked JSON answer.

const { AiError, parseJson } = require('./openaiClient');

// Tool definitions follow MCP's shape (name, description, inputSchema) so the
// same tools could later be served from an MCP server unchanged.
function toOpenAiTools(tools) {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.inputSchema, strict: true },
  }));
}

async function runTool(tools, call) {
  const tool = tools.find((t) => t.name === call.function?.name);
  if (!tool) return { error: `Unknown tool: ${call.function?.name}` };
  let args;
  try {
    args = JSON.parse(call.function.arguments || '{}');
  } catch {
    return { error: 'Tool arguments were not valid JSON.' };
  }
  try {
    return await tool.handler(args);
  } catch (err) {
    // The model sees a short error and can try something else; details stay in our logs.
    console.warn(`[ai] tool ${tool.name} failed:`, err.message);
    return { error: err.publicMessage || 'That lookup failed. Try a different request or continue without it.' };
  }
}

async function runAgent({ client, system, user, tools, output, maxSteps = 6 }) {
  const openAiTools = toOpenAiTools(tools);
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: typeof user === 'string' ? user : JSON.stringify(user) },
  ];
  const trace = [];

  for (let step = 1; step <= maxSteps; step++) {
    // On the last step the model must answer with what it already has.
    const lastStep = step === maxSteps;
    const message = await client.chat({ messages, tools: openAiTools, toolChoice: lastStep ? 'none' : 'auto', output });

    if (!message.tool_calls?.length) {
      return { result: parseJson(message.content), trace };
    }

    messages.push({ role: 'assistant', content: message.content ?? null, tool_calls: message.tool_calls });
    for (const call of message.tool_calls) {
      const result = await runTool(tools, call);
      trace.push({ tool: call.function?.name, arguments: call.function?.arguments });
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }
  throw new AiError('The AI assistant did not finish within its step limit.');
}

module.exports = { runAgent, toOpenAiTools };
