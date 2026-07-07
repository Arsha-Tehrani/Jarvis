"""HTTP /transcribe endpoint with a stub transcriber and a fake decoder —
no model download, no PyAV decode, no mic."""

import numpy as np
import pytest
from fastapi.testclient import TestClient

from voice import server
from voice.server import app


class StubTranscriber:
    def __init__(self, text: str = "add a task to call the bank") -> None:
        self.text = text
        self.heard: list[np.ndarray] = []

    def transcribe(self, audio: np.ndarray) -> str:
        self.heard.append(audio)
        return self.text


@pytest.fixture()
def client(monkeypatch):
    stub = StubTranscriber()
    server.set_transcriber(stub)
    # One second of silence regardless of input bytes.
    monkeypatch.setattr(
        server, "decode_to_pcm", lambda data: np.zeros(16_000, dtype=np.float32)
    )
    yield TestClient(app), stub
    server.set_transcriber(None)


def test_transcribe_returns_text(client):
    http, stub = client
    res = http.post("/transcribe", files={"audio": ("clip.webm", b"fakebytes", "audio/webm")})
    assert res.status_code == 200
    assert res.json() == {"text": "add a task to call the bank"}
    assert len(stub.heard) == 1
    assert stub.heard[0].dtype == np.float32


def test_empty_upload_is_rejected(client):
    http, _ = client
    res = http.post("/transcribe", files={"audio": ("clip.webm", b"", "audio/webm")})
    assert res.status_code == 400
    assert "Empty" in res.json()["detail"]


def test_oversized_upload_is_rejected(client, monkeypatch):
    http, _ = client
    monkeypatch.setattr(server, "MAX_AUDIO_BYTES", 10)
    res = http.post("/transcribe", files={"audio": ("clip.webm", b"x" * 11, "audio/webm")})
    assert res.status_code == 413


def test_undecodable_audio_is_a_400_not_a_crash(client, monkeypatch):
    http, stub = client

    def boom(data):
        raise ValueError("bad container")

    monkeypatch.setattr(server, "decode_to_pcm", boom)
    res = http.post("/transcribe", files={"audio": ("clip.bin", b"garbage", "text/plain")})
    assert res.status_code == 400
    assert "decode" in res.json()["detail"].lower()
    assert stub.heard == []  # unvalidated bytes never reach the model


def test_sub_misfire_clip_returns_empty_without_transcribing(client, monkeypatch):
    http, stub = client
    monkeypatch.setattr(
        server, "decode_to_pcm", lambda data: np.zeros(100, dtype=np.float32)
    )
    res = http.post("/transcribe", files={"audio": ("clip.webm", b"blip", "audio/webm")})
    assert res.status_code == 200
    assert res.json() == {"text": ""}
    assert stub.heard == []


def test_transcriber_failure_is_a_502(client):
    http, _ = client

    class Exploding:
        def transcribe(self, audio):
            raise RuntimeError("model not downloaded")

    server.set_transcriber(Exploding())
    res = http.post("/transcribe", files={"audio": ("clip.webm", b"fakebytes", "audio/webm")})
    assert res.status_code == 502
    assert "model not downloaded" in res.json()["detail"]


def test_health_reports_model_and_lazy_state(client):
    http, _ = client
    res = http.get("/health")
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "ok"
    assert body["loaded"] is True  # fixture installed a transcriber
