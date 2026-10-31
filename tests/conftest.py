"""Shared test fixtures: an app on an in-memory database with the sample CRM,
and helpers that sign in through the real password + emailed-code flow."""

from __future__ import annotations

import dataclasses
import os
from typing import Any

import httpx
import pytest

from app.config import MailSettings, SecuritySettings, Settings
from app.db import Database
from app.main import create_app
from app.mailer import Mailer
from app.zoho.mock_crm import MockCrm


def make_settings(**security: Any) -> Settings:
    return Settings(
        session_secret="test-secret-test-secret-test-secret",
        # Set TEST_DATABASE_URL (e.g. postgresql+psycopg://...) to run the suite against PostgreSQL.
        database_url=os.environ.get("TEST_DATABASE_URL", "sqlite+aiosqlite:///:memory:"),
        zoho_mode="mock",
        mail=MailSettings(provider="console"),
        security=dataclasses.replace(SecuritySettings(), **security),
    )


class Portal:
    """A running app plus convenience helpers."""

    def __init__(self, app, settings: Settings, crm: MockCrm):
        self.app = app
        self.settings = settings
        self.crm = crm
        self.svc = app.state.services

    def client(self, **headers: str) -> httpx.AsyncClient:
        return httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://testserver", headers=headers)

    async def add_user(self, email: str, password: str, role: str = "client", **kw: Any):
        return await self.svc.users.create(email=email, password=password, role=role, email_verified=True, **kw)

    async def sign_in(self, email: str, password: str) -> httpx.AsyncClient:
        """Signs in through password + emailed code; returns a client holding the session."""
        c = self.client()
        res = await c.post("/api/auth/login", json={"email": email, "password": password})
        assert res.status_code == 200, res.text
        body = res.json()
        if body["otpRequired"]:
            res = await c.post("/api/auth/login/verify", json={"challengeId": body["challengeId"], "code": body["devCode"]})
            assert res.status_code == 200, res.text
        return c

    def last_email(self, to: str):
        return next(e for e in reversed(self.svc.mailer.outbox) if e.to == to)


async def build_portal(*, ai: Any = None, crm: MockCrm | None = None, sync: bool = True, **security: Any) -> Portal:
    settings = make_settings(**security)
    crm = crm or MockCrm(settings)
    app = create_app(settings, crm=crm, db=Database(settings.database_url), ai=ai, mailer=Mailer(settings.mail), seed=False)
    if not settings.database_url.startswith("sqlite"):
        from app.db import Base
        async with app.state.services.db.engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)  # a clean database for every test
    await app.state.services.db.create_all()
    if sync and app.state.services.sync:
        await app.state.services.sync.run(full=True)  # what startup does: copy Zoho into the database
    portal = Portal(app, settings, crm)
    _open_portals.append(portal)
    return portal


_open_portals: list[Portal] = []


@pytest.fixture(autouse=True)
async def _close_databases():
    """Closes every database a test opened, so no connection outlives its event loop."""
    yield
    while _open_portals:
        await _open_portals.pop().svc.db.dispose()


@pytest.fixture
async def portal() -> Portal:
    p = await build_portal()
    await p.add_user("admin@brokerage.example", "admin-pass-1", role="admin", name="Dana Brooks")
    await p.add_user("alex@client.example", "demo1234", contact_id="c1", name="Alex Rivera")
    await p.add_user("priya@client.example", "demo1234", contact_id="c2", name="Priya Shah")
    yield p
