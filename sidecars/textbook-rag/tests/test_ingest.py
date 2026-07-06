"""End-to-end ingest → chunk → embed (stub) → store → retrieve, on a real
sample PDF and on Markdown, plus idempotency of re-ingest."""

from rag import store
from rag.ingest import ingest_file

MATH_MD = """# Chapter 5: Green's Theorem

Green's theorem relates a line integral around a simple closed curve to a
double integral of the curl over the region it encloses.

$$
\\oint_C (L\\,dx + M\\,dy) = \\iint_D \\left( \\frac{\\partial M}{\\partial x} - \\frac{\\partial L}{\\partial y} \\right) dA
$$

# Chapter 7: Eigenvalues

An eigenvalue lambda of a matrix A satisfies the characteristic equation
det(A - lambda I) = 0. Eigenvectors point along invariant directions.
"""


def test_pdf_ingest_end_to_end(sample_pdf, stub_embedder, tmp_path):
    chroma_dir = str(tmp_path / "chroma")
    summary = ingest_file(sample_pdf, embedder=stub_embedder, chroma_dir=chroma_dir)
    assert summary["engine"] == "markitdown"  # marker not installed in CI
    assert summary["chunks"] >= 1
    assert summary["collection_total"] == summary["chunks"]

    collection = store.get_collection(chroma_dir)
    hits = store.query(
        collection, stub_embedder, "line integral around a closed curve", top_k=2
    )
    assert hits and "Greens theorem" in hits[0].text
    assert hits[0].source == "sample-textbook"


def test_markdown_ingest_chunks_by_section_and_ranks(tmp_path, stub_embedder):
    chroma_dir = str(tmp_path / "chroma")
    book = tmp_path / "calc-notes.md"
    book.write_text(MATH_MD, encoding="utf-8")

    summary = ingest_file(book, embedder=stub_embedder, chroma_dir=chroma_dir)
    assert summary["engine"] == "passthrough"
    assert summary["chunks"] == 2  # one per chapter header

    collection = store.get_collection(chroma_dir)
    hits = store.query(
        collection, stub_embedder, "what is an eigenvalue of a matrix", top_k=2
    )
    assert "Eigenvalues" in hits[0].section
    # The equation survived chunking intact.
    greens = store.query(collection, stub_embedder, "green theorem curve", top_k=1)
    assert greens[0].text.count("$$") == 2


def test_reingest_updates_not_duplicates(tmp_path, stub_embedder):
    chroma_dir = str(tmp_path / "chroma")
    book = tmp_path / "book.md"
    book.write_text(MATH_MD, encoding="utf-8")

    first = ingest_file(book, embedder=stub_embedder, chroma_dir=chroma_dir)
    second = ingest_file(book, embedder=stub_embedder, chroma_dir=chroma_dir)
    assert second["collection_total"] == first["collection_total"]

    # Shrinking rewrite: stale chunks must disappear, content must be new.
    book.write_text("# Only Chapter\n\nCompletely new text about topology.\n", encoding="utf-8")
    third = ingest_file(book, embedder=stub_embedder, chroma_dir=chroma_dir)
    assert third["chunks"] == 1
    remaining = store.get_collection(chroma_dir).get(where={"source": "book"})
    assert len(remaining["ids"]) == 1
    assert "topology" in remaining["documents"][0]


def test_two_sources_coexist(tmp_path, stub_embedder, sample_pdf):
    chroma_dir = str(tmp_path / "chroma")
    notes = tmp_path / "notes.md"
    notes.write_text(MATH_MD, encoding="utf-8")
    ingest_file(sample_pdf, embedder=stub_embedder, chroma_dir=chroma_dir)
    ingest_file(notes, embedder=stub_embedder, chroma_dir=chroma_dir)
    collection = store.get_collection(chroma_dir)
    sources = {m["source"] for m in collection.get()["metadatas"]}
    assert sources == {"sample-textbook", "notes"}
