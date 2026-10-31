"""Zoho → portal webhook: Zoho calls this when a record is created, edited or
deleted, and the portal refreshes that one record in its copy.

Set it up in Zoho CRM: Setup → Automation → Actions → Webhooks, URL
https://<portal>/api/sync/zoho-webhook, with the parameters module, id and
event (and the secret, as the X-Portal-Webhook-Token header or a "token"
parameter). See docs/DATABASE.md.
"""

from __future__ import annotations

import hmac
import json
import logging
import re
from urllib.parse import parse_qsl

from fastapi import APIRouter, Depends, Request

from ..web import ApiError, Services, services

log = logging.getLogger("portal.sync")
router = APIRouter(prefix="/api/sync")
ZOHO_ID = re.compile(r"^[A-Za-z0-9_-]{1,40}$")


async def _payload(request: Request) -> dict:
    raw = await request.body()
    content_type = request.headers.get("content-type", "").split(";")[0].strip().lower()
    try:
        if content_type == "application/json":
            data = json.loads(raw or b"{}")
            return data if isinstance(data, dict) else {}
        return dict(parse_qsl(raw.decode("utf-8"), keep_blank_values=True))
    except (ValueError, UnicodeDecodeError):
        return {}


@router.post("/zoho-webhook")
async def zoho_webhook(request: Request, svc: Services = Depends(services)):
    secret = svc.settings.sync.webhook_secret
    if not secret or not svc.sync:
        raise ApiError(404, "Not found.")  # webhooks are off until a secret is set
    data = await _payload(request)
    token = request.headers.get("x-portal-webhook-token") or str(data.get("token") or "")
    if not hmac.compare_digest(token.encode(), secret.encode()):
        log.warning("Webhook rejected: bad token from %s", request.client.host if request.client else "?")
        raise ApiError(401, "Unauthorized.")
    module, zoho_id = str(data.get("module") or "").strip(), str(data.get("id") or "").strip()
    if not module or not ZOHO_ID.match(zoho_id):
        raise ApiError(400, "Invalid request.")
    deleted = str(data.get("event") or "").strip().lower() in {"delete", "deleted", "remove"}
    try:
        result = await svc.sync.sync_record(module, zoho_id, deleted=deleted)
    except ValueError:
        raise ApiError(400, "Unknown module.") from None
    return {"ok": True, "result": result}
