"""Text → validated nutrition items, with one repair pass.

The chat function is injectable so tests run without a model."""

from typing import Callable

from .ollama_client import chat_json
from .schema import MealItem, MealParseError, parse_meal_json

SYSTEM_PROMPT = (
    "You are a nutrition extraction engine. Given a description of food "
    "eaten, respond with ONLY JSON: an array of objects, one per food item, "
    'each exactly {"item": string, "calories": int, "protein": int, '
    '"carbs": int, "fat": int}. Grams for protein/carbs/fat. Estimate '
    "sensible integer values from typical portions when the text doesn't "
    "give exact numbers. No prose, no markdown, no extra keys."
)


def extract_nutrition(
    text: str, chat: Callable[[list[dict]], str] = chat_json
) -> list[MealItem]:
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": text},
    ]
    raw = chat(messages)
    try:
        return parse_meal_json(raw)
    except MealParseError as err:
        # One repair attempt: show the model its output and what was wrong.
        repair = messages + [
            {"role": "assistant", "content": raw},
            {
                "role": "user",
                "content": (
                    f"That output was invalid: {err}. Respond again with ONLY "
                    "the corrected JSON array."
                ),
            },
        ]
        return parse_meal_json(chat(repair))  # still bad → MealParseError
