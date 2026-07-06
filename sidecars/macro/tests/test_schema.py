"""The mandatory validation gate: what gets through, what gets rejected."""

import json

import pytest

from macro.schema import MealItem, MealParseError, parse_meal_json

GOOD = {"item": "chicken burrito", "calories": 700, "protein": 40, "carbs": 70, "fat": 25}


def test_single_object_and_list_and_wrapper_all_parse():
    assert parse_meal_json(json.dumps(GOOD))[0].item == "chicken burrito"
    two = parse_meal_json(json.dumps([GOOD, {**GOOD, "item": "side salad"}]))
    assert [m.item for m in two] == ["chicken burrito", "side salad"]
    wrapped = parse_meal_json(json.dumps({"items": [GOOD]}))
    assert wrapped[0].calories == 700


def test_benign_model_quirks_are_repaired():
    quirky = {**GOOD, "calories": "700", "protein": 40.0, "brand": "Chipotle"}
    [item] = parse_meal_json(json.dumps(quirky))
    assert item.calories == 700 and item.protein == 40
    assert isinstance(item, MealItem)
    assert not hasattr(item, "brand")


@pytest.mark.parametrize(
    "bad",
    [
        "not json at all",
        "[]",
        json.dumps({**GOOD, "calories": -100}),
        json.dumps({**GOOD, "fat": 12.5}),  # non-integral grams
        json.dumps({**GOOD, "calories": 99_999}),
        json.dumps({k: v for k, v in GOOD.items() if k != "protein"}),
        json.dumps({**GOOD, "item": "   "}),
        json.dumps({**GOOD, "calories": "lots"}),
        json.dumps({"summary": "a burrito"}),  # wrapper without a list
        json.dumps([GOOD] * 21),  # too many items
    ],
)
def test_malformed_output_is_rejected(bad):
    with pytest.raises(MealParseError):
        parse_meal_json(bad)


def test_error_message_names_the_offending_field():
    with pytest.raises(MealParseError, match="calories"):
        parse_meal_json(json.dumps({**GOOD, "calories": -1}))
