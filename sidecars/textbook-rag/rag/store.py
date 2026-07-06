"""Persistent ChromaDB store. One collection, chunks keyed by
source::index so re-ingesting a book replaces its chunks (idempotent)."""

from dataclasses import dataclass
from typing import Protocol

import chromadb

from . import config
from .chunker import Chunk


class Embedder(Protocol):
    def embed(self, texts: list[str]) -> list[list[float]]: ...


@dataclass
class Retrieved:
    text: str
    source: str
    section: str
    distance: float


def get_collection(
    chroma_dir: str = config.CHROMA_DIR,
    name: str = config.COLLECTION_NAME,
) -> chromadb.Collection:
    client = chromadb.PersistentClient(path=chroma_dir)
    return client.get_or_create_collection(name, metadata={"hnsw:space": "cosine"})


def upsert_source(
    collection: chromadb.Collection,
    source_id: str,
    chunks: list[Chunk],
    embedder: Embedder,
) -> int:
    """Replace all chunks for source_id with the given ones. Re-running the
    same PDF updates rather than duplicates, and stale chunks from an older
    conversion are removed even if the chunk count shrank."""
    if not chunks:
        raise ValueError(f"No chunks to ingest for {source_id!r}")
    embeddings = embedder.embed([c.text for c in chunks])
    collection.delete(where={"source": source_id})
    collection.add(
        ids=[f"{source_id}::{c.index}" for c in chunks],
        embeddings=embeddings,
        documents=[c.text for c in chunks],
        metadatas=[
            {"source": source_id, "section": c.section, "index": c.index}
            for c in chunks
        ],
    )
    return len(chunks)


def query(
    collection: chromadb.Collection,
    embedder: Embedder,
    question: str,
    top_k: int = config.DEFAULT_TOP_K,
) -> list[Retrieved]:
    if collection.count() == 0:
        return []
    [vector] = embedder.embed([question])
    result = collection.query(
        query_embeddings=[vector],
        n_results=min(top_k, collection.count()),
        include=["documents", "metadatas", "distances"],
    )
    hits: list[Retrieved] = []
    for text, meta, distance in zip(
        result["documents"][0], result["metadatas"][0], result["distances"][0]
    ):
        hits.append(
            Retrieved(
                text=text,
                source=str(meta["source"]),
                section=str(meta["section"]),
                distance=float(distance),
            )
        )
    return hits
