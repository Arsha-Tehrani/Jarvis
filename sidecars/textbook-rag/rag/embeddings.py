"""Embeddings via local Ollama (`ollama pull nomic-embed-text` first).

Tests inject a deterministic stub with the same .embed() shape, so nothing
here runs during unit tests.
"""

import httpx

from . import config

BATCH_SIZE = 32


class OllamaEmbedder:
    def __init__(
        self,
        base_url: str = config.OLLAMA_BASE_URL,
        model: str = config.EMBED_MODEL,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.model = model

    def embed(self, texts: list[str]) -> list[list[float]]:
        vectors: list[list[float]] = []
        for start in range(0, len(texts), BATCH_SIZE):
            batch = texts[start : start + BATCH_SIZE]
            try:
                response = httpx.post(
                    f"{self.base_url}/api/embed",
                    json={"model": self.model, "input": batch},
                    timeout=120,
                )
            except httpx.HTTPError as err:
                raise RuntimeError(
                    f"Could not reach Ollama at {self.base_url}. "
                    "Is it running? (ollama serve)"
                ) from err
            if response.status_code == 404:
                raise RuntimeError(
                    f"Embedding model {self.model!r} not found. "
                    f"Run: ollama pull {self.model}"
                )
            response.raise_for_status()
            vectors.extend(response.json()["embeddings"])
        return vectors
