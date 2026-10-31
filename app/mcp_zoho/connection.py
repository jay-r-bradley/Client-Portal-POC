"""A lazily-connected MCP client (Streamable HTTP, official Python SDK) with JSON result parsing."""

from __future__ import annotations

import asyncio
import json
import logging
from contextlib import AsyncExitStack
from typing import Any

import httpx2
from mcp import Client
from mcp.client.streamable_http import streamable_http_client

log = logging.getLogger("portal.mcp")


class McpToolError(Exception):
    def __init__(self, message: str, tool: str | None = None):
        super().__init__(message)
        self.tool = tool


def parse_tool_result(result: Any, tool: str) -> Any:
    """MCP tools return content blocks. Zoho returns its REST payloads as JSON text."""
    text = "\n".join(c.text for c in result.content if getattr(c, "type", None) == "text")
    if result.is_error:
        raise McpToolError(text or f"MCP tool {tool} failed", tool)
    if text.strip():
        try:
            return json.loads(text)
        except ValueError:
            return text
    return getattr(result, "structured_content", None)


class McpConnection:
    """`server` is the MCP server URL, or (in tests) an in-process server object."""

    def __init__(self, server: Any, *, headers: dict[str, str] | None = None, timeout_seconds: float = 20.0):
        self.server = server
        self.headers = headers or {}
        self.timeout = timeout_seconds
        self._client: Client | None = None
        self._stack: AsyncExitStack | None = None
        self._lock = asyncio.Lock()

    def _target(self) -> Any:
        if isinstance(self.server, str):
            http = httpx2.AsyncClient(headers=self.headers, timeout=httpx2.Timeout(self.timeout, connect=5.0))
            return streamable_http_client(self.server, http_client=http)
        return self.server

    async def connect(self) -> Client:
        async with self._lock:
            if self._client is None:
                stack = AsyncExitStack()
                self._client = await stack.enter_async_context(Client(self._target(), read_timeout_seconds=self.timeout))
                self._stack = stack
            return self._client

    async def list_tools(self) -> list[Any]:
        client = await self.connect()
        tools, cursor = [], None
        while True:
            page = await client.list_tools(cursor=cursor)
            tools.extend(page.tools)
            cursor = getattr(page, "next_cursor", None)
            if not cursor:
                return tools

    async def call_tool(self, name: str, arguments: dict[str, Any], *, _retried: bool = False) -> Any:
        try:
            client = await self.connect()
            result = await asyncio.wait_for(client.call_tool(name, arguments), timeout=self.timeout)
        except McpToolError:
            raise
        except Exception as err:  # noqa: BLE001 - remote sessions expire; reconnect once
            if _retried:
                raise McpToolError(f"MCP call {name} failed: {type(err).__name__}", name) from err
            await self.close()
            return await self.call_tool(name, arguments, _retried=True)
        return parse_tool_result(result, name)

    async def close(self) -> None:
        stack, self._stack, self._client = self._stack, None, None
        if stack:
            try:
                await stack.aclose()
            except Exception as err:  # noqa: BLE001
                log.debug("MCP close: %s", err)
