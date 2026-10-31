"""Wires the AI: the model client, and which CRM path the AI reads through."""

from __future__ import annotations

import logging
from typing import Any

from ..config import Settings
from ..mcp_zoho.connection import McpConnection
from ..mcp_zoho.zoho_mcp_api import ZohoMcpApi, load_tool_map
from ..zoho.live_crm import LiveCrm
from .openai_client import OpenAiClient
from .service import AiService

log = logging.getLogger("portal.ai")


def create_ai_crm(settings: Settings, crm: Any) -> tuple[Any, str, McpConnection | None]:
    """With ZOHO_MCP_URL set (live mode) every AI lookup goes over Zoho MCP;
    otherwise the AI shares the pages' CRM service."""
    if not settings.zoho_mcp.url:
        return crm, "mock data" if settings.zoho_mode == "mock" else "Zoho REST API", None
    if settings.zoho_mode != "live":
        log.warning("ZOHO_MCP_URL is ignored while ZOHO_MODE=mock, so the AI sees the same sample data as the pages.")
        return crm, "mock data", None
    headers = {"Authorization": settings.zoho_mcp.authorization} if settings.zoho_mcp.authorization else {}
    connection = McpConnection(settings.zoho_mcp.url, headers=headers, timeout_seconds=settings.zoho_mcp.timeout_seconds)
    api = ZohoMcpApi(connection=connection, tool_map=load_tool_map(settings.zoho_mcp.tool_map_path), crm=settings.crm)
    return LiveCrm(settings, api=api), "Zoho MCP", connection


def create_ai(settings: Settings, crm: Any) -> AiService | None:
    if not settings.ai.enabled:
        return None
    ai_crm, source, connection = create_ai_crm(settings, crm)
    ai = AiService(client=OpenAiClient(settings.ai), crm=ai_crm, settings=settings)
    ai.source = source
    ai.mcp = connection
    return ai
