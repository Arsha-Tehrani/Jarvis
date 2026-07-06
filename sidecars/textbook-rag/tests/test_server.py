"""/ask endpoint with stubbed embedder + chat: retrieval context reaches the
model prompt, sources are cited back, failure modes map to clean HTTP errors."""

import pytest
from fastapi.testclient import TestClient

from rag import server, store
from rag.ingest import ingest_file
from tests.test_ingest import MATH_MD


@pytest.fixture
def client(tmp_path, stub_embedder, monkeypatch):
    chroma_dir = str(tmp_path / "chroma")
    book = tmp_path / "calc.md"
    book.write_text(MATH_MD, encoding="utf-8")
    ingest_file(book, embedder=stub_embedder, chroma_dir=chroma_dir)

    captured: dict = {}

    def stub_chat(messages: list[dict]) -> str:
        captured["messages"] = messages
        return "Per [1], Green's theorem converts a line integral into a double integral."

    monkeypatch.setattr(server, "get_collection", lambda: store.get_collection(chroma_dir))
    monkeypatch.setattr(server, "get_embedder", lambda: stub_embedder)
    monkeypatch.setattr(server, "chat", stub_chat)
    test_client = TestClient(server.app)
    test_client.captured = captured
    return test_client


def test_ask_returns_answer_with_cited_sources(client):
    response = client.post("/ask", json={"question": "State Green's theorem", "top_k": 2})
    assert response.status_code == 200
    data = response.json()
    assert "Green's theorem" in data["answer"]
    assert len(data["sources"]) == 2
    top = data["sources"][0]
    assert top["source"] == "calc"
    assert "Green" in top["section"]
    assert top["snippet"]

    # The retrieved excerpt actually reached the model as numbered context.
    system = client.captured["messages"][0]["content"]
    assert "[1] (calc" in system
    assert "line integral" in system
    assert client.captured["messages"][1]["content"] == "State Green's theorem"


def test_ask_validates_input(client):
    assert client.post("/ask", json={"question": ""}).status_code == 422
    assert client.post("/ask", json={"question": "x", "top_k": 99}).status_code == 422


def test_empty_collection_is_a_clear_409(tmp_path, stub_embedder, monkeypatch):
    empty_dir = str(tmp_path / "empty-chroma")
    monkeypatch.setattr(server, "get_collection", lambda: store.get_collection(empty_dir))
    monkeypatch.setattr(server, "get_embedder", lambda: stub_embedder)
    response = TestClient(server.app).post("/ask", json={"question": "anything"})
    assert response.status_code == 409
    assert "ingest" in response.json()["detail"]


def test_chat_failure_maps_to_502(client, monkeypatch):
    def broken_chat(messages):
        raise RuntimeError("Could not get a completion from Ollama")

    monkeypatch.setattr(server, "chat", broken_chat)
    response = client.post("/ask", json={"question": "State Green's theorem"})
    assert response.status_code == 502
    assert "Ollama" in response.json()["detail"]


def test_health_reports_chunk_count(client):
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "chunks": 2}


def test_ingest_endpoint_adds_a_source(client, tmp_path, stub_embedder, monkeypatch):
    # Same chroma dir the fixture ingested "calc" into (2 chunks).
    chroma_dir = str(tmp_path / "chroma")
    notes = tmp_path / "goodnotes-week1.md"
    notes.write_text(MATH_MD, encoding="utf-8")
    monkeypatch.setattr(
        server,
        "run_ingest",
        lambda path: ingest_file(path, embedder=stub_embedder, chroma_dir=chroma_dir),
    )
    response = client.post("/ingest", json={"path": str(notes)})
    assert response.status_code == 200
    data = response.json()
    assert data["source"] == "goodnotes-week1"
    assert data["engine"] == "passthrough"
    assert data["chunks"] == 2
    assert data["collection_total"] == 4


def test_ingest_missing_file_is_404(client):
    response = client.post("/ingest", json={"path": "/nowhere/notes.pdf"})
    assert response.status_code == 404


def test_ingest_unsupported_type_is_415(client, tmp_path):
    doc = tmp_path / "notes.docx"
    doc.write_text("not ingestable", encoding="utf-8")
    response = client.post("/ingest", json={"path": str(doc)})
    assert response.status_code == 415


def test_ingest_embed_failure_maps_to_502(client, tmp_path, monkeypatch):
    notes = tmp_path / "week2.md"
    notes.write_text(MATH_MD, encoding="utf-8")

    def broken_ingest(path):
        raise RuntimeError("Could not reach Ollama for embeddings")

    monkeypatch.setattr(server, "run_ingest", broken_ingest)
    response = client.post("/ingest", json={"path": str(notes)})
    assert response.status_code == 502
    assert "Ollama" in response.json()["detail"]
