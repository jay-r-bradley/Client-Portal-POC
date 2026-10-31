"""AI: OpenAI client, agent loop, client-scoped tools and the AI features (scripted model)."""

from __future__ import annotations

import itertools
import json

import httpx
import pytest

from app.ai.agent import Tool, run_agent
from app.ai.openai_client import AiError, OpenAiClient
from app.ai.portal_tools import create_portal_tools
from app.ai.service import AiLimitError, AiService
from app.config import AiSettings, Settings
from app.zoho.mock_crm import MockCrm

from .conftest import build_portal

S = Settings(ai=AiSettings(api_key="sk-test", max_requests_per_hour=30, guest_max_requests_per_hour=10))
_ids = itertools.count(1)


def tool_call(name: str, args: dict) -> dict:
    return {"id": f"call_{next(_ids)}", "type": "function", "function": {"name": name, "arguments": json.dumps(args)}}


def call_tools(*calls: dict) -> dict:
    return {"role": "assistant", "content": None, "tool_calls": list(calls)}


def answer(data: dict) -> dict:
    return {"role": "assistant", "content": json.dumps(data)}


class Scripted:
    """Plays back one reply per model turn; a step may be a function of the request."""

    def __init__(self, steps):
        self.steps = list(steps)
        self.requests = []

    async def chat(self, **req):
        self.requests.append(json.loads(json.dumps(req, default=str)))
        step = self.steps[len(self.requests) - 1]
        if isinstance(step, Exception):
            raise step
        return step(req) if callable(step) else step


def tool_results(req) -> list:
    return [json.loads(m["content"]) for m in req["messages"] if m["role"] == "tool"]


def search_args(**overrides):
    return {"budget_min": None, "budget_max": None, "locations": [], "listing_type": None, "property_type": None,
            "min_bedrooms": None, "min_bathrooms": None, "min_floor_area": None, **overrides}


async def test_openai_client_sends_tools_and_a_strict_output_schema():
    sent = {}

    def handler(request: httpx.Request):
        sent.update(url=str(request.url), auth=request.headers["Authorization"], body=json.loads(request.content))
        return httpx.Response(200, json={"choices": [{"finish_reason": "stop", "message": {"content": '{"ok":true}'}}]})

    client = OpenAiClient(AiSettings(api_key="sk-test", model="test-mini"), transport=httpx.MockTransport(handler))
    message = await client.chat(messages=[{"role": "user", "content": "hi"}], tools=[{"type": "function", "function": {"name": "t", "parameters": {}}}],
                                output={"name": "out", "schema": {"type": "object"}})
    assert message["content"] == '{"ok":true}'
    assert sent["url"] == "https://api.openai.com/v1/chat/completions" and sent["auth"] == "Bearer sk-test"
    assert sent["body"]["model"] == "test-mini" and sent["body"]["tool_choice"] == "auto"
    assert sent["body"]["response_format"]["json_schema"]["strict"] is True


async def test_openai_client_surfaces_refusals_errors_and_timeouts():
    def refuse(_):
        return httpx.Response(200, json={"choices": [{"message": {"refusal": "no"}}]})

    def fail(_):
        return httpx.Response(401, json={"error": {"message": "bad key"}})

    def slow(request):
        raise httpx.ReadTimeout("slow", request=request)

    for handler, match in ((refuse, "declined"), (fail, "bad key"), (slow, "timed out")):
        client = OpenAiClient(AiSettings(api_key="k"), transport=httpx.MockTransport(handler))
        with pytest.raises(AiError, match=match):
            await client.complete_json(name="x", schema={}, system="", user="")


async def test_agent_runs_tools_feeds_results_back_and_forces_an_answer():
    async def echo(args):
        return {"echoed": args["v"]}

    tools = [Tool("echo", "", {}, echo)]

    def second(req):
        assert tool_results(req) == [{"echoed": 1}, {"error": "Unknown tool: missing_tool"}]
        return call_tools(tool_call("echo", {"v": 2}))

    def third(req):
        assert req["tool_choice"] == "none"
        return answer({"done": True})

    client = Scripted([call_tools(tool_call("echo", {"v": 1}), tool_call("missing_tool", {})), second, third])
    result, trace = await run_agent(client=client, system="s", user="u", tools=tools, output={"name": "o", "schema": {}}, max_steps=3)
    assert result == {"done": True} and [t["tool"] for t in trace] == ["echo", "missing_tool", "echo"]


async def test_agent_hides_tool_failure_details_from_the_model():
    async def boom(_):
        raise RuntimeError("db password=hunter2")

    def check(req):
        assert "hunter2" not in json.dumps(req["messages"])
        return answer({})

    await run_agent(client=Scripted([call_tools(tool_call("boom", {})), check]), system="s", user="u",
                    tools=[Tool("boom", "", {}, boom)], output={"name": "o", "schema": {}})


async def test_portal_tools_are_bound_to_the_signed_in_client():
    portal = await create_portal_tools(crm=MockCrm(S), contact_id="c1", settings=S, now=_now)
    call = {t.name: t.handler for t in portal.tools}
    assert [d["id"] for d in (await call["list_my_deals"]({}))["deals"]] == ["d1", "d2", "d3", "d4"]
    with pytest.raises(Exception, match="No deal"):
        await call["get_deal"]({"deal_id": "d5"})
    assert (await call["get_deal"]({"deal_id": "d1"}))["property"]["id"] == "p1"
    assert (await call["get_listing"]({"listing_id": "p16"}))["listing"], "off-market, but Alex has a deal on it"
    priya = await create_portal_tools(crm=MockCrm(S), contact_id="c2", settings=S, now=_now)
    with pytest.raises(Exception, match="No available listing"):
        await {t.name: t.handler for t in priya.tools}["get_listing"]({"listing_id": "p16"})


async def test_tool_schemas_are_valid_for_strict_function_calling():
    portal = await create_portal_tools(crm=MockCrm(S), contact_id="c1", settings=S, now=_now)
    for tool in portal.tools:
        assert tool.input_schema["additionalProperties"] is False, tool.name
        assert sorted(tool.input_schema["required"]) == sorted(tool.input_schema["properties"]), tool.name


def _now():
    from datetime import datetime, timezone
    return datetime(2026, 10, 31, tzinfo=timezone.utc)


async def test_ai_search_uses_tools_and_matches_results_back_to_crm_records():
    def rank(req):
        assert [l["id"] for l in tool_results(req)[0]["listings"]] == ["p1", "p18", "p15"]
        return answer({"interpretation": "A 3-bed home in Austin.", "preferences": ["pool"], "relaxed": False, "overview": "Options.",
                       "results": [{"id": "p15", "score": 90, "reason": "Near Zilker Park."}, {"id": "p999", "score": 99, "reason": "Invented."}]})

    client = Scripted([call_tools(tool_call("search_listings", search_args(budget_max=650000, locations=["Austin"], listing_type="Sale", min_bedrooms=3))), rank])
    out = await AiService(client=client, crm=MockCrm(S), settings=S).property_search("c1", "3 bed in Austin under 650k with a pool")
    assert [r["property"]["id"] for r in out["results"]] == ["p15", "p1", "p18"], "ranked, then unranked; invented id dropped"
    assert out["results"][0]["property"]["price"] == 599000 and out["results"][1]["reason"] is None
    assert out["relaxed"] is False and out["criteria"]["budgetMax"] == 650000


async def test_ai_search_reports_relaxed_results_after_an_empty_search():
    def rank(req):
        first, second = tool_results(req)
        assert first["count"] == 0
        return answer({"interpretation": "x", "preferences": [], "relaxed": False, "overview": "Closest.",
                       "results": [{"id": l["id"], "score": 60, "reason": "Outside Austin."} for l in second["listings"]]})

    client = Scripted([
        call_tools(tool_call("search_listings", search_args(budget_max=400000, locations=["Austin"], listing_type="Sale", min_bedrooms=3))),
        call_tools(tool_call("search_listings", search_args(budget_max=460000, listing_type="Sale", min_bedrooms=2))),
        rank,
    ])
    out = await AiService(client=client, crm=MockCrm(S), settings=S).property_search("c1", "cheap 3 bed in Austin")
    assert out["relaxed"] is True and out["results"] and all(r["property"]["price"] <= 460000 for r in out["results"])


async def test_deal_insights_are_scoped_send_no_contact_details_and_are_cached():
    insight = {"headline": "Negotiating", "summary": "s", "nextSteps": [], "watchOuts": [], "questionsToAsk": []}
    client = Scripted([call_tools(tool_call("get_listing", {"listing_id": "p1"})), answer(insight)])
    ai = AiService(client=client, crm=MockCrm(S), settings=S)
    assert await ai.deal_insights("c1", "d5") is None
    assert await ai.deal_insights("c1", "d1") == insight
    await ai.deal_insights("c1", "d1")
    assert len(client.requests) == 2, "second request served from cache"
    sent = json.dumps(client.requests)
    assert "Negotiation" in sent and "4 of 5" in sent and "@" not in sent
    assert sorted(t["function"]["name"] for t in client.requests[0]["tools"]) == ["get_listing", "list_my_deals"]


async def test_portfolio_insights_drop_unknown_deals():
    client = Scripted([answer({"overview": "Two open deals.", "priorities": [{"dealId": "d1", "note": "Closing soon."}, {"dealId": "d5", "note": "x"}]})])
    out = await AiService(client=client, crm=MockCrm(S), settings=S).portfolio_insights("c1")
    assert out["priorities"] == [{"dealId": "d1", "dealName": "Rivera - Lakeview Townhouse purchase", "note": "Closing soon."}]
    assert client.requests[0]["output"]["schema"]["properties"]["priorities"]["items"]["properties"]["dealId"]["enum"] == ["d1", "d2", "d3", "d4"]


async def test_usage_is_capped_per_account_and_guests_get_no_deal_tools():
    done = answer({"interpretation": "", "preferences": [], "relaxed": False, "overview": "", "results": []})
    settings = Settings(ai=AiSettings(api_key="k", max_requests_per_hour=2, guest_max_requests_per_hour=1))
    client = Scripted([done] * 5)
    ai = AiService(client=client, crm=MockCrm(settings), settings=settings)
    await ai.property_search("c1", "anything")
    await ai.property_search("c1", "anything")
    with pytest.raises(AiLimitError):
        await ai.property_search("c1", "anything")
    await ai.property_search(None, "a home", guest_id="g1")
    assert sorted(t["function"]["name"] for t in client.requests[-1]["tools"]) == ["get_listing", "search_listings"]
    with pytest.raises(AiLimitError):
        await ai.property_search(None, "again", guest_id="g1")


async def test_ai_endpoints_hidden_without_a_key_and_errors_hidden_with_one():
    p = await build_portal()
    await p.add_user("alex@client.example", "demo1234", contact_id="c1", name="Alex")
    c = await p.sign_in("alex@client.example", "demo1234")
    assert (await c.get("/api/ai/insights")).status_code == 404
    assert (await c.get("/api/config")).json()["aiEnabled"] is False

    p2 = await build_portal(ai=AiService(client=Scripted([AiError("upstream exploded with secret details")]), crm=MockCrm(S), settings=S))
    await p2.add_user("alex@client.example", "demo1234", contact_id="c1", name="Alex")
    c2 = await p2.sign_in("alex@client.example", "demo1234")
    assert (await c2.post("/api/ai/property-search", json={"query": "x"})).status_code == 400
    res = await c2.post("/api/ai/property-search", json={"query": "a flat in Dallas"})
    assert res.status_code == 502 and "secret" not in res.text
