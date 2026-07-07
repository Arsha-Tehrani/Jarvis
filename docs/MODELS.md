# Local models — which one for which job

Jarvis asks Ollama to do three different jobs with different requirements.
This page maps each job to concrete model recommendations, what they cost in
memory, and the exact pull command.

> **Staleness warning.** The local-model landscape moves fast; names, tags,
> and "current best" change every few months. The specific models below were
> reasonable picks when this was written (mid-2026). Before pulling anything,
> check what you already have with `ollama list` and skim the
> [Ollama model library](https://ollama.com/library) (and
> [vision models](https://ollama.com/search?c=vision)) for what's current.
> The RAM footprints and tokens/sec below are rough, real-world-ish numbers
> for the default Q4 quantizations — treat them as orders of magnitude, not
> benchmarks.

Run `npm run doctor` to verify the models you've configured are actually
pulled and everything else is wired up.

## The three jobs

| Job | Used by | Needs | Env var |
|---|---|---|---|
| **Chat / tool-calling** | the agent (`lib/llm.ts`), mail triage, transaction categorization, brief/digest rephrasing, textbook-RAG answers | reliable structured **tool-call / JSON output** — this matters more than raw smarts; a model that free-texts instead of emitting tool calls is useless here | `LLM_MODEL` |
| **Vision** | macro sidecar photo path (`sidecars/macro`) | image understanding + portion/food estimation | `MACRO_VISION_MODEL` |
| **Embedding** | semantic search index, textbook RAG, GoodNotes ingestion | consistent vectors; **hardcoded default in the ingest pipeline** | `EMBED_MODEL` |

## Chat / tool-calling (`LLM_MODEL`)

The default is `llama3.1:8b`, chosen for dependable OpenAI-style tool-calling
on the Ollama endpoint.

**Fits on 8–16 GB unified memory / a laptop GPU:**

| Model | Pull | Download | RAM while running | Rough speed |
|---|---|---|---|---|
| `llama3.1:8b` (default) | `ollama pull llama3.1:8b` | ~4.9 GB | ~6–8 GB | ~25–45 tok/s on an M-series Mac; ~50–70 tok/s on a mid-range discrete GPU (RTX 4060-class, 8 GB VRAM) |
| `qwen3:8b` | `ollama pull qwen3:8b` | ~5 GB | ~6–8 GB | similar; strong JSON/tool output for its size |

**Have more VRAM / unified memory (24 GB+):**

| Model | Pull | Download | RAM while running | Rough speed |
|---|---|---|---|---|
| `qwen3:32b` | `ollama pull qwen3:32b` | ~20 GB | ~24 GB | ~10–20 tok/s on an M-Max; needs a 24 GB GPU to run fully on a discrete card |
| `llama3.3:70b` | `ollama pull llama3.3:70b` | ~43 GB | ~48 GB | Mac Studio / 48 GB+ territory; not a laptop model |

Bigger buys you better categorization, triage, and phrasing — but every
deterministic path (keyword categorization, exact search, plain brief) works
with **no model at all**, so start small and upgrade only if tool calls
misfire.

## Vision (`MACRO_VISION_MODEL`)

Used only when you photograph food for the macro sidecar. **This is the
least reliable model in the system** — it guesses portions from one 2D image
and misses oils and dressings — and the UI already labels photo entries as
approximate. Don't expect nutrition-label accuracy from any model here.

| Model | Pull | Download | RAM while running |
|---|---|---|---|
| `qwen2.5vl` (sidecar default) | `ollama pull qwen2.5vl` | ~6 GB | ~8 GB |
| `llama3.2-vision:11b` | `ollama pull llama3.2-vision:11b` | ~8 GB | ~10 GB |

Vision tags churn faster than chat models — check
[ollama.com/search?c=vision](https://ollama.com/search?c=vision) before
pulling.

## Embedding (`EMBED_MODEL`)

| Model | Pull | Download | RAM while running |
|---|---|---|---|
| `nomic-embed-text` (default) | `ollama pull nomic-embed-text` | ~274 MB | < 1 GB |

`nomic-embed-text` is the default across the app's semantic search
(`search_embeddings`), the textbook-RAG store, and GoodNotes ingestion.
**Swapping it means re-ingesting everything**: vectors from different models
(or even different dimensions) are not comparable, so you'd need to clear the
`search_embeddings` table, wipe the sidecar's ChromaDB directory, and re-run
`rag.ingest` on every book and notebook. Unless you have a specific reason,
leave it alone — it's tiny and it works.

## Speed expectations, honestly

Tokens/sec depends on quantization, context length, and what else is using
the GPU/RAM. The numbers above assume the default Q4 quant and short
contexts. Long agent turns (many tools in the system prompt) are noticeably
slower on first token. If a job feels too slow, the fix is usually a smaller
model, not a bigger machine — see the deterministic-first note above.
