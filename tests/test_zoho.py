"""Zoho CRM: COQL building, record mapping, the REST client, and LiveCrm over a fake API."""

from __future__ import annotations

import json

import httpx
import pytest

from app.config import Settings, ZohoSettings
from app.criteria import CriteriaError, normalize_criteria
from app.zoho.api import ZohoApi, ZohoApiError
from app.zoho.live_crm import LiveCrm
from app.zoho.mappers import assert_id, build_featured_query, build_property_query, map_deal, quote

S = Settings()
OPTS = {"module": "Properties", "fields": S.crm.property, "available_status": "Available"}


def test_coql_includes_every_criterion_with_pairwise_parentheses():
    c = normalize_criteria({"budgetMin": "200000", "budgetMax": "600000", "preferredLocation": "Austin", "otherLocations": "Dallas, Plano",
                            "listingType": "Sale", "minBedrooms": "3", "sort": "price_desc"})
    q = build_property_query(c, **OPTS)
    assert q.startswith("select ") and " from Properties where " in q
    assert "((City like '%Austin%' or City like '%Dallas%') or City like '%Plano%')" in q
    assert "(((((Status = 'Available' and Price >= 200000) and Price <= 600000)" in q
    assert "Listing_Type = 'Sale'" in q and "Bedrooms >= 3" in q
    assert q.endswith("order by Price desc limit 100")


def test_coql_literals_escape_quotes_so_input_cannot_break_out():
    assert quote("O'Hare") == "'O\\'Hare'"
    assert quote("x\\' or 1=1") == "'x\\\\\\' or 1=1'"
    q = build_property_query(normalize_criteria({"preferredLocation": "a' or Status = 'Sold"}), **OPTS)
    assert "City like '%a\\' or Status = \\'Sold%'" in q


def test_record_ids_are_validated():
    assert assert_id("5725767000001234567") == "5725767000001234567"
    for bad in ("1' or id != '0", "../users", "a b", "x" * 41):
        with pytest.raises(ValueError):
            assert_id(bad)


def test_featured_query_filters_on_the_checkbox_newest_first():
    q = build_featured_query(module="Properties", fields=S.crm.property, available_status="Available", featured_only=True, limit=6)
    assert q.endswith("where (Status = 'Available' and Featured = true) order by Listed_Date desc limit 6")
    q = build_featured_query(module="Properties", fields=S.crm.property, available_status="Available", featured_only=False, limit=6)
    assert q.endswith("where Status = 'Available' order by Listed_Date desc limit 6")


def test_criteria_validation():
    with pytest.raises(CriteriaError, match="cannot be greater"):
        normalize_criteria({"budgetMin": 5, "budgetMax": 1})
    with pytest.raises(CriteriaError, match="positive number"):
        normalize_criteria({"budgetMax": "abc"})
    with pytest.raises(CriteriaError, match="at most 5"):
        normalize_criteria({"otherLocations": "a,b,c,d,e,f"})
    assert normalize_criteria({"preferredLocation": "Austin", "otherLocations": "austin, Austin ,"})["locations"] == ["Austin", "austin"]


def test_map_deal_reads_configured_field_names():
    deal = map_deal({"id": 123, "Deal_Name": "D", "Stage": "Negotiation", "Amount": "1000", "Contact_Name": {"id": 9, "name": "C"},
                     "Property": {"id": 5, "name": "Prop"}, "Owner": {"id": 7, "name": "Agent", "email": "a@x"}}, S.crm.deal)
    assert deal["id"] == "123" and deal["amount"] == 1000 and deal["contactId"] == "9"
    assert deal["property"] == {"id": "5", "name": "Prop"} and deal["agent"]["email"] == "a@x"


class FakeApi:
    def __init__(self, **handlers):
        self.calls = []
        self.handlers = handlers

    async def get_record(self, module, record_id, fields=None):
        return await self.handlers["get_record"](module, record_id) if "get_record" in self.handlers else None

    async def get_related_records(self, module, record_id, related, fields):
        return await self.handlers["related"](module, record_id, related) if "related" in self.handlers else []

    async def get_user(self, user_id):
        return {"id": user_id, "full_name": "Agent Smith", "email": "agent@x"}

    async def get_fields(self, module):
        return await self.handlers["fields"](module) if "fields" in self.handlers else []

    async def create_record(self, module, record):
        self.calls.append((module, record))
        return {"id": f"{module}-1", "Created_Time": "2026-01-01T00:00:00Z"}

    async def coql(self, query):
        self.calls.append(("coql", query))
        return []


def _async(value):
    async def fn(*_):
        return value
    return fn


async def test_live_crm_hides_deals_that_belong_to_another_contact():
    crm = LiveCrm(S, api=FakeApi(get_record=_async({"id": "d1", "Deal_Name": "X", "Contact_Name": {"id": "other"}})))
    assert await crm.get_deal("me", "d1") is None


async def test_live_crm_only_exposes_portal_notes():
    notes = [
        {"id": 1, "Note_Title": "[Client Portal] Hello", "Note_Content": "from client", "Created_Time": "2026-01-02T00:00:00Z"},
        {"id": 2, "Note_Title": "Internal: price sensitive", "Note_Content": "secret", "Created_Time": "2026-01-01T00:00:00Z"},
        {"id": 3, "Note_Title": "[Portal Reply] Re: Hello", "Note_Content": "from agent", "Created_Time": "2026-01-03T00:00:00Z", "Owner": {"name": "Maria"}},
    ]
    messages = await LiveCrm(S, api=FakeApi(related=_async(notes))).list_messages("c1")
    assert [(m["from"], m["subject"]) for m in messages] == [("client", "Hello"), ("agent", "Re: Hello")]
    assert "secret" not in json.dumps(messages)


async def test_live_crm_sends_a_message_as_a_note_and_a_task_for_the_deal_owner():
    api = FakeApi(get_record=_async({"id": "c1", "Full_Name": "Alex", "Owner": {"id": "u-contact"}}))
    deal = {"id": "d1", "name": "Deal", "stage": "Offer Made", "agent": {"id": "u-deal"}}
    await LiveCrm(S, api=api).send_message("c1", subject="Hi", body="Body", deal=deal, property=None)
    (note_module, note), (task_module, task) = api.calls
    assert note_module == "Notes" and note["Note_Title"] == "[Client Portal] Hi"
    assert note["Parent_Id"] == {"module": {"api_name": "Contacts"}, "id": "c1"}
    assert task_module == "Tasks" and task["Owner"] == {"id": "u-deal"} and task["What_Id"] == {"id": "d1"} and task["$se_module"] == "Deals"


async def test_live_crm_follows_the_zoho_stage_picklist_order():
    fields = [{"api_name": "Stage", "pick_list_values": [{"display_value": "B", "sequence_number": 2},
                                                          {"display_value": "-None-", "sequence_number": 0},
                                                          {"display_value": "A", "sequence_number": 1}]}]
    assert await LiveCrm(S, api=FakeApi(fields=_async(fields))).get_stages() == ["A", "B"]


async def test_live_crm_creates_referrals_and_signups_as_leads():
    api = FakeApi(get_record=_async({"id": "101", "Full_Name": "Alex Rivera", "Owner": {"id": "agent-9"}}))
    crm = LiveCrm(S, api=api)
    await crm.create_referral("101", {"name": "Morgan Diaz", "firstName": "Morgan", "lastName": "Diaz", "email": "m@example.net",
                                      "phone": None, "interest": "Land or a lot", "notes": "Acreage"})
    await crm.create_signup_lead({"firstName": "Taylor", "lastName": "Morgan", "email": "t@example.net", "description": "Signed up."})
    (_, referral), (_, signup) = api.calls
    assert referral["Lead_Source"] == "Client Referral" and referral["Referred_By"] == {"id": "101"}
    assert referral["Owner"] == {"id": "agent-9"} and referral["Inquiry_Type"] == "Land or a lot"
    assert signup["Lead_Source"] == "Portal Sign-up" and signup["Last_Name"] == "Morgan"


def _zoho_api(handler):
    settings = ZohoSettings(client_id="id", client_secret="s", refresh_token="r", timeout_seconds=1)
    return ZohoApi(settings, transport=httpx.MockTransport(handler))


async def test_zoho_api_refreshes_the_token_once_and_retries():
    calls = {"token": 0, "api": 0}

    def handler(request: httpx.Request):
        if "/oauth/v2/token" in str(request.url):
            calls["token"] += 1
            return httpx.Response(200, json={"access_token": f"t{calls['token']}", "expires_in": 3600})
        calls["api"] += 1
        if request.headers["Authorization"] == "Zoho-oauthtoken t1":
            return httpx.Response(401, json={"code": "INVALID_TOKEN", "message": "expired"})
        return httpx.Response(200, json={"data": [{"id": "c1"}]})

    assert await _zoho_api(handler).get_record("Contacts", "c1") == {"id": "c1"}
    assert calls == {"token": 2, "api": 2}


async def test_zoho_api_treats_204_as_empty_and_encodes_ids_in_paths():
    seen = []

    def handler(request: httpx.Request):
        if "/oauth/" in str(request.url):
            return httpx.Response(200, json={"access_token": "t", "expires_in": 3600})
        seen.append(request.url.raw_path.decode())
        return httpx.Response(204)

    api = _zoho_api(handler)
    assert await api.coql("select id from Properties where id is not null") == []
    assert await api.get_record("Deals", "../users?x=1") is None
    assert seen[-1].startswith("/crm/v8/Deals/..%2Fusers%3Fx%3D1")


async def test_zoho_api_timeouts_become_api_errors():
    def handler(request: httpx.Request):
        if "/oauth/" in str(request.url):
            return httpx.Response(200, json={"access_token": "t", "expires_in": 3600})
        raise httpx.ReadTimeout("slow", request=request)

    with pytest.raises(ZohoApiError, match="timed out"):
        await _zoho_api(handler).coql("select id from Deals where id is not null")
