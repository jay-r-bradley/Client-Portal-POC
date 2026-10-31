"""Minimal OpenAI Chat Completions client: tool calling plus Structured Outputs
(strict JSON schema), with a timeout on every call."""

from __future__ import annotations

import json
from typing import Any

import httpx

from ..config import AiSettings


class AiError(Exception):
    def __init__(self, message: str, *, status: int | None = None, code: str | None = None):
        super().__init__(message)
        self.status = status
        self.code = code


def parse_json(content: str | None) -> Any:
    try:
        return json.loads(content or "")
    except ValueError:
        raise AiError("OpenAI returned a response that was not valid JSON.") from None


class OpenAiClient:
    def __init__(self, settings: AiSettings, *, transport: httpx.AsyncBaseTransport | None = None):
        if not settings.api_key:
            raise RuntimeError("OPENAI_API_KEY is required to enable AI features.")
        self.settings = settings
        self.http = httpx.AsyncClient(
            base_url=settings.base_url.rstrip("/"),
            timeout=httpx.Timeout(settings.timeout_seconds, connect=5.0),
            headers={"Authorization": f"Bearer {settings.api_key}"},
            transport=transport,
        )

    async def chat(self, *, messages: list[dict], tools: list[dict] | None = None, tool_choice: str | None = None,
                   output: dict | None = None) -> dict:
        """One model turn: returns the assistant message (tool calls, or final JSON content)."""
        body: dict[str, Any] = {"model": self.settings.model, "messages": messages}
        if tools:
            body.update(tools=tools, tool_choice=tool_choice or "auto", parallel_tool_calls=True)
        if output:
            body["response_format"] = {"type": "json_schema", "json_schema": {"name": output["name"], "strict": True, "schema": output["schema"]}}
        try:
            res = await self.http.post("/chat/completions", json=body)
        except httpx.TimeoutException as err:
            raise AiError("OpenAI request timed out.") from err
        except httpx.HTTPError as err:
            raise AiError(f"OpenAI request failed: {type(err).__name__}") from err
        try:
            payload = res.json()
        except ValueError:
            payload = {}
        if res.status_code >= 400:
            error = payload.get("error") or {}
            raise AiError(error.get("message") or f"OpenAI returned {res.status_code}", status=res.status_code, code=error.get("code"))
        choice = (payload.get("choices") or [{}])[0]
        message = choice.get("message")
        if message and message.get("refusal"):
            raise AiError(f"OpenAI declined the request: {message['refusal']}", code="refusal")
        if choice.get("finish_reason") == "length":
            raise AiError("OpenAI response was truncated.", code="length")
        if not message:
            raise AiError("OpenAI returned no message.")
        return message

    async def complete_json(self, *, name: str, schema: dict, system: str, user: Any) -> Any:
        message = await self.chat(
            messages=[{"role": "system", "content": system},
                      {"role": "user", "content": user if isinstance(user, str) else json.dumps(user)}],
            output={"name": name, "schema": schema},
        )
        return parse_json(message.get("content"))

    async def aclose(self) -> None:
        await self.http.aclose()
