"""Macro sidecar configuration — all env-overridable, all models local Ollama."""

import os

OLLAMA_BASE_URL = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434")

# Primary text/extraction model — keep in sync with the app's LLM_MODEL.
TEXT_MODEL = os.environ.get("LLM_MODEL", "llama3.1:8b")

# Vision model for food photos. Ollama's vision lineup moves fast — check
# https://ollama.com/search?c=vision for the current best tag at setup time
# rather than trusting this default (see README).
VISION_MODEL = os.environ.get("MACRO_VISION_MODEL", "qwen2.5vl")

# The Jarvis Next.js app; validated entries are POSTed to /api/nutrition.
JARVIS_URL = os.environ.get("JARVIS_URL", "http://localhost:3000")

HOST = os.environ.get("MACRO_HOST", "127.0.0.1")
PORT = int(os.environ.get("MACRO_PORT", "8017"))
