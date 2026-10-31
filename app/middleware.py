"""HTTP security middleware: headers, cross-site request blocking, body-size
limits and request timeouts."""

from __future__ import annotations

import asyncio
import logging
from urllib.parse import urlsplit

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from .config import Settings

log = logging.getLogger("portal.http")

CSP = ("default-src 'self'; img-src 'self' https: data:; style-src 'self'; script-src 'self'; "
       "connect-src 'self'; form-action 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'")
WRITE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}


def install_middleware(app: FastAPI, settings: Settings) -> None:
    sec = settings.security

    @app.middleware("http")
    async def request_timeout(request: Request, call_next):
        # AI requests make several model calls, so they get a longer budget.
        limit = sec.ai_request_timeout_seconds if request.url.path.startswith("/api/ai/") else sec.request_timeout_seconds
        try:
            return await asyncio.wait_for(call_next(request), timeout=limit)
        except TimeoutError:
            log.warning("Request timed out after %ss: %s %s", limit, request.method, request.url.path)
            return JSONResponse({"error": "The request took too long. Please try again."}, status_code=504)

    @app.middleware("http")
    async def guard_writes(request: Request, call_next):
        """CSRF defence and size limits for state-changing API requests."""
        if request.url.path.startswith("/api/") and request.method in WRITE_METHODS:
            content_type = request.headers.get("content-type", "").split(";")[0].strip().lower()
            if content_type != "application/json":
                return JSONResponse({"error": "Requests must be JSON."}, status_code=415)
            if request.headers.get("sec-fetch-site") == "cross-site":
                return JSONResponse({"error": "Cross-site request blocked."}, status_code=403)
            origin = request.headers.get("origin")
            if origin and urlsplit(origin).netloc != request.headers.get("host"):
                return JSONResponse({"error": "Cross-site request blocked."}, status_code=403)
            length = request.headers.get("content-length")
            if length is None:
                return JSONResponse({"error": "Request size is required."}, status_code=411)
            if not length.isdigit() or int(length) > sec.max_body_bytes:
                return JSONResponse({"error": "Request is too large."}, status_code=413)
        return await call_next(request)

    @app.middleware("http")
    async def security_headers(request: Request, call_next):
        response = await call_next(request)
        headers = response.headers
        headers["X-Content-Type-Options"] = "nosniff"
        headers["X-Frame-Options"] = "DENY"
        headers["Referrer-Policy"] = "same-origin"
        headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=(), payment=()"
        headers["Cross-Origin-Opener-Policy"] = "same-origin"
        headers["Content-Security-Policy"] = CSP
        if settings.is_production:
            headers["Strict-Transport-Security"] = "max-age=63072000; includeSubDomains"
        if request.url.path.startswith("/api/"):
            headers["Cache-Control"] = "no-store"
        return response
