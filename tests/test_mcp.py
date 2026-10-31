"""Zoho over MCP, against an in-process MCP server built with the official Python SDK."""

from __future__ import annotations

import json

import pytest
from mcp.server.mcpserver import MCPServer

from app.config import Settings
from app.mcp_zoho.connection import McpConnection, McpToolError
from app.mcp_zoho.zoho_mcp_api import ZohoMcpApi, fill_template
from app.zoho.live_crm import LiveCrm

S = Settings()
TOOL_MAP = {
    "coql": {"tool": "ExecuteCOQLQuery", "args": {"body": {"select_query": "{query}"}}},
    "getUser": {"tool": "GetUser", "args": {"path_variables": {"user": "{id}"}}},
}


def fake_zoho_mcp():
    queries: list[str] = []
    server = MCPServer("fake-zoho-crm")

    @server.tool()
    def ExecuteCOQLQuery(body: dict) -> str:  # noqa: N802 - mirrors a Zoho tool name
        """Run a COQL query."""
        query = body["select_query"]
        queries.append(query)
        if "BROKEN" in query:
            raise ValueError("INVALID_QUERY")
        if "from Deals where Contact_Name" in query:
            return json.dumps({"data": [{"id": "501", "Deal_Name": "Rivera - Lakeview", "Stage": "Negotiation", "Amount": 478000,
                                         "Contact_Name": {"id": "101"}, "Owner": {"id": "9"}}]})
        if "from Deals where id = '502'" in query:
            return json.dumps({"data": [{"id": "502", "Deal_Name": "Someone else", "Contact_Name": {"id": "999"}}]})
        if "from Properties" in query:
            return json.dumps({"data": [{"id": "701", "Name": "Lakeview Townhouse", "City": "Austin", "Price": 485000, "Status": "Available"}]})
        return ""

    @server.tool()
    def GetUser(path_variables: dict) -> str:  # noqa: N802
        """Get a CRM user."""
        return json.dumps({"users": [{"id": path_variables["user"], "full_name": "Maria Santos", "email": "maria@x"}]})

    return server, queries


@pytest.fixture
async def mcp():
    server, queries = fake_zoho_mcp()
    connection = McpConnection(server)
    api = ZohoMcpApi(connection=connection, tool_map=TOOL_MAP, crm=S.crm)
    yield {"api": api, "crm": LiveCrm(S, api=api), "queries": queries, "connection": connection}
    await connection.close()


def test_fill_template_substitutes_whole_values_and_interpolates():
    assert fill_template({"body": {"q": "{query}", "list": "{ids}"}, "path": "x/{id}", "gone": "{missing}"},
                         {"query": "select 1", "ids": [1, 2], "id": 7}) == {"body": {"q": "select 1", "list": [1, 2]}, "path": "x/7"}


async def test_deals_are_read_over_mcp_with_client_scoped_coql(mcp):
    deals = await mcp["crm"].list_deals("101")
    assert len(deals) == 1 and deals[0]["stage"] == "Negotiation"
    assert deals[0]["agent"]["name"] == "Maria Santos", "agent details via the mapped GetUser tool"
    assert mcp["queries"][0].endswith("from Deals where Contact_Name = '101' limit 200")


async def test_another_contacts_deal_is_not_returned(mcp):
    assert await mcp["crm"].get_deal("101", "502") is None


async def test_property_search_runs_as_coql_through_mcp(mcp):
    from app.criteria import normalize_criteria
    results = await mcp["crm"].search_properties(normalize_criteria({"budgetMax": 500000, "locations": ["Austin"]}))
    assert [p["name"] for p in results] == ["Lakeview Townhouse"]
    assert "Price <= 500000" in mcp["queries"][0]


async def test_ids_are_validated_before_reaching_coql(mcp):
    with pytest.raises(ValueError, match="Invalid record id"):
        await mcp["api"].get_record("Deals", "1' or id != '0")
    assert mcp["queries"] == []


async def test_tool_errors_and_read_only(mcp):
    with pytest.raises(McpToolError):
        await mcp["api"].coql("select BROKEN")
    with pytest.raises(PermissionError, match="read-only"):
        await mcp["api"].create_record("Notes", {})


async def test_stages_fall_back_to_config_without_a_fields_tool(mcp):
    assert await mcp["crm"].get_stages() == S.crm.deal_stages
