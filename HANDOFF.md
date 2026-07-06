# HANDOFF — updated after Phase 19 (2026-07-06, second run; P16–18 notes below)

## Phase 19 (this run): GoodNotes sync, system monitor, screen time

Built on the macOS box (first run on this machine — Node 24 was present,
sidecar venvs were not).

- **GoodNotes → RAG (Drive)**: `lib/goodnotes.ts` polls the Drive folder
  named by `GOODNOTES_DRIVE_FOLDER` (default "GoodNotes Backup") hourly at
  :15 (+ launch catch-up), diffs each PDF's `modifiedTime` against the new
  `goodnotes_sync_state` table, downloads changed files to the gitignored
  `/temp_notes`, and posts the path to the RAG sidecar's **new
  `POST /ingest` endpoint** (added to `rag/server.py`, same pipeline as the
  CLI; 5 new pytest cases). Sync state commits only after a successful
  ingest, so failures retry. **`drive.readonly` was added to the Google
  SCOPES — existing connections must reconnect once from the Calendar tab**
  (a 403 surfaces exactly that message). `getAccessToken` is now exported
  as `getGoogleAccessToken`.
- **System monitor**: `GET /api/system` (via `systeminformation@5.31.13`,
  pinned at install) returns CPU load/cores, active vs total memory, and
  the OS-drive usage; `<SystemMonitor />` on the Today grid polls it every
  8 s and cleans up on unmount.
- **Screen time**: `lib/activitywatch.ts` reads the local ActivityWatch
  API (`AW_BASE_URL`, default :5600) — AFK bucket for active time (window
  time as fallback), window bucket by app, web bucket by domain; pure
  aggregation helpers have 3 node tests. `GET /api/activity` always
  answers 200 with an `available` flag; `<ScreenTime />` refreshes every
  60 s and shows a quiet hint when AW is offline.

Deferred to a live session: reconnect Google (new scope) and watch a real
GoodNotes PDF flow Drive → `/temp_notes` → sidecar → `ask_textbook`;
install/run ActivityWatch and eyeball the Screen time card against its own
UI; confirm the Windows box reports `C:` in the System card.

# Previous handoff — Phases 16–18 (2026-07-06)

Phases 1–18 are built and committed. Phases 16–18 are **Python sidecars**
under `sidecars/` — standalone services with their own venvs that talk to
Jarvis/Ollama over HTTP; nothing was added to the Next.js build. This run
had no live Ollama models pulled and no mic/GPU exercised; every
model-dependent test is *deferred* below. Each phase closed on green
`npm run build` + `npm run typecheck`; `npm test` runs **23 passing** node
tests and the three sidecars run **17 + 24 + 18 passing** pytest cases
(all model/mic/Jarvis calls stubbed). The `nutrition_logs` test row created
during verification was deleted — DB is clean.

The P9–15 handoff (env table, back-burner items, earlier deferred tests) is
in git history at `b3b63d2`; everything there still stands.

## Commits (this run)

| Commit | What |
|---|---|
| `bab8984` | Phase 16: math PDF parser + local RAG sidecar (`sidecars/textbook-rag`) |
| `8dd390b` | Phase 17: macro vision + text pipeline (`sidecars/macro` + nutrition in the app) |
| `42c89e0` | Phase 18: local voice transcription bridge (`sidecars/voice`) |

## What this run built

- **Textbook RAG (P16).** `sidecars/textbook-rag`: `python -m rag.ingest
  book.pdf` converts PDF→Markdown (**Marker** by default when installed —
  it's the engine that preserves LaTeX; **MarkItDown** is the installed
  light fallback and does *not* reconstruct equations from images), chunks
  it with an equation-safe splitter (headers + blank-line blocks; `$$…$$`,
  `\[…\]`, `\begin{env}…\end{env}`, and code fences are unsplittable, so
  theorem+proof+equation travel together — 8 unit tests incl. a
  force-tiny-chunks case), embeds via Ollama `nomic-embed-text`, and
  upserts into persistent ChromaDB keyed `source::index` (re-ingest
  replaces, never duplicates; shrinking re-ingests drop stale chunks).
  `python -m rag.server` serves `POST /ask {"question","top_k"}` on
  **:8016** → top-k chunks + the primary Ollama model explaining with
  numbered section citations. The app got one new read-only zod tool,
  `ask_textbook(question)` (`TEXTBOOK_RAG_URL` in `.env.example`).
  Marker is a multi-GB PyTorch install, so it lives in
  `requirements-marker.txt` (pinned `marker-pdf==1.10.2`, current stable,
  actively maintained) and is auto-detected at ingest time.
- **Macro pipeline (P17).** `sidecars/macro` on **:8017**:
  `POST /nutrition` takes a **food photo** (multipart `image=`) or **text**
  (JSON `{"text"}`); photos go through a local Ollama vision model to
  identify items/portions, then either path hits the primary model in
  **Ollama JSON mode** with a strict system prompt; output must validate as
  `{"item",calories,protein,carbs,fat}` (single or list, ≤20) against a
  pydantic gate — one repair pass showing the model its error, then hard
  reject with 422. Validated items POST to the app's new zod-validated
  `/api/nutrition`, which writes the new `nutrition_logs` table. App side
  also got: `log_meal` agent tool, `calories_per_day` goal kind (goals page
  treats it lower-is-better), and a "Macros today" card on Trackers with
  totals vs goal, per-item list, photo-approximation badge, and remove.
  **Honest note (in code + API responses): photo calorie estimates are
  rough approximations — portions guessed from one 2D image; the text path
  is more accurate.** Verified end-to-end on the running app with the model
  stubbed: insert → totals → goal → delete, and the zod gate rejecting bad
  entries.
- **Voice bridge (P18).** `sidecars/voice`: `python -m voice.push_to_talk`
  — hold **F9** (`PTT_KEY`) to record (sounddevice, 16 kHz mono), release
  to transcribe with **faster-whisper `large-v3-turbo`** and POST the text
  to `/api/agent` exactly as the chat box does, printing transcript +
  reply (with a pending-confirmation notice when the agent gates an
  action). Compute path is a pure, unit-tested decision matrix over probed
  hardware: NVIDIA→CUDA fp16; **AMD→CPU int8 with an explicit startup log
  that faster-whisper/CTranslate2 has no clean native AMD GPU path**
  (CUDA-only upstream; ROCm = experimental Linux-only community builds);
  Apple Silicon→CPU int8 (Accelerate/NEON, no Metal offload); else CPU
  int8. `WHISPER_DEVICE`/`WHISPER_COMPUTE`/`WHISPER_MODEL` env override
  everything. Live detection on this machine correctly identified the AMD
  GPU and fell back to CPU int8.

## Sidecar endpoints (exact payloads)

| Sidecar | Run | Endpoint / payload |
|---|---|---|
| textbook-rag | `sidecars/textbook-rag/.venv/Scripts/python -m rag.server` | `POST :8016/ask {"question": str, "top_k"?: 1–10}` → `{"answer", "sources":[{"source","section","snippet","distance"}]}`; `GET /health` |
| macro | `sidecars/macro/.venv/Scripts/python -m macro.server` | `POST :8017/nutrition` JSON `{"text": str, "date"?: "YYYY-MM-DD"}` **or** multipart `image=<file>[, text, date]` → `{"source","items":[…],"jarvis":{…},"note"?}`; `GET /health` shows whether models are pulled |
| voice | `sidecars/voice/.venv/Scripts/python -m voice.push_to_talk` | no server — it *calls* `POST {JARVIS_URL}/api/agent {"text": <transcript>}` |

Each sidecar: `py -3.13 -m venv .venv && .venv\Scripts\pip install -r
requirements.txt` (all pins captured at install on 2026-07-06), tests with
`.venv\Scripts\python -m pytest`. Venvs, `__pycache__`, and
`sidecars/textbook-rag/data/` (Chroma) are gitignored.

## Deferred tests (need Ollama + pulled models + hardware)

Do these in order the first live session:

1. `ollama pull nomic-embed-text` (~274 MB), then ingest a real math PDF —
   **first install Marker**: `sidecars/textbook-rag/.venv/Scripts/pip
   install -r requirements-marker.txt` (PyTorch, multi-GB; ~3 GB weights
   download on first conversion; MarkItDown fallback works today but
   loses LaTeX). Then `python -m rag.ingest <book.pdf>`, start the server,
   and ask the agent a course question → `ask_textbook` end-to-end with
   real embeddings + real citations. Verify Marker's 1.10.x import path
   (`marker.converters.pdf`) still matches `rag/convert.py` at install.
2. **Vision model**: check https://ollama.com/search?c=vision for the
   current best tag (default is `MACRO_VISION_MODEL=qwen2.5vl`;
   llava-family also works), `ollama pull` it, then POST a real food photo
   to :8017 → vision description → JSON-mode extraction → row lands in
   Trackers with the photo badge. Also test the text path and `log_meal`
   through the agent ("I ate two eggs and toast").
3. **Voice**: first run downloads large-v3-turbo (~1.6 GB from Hugging
   Face). On this AMD (6700 XT) box it runs **CPU int8** — if too slow,
   set `WHISPER_MODEL=small`. On an NVIDIA box it needs CUDA 12 + cuDNN 9
   runtimes for the fp16 path. Real-mic test: hold F9, say "log the gym",
   confirm the gym log appears. (The `keyboard` lib needs the console
   focused nowhere in particular on Windows; it hooks globally.)
4. Eyeball the Trackers "Macros today" card and the calories ring on
   /goals with a `calories_per_day` goal set.

## Known limitations (this run)

- MarkItDown path flattens equation images to nothing/alt-text — fine for
  smoke tests, wrong for real study; Marker is the intended engine.
- RAG retrieval is semantic-only (no keyword/BM25 hybrid); very
  symbol-heavy queries may retrieve loosely.
- Photo macros are estimates by design (labeled in UI + API).
- Vision default tag (`qwen2.5vl`) was chosen without a live registry
  check — verify against ollama.com before pulling (step 2 above).
- `keyboard` hooks keys globally (that's the point of push-to-talk) but
  means F9 is captured system-wide while the bridge runs; change `PTT_KEY`
  if it collides.
- Chunker treats an unclosed `$$`/`\begin{}` (bad conversion output) as
  protecting the rest of the document — a malformed book can yield one
  giant chunk; visible in ingest's chunk count.

## Env vars added this run

Next app (`.env.example`): `TEXTBOOK_RAG_URL=http://localhost:8016`.
Sidecar-side (documented in each README, not app env): `OLLAMA_BASE_URL`,
`EMBED_MODEL`, `CHROMA_DIR`, `RAG_PORT/RAG_TOP_K/CHUNK_*`;
`MACRO_VISION_MODEL`, `JARVIS_URL`, `MACRO_PORT`; `WHISPER_MODEL`,
`WHISPER_DEVICE`, `WHISPER_COMPUTE`, `PTT_KEY`. No new secrets anywhere.
