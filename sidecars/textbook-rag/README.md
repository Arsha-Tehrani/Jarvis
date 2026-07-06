# textbook-rag sidecar

Ingests math textbooks (PDF → Markdown → equation-safe chunks → local
ChromaDB) and answers questions over them with the same local Ollama
instance the Jarvis app uses. Standalone Python service — not part of the
Next.js build. The Jarvis agent reaches it through the `ask_textbook` tool
(`TEXTBOOK_RAG_URL`, default `http://localhost:8016`).

## Setup (one-time)

```powershell
cd sidecars/textbook-rag
py -3.13 -m venv .venv
.venv\Scripts\pip install -r requirements.txt

# embedding model for ingest + retrieval (~274 MB)
ollama pull nomic-embed-text

# RECOMMENDED for real math books — Marker reconstructs LaTeX; the default
# MarkItDown fallback does not. Heavy: PyTorch + ~3 GB weights on first run.
.venv\Scripts\pip install -r requirements-marker.txt
```

## Use

```powershell
# ingest a book (idempotent — re-running the same file updates, not duplicates)
.venv\Scripts\python -m rag.ingest "C:\books\vector-calculus.pdf"
# --engine marker|markitdown|auto   (auto prefers Marker when installed)

# serve the /ask endpoint for Jarvis
.venv\Scripts\python -m rag.server
```

```
POST /ask  {"question": "state Green's theorem", "top_k": 4}
→ {"answer": "...", "sources": [{"source", "section", "snippet", "distance"}]}
POST /ingest  {"path": "/abs/path/to/file.pdf"}      # same pipeline as the CLI
→ {"source", "engine", "chunks", "collection_total"}
GET /health → {"status": "ok", "chunks": N}
```

`/ingest` exists for the app's GoodNotes sync (`lib/goodnotes.ts`): Jarvis
downloads a Drive PDF to `/temp_notes` and posts the local path here — valid
because the app and this sidecar share a filesystem. Unsupported types get a
415, missing files a 404, and an unreachable Ollama a 502 (the file is
retried on the next sync).

Config via env: `OLLAMA_BASE_URL` (default `http://localhost:11434`),
`EMBED_MODEL` (`nomic-embed-text`), `LLM_MODEL` (chat model, default
`llama3.1:8b`), `CHROMA_DIR`, `RAG_PORT` (8016), `RAG_TOP_K`,
`CHUNK_MAX_CHARS`/`CHUNK_MIN_CHARS`.

## Tests (no Ollama needed — stubbed embedder/chat)

```powershell
.venv\Scripts\python -m pytest
```

The chunker is the load-bearing piece: it splits on Markdown headers and
blank-line blocks but treats `$$…$$`, `\[…\]`, `\begin{env}…\end{env}`, and
fenced code as unsplittable, so theorems stay bundled with their equations.
See `tests/test_chunker.py`.

Chroma data persists in `data/chroma/` (gitignored).
