"""Client Portal: FastAPI application."""

from __future__ import annotations

import asyncio
import contextlib
import logging
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException

from .ai.factory import create_ai
from .ai.openai_client import AiError
from .config import Settings, load_settings
from .db import Database
from .demo import seed_demo
from .mailer import Mailer
from .mcp_zoho.connection import McpToolError
from .middleware import install_middleware
from .routes import admin as admin_routes, ai as ai_routes, auth as auth_routes, portal as portal_routes
from .web import Services
from .zoho.api import ZohoApi, ZohoApiError
from .zoho.live_crm import LiveCrm
from .zoho.mock_crm import MockCrm

log = logging.getLogger("portal")


def create_crm(settings: Settings) -> Any:
    if settings.zoho_mode == "live":
        return LiveCrm(settings, api=ZohoApi(settings.zoho))
    if settings.zoho_mode == "mock":
        return MockCrm(settings)
    raise RuntimeError(f'Unknown ZOHO_MODE "{settings.zoho_mode}". Use "mock" or "live".')


async def maintenance(svc: Services) -> None:
    """Data retention: expired codes and audit events past the retention period."""
    await svc.otps.purge()
    removed = await svc.activity.prune(svc.settings.security.activity_retention_days)
    if removed:
        await svc.activity.record(action="system.retention_pruned", details={"removed": removed,
                                  "retentionDays": svc.settings.security.activity_retention_days})


def create_app(settings: Settings | None = None, *, crm: Any = None, db: Database | None = None, ai: Any = "auto",
               mailer: Mailer | None = None, seed: bool | None = None) -> FastAPI:
    settings = settings or load_settings()
    crm = crm or create_crm(settings)
    db = db or Database(settings.database_url)
    ai_service = create_ai(settings, crm) if ai == "auto" else ai
    svc = Services(settings=settings, db=db, crm=crm, mailer=mailer or Mailer(settings.mail), ai=ai_service,
                   mcp=getattr(ai_service, "mcp", None))
    do_seed = settings.zoho_mode == "mock" if seed is None else seed

    @contextlib.asynccontextmanager
    async def lifespan(app: FastAPI):
        await db.create_all()
        if do_seed:
            await seed_demo(svc.users, svc.activity)
        await maintenance(svc)

        async def daily() -> None:
            while True:
                await asyncio.sleep(24 * 3600)
                try:
                    await maintenance(svc)
                except Exception as err:  # noqa: BLE001
                    log.error("Maintenance failed: %s", err)

        task = asyncio.create_task(daily())
        log.info("%s ready (Zoho mode: %s, AI: %s)", settings.brand_name, settings.zoho_mode,
                 f"{settings.ai.model} via {ai_service.source}" if ai_service else "off")
        yield
        task.cancel()
        if svc.mcp:
            await svc.mcp.close()

    # API docs are not exposed: they would advertise every endpoint to anyone.
    app = FastAPI(title=settings.brand_name, lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.state.services = svc
    install_middleware(app, settings)

    @app.exception_handler(StarletteHTTPException)
    async def http_error(request: Request, exc: StarletteHTTPException):
        message = exc.detail if isinstance(exc.detail, str) else "Request failed."
        if exc.status_code == 404 and not isinstance(exc.detail, str):
            message = "Not found."
        return JSONResponse({"error": message}, status_code=exc.status_code, headers=getattr(exc, "headers", None))

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, exc: RequestValidationError):
        # Malformed ids, dates or bodies: never echo the raw input back.
        return JSONResponse({"error": "Invalid request."}, status_code=400)

    @app.exception_handler(Exception)
    async def unexpected(request: Request, exc: Exception):
        status = 502 if isinstance(exc, (ZohoApiError, McpToolError, AiError)) else 500
        log.exception("[%s %s] %s", request.method, request.url.path, type(exc).__name__)
        return JSONResponse({"error": "Something went wrong. Please try again."}, status_code=status)

    @app.get("/api/config")
    async def config():
        sec = settings.security
        return {"brandName": settings.brand_name, "currency": settings.currency, "locale": settings.locale, "mode": settings.zoho_mode,
                "aiEnabled": ai_service is not None, "emailOtp": sec.email_otp, "sessionIdleMinutes": sec.session_idle_minutes,
                "privacyPolicyVersion": sec.privacy_policy_version, "privacyContactEmail": sec.privacy_contact_email}

    for router in (auth_routes.router, admin_routes.router, ai_routes.router, portal_routes.router):
        app.include_router(router)

    @app.api_route("/api/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"], include_in_schema=False)
    async def api_not_found(path: str):
        return JSONResponse({"error": "Not found."}, status_code=404)

    app.mount("/", StaticFiles(directory=settings.public_dir, html=True), name="public")
    return app
