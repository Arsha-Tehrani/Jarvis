"""extract_nutrition with a stubbed chat: happy path, one repair pass, hard fail."""

import json

import pytest

from macro.extract import extract_nutrition
from macro.schema import MealParseError

GOOD_JSON = json.dumps(
    [{"item": "oatmeal with banana", "calories": 350, "protein": 10, "carbs": 65, "fat": 6}]
)


def test_valid_first_response_needs_no_repair():
    calls = []

    def chat(messages):
        calls.append(messages)
        return GOOD_JSON

    [item] = extract_nutrition("oatmeal with a banana", chat=chat)
    assert item.item == "oatmeal with banana"
    assert len(calls) == 1
    assert calls[0][1]["content"] == "oatmeal with a banana"
    assert "ONLY JSON" in calls[0][0]["content"]


def test_invalid_then_repaired():
    responses = iter(['{"food": "oatmeal"}', GOOD_JSON])
    calls = []

    def chat(messages):
        calls.append(messages)
        return next(responses)

    [item] = extract_nutrition("oatmeal", chat=chat)
    assert item.calories == 350
    assert len(calls) == 2
    # The repair turn shows the model its bad output and the specific error.
    repair_turn = calls[1]
    assert repair_turn[-2]["content"] == '{"food": "oatmeal"}'
    assert "invalid" in repair_turn[-1]["content"]


def test_still_invalid_after_repair_raises():
    def chat(messages):
        return "I estimate roughly 350 calories."

    with pytest.raises(MealParseError):
        extract_nutrition("oatmeal", chat=chat)
