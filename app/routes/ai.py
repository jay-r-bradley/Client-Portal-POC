"""AI routes: property matcher (clients and guests) and deal insights (clients)."""

from __future__ import annotations

import logging

from fastapi import APIRouter, Body, Depends, Path, Request

from ..ai.openai_client import AiError
from ..ai.service import AiLimitError
from ..criteria import CriteriaError
from ..db import User
from ..web import ID_PATTERN, ApiError, RequireUser, Services, audit, services, text

log = logging.getLogger("portal.ai")
router = APIRouter(prefix="/api/ai")
client_or_guest = RequireUser("client", "guest")
client_only = RequireUser("client")


def _ai(svc: Services):
    if not svc.ai:
        raise ApiError(404, "AI features are not enabled.")
    return svc.ai


async def _run(coro):
    """Maps AI-layer failures onto responses the user can act on."""
    try:
        return await coro
    except AiLimitError as err:
        raise ApiError(429, str(err)) from None
    except CriteriaError as err:
        raise ApiError(400, f"The assistant could not turn that into a search: {err}") from None
    except AiError as err:
        log.error("AI error: %s", err)
        raise ApiError(502, "The AI assistant is unavailable right now. Please try again, or use the search form.") from None


@router.post("/property-search")
async def property_search(request: Request, body: dict = Body(...), user: User = Depends(client_or_guest), svc: Services = Depends(services)):
    ai = _ai(svc)
    query = text(body.get("query"), 1000)
    if not 3 <= len(query) <= 500:
        raise ApiError(400, "Describe what you are looking for in 3 to 500 characters.")
    guest_id = user.id if user.role == "guest" else None
    result = await _run(ai.property_search(user.zoho_contact_id, query, guest_id=guest_id))
    svc.lead_sync(user, result["criteria"], query=query)
    await audit(request, "property.ai_searched", actor=user,
                details={"query": query, "criteria": result["criteria"], "results": len(result["results"]), "relaxed": result["relaxed"]})
    return result


@router.get("/insights")
async def insights(user: User = Depends(client_only), svc: Services = Depends(services)):
    return await _run(_ai(svc).portfolio_insights(user.zoho_contact_id))


@router.get("/deals/{deal_id}/insights")
async def deal_insights(deal_id: str = Path(pattern=ID_PATTERN), user: User = Depends(client_only), svc: Services = Depends(services)):
    insight = await _run(_ai(svc).deal_insights(user.zoho_contact_id, deal_id))
    if insight is None:
        raise ApiError(404, "Deal not found.")
    return insight
