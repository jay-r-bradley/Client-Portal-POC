"""Tool-calling loop: the model decides which portal tools to call, the portal
runs them, and the model finishes with a schema-checked JSON answer."""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Any, Awaitable, Callable

from .openai_client import AiError, parse_json

log = logging.getLogger("portal.ai")


@dataclass
class Tool:
    """Shaped like an MCP tool (name, description, input schema), so the same tools
    could later be served from an MCP server unchanged."""

    name: str
    description: str
    input_schema: dict
    handler: Callable[[dict], Awaitable[Any]]


class ToolError(Exception):
    """A tool failure whose message is safe to show the model."""


def to_openai_tools(tools: list[Tool]) -> list[dict]:
    return [{"type": "function", "function": {"name": t.name, "description": t.description, "parameters": t.input_schema, "strict": True}} for t in tools]


async def _run_tool(tools: list[Tool], call: dict) -> Any:
    fn = call.get("function") or {}
    tool = next((t for t in tools if t.name == fn.get("name")), None)
    if not tool:
        return {"error": f"Unknown tool: {fn.get('name')}"}
    try:
        args = json.loads(fn.get("arguments") or "{}")
    except ValueError:
        return {"error": "Tool arguments were not valid JSON."}
    try:
        return await tool.handler(args)
    except ToolError as err:
        return {"error": str(err)}
    except Exception as err:  # noqa: BLE001 - details stay in our logs, not the model's context
        log.warning("AI tool %s failed: %s", tool.name, err)
        return {"error": "That lookup failed. Try a different request or continue without it."}


async def run_agent(*, client: Any, system: str, user: Any, tools: list[Tool], output: dict, max_steps: int = 6) -> tuple[Any, list[dict]]:
    openai_tools = to_openai_tools(tools)
    messages: list[dict] = [{"role": "system", "content": system},
                            {"role": "user", "content": user if isinstance(user, str) else json.dumps(user)}]
    trace: list[dict] = []
    for step in range(1, max_steps + 1):
        # On the last step the model must answer with what it already has.
        message = await client.chat(messages=messages, tools=openai_tools, tool_choice="none" if step == max_steps else "auto", output=output)
        calls = message.get("tool_calls") or []
        if not calls:
            return parse_json(message.get("content")), trace
        messages.append({"role": "assistant", "content": message.get("content"), "tool_calls": calls})
        for call in calls:
            result = await _run_tool(tools, call)
            trace.append({"tool": (call.get("function") or {}).get("name"), "arguments": (call.get("function") or {}).get("arguments")})
            messages.append({"role": "tool", "tool_call_id": call.get("id"), "content": json.dumps(result, default=str)})
    raise AiError("The AI assistant did not finish within its step limit.")
