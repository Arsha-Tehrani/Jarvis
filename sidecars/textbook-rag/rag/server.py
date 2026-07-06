"""HTTP endpoint the Jarvis agent tool (ask_textbook) calls.

    .venv/Scripts/python -m rag.server        # http://127.0.0.1:8016

POST /ask {"question": "...", "top_k": 4} →
  {"answer": "...", "sources": [{"source", "section", "snippet", "distance"}]}

Read-only: retrieves top-k chunks from Chroma and asks the primary Ollama
model to explain, citing the numbered excerpts. The embedder, collection,
and chat call are module-level factories so tests can stub them.
"""

import httpx
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from . import config, store
from .embeddings import OllamaEmbedder

app = FastAPI(title="Jarvis textbook RAG sidecar")


# --- seams (monkeypatched in tests) ---------------------------------------

def get_embedder() -> store.Embedder:
    return OllamaEmbedder()


def get_collection():
    return store.get_collection()


def chat(messages: list[dict]) -> str:
    """One completion via Ollama's OpenAI-compatible endpoint — the same
    server and route the app's lib/llm.ts uses."""
    try:
        response = httpx.post(
            f"{config.OLLAMA_BASE_URL}/v1/chat/completions",
            json={"model": config.CHAT_MODEL, "messages": messages, "stream": False},
            timeout=300,
        )
        response.raise_for_status()
    except httpx.HTTPError as err:
        raise RuntimeError(
            f"Could not get a completion from Ollama at {config.OLLAMA_BASE_URL} "
            f"(model {config.CHAT_MODEL}). Is Ollama running? (ollama serve)"
        ) from err
    return response.json()["choices"][0]["message"]["content"] or ""


# --- request/response ------------------------------------------------------

class AskRequest(BaseModel):
    question: str = Field(min_length=1, max_length=2000)
    top_k: int = Field(default=config.DEFAULT_TOP_K, ge=1, le=10)


class SourceOut(BaseModel):
    source: str
    section: str
    snippet: str
    distance: float


class AskResponse(BaseModel):
    answer: str
    sources: list[SourceOut]


def build_messages(question: str, hits: list[store.Retrieved]) -> list[dict]:
    excerpts = "\n\n".join(
        f"[{i}] ({h.source} — {h.section})\n{h.text}" for i, h in enumerate(hits, 1)
    )
    system = (
        "You are a math tutor. Answer the question using ONLY the numbered "
        "textbook excerpts below. Preserve LaTeX notation as written. Cite the "
        "excerpts you used by number, e.g. [1]. If the excerpts don't cover "
        "the question, say so instead of guessing.\n\n" + excerpts
    )
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": question},
    ]


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "chunks": get_collection().count()}


@app.post("/ask", response_model=AskResponse)
def ask(request: AskRequest) -> AskResponse:
    try:
        hits = store.query(
            get_collection(), get_embedder(), request.question, request.top_k
        )
    except RuntimeError as err:
        raise HTTPException(status_code=502, detail=str(err)) from err
    if not hits:
        raise HTTPException(
            status_code=409,
            detail="No textbook content ingested yet — run: python -m rag.ingest <book.pdf>",
        )
    try:
        answer = chat(build_messages(request.question, hits))
    except RuntimeError as err:
        raise HTTPException(status_code=502, detail=str(err)) from err
    return AskResponse(
        answer=answer,
        sources=[
            SourceOut(
                source=h.source,
                section=h.section,
                snippet=h.text[:300],
                distance=round(h.distance, 4),
            )
            for h in hits
        ],
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=config.HOST, port=config.PORT)
