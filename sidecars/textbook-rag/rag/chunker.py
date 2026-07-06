"""Equation-safe semantic chunker for math-textbook Markdown.

Strategy: split on Markdown headers and blank-line block boundaries, then
pack whole blocks into chunks up to a soft size cap. Blocks are the atoms —
they are never split — and blank lines *inside* protected regions (fenced
code, $$ display math, \\[ ... \\], \\begin{env}...\\end{env}) do not end a
block, so an equation always travels intact with the prose block around it.
A theorem statement, its display equation, and its proof paragraph stay
bundled as long as they sit under the same header without huge gaps.

Pure logic, no third-party dependencies, unit-tested in tests/test_chunker.py.
"""

import re
from dataclasses import dataclass

from . import config

HEADER_RE = re.compile(r"^(#{1,6})\s+(.*)$")
FENCE_RE = re.compile(r"^(```|~~~)")


@dataclass
class Chunk:
    text: str
    section: str  # heading trail, e.g. "Ch 3 > 3.2 Line Integrals"
    index: int  # position within the document


def _count_unescaped(line: str, token: str) -> int:
    """Occurrences of token not preceded by a backslash (so \\$ or \\$$ in
    prose doesn't toggle math state)."""
    count = 0
    i = 0
    while True:
        i = line.find(token, i)
        if i == -1:
            return count
        if i == 0 or line[i - 1] != "\\":
            count += 1
        i += len(token)


class _ProtectionTracker:
    """Line-by-line state machine for regions a split must never land in."""

    def __init__(self) -> None:
        self.in_fence = False
        self.in_display_math = False  # $$ ... $$
        self.in_bracket_math = False  # \[ ... \]
        self.env_depth = 0  # \begin{...} ... \end{...}

    @property
    def protected(self) -> bool:
        return (
            self.in_fence
            or self.in_display_math
            or self.in_bracket_math
            or self.env_depth > 0
        )

    def feed(self, line: str) -> None:
        if FENCE_RE.match(line.lstrip()):
            self.in_fence = not self.in_fence
            return
        if self.in_fence:
            return  # everything inside a fence is literal
        if _count_unescaped(line, "$$") % 2 == 1:
            self.in_display_math = not self.in_display_math
        opens = len(re.findall(r"\\begin\{[^}]*\}", line))
        closes = len(re.findall(r"\\end\{[^}]*\}", line))
        self.env_depth = max(0, self.env_depth + opens - closes)
        if _count_unescaped(line, "\\[") != _count_unescaped(line, "\\]"):
            self.in_bracket_math = not self.in_bracket_math


def split_blocks(markdown: str) -> list[str]:
    """Split into blocks on blank lines, except blank lines inside a
    protected region. Header lines always form their own block start."""
    blocks: list[list[str]] = []
    current: list[str] = []
    tracker = _ProtectionTracker()

    for line in markdown.splitlines():
        is_blank = line.strip() == ""
        if is_blank and not tracker.protected:
            if current:
                blocks.append(current)
                current = []
            continue
        if HEADER_RE.match(line) and not tracker.protected and current:
            blocks.append(current)
            current = []
        current.append(line)
        tracker.feed(line)
    if current:
        blocks.append(current)
    return ["\n".join(b) for b in blocks]


def chunk_markdown(
    markdown: str,
    max_chars: int = config.CHUNK_MAX_CHARS,
    min_chars: int = config.CHUNK_MIN_CHARS,
) -> list[Chunk]:
    """Pack whole blocks into chunks. New chunk on every header; also when
    the soft size cap would be exceeded. A single oversized block (a long
    derivation) stays whole rather than being cut."""
    blocks = split_blocks(markdown)

    heading_trail: dict[int, str] = {}  # level -> title

    def section_label() -> str:
        return " > ".join(heading_trail[k] for k in sorted(heading_trail)) or "(document)"

    chunks: list[Chunk] = []
    buffer: list[str] = []
    buffer_section = section_label()

    def flush() -> None:
        nonlocal buffer
        if buffer:
            chunks.append(Chunk("\n\n".join(buffer), buffer_section, len(chunks)))
            buffer = []

    for block in blocks:
        header = HEADER_RE.match(block.splitlines()[0])
        if header:
            flush()
            level = len(header.group(1))
            heading_trail[level] = header.group(2).strip()
            for deeper in [k for k in heading_trail if k > level]:
                del heading_trail[deeper]
            buffer_section = section_label()
            buffer.append(block)
            continue
        current_len = sum(len(b) for b in buffer) + 2 * len(buffer)
        if buffer and current_len + len(block) > max_chars:
            flush()
        buffer.append(block)
    flush()

    return _merge_small(chunks, min_chars)


def _merge_small(chunks: list[Chunk], min_chars: int) -> list[Chunk]:
    """Fold undersized chunks into the previous chunk of the same section
    so retrieval doesn't surface bare fragments. Tiny chunks that open a
    new section (a lone header) are kept as-is."""
    merged: list[Chunk] = []
    for chunk in chunks:
        if (
            merged
            and len(chunk.text) < min_chars
            and merged[-1].section == chunk.section
        ):
            previous = merged[-1]
            merged[-1] = Chunk(previous.text + "\n\n" + chunk.text, previous.section, previous.index)
        else:
            merged.append(chunk)
    return [Chunk(c.text, c.section, i) for i, c in enumerate(merged)]
