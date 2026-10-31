"""The database design: keys, references and constraints of the CRM copy."""

from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy.exc import IntegrityError

from app.db import Base, CrmAgent, CrmContact, CrmDeal, CrmDealStage, CrmLead, CrmProperty

from .conftest import build_portal


async def test_every_table_has_a_primary_key_and_crm_tables_keep_the_zoho_id():
    for table in Base.metadata.sorted_tables:
        assert table.primary_key.columns, table.name
        if table.name.startswith("crm_") and table.name != "crm_deal_stages":
            assert table.c.zoho_id.unique and not table.c.zoho_id.nullable, table.name
            assert all(c.comment for c in table.columns if c.name not in ("id", "synced_at")), f"{table.name} columns document their Zoho source"


async def test_a_sync_batch_can_arrive_in_any_order():
    p = await build_portal()
    async with p.svc.db.session() as s, s.begin():
        # Deal first, then the records it points at: references are checked at commit.
        s.add(CrmDeal(zoho_id="5001", deal_name="Rivera - Lakeview", stage="Negotiation", amount=Decimal("478000.00"),
                      closing_date=date(2026, 12, 15), contact_zoho_id="3001", property_zoho_id="7001", owner_zoho_id="9001"))
        s.add(CrmDealStage(name="Negotiation", sequence=4))
        s.add(CrmContact(zoho_id="3001", last_name="Rivera", email="alex@client.example", owner_zoho_id="9001"))
        s.add(CrmProperty(zoho_id="7001", name="Lakeview Modern Townhouse", city="Austin", price=Decimal("485000"), status="Available"))
        s.add(CrmAgent(zoho_id="9001", full_name="Maria Santos"))
    async with p.svc.db.session() as s:
        deal = await s.get(CrmDeal, (await s.scalar(CrmDeal.__table__.select().with_only_columns(CrmDeal.id))))
        assert deal.amount == Decimal("478000.00")


async def test_dangling_references_and_bad_values_are_rejected():
    p = await build_portal()
    with pytest.raises(IntegrityError):
        async with p.svc.db.session() as s, s.begin():
            s.add(CrmDeal(zoho_id="5002", deal_name="Orphan", contact_zoho_id="does-not-exist"))
    with pytest.raises(IntegrityError):
        async with p.svc.db.session() as s, s.begin():
            s.add(CrmLead(zoho_id="6001", kind="spam", last_name="X"))
    with pytest.raises(IntegrityError):
        async with p.svc.db.session() as s, s.begin():
            s.add(CrmAgent(zoho_id="9002", full_name="A"))
            s.add(CrmAgent(zoho_id="9002", full_name="Duplicate"))
