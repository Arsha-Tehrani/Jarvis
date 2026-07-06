"""PDF → Markdown conversion.

Default engine: **Marker** — best-in-class at academic layout and LaTeX
equations. Marker drags in PyTorch (multi-GB), so it is an opt-in install
(`pip install -r requirements-marker.txt`) and we auto-detect it.

Fallback: **MarkItDown** (installed by default, light) — fine for text-first
PDFs, but it does NOT reconstruct LaTeX from equation images; heavy math
books should go through Marker. The ingest CLI prints which engine ran.
"""

from importlib.util import find_spec
from pathlib import Path


def marker_available() -> bool:
    return find_spec("marker") is not None


def convert_pdf(path: str | Path, engine: str = "auto") -> tuple[str, str]:
    """Returns (markdown, engine_used). engine: auto | marker | markitdown."""
    path = Path(path)
    if not path.exists():
        raise FileNotFoundError(f"No such file: {path}")
    if engine == "auto":
        engine = "marker" if marker_available() else "markitdown"
    if engine == "marker":
        return _convert_marker(path), "marker"
    if engine == "markitdown":
        return _convert_markitdown(path), "markitdown"
    raise ValueError(f"Unknown engine: {engine!r} (use auto, marker, or markitdown)")


def _convert_marker(path: Path) -> str:
    # marker-pdf 1.x API. Model weights (~3 GB) download on first run.
    try:
        from marker.converters.pdf import PdfConverter
        from marker.models import create_model_dict
        from marker.output import text_from_rendered
    except ImportError as err:
        raise RuntimeError(
            "Marker is not installed. Run: pip install -r requirements-marker.txt "
            "(heavy — pulls PyTorch), or use --engine markitdown."
        ) from err
    converter = PdfConverter(artifact_dict=create_model_dict())
    rendered = converter(str(path))
    markdown, _, _images = text_from_rendered(rendered)
    return markdown


def _convert_markitdown(path: Path) -> str:
    from markitdown import MarkItDown

    result = MarkItDown().convert(str(path))
    return result.text_content
