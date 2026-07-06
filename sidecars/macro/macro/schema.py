"""Strict nutrition schema + parser for model JSON output.

This is the mandatory gate between LLM output and anything downstream —
malformed output is rejected (and the caller gets one repair attempt),
never upserted. Mirrors the zod schema in the app's lib/nutrition-schema.ts.
"""

import json

from typing import Annotated

from pydantic import BaseModel, Field, StringConstraints, ValidationError

MAX_ITEMS = 20


class MealItem(BaseModel):
    # Pydantic lax mode repairs benign model quirks ("700", 700.0) but still
    # rejects real garbage (12.5, -3, "lots"). Extra keys are ignored.
    item: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
    calories: int = Field(ge=0, le=10_000)
    protein: int = Field(ge=0, le=1_000)
    carbs: int = Field(ge=0, le=1_000)
    fat: int = Field(ge=0, le=1_000)


class MealParseError(ValueError):
    """Model output that failed JSON parsing or schema validation."""


def parse_meal_json(raw: str) -> list[MealItem]:
    """Accepts a single object, a list of objects, or the common
    {"items": [...]} wrapper. Anything else raises MealParseError with a
    message specific enough to feed back to the model for one repair pass."""
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as err:
        raise MealParseError(f"not valid JSON: {err}") from err

    if isinstance(data, dict):
        keys = list(data.keys())
        if len(keys) == 1 and isinstance(data[keys[0]], list):
            data = data[keys[0]]  # unwrap {"items": [...]}
        else:
            data = [data]
    if not isinstance(data, list) or not data:
        raise MealParseError(
            "expected a JSON object or non-empty array of "
            '{"item", "calories", "protein", "carbs", "fat"} objects'
        )
    if len(data) > MAX_ITEMS:
        raise MealParseError(f"too many items ({len(data)} > {MAX_ITEMS})")

    items: list[MealItem] = []
    errors: list[str] = []
    for i, entry in enumerate(data):
        try:
            items.append(MealItem.model_validate(entry))
        except ValidationError as err:
            first = err.errors()[0]
            errors.append(f"item {i}: {'.'.join(str(p) for p in first['loc'])} {first['msg']}")
    if errors:
        raise MealParseError("; ".join(errors))
    return items
