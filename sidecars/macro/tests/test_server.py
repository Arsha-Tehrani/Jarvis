"""/nutrition routing: image → vision path, text → extraction path, with the
model and the Jarvis endpoint both stubbed out."""

import json

import pytest
from fastapi.testclient import TestClient

from macro import server
from macro.schema import MealItem, MealParseError

ITEMS = [MealItem(item="scrambled eggs", calories=210, protein=14, carbs=2, fat=16)]


@pytest.fixture
def client(monkeypatch):
    seen = {"vision": None, "extracted": None, "posted": None}

    def stub_describe(image_bytes: bytes) -> str:
        seen["vision"] = image_bytes
        return "2 scrambled eggs"

    def stub_extract(text: str, chat=None) -> list[MealItem]:
        seen["extracted"] = text
        return ITEMS

    def stub_post(items, source, date=None):
        seen["posted"] = {"items": items, "source": source, "date": date}
        return {"added": len(items), "totals": {"calories": 210}}

    monkeypatch.setattr(server, "describe_image", stub_describe)
    monkeypatch.setattr(server, "extract_nutrition", stub_extract)
    monkeypatch.setattr(server, "post_meals", stub_post)
    test_client = TestClient(server.app)
    test_client.seen = seen
    return test_client


def test_text_json_path(client):
    response = client.post("/nutrition", json={"text": "two scrambled eggs", "date": "2026-07-06"})
    assert response.status_code == 200
    data = response.json()
    assert data["source"] == "text"
    assert data["items"][0]["item"] == "scrambled eggs"
    assert data["jarvis"]["added"] == 1
    assert "note" not in data  # honesty note is photo-only
    assert client.seen["vision"] is None
    assert client.seen["extracted"] == "two scrambled eggs"
    assert client.seen["posted"]["source"] == "text"
    assert client.seen["posted"]["date"] == "2026-07-06"


def test_image_multipart_path_routes_via_vision(client):
    response = client.post(
        "/nutrition",
        files={"image": ("breakfast.jpg", b"\xff\xd8fakejpegbytes", "image/jpeg")},
    )
    assert response.status_code == 200
    data = response.json()
    assert data["source"] == "photo"
    assert "rough approximations" in data["note"]
    assert client.seen["vision"] == b"\xff\xd8fakejpegbytes"
    # The vision description (not raw bytes) feeds the extraction model.
    assert client.seen["extracted"] == "2 scrambled eggs"
    assert client.seen["posted"]["source"] == "photo"


def test_multipart_text_only_uses_text_path(client):
    response = client.post("/nutrition", data={"text": "greek yogurt"})
    assert response.status_code == 200
    assert response.json()["source"] == "text"
    assert client.seen["extracted"] == "greek yogurt"


def test_image_caption_is_appended_to_vision_description(client):
    response = client.post(
        "/nutrition",
        data={"text": "the toast has peanut butter"},
        files={"image": ("b.jpg", b"img", "image/jpeg")},
    )
    assert response.status_code == 200
    assert response.json()["source"] == "photo"
    assert "2 scrambled eggs" in client.seen["extracted"]
    assert "peanut butter" in client.seen["extracted"]


def test_empty_payload_and_bad_date_are_400(client):
    assert client.post("/nutrition", json={}).status_code == 400
    assert client.post("/nutrition", json={"text": "   "}).status_code == 400
    assert (
        client.post("/nutrition", json={"text": "eggs", "date": "July 6"}).status_code == 400
    )
    assert client.seen["posted"] is None


def test_unvalidated_model_output_never_reaches_jarvis(client, monkeypatch):
    def failing_extract(text, chat=None):
        raise MealParseError("item 0: calories input should be a valid integer")

    monkeypatch.setattr(server, "extract_nutrition", failing_extract)
    response = client.post("/nutrition", json={"text": "mystery meal"})
    assert response.status_code == 422
    assert "invalid nutrition JSON" in response.json()["detail"]
    assert client.seen["posted"] is None


def test_jarvis_down_is_a_clear_502(client, monkeypatch):
    def failing_post(items, source, date=None):
        raise RuntimeError("Jarvis app not reachable at http://localhost:3000")

    monkeypatch.setattr(server, "post_meals", failing_post)
    response = client.post("/nutrition", json={"text": "eggs"})
    assert response.status_code == 502
    assert "not reachable" in response.json()["detail"]


def test_health_reports_model_status(client, monkeypatch):
    monkeypatch.setattr(server, "pulled_models", lambda: ["llama3.1:8b"])
    data = TestClient(server.app).get("/health").json()
    assert data["status"] == "ok"
    assert data["ollama"] == "up"
    assert data["text_model_pulled"] is True
    assert data["vision_model_pulled"] is False

    monkeypatch.setattr(server, "pulled_models", lambda: None)
    data = TestClient(server.app).get("/health").json()
    assert data["ollama"] == "unreachable"
    assert data["vision_model_pulled"] is None
