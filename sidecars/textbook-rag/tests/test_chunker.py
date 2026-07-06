"""Proves the chunker never cuts an equation, fence, or LaTeX environment."""

import re

from rag.chunker import Chunk, chunk_markdown, split_blocks

# A fixture shaped like Marker output for a math textbook: headers, display
# math with blank lines inside it, \begin{align}, a fenced code block, and a
# theorem/proof pair with inline $...$ math.
FIXTURE = r"""# Chapter 3: Vector Calculus

Intro prose about fields and flows with inline math $\mathbf{F} = \nabla \phi$.

## 3.1 Line Integrals

**Theorem 3.1 (Fundamental Theorem for Line Integrals).** If $\phi$ is
differentiable and $\mathbf{F} = \nabla\phi$, then

$$
\int_C \mathbf{F} \cdot d\mathbf{r}

= \phi(\mathbf{r}(b)) - \phi(\mathbf{r}(a))
$$

**Proof.** Apply the chain rule to $\phi(\mathbf{r}(t))$ and integrate.

\begin{align}
\frac{d}{dt}\phi(\mathbf{r}(t)) &= \nabla\phi \cdot \mathbf{r}'(t) \\

&= \mathbf{F} \cdot \mathbf{r}'(t)
\end{align}

Integrating both sides over $[a, b]$ completes the proof. $\blacksquare$

## 3.2 Green's Theorem

Relates a line integral around a simple closed curve $C$ to a double
integral over the region $D$ it encloses.

\[
\oint_C (L\,dx + M\,dy)

= \iint_D \left( \frac{\partial M}{\partial x} - \frac{\partial L}{\partial y} \right) dA
\]

```python
# numeric check of Green's theorem

def circulation(field, curve):
    return sum(field(p).dot(t) for p, t in curve)
```

Closing remarks for the section.
"""

EQUATION = "\\int_C \\mathbf{F} \\cdot d\\mathbf{r}"


def balanced(text: str, token: str) -> bool:
    return text.count(token) % 2 == 0


def test_blank_lines_inside_math_do_not_split_blocks():
    blocks = split_blocks(FIXTURE)
    dollar_block = next(b for b in blocks if EQUATION in b)
    # The $$ region — including its interior blank line — is one block.
    assert dollar_block.count("$$") == 2
    align_block = next(b for b in blocks if "\\begin{align}" in b)
    assert "\\end{align}" in align_block
    bracket_block = next(b for b in blocks if "\\oint_C" in b)
    assert "\\[" in bracket_block and "\\]" in bracket_block
    fence_block = next(b for b in blocks if "def circulation" in b)
    assert fence_block.count("```") == 2


def test_no_chunk_cuts_an_equation_or_fence():
    # Tiny max_chars forces aggressive splitting — the pathological case.
    chunks = chunk_markdown(FIXTURE, max_chars=80, min_chars=0)
    for chunk in chunks:
        assert balanced(chunk.text, "$$"), chunk.text
        assert balanced(chunk.text, "```"), chunk.text
        assert len(re.findall(r"\\begin\{", chunk.text)) == len(
            re.findall(r"\\end\{", chunk.text)
        ), chunk.text
        assert chunk.text.count("\\[") == chunk.text.count("\\]"), chunk.text


def test_display_equation_survives_whole_in_exactly_one_chunk():
    chunks = chunk_markdown(FIXTURE, max_chars=80, min_chars=0)
    holders = [c for c in chunks if EQUATION in c.text]
    assert len(holders) == 1
    # ...and the full $$...$$ region is present, not a truncated half.
    assert holders[0].text.count("$$") == 2


def test_headers_start_new_chunks_and_set_section_trail():
    chunks = chunk_markdown(FIXTURE)
    sections = {c.section for c in chunks}
    assert any("3.1 Line Integrals" in s for s in sections)
    assert any("3.2 Green's Theorem" in s for s in sections)
    line_integrals = next(c for c in chunks if "Theorem 3.1" in c.text)
    assert line_integrals.section == "Chapter 3: Vector Calculus > 3.1 Line Integrals"
    # Sibling ## replaces the previous ## in the trail, not nests under it.
    greens = next(c for c in chunks if "Green's Theorem" in c.section)
    assert "3.1" not in greens.section


def test_theorem_stays_bundled_with_its_display_equation():
    # At the default chunk size the theorem statement and its $$ equation
    # share a chunk (they're adjacent blocks in the same small section).
    chunks = chunk_markdown(FIXTURE)
    holder = next(c for c in chunks if "Theorem 3.1" in c.text)
    assert EQUATION in holder.text


def test_oversized_single_block_is_kept_whole():
    lines = ["$$"] + [f"a_{i} + b_{i} = c_{i} \\\\" for i in range(200)] + ["$$"]
    giant = "# H\n\nintro\n\n" + "\n".join(lines) + "\n\nafter\n"
    chunks = chunk_markdown(giant, max_chars=100, min_chars=0)
    holders = [c for c in chunks if "a_0" in c.text]
    assert len(holders) == 1
    assert holders[0].text.count("$$") == 2
    assert "a_199" in holders[0].text


def test_small_chunks_merge_within_section():
    md = "# S\n\nfirst tiny.\n\nsecond tiny.\n\nthird tiny.\n"
    chunks = chunk_markdown(md, max_chars=24, min_chars=500)
    assert len(chunks) == 1
    assert isinstance(chunks[0], Chunk)
    assert "third tiny." in chunks[0].text


def test_indices_are_sequential():
    chunks = chunk_markdown(FIXTURE, max_chars=80, min_chars=0)
    assert [c.index for c in chunks] == list(range(len(chunks)))
