"""Upsert validated entries into Jarvis via its zod-validated /api/nutrition."""

import httpx

from . import config
from .schema import MealItem


def post_meals(items: list[MealItem], source: str, date: str | None = None) -> dict:
    payload: dict = {
        "entries": [item.model_dump() for item in items],
        "source": source,
    }
    if date:
        payload["date"] = date
    try:
        response = httpx.post(
            f"{config.JARVIS_URL}/api/nutrition", json=payload, timeout=30
        )
    except httpx.HTTPError as err:
        raise RuntimeError(
            f"Jarvis app not reachable at {config.JARVIS_URL} — is `npm run dev` running?"
        ) from err
    if response.status_code != 200:
        detail = response.text[:300]
        raise RuntimeError(f"Jarvis rejected the entries ({response.status_code}): {detail}")
    return response.json()
