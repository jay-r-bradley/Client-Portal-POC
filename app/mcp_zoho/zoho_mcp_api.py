"""Read-only Zoho CRM access through a Zoho MCP server.

Implements the subset of ZohoApi that LiveCrm needs for reading, so
LiveCrm(settings, api=ZohoMcpApi(...)) is a CRM service whose every lookup goes
over MCP. Reads are expressed as COQL, so only the COQL tool is required; user
and field-metadata tools are optional. Tool names and argument shapes come from
config/zoho-mcp-tools.json because they depend on the Zoho MCP server's setup.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from ..config import CrmSettings
from ..zoho.mappers import assert_id, quote

COQL_LIMIT = 200
_WHOLE = re.compile(r"^\{(\w+)\}$")
_PART = re.compile(r"\{(\w+)\}")


def load_tool_map(path: Path) -> dict[str, Any]:
    data = json.loads(Path(path).read_text())
    data.pop("_comment", None)
    return data


_MISSING = object()


def fill_template(template: Any, values: dict[str, Any]) -> Any:
    """"{name}" alone becomes the raw value; inside a longer string it is
    interpolated; keys whose value resolves to missing are dropped."""
    if isinstance(template, str):
        whole = _WHOLE.match(template)
        if whole:
            return values.get(whole.group(1), _MISSING)
        return _PART.sub(lambda m: "" if values.get(m.group(1)) is None else str(values[m.group(1)]), template)
    if isinstance(template, list):
        return [v for v in (fill_template(t, values) for t in template) if v is not _MISSING]
    if isinstance(template, dict):
        out = {}
        for key, value in template.items():
            filled = fill_template(value, values)
            if filled is not _MISSING:
                out[key] = filled
        return out
    return template


def unwrap(result: Any, key: str) -> list[Any]:
    """Zoho MCP tools wrap REST endpoints, so results carry the REST envelope."""
    if isinstance(result, list):
        return result
    if isinstance(result, dict):
        if isinstance(result.get(key), list):
            return result[key]
        if isinstance(result.get("data"), dict) and isinstance(result["data"].get(key), list):
            return result["data"][key]
    return []


class ZohoMcpApi:
    def __init__(self, *, connection: Any, tool_map: dict[str, Any], crm: CrmSettings):
        if "coql" not in tool_map:
            raise ValueError('The Zoho MCP tool map must define a "coql" tool.')
        self.connection = connection
        self.tool_map = tool_map
        self.crm = crm

    async def _call(self, operation: str, values: dict[str, Any]) -> Any:
        entry = self.tool_map.get(operation)
        if not entry:
            raise LookupError(f'No Zoho MCP tool is mapped for "{operation}".')
        return await self.connection.call_tool(entry["tool"], fill_template(entry.get("args", {}), values))

    async def coql(self, select_query: str) -> list[dict]:
        return unwrap(await self._call("coql", {"query": select_query}), "data")

    def _default_fields(self, module: str) -> list[str]:
        if module == self.crm.properties_module:
            return self.crm.property.values()
        if module == self.crm.deals_module:
            return [*vars(self.crm.deal).values(), "Owner", "Modified_Time"]
        return ["Owner", "Modified_Time"]

    async def get_record(self, module: str, record_id: str, fields: list[str] | None = None) -> dict | None:
        columns = ", ".join(dict.fromkeys(fields or self._default_fields(module)))
        rows = await self.coql(f"select {columns} from {module} where id = {quote(assert_id(record_id))} limit 1")
        return rows[0] if rows else None

    async def get_related_records(self, module: str, record_id: str, related: str, fields: list[str]) -> list[dict]:
        # Only Contact -> Deals is needed: it is the deal's contact lookup.
        if module != self.crm.contacts_module or related != self.crm.deals_module:
            raise LookupError(f"Related list {module}/{related} is not available over MCP.")
        columns = ", ".join(dict.fromkeys(fields))
        return await self.coql(f"select {columns} from {related} where {self.crm.deal.contact} = {quote(assert_id(record_id))} limit {COQL_LIMIT}")

    async def get_user(self, user_id: str) -> dict | None:
        if "getUser" not in self.tool_map:
            return None
        users = unwrap(await self._call("getUser", {"id": assert_id(user_id)}), "users")
        return users[0] if users else None

    async def get_fields(self, module: str) -> list[dict]:
        if "getFields" not in self.tool_map:
            return []
        return unwrap(await self._call("getFields", {"module": module}), "fields")

    # The AI path is read-only by design: portal writes go over REST.
    async def create_record(self, *_: Any, **__: Any) -> Any:
        raise PermissionError("The Zoho MCP connection is read-only.")

    async def update_record(self, *_: Any, **__: Any) -> Any:
        raise PermissionError("The Zoho MCP connection is read-only.")

    async def search_by_email(self, *_: Any, **__: Any) -> Any:
        raise LookupError("Contact lookup by email is not available over MCP.")
