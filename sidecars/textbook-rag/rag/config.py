"""Sidecar configuration, all overridable via environment variables.

Model calls go through the local Ollama instance the Jarvis app already
uses (CLAUDE.md: no paid APIs from sidecars).
"""

import os
from pathlib import Path

SIDECAR_DIR = Path(__file__).resolve().parent.parent

# Ollama's native API root (embeddings use /api/embed, chat uses the
# OpenAI-compatible /v1/chat/completions — same server, same default port
# as the app's lib/llm.ts).
OLLAMA_BASE_URL = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434")

# Requires a one-time `ollama pull nomic-embed-text` (see README).
EMBED_MODEL = os.environ.get("EMBED_MODEL", "nomic-embed-text")

# Primary chat model used to explain concepts; keep in sync with the
# app's LLM_MODEL unless you want a different one for textbook Q&A.
CHAT_MODEL = os.environ.get("LLM_MODEL", "llama3.1:8b")

# Persistent ChromaDB directory (gitignored).
CHROMA_DIR = os.environ.get("CHROMA_DIR", str(SIDECAR_DIR / "data" / "chroma"))
COLLECTION_NAME = os.environ.get("CHROMA_COLLECTION", "textbooks")

# HTTP server the Jarvis agent tool calls.
HOST = os.environ.get("RAG_HOST", "127.0.0.1")
PORT = int(os.environ.get("RAG_PORT", "8016"))

DEFAULT_TOP_K = int(os.environ.get("RAG_TOP_K", "4"))

# Chunker tuning. max is a soft cap — a single block (e.g. a long
# derivation) is never split, so chunks can exceed it.
CHUNK_MAX_CHARS = int(os.environ.get("CHUNK_MAX_CHARS", "1800"))
CHUNK_MIN_CHARS = int(os.environ.get("CHUNK_MIN_CHARS", "200"))
