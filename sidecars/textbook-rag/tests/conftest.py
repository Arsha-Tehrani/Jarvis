"""Shared test helpers: a deterministic embedder (no Ollama needed) and a
minimal hand-assembled PDF so the ingest pipeline can be exercised
end-to-end on a real .pdf file without any model or network."""

import hashlib
import math
import re

import pytest


class StubEmbedder:
    """Deterministic bag-of-hashed-words vectors. Texts sharing words get
    high cosine similarity, so retrieval ranking is meaningful in tests."""

    DIMS = 64

    def embed(self, texts: list[str]) -> list[list[float]]:
        return [self._one(t) for t in texts]

    def _one(self, text: str) -> list[float]:
        vec = [0.0] * self.DIMS
        for token in re.findall(r"[a-z0-9]+", text.lower()):
            digest = hashlib.md5(token.encode()).hexdigest()
            vec[int(digest, 16) % self.DIMS] += 1.0
        norm = math.sqrt(sum(v * v for v in vec)) or 1.0
        return [v / norm for v in vec]


@pytest.fixture
def stub_embedder() -> StubEmbedder:
    return StubEmbedder()


def _pdf_escape(text: str) -> str:
    return text.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)")


def build_pdf(pages: list[list[str]]) -> bytes:
    """Assemble a minimal valid one-font PDF, one text line per list entry.
    Objects: 1=Catalog, 2=Pages, 3=Font, then (Page, Contents) per page."""
    page_obj_nums = [4 + 2 * i for i in range(len(pages))]
    kids = " ".join(f"{n} 0 R" for n in page_obj_nums)

    bodies: dict[int, bytes] = {
        1: b"<< /Type /Catalog /Pages 2 0 R >>",
        2: (
            f"<< /Type /Pages /Kids [{kids}] /Count {len(pages)} >>"
        ).encode(),
        3: b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    }
    for i, lines in enumerate(pages):
        page_num = 4 + 2 * i
        content_num = page_num + 1
        text_ops = " T* ".join(f"({_pdf_escape(line)}) Tj" for line in lines)
        stream = f"BT /F1 12 Tf 14 TL 72 720 Td {text_ops} ET".encode()
        bodies[page_num] = (
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
            f"/Resources << /Font << /F1 3 0 R >> >> /Contents {content_num} 0 R >>"
        ).encode()
        bodies[content_num] = (
            f"<< /Length {len(stream)} >>\nstream\n".encode() + stream + b"\nendstream"
        )

    out = bytearray(b"%PDF-1.4\n")
    offsets: dict[int, int] = {}
    for num in sorted(bodies):
        offsets[num] = len(out)
        out += f"{num} 0 obj\n".encode() + bodies[num] + b"\nendobj\n"
    xref_at = len(out)
    count = len(bodies) + 1
    out += f"xref\n0 {count}\n".encode()
    out += b"0000000000 65535 f \n"
    for num in sorted(bodies):
        out += f"{offsets[num]:010d} 00000 n \n".encode()
    out += (
        f"trailer\n<< /Size {count} /Root 1 0 R >>\nstartxref\n{xref_at}\n%%EOF\n"
    ).encode()
    return bytes(out)


@pytest.fixture
def sample_pdf(tmp_path):
    """Two-page math PDF: page 1 Green's theorem, page 2 eigenvalues."""
    pdf = build_pdf(
        [
            [
                "Chapter 5: Greens Theorem",
                "Greens theorem relates a line integral around a closed curve",
                "to a double integral of the curl over the enclosed region.",
            ],
            [
                "Chapter 7: Eigenvalues",
                "An eigenvalue lambda of a matrix satisfies det(A - lambda I) = 0,",
                "the characteristic polynomial equation.",
            ],
        ]
    )
    path = tmp_path / "sample-textbook.pdf"
    path.write_bytes(pdf)
    return path
