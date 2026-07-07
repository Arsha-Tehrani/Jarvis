# HANDOFF — updated after Phase 21 (2026-07-06, third run; P19 and P16–18 notes below)

## Phase 21 (this run): README, agent memory + undo, budgets + restore, hybrid search, PWA + auth

Four upgrade phases, each closed on green `npm test` (**49** node tests, up
from 36), `npm run typecheck`, and `npm run build`. Ollama was **not**
running on this box, so every LLM-dependent path was verified through its
fallback (which is the architecture's contract anyway); live-model passes
are deferred below.

- **README** rewritten: pitch + screenshot placeholder (`public/demo.gif`
  does not exist yet — drop a real capture there), quickstart up top, TOC,
  feature bullets clustered (Agent / Life tracking / Money / Knowledge /
  System & automation), a real Testing-philosophy section, and a
  "Scheduler caveat" section with a pm2 recipe (recipe not exercised).
- **Agent memory** (`lib/agent-memory.ts`): `POST /api/agent` now injects
  the last 8 turns from `agent_log` (user_text + result only, clipped to
  300 chars each; `tool_calls` JSON deliberately excluded) into the system
  prompt. Memory-read failure logs and continues — never blocks a turn.
- **Undo** (`revert_action`, `requiresConfirm: true`): pure inverse-SQL
  mapper in `lib/revert-plan.ts` (add_task, log_gym, log_leetcode,
  log_metric, log_habit, log_meal, add_application, add_to_reading_list;
  everything else refused with a reason — calendar/notes/overwrites have no
  clean inverse). `lib/revert.ts` scans `agent_log` for the newest
  un-reverted executed call, runs the inverse + a marker row in the new
  `reverted_actions` table in one transaction. Verified end-to-end via the
  confirm leg: add → revert (row deleted, marker written) → second revert
  correctly refused; date defaults resolve to the **log row's** date, not
  revert-day.
- **Category budgets**: `category_budgets` table, `GET/PUT
  /api/finance/budgets` (zod: fixed category enum, positive limit, null
  clears), pure math in `lib/finance/budget-math.ts` (≥80% warns, >100%
  over), and 💸 lines in the deterministic morning brief. Verified with a
  seeded July transaction: overage line rendered in `/api/brief`, bad PUT
  rejected 400.
- **Restore** (`npm run restore [-- file] [--yes]`): loads a backup JSON,
  truncates each known table present in it (never `oauth_tokens`), bulk
  inserts in ONE transaction, asks for the literal word "restore" unless
  `--yes`. Note: package.json uses `node scripts/restore.ts` (repo
  convention, Node 24 native TS) rather than tsx. Both backup scripts now
  share `lib/backup-tables.ts` — the old 10-table list was missing 15
  newer tables. Round-trip (backup → restore → identical counts) and the
  abort path verified live.
- **Hybrid search**: `lib/llm.ts` gained `embed(texts)` (always local
  Ollama `/v1/embeddings`, `EMBED_MODEL` default `nomic-embed-text`).
  `search_embeddings` table (float32 BLOBs) + incremental refresh
  (`lib/search-index.ts`, re-embeds only changed text, drops stale rows)
  on a `5,35 * * * *` cron with launch catch-up. `globalSearch` is now
  async: exact LIKE tier first, semantic tier appended after per-source
  dedupe (`lib/search-rank.ts`, cosine ≥ 0.5). Verified degradation live:
  with Ollama down and a populated index, `/api/search` still answers 200
  exact-only.
- **PWA + auth**: minimal no-cache `public/sw.js` + registration component
  (manifest/icons existed since P20); verified registered and active in
  the preview browser. Root `middleware.ts`: when `JARVIS_AUTH_TOKEN` is
  set, every page/API needs `Authorization: Bearer`, the `jarvis_auth`
  cookie, or a one-time `?token=` (sets HttpOnly cookie, 307-redirects to
  strip the URL). sw.js/manifest/icons stay exempt or install breaks.
  Verified all paths live (401 page + JSON 401 API, wrong bearer 401,
  right bearer 200, cookie flow, exemptions). Unset → verified no-op.
  **Gotcha:** the dev server does not hot-reload `JARVIS_AUTH_TOKEN` into
  the middleware worker — restart after changing it.

**Mic button on Ask Jarvis** (same run, follow-up request): the voice
sidecar gained an HTTP mode — `voice/server.py` (FastAPI, **:8018**,
`POST /transcribe` multipart `audio=` → `{"text"}`), reusing the same lazy
`FasterWhisperTranscriber` and decoding browser containers (webm/mp4/wav)
via faster-whisper's own PyAV path; 7 new pytest cases (stubbed
transcriber + decoder) → voice suite now **25 passing**. The app got
`POST /api/transcribe` (proxies to `VOICE_SIDECAR_URL`, default :8018,
zod-validates the sidecar reply, clear 502 "start it:" message when down)
and `components/agent-chat.tsx` grew a 🎤 button: MediaRecorder → upload →
transcript **auto-sends through `send()`** — the same agent tool-calling
path as typing, so spoken commands route to sections exactly like typed
ones (that routing already existed; nothing new was needed there).
Verified live end-to-end with `WHISPER_MODEL=tiny` and a macOS
`say`-synthesized clip: sidecar `{"text": "at a task to buy milk
tomorrow."}` (tiny-model mishearing; default model is much better), proxy
200, garbage bytes → 400/502 with clear detail, sidecar-down → 502 with
the start command. **This box's voice venv is Python 3.11** (3.13 isn't
installed), so `numpy` was re-pinned `2.5.1 → 2.4.6` (2.5.x dropped
py3.11; 2.4.6 works on both boxes). Also removed stray macOS `"* 2.ts"`
duplicate artifacts in `.next/` that broke `tsc`.

Deferred to a live session (needs `ollama pull nomic-embed-text` + a chat
model): a real agent turn exercising conversation memory ("make that high
priority") and "undo that" through the model; a real embedding index build
and a fuzzy search hit; PWA install from a phone over Tailscale with the
token flow on https; the pm2 recipe; a real-microphone click of the 🎤
button in desktop Chrome/Safari (the embedded preview browser hard-denies
`getUserMedia`, so only the API chain below the browser was exercised with
real audio) and a full-size `large-v3-turbo` transcription. DB was left
clean — all verification rows (tasks, transactions, budgets, agent_log,
embeddings) deleted, and the verification backup JSON removed.

# Previous handoff — Phase 19 (2026-07-06, second run; P16–18 notes below)

## Phase 19: GoodNotes sync, system monitor, screen time

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
