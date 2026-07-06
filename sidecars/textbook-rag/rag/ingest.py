"""Ingest a textbook into the local vector store.

    .venv/Scripts/python -m rag.ingest path/to/book.pdf
    .venv/Scripts/python -m rag.ingest notes.md          # pre-converted Markdown

Idempotent: chunks are keyed by source::index and re-ingesting a file
replaces its previous chunks. Requires Ollama running with the embedding
model pulled (ollama pull nomic-embed-text).
"""

import argparse
from pathlib import Path

from . import config
from .chunker import chunk_markdown
from .convert import convert_pdf
from .embeddings import OllamaEmbedder
from .store import Embedder, get_collection, upsert_source


def ingest_file(
    path: str | Path,
    engine: str = "auto",
    embedder: Embedder | None = None,
    chroma_dir: str = config.CHROMA_DIR,
) -> dict:
    """Convert (if PDF) → chunk → embed → upsert. Returns a summary dict."""
    path = Path(path)
    if path.suffix.lower() == ".pdf":
        markdown, engine_used = convert_pdf(path, engine)
    elif path.suffix.lower() in (".md", ".markdown", ".txt"):
        markdown, engine_used = path.read_text(encoding="utf-8"), "passthrough"
    else:
        raise ValueError(f"Unsupported file type: {path.suffix} (pdf, md, txt)")

    chunks = chunk_markdown(markdown)
    collection = get_collection(chroma_dir)
    count = upsert_source(
        collection, path.stem, chunks, embedder or OllamaEmbedder()
    )
    return {
        "source": path.stem,
        "engine": engine_used,
        "chunks": count,
        "collection_total": collection.count(),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", help="PDF (or pre-converted .md/.txt) to ingest")
    parser.add_argument(
        "--engine",
        choices=["auto", "marker", "markitdown"],
        default="auto",
        help="PDF converter; auto prefers Marker when installed",
    )
    args = parser.parse_args()
    summary = ingest_file(args.path, args.engine)
    print(
        f"Ingested {summary['source']!r} via {summary['engine']}: "
        f"{summary['chunks']} chunks (collection now {summary['collection_total']})."
    )
    if summary["engine"] == "markitdown":
        print(
            "Note: MarkItDown does not reconstruct LaTeX from equation images; "
            "for heavy math books install Marker (requirements-marker.txt)."
        )


if __name__ == "__main__":
    main()
