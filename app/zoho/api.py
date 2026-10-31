"""Async Zoho CRM REST client (v8 by default): OAuth refresh-token exchange,
access-token caching, one retry on an expired token, and timeouts on every call."""

from __future__ import annotations

import asyncio
import time
from typing import Any
from urllib.parse import quote as urlquote

import httpx

from ..config import ZohoSettings


class ZohoApiError(Exception):
    def __init__(self, message: str, *, status: int | None = None, code: str | None = None):
        super().__init__(message)
        self.status = status
        self.code = code


def _seg(value: str) -> str:
    """Encode a path segment so an id can never add path components or a query."""
    return urlquote(str(value), safe="")


class ZohoApi:
    def __init__(self, settings: ZohoSettings, *, transport: httpx.AsyncBaseTransport | None = None):
        if not (settings.client_id and settings.client_secret and settings.refresh_token):
            raise RuntimeError("ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET and ZOHO_REFRESH_TOKEN are required when ZOHO_MODE=live.")
        self.settings = settings
        self.api_domain = settings.api_domain.rstrip("/")
        self.http = httpx.AsyncClient(timeout=httpx.Timeout(settings.timeout_seconds, connect=5.0), transport=transport)
        self.access_token: str | None = None
        self.expires_at = 0.0
        self._refresh_lock = asyncio.Lock()

    async def get_access_token(self, *, force: bool = False) -> str:
        if not force and self.access_token and time.time() < self.expires_at:
            return self.access_token
        # One refresh at a time; Zoho rate-limits token calls.
        async with self._refresh_lock:
            if not force and self.access_token and time.time() < self.expires_at:
                return self.access_token
            try:
                res = await self.http.post(f"{self.settings.accounts_url.rstrip('/')}/oauth/v2/token", data={
                    "refresh_token": self.settings.refresh_token, "client_id": self.settings.client_id,
                    "client_secret": self.settings.client_secret, "grant_type": "refresh_token",
                })
            except httpx.HTTPError as err:
                raise ZohoApiError(f"Zoho token request failed: {type(err).__name__}") from err
            body = res.json() if res.content else {}
            if res.status_code >= 400 or "access_token" not in body:
                raise ZohoApiError(f"Zoho token refresh failed: {body.get('error', res.status_code)}", status=res.status_code)
            self.access_token = body["access_token"]
            # Refresh a minute early so in-flight requests never carry a stale token.
            self.expires_at = time.time() + float(body.get("expires_in", 3600)) - 60
            if body.get("api_domain"):
                self.api_domain = body["api_domain"].rstrip("/")
            return self.access_token

    async def request(self, method: str, path: str, *, params: dict[str, Any] | None = None, json: Any = None,
                      headers: dict[str, str] | None = None, _retried: bool = False) -> Any:
        token = await self.get_access_token()
        url = f"{self.api_domain}/crm/{self.settings.api_version}{path}"
        try:
            res = await self.http.request(method, url, params={k: v for k, v in (params or {}).items() if v is not None},
                                          json=json, headers={**(headers or {}), "Authorization": f"Zoho-oauthtoken {token}"})
        except httpx.TimeoutException as err:
            raise ZohoApiError(f"Zoho API {method} {path} timed out") from err
        except httpx.HTTPError as err:
            raise ZohoApiError(f"Zoho API {method} {path} failed: {type(err).__name__}") from err
        # Zoho answers 204 for searches, related lists and COQL with no rows, and
        # 304 when nothing changed since If-Modified-Since.
        if res.status_code in (204, 304):
            return None
        try:
            payload = res.json()
        except ValueError:
            payload = None
        if res.status_code == 401 and not _retried and (payload or {}).get("code") == "INVALID_TOKEN":
            await self.get_access_token(force=True)
            return await self.request(method, path, params=params, json=json, headers=headers, _retried=True)
        if res.status_code >= 400:
            payload = payload or {}
            raise ZohoApiError(payload.get("message") or f"Zoho API {method} {path} failed with {res.status_code}",
                               status=res.status_code, code=payload.get("code"))
        return payload

    async def get_record(self, module: str, record_id: str, fields: list[str] | None = None) -> dict[str, Any] | None:
        try:
            res = await self.request("GET", f"/{_seg(module)}/{_seg(record_id)}", params={"fields": ",".join(fields) if fields else None})
        except ZohoApiError as err:
            if err.status == 404 or err.code == "INVALID_DATA":
                return None
            raise
        return ((res or {}).get("data") or [None])[0]

    async def get_related_records(self, module: str, record_id: str, related: str, fields: list[str]) -> list[dict[str, Any]]:
        res = await self.request("GET", f"/{_seg(module)}/{_seg(record_id)}/{_seg(related)}", params={"fields": ",".join(fields), "per_page": 200})
        return (res or {}).get("data") or []

    async def search_by_email(self, module: str, email: str) -> list[dict[str, Any]]:
        res = await self.request("GET", f"/{_seg(module)}/search", params={"email": email})
        return (res or {}).get("data") or []

    async def coql(self, select_query: str) -> list[dict[str, Any]]:
        res = await self.request("POST", "/coql", json={"select_query": select_query})
        return (res or {}).get("data") or []

    async def create_record(self, module: str, record: dict[str, Any]) -> dict[str, Any]:
        res = await self.request("POST", f"/{_seg(module)}", json={"data": [{k: v for k, v in record.items() if v is not None}]})
        result = ((res or {}).get("data") or [{}])[0]
        if result.get("status") != "success":
            raise ZohoApiError(result.get("message") or f"Failed to create {module} record", code=result.get("code"))
        return result.get("details") or {}

    async def update_record(self, module: str, record_id: str, record: dict[str, Any]) -> dict[str, Any]:
        res = await self.request("PUT", f"/{_seg(module)}/{_seg(record_id)}", json={"data": [record]})
        result = ((res or {}).get("data") or [{}])[0]
        if result.get("status") != "success":
            raise ZohoApiError(result.get("message") or f"Failed to update {module} record", code=result.get("code"))
        return result.get("details") or {}

    async def list_records(self, module: str, fields: list[str], *, modified_since: str | None = None) -> list[dict[str, Any]]:
        """Every record of a module (or only those changed since a time), oldest change
        first, following Zoho's page tokens."""
        out: list[dict[str, Any]] = []
        params: dict[str, Any] = {"fields": ",".join(dict.fromkeys(fields)), "per_page": 200, "sort_by": "Modified_Time", "sort_order": "asc"}
        headers = {"If-Modified-Since": modified_since} if modified_since else None
        paging: dict[str, Any] = {"page": 1}
        while True:
            res = await self.request("GET", f"/{_seg(module)}", params=params | paging, headers=headers) or {}
            out.extend(res.get("data") or [])
            info = res.get("info") or {}
            if not info.get("more_records"):
                return out
            if info.get("next_page_token"):  # Zoho requires page tokens past 2,000 records
                paging = {"page_token": info["next_page_token"]}
            else:
                paging = {"page": paging.get("page", 1) + 1}

    async def list_users(self) -> list[dict[str, Any]]:
        res = await self.request("GET", "/users", params={"type": "AllUsers", "per_page": 200})
        return (res or {}).get("users") or []

    async def get_user(self, user_id: str) -> dict[str, Any] | None:
        res = await self.request("GET", f"/users/{_seg(user_id)}")
        return ((res or {}).get("users") or [None])[0]

    async def get_fields(self, module: str) -> list[dict[str, Any]]:
        res = await self.request("GET", "/settings/fields", params={"module": module})
        return (res or {}).get("fields") or []

    async def aclose(self) -> None:
        await self.http.aclose()
