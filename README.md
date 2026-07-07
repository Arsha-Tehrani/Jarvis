# Jarvis — Local-First Personal Command Center

Jarvis is a personal dashboard and natural-language agent that runs entirely on your own machine. One Next.js app at `localhost:3000` is both the UI and the backend; a single SQLite file (`jarvis.db`) is the database; a local LLM (Ollama) is the brain. It costs $0 to run, and sensitive data — finances, notes, health logs — never leaves the laptop.

![Jarvis Today View](./public/demo.gif)

## Quickstart

```bash
npm install
npm run dev        # starts the app AND the in-process cron worker
```

Open `http://localhost:3000`. With no configuration you get tasks, trackers, notes-free features, and the dashboard; add a local Ollama model for the agent, and API keys per feature as you need them (see [Configuration](#configuration)).

Other commands: `npm run build`, `npm run typecheck`, `npm test` (node test runner), `npm run backup`, `npm run restore`.

## Table of contents

- [What Jarvis does](#what-jarvis-does)
  - [Agent](#agent)
  - [Life tracking](#life-tracking)
  - [Money](#money)
  - [Knowledge](#knowledge)
  - [System & automation](#system--automation)
- [Architecture at a glance](#architecture-at-a-glance)
- [Configuration](#configuration)
- [How each piece works](#how-each-piece-works)
- [Scheduler caveat](#scheduler-caveat)
- [Testing](#testing)

## What Jarvis does

### Agent

- **Natural-language agent** — type (or speak) "remind me to call the bank Friday" or "I ate two eggs and toast" and the agent calls the right tool. Every tool call is zod-validated before it executes; money/destructive actions require explicit confirmation; every turn is logged.
- **Conversation memory** — each turn sees a rolling window of the recent conversation (from the `agent_log` table), so "make that high priority" works without re-explaining what "that" is.
- **Undo** — "undo that" invokes the `revert_action` tool, which maps a logged action (added task, logged workout, logged meal, …) to its inverse database operation and asks for confirmation before running it.
- **Voice input** — two paths, one local Whisper model: a 🎤 button on the Ask Jarvis card records in the browser and auto-sends the transcript through the agent, and a push-to-talk sidecar (hold F9, talk, release) does the same from anywhere on the desktop. Either way, "remind me to call the bank Friday" spoken aloud is routed by the agent to the right section, exactly like typing it.

### Life tracking

- **Tasks** — a task list with due dates and priorities, fed by hand or by the agent.
- **Trackers** — gym visits, LeetCode progress (auto-pulled daily), sleep/bedtime/weight/mood, generic habits with streaks and heatmaps, and daily macros.
- **Nutrition / macros** — log a meal by text, through the agent, or by **photo**: a local vision model estimates portions and a JSON-mode extraction produces validated calories/protein/carbs/fat.
- **Goals** — savings rate, gym days per week, LeetCode per week, average sleep, calories per day — each with on-track math on the Goals page and in the morning brief.
- **Google Calendar** — OAuth-connected, read back hourly into a local cache; the agent can create events and phone-notifying reminders. Google stays the single source of truth.
- **People** — a keep-in-touch list with contact cadences, overdue flags, and upcoming birthdays.
- **Career** — job-application pipeline (wishlist → applied → … → offer) with next actions and follow-up nudges.

### Money

- **Finance** — drop bank statement CSVs/PDFs into `/statements`, hit Import: parsing (with account-number redaction), LLM categorization with keyword fallback, recurring-charge detection, a renewal "radar", and a read-only agent tool for questions like "how much did I spend on dining in May?".
- **Category budgets** — set a monthly limit per spending category; month-to-date spend is checked against it deterministically and overages surface in the morning brief.
- **Stocks & watchlist** — live quotes via Finnhub or Alpha Vantage free tiers, cached to stay inside rate limits; holdings imported from brokerage CSV exports.
- **Net worth** — manual account balances plus market-priced holdings, snapshotted daily into an over-time chart.

### Knowledge

- **Notes** — read and append to your Obsidian vault straight off disk, with a path-traversal guard.
- **Reading list** — books, articles, courses, papers, videos with statuses.
- **Global search** — one search box across every local source. Exact `LIKE` matching answers first; a local embedding index (Ollama `nomic-embed-text`) catches fuzzy queries the exact match misses. No cloud calls.
- **Textbook Q&A (RAG sidecar)** — ingest math textbooks (PDF → Markdown → equation-safe chunks → local embeddings) and ask conceptual questions; answers cite sections.
- **GoodNotes ingestion** — handwritten notes that GoodNotes backs up to Google Drive are pulled down hourly and fed into the same RAG store, so `ask_textbook` searches your own notes too.

### System & automation

- **Mail triage** — read-only Gmail polling (multi-account) with LLM triage into categories; drafts are created only on explicit click, and nothing can ever send mail.
- **Slack check-in & morning brief** — a morning DM asking about sleep/gym/LeetCode, and a daily brief of events, tasks, follow-ups, unread mail, budget overages, and goals at risk.
- **Weekly digest** — Sunday-night life + finance summary appended to your Obsidian vault.
- **System monitor** — a live dashboard card with CPU load, memory, and disk usage for the machine Jarvis is running on.
- **Screen time** — total active time today and top apps/sites, read from a local ActivityWatch instance.
- **PWA & remote access** — installable on a phone (manifest + service worker), with optional bearer-token auth (`JARVIS_AUTH_TOKEN`) so the app can be served over Tailscale or a local mesh without being wide open.
- **Backups & restore** — one command exports every table to JSON (OAuth tokens deliberately excluded); a matching restore command loads an export back into `jarvis.db`. Never locked in.

## Architecture at a glance

```
Next.js app (localhost:3000)          Python sidecars (optional)
├─ UI: dashboard pages                ├─ textbook-rag  :8016  (PDF → RAG → cited answers)
├─ API routes under /app/api          ├─ macro         :8017  (food photo/text → macros)
├─ lib/db.ts      SQLite (jarvis.db)  └─ voice          —     (push-to-talk → /api/agent)
├─ lib/llm.ts     Ollama | Anthropic
├─ lib/tools.ts   agent tool registry          Ollama (localhost:11434)
└─ lib/cron.ts    scheduler + catch-up         └─ chat, vision, embedding models
```

Everything runs from `npm run dev`. The sidecars are standalone Python services with their own venvs that talk to the app and Ollama over HTTP — nothing Python is in the Next.js build.

## Configuration

Configure `.env.local` (all optional except the LLM if you want the agent):

| Variable | Purpose |
|---|---|
| `LLM_PROVIDER` | `ollama` (default) or `anthropic` |
| `LLM_BASE_URL` | Ollama OpenAI-compatible endpoint (default `http://localhost:11434/v1`) |
| `LLM_MODEL` | chat model name |
| `EMBED_MODEL` | embedding model for semantic search (default `nomic-embed-text`) |
| `ANTHROPIC_API_KEY` | only if `LLM_PROVIDER=anthropic` |
| `FINNHUB_API_KEY` / `ALPHAVANTAGE_API_KEY` | stock quotes |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Calendar + Gmail OAuth |
| `LEETCODE_USERNAME` | daily LeetCode auto-pull |
| `OBSIDIAN_VAULT_PATH` | notes + weekly digest |
| `SLACK_BOT_TOKEN` / `SLACK_USER_ID` / `SLACK_SIGNING_SECRET` | check-in, brief |
| `TEXTBOOK_RAG_URL` | textbook sidecar (default `http://localhost:8016`) |
| `GOODNOTES_DRIVE_FOLDER` | Drive folder GoodNotes backs up to (default `GoodNotes Backup`) |
| `AW_BASE_URL` | ActivityWatch API (default `http://localhost:5600`) |
| `VOICE_SIDECAR_URL` | voice transcription server for the mic button (default `http://localhost:8018`) |
| `JARVIS_AUTH_TOKEN` | if set, every page/API request must present this bearer token |

---

## How each piece works

### The agent

`POST /api/agent { text }` is one agent turn. The route builds a system prompt with today's date plus a compact transcript of the last few turns (pulled from `agent_log`, large tool-call JSON excluded), calls `lib/llm.ts` `chat()` with the full tool registry from `lib/tools.ts`, and then processes each tool call the model returns under three hard rules:

1. **Validate before execute.** Arguments are parsed against the tool's zod schema; anything unknown or invalid is refused with a clear error instead of guessed at.
2. **Confirm money/destructive actions.** Tools flagged `requiresConfirm` (e.g. `set_goal`, `revert_action`) are not executed — the route returns a *pending confirmation* payload showing exactly what would run. The UI displays it; `POST /api/agent { confirmedCalls, originalText }` re-validates and executes only on your confirm.
3. **Everything logs.** Every turn — user text, tool calls as JSON, result — is written to the `agent_log` table.

Current tools: `add_task`, `log_gym`, `log_leetcode`, `set_goal`, `append_note`, `create_calendar_event`, `set_reminder`, `log_metric`, `log_habit`, `add_application`, `advance_application`, `add_to_reading_list`, `log_contact`, `query_finance`, `log_meal`, `ask_textbook`, `revert_action`.

**Undo** (`revert_action`): because every executed tool call is logged with its validated arguments, a deterministic mapper (`lib/revert-plan.ts`) translates a logged action into its inverse SQL — `add_task` → delete that task, `log_gym` → delete that day's row, `log_meal` → delete that meal, and so on. Only cleanly invertible tools are revertible; anything else (calendar events, notes appends, stage changes that lose prior state) is refused with an explanation. Reverts are tracked in a `reverted_actions` table so the same action can't be undone twice, and the tool always requires confirmation.

### LLM abstraction

`lib/llm.ts` exports `chat({ messages, tools })` and routes by `LLM_PROVIDER`: Ollama's OpenAI-compatible `/v1/chat/completions` by default, or the Anthropic API if configured. Callers never know which provider ran, so moving to a hosted model later is a config change, not a refactor. It also exports `embed(texts)` for the semantic search index, which always talks to the local Ollama embeddings endpoint (`EMBED_MODEL`, default `nomic-embed-text`) — Anthropic has no embeddings API, and embeddings of personal data should stay local anyway.

### Scheduling: cron + catch-up-on-launch

`lib/cron.ts` runs an in-process `node-cron` scheduler. Every job also fires **once at startup**, so if the laptop was asleep past a scheduled time the gap self-heals on next launch. Jobs:

| Job | Schedule |
|---|---|
| LeetCode daily pull | 08:00 daily |
| Slack morning brief | 08:00 daily |
| Slack morning check-in | 08:30 daily |
| Stocks refresh | every 15 min |
| Calendar poll | hourly |
| GoodNotes → RAG sync | hourly (:15) |
| Search embedding index refresh | every 30 min (:05/:35) |
| Net-worth snapshot | 18:00 daily |
| Mail poll | every 30 min |
| Weekly digest | Sunday 21:00 |

See the [Scheduler caveat](#scheduler-caveat) below — the scheduler only runs while the app process runs.

### Tasks

A plain task table (`title`, `due_at`, `priority`, `status`, `source`) surfaced on the Tasks page and the Today view. Tasks arrive from the UI or from the agent's `add_task` tool; the agent resolves relative dates ("Friday") to concrete ISO dates itself.

### Trackers: gym, LeetCode, health, habits

- **Gym** — one row per visit (`gym_logs`), logged from the UI, the agent (`log_gym`), the Slack check-in, or voice.
- **LeetCode** — a daily cron hits the unofficial `leetcode.com/graphql` API for total solved, streak, and recent problems. Unofficial APIs break, so every caller treats failure as normal: log it, keep the last stored row, and the manual-entry fallback (`log_leetcode`) always works.
- **Health** — `log_metric` upserts one value per date+kind: `sleep_hours` (0–16), `bedtime` (decimal hour, 23.5 = 11:30pm), `weight` (your unit as-is), `mood` (1–5). Values are range-validated by a zod discriminated union before they land.
- **Habits** — user-defined habits with `daily` cadence (consecutive-day streak) or `weekly` cadence (this week's count vs. a per-week goal), rendered as a GitHub-style heatmap over the last ~53 weeks. `log_habit` fails with the list of known habits if the name doesn't match, so the model can self-correct.

### Nutrition / macros

Three ways in, one validated table (`nutrition_logs`):

1. **Agent text** — "I ate two eggs and toast" → the `log_meal` tool, with the model estimating sensible integer macros.
2. **Macro sidecar text** — `POST :8017/nutrition {"text": ...}` runs the primary Ollama model in **JSON mode** under a strict system prompt.
3. **Macro sidecar photo** — multipart `image=` goes through a local Ollama **vision model** that describes items and portions, then the same JSON-mode extraction.

Either sidecar path must validate as `{item, calories, protein, carbs, fat}` against a pydantic gate — one repair pass showing the model its own error, then a hard 422 reject. Unvalidated output never touches the database. Validated items POST to the app's zod-validated `/api/nutrition`. Honest by design: photo estimates are labeled as rough approximations (portions guessed from one 2D image) in both the UI and API; the text path is more accurate. The Trackers page shows a "Macros today" card with totals vs. goal, a per-item list, a photo-approximation badge, and per-item remove.

### Goals

The `goals` table holds `(kind, target, period)`; `lib/goals-progress.ts` computes actuals per kind: `savings_rate`, `gym_days_per_week`, `leetcode_per_week`, `sleep_hours` (rolling average), and `calories_per_day` — the one goal where **lower is better** (a ceiling, not a floor). Setting a goal through the agent requires confirmation. Progress rings appear on the Goals page, and at-risk weekly goals feed the morning brief: a weekly count goal is "at risk" when the remaining need exceeds the days left in the week.

### Finance

Drop CSV or PDF bank statements into the gitignored `/statements` folder and hit Import:

1. **Ingest** (`lib/finance/ingest.ts`) scans for files not yet in the `statements` table, parses them (redacting account numbers), and stores transactions. Everything stays on this machine.
2. **Categorization** (`categorize.ts`) is LLM-first — only merchant/amount lines are sent, never full statements — with keyword rules as the always-working fallback so import succeeds even with no model running. Fifteen fixed categories (Income, Rent, Groceries, Dining, …).
3. **Recurring radar** (`radar.ts`) is fully deterministic (dates + amounts, no LLM): it estimates each subscription's next renewal from its median gap and flags "renews in ~N days" (≤14) and "amount jumped >10% vs. usual".
4. **Brokerage CSVs** — Fidelity has no free personal API, so holdings come in the same way: a positions/history CSV in `/statements` is shape-detected and upserted by ticker (never deleted, so a second account's export can't clobber manual holdings). Account-number columns are never persisted.
5. **Agent queries** — the read-only `query_finance` tool answers spend/earn questions filtered by category, merchant text, month, or date range, returning a total plus a small category breakdown.

### Category budgets

The `category_budgets` table maps each of the 15 fixed transaction categories to an optional monthly limit (`GET`/`PUT /api/finance/budgets`, zod-validated). `lib/finance/budgets.ts` computes month-to-date spend per category and compares it to the limit with plain arithmetic — no LLM anywhere. Categories at ≥80% of budget warn, categories over budget flag an overage, and both lines feed the deterministic part of the Slack morning brief.

### Stocks & watchlist

Quotes come from Finnhub (preferred, 60 req/min free) or Alpha Vantage (fallback, ~25 req/day free). A 15-minute in-memory cache plus the 15-minute cron re-warm keep usage far inside both free tiers. No API key means a clear error state in the UI, never a crash.

### Net worth

Net worth = manual account balances (`accounts`, where `debt` subtracts) + holdings value. Holdings use the cached market quote when warm and fall back to cost basis — stated in the UI as a valuation proxy, not a promise. The daily 18:00 snapshot (plus launch catch-up) builds the over-time chart on the Net Worth page.

### Google Calendar & reminders

OAuth tokens live server-side in the `oauth_tokens` table — never in the browser. **Google is the single source of truth**: Jarvis polls (on page open and hourly) and reads events into `calendar_cache`; it never maintains a second mutable calendar or reconciles bidirectionally. The agent's `create_calendar_event` writes real events and `set_reminder` creates a short event so your phone notifies you. Testing-mode OAuth refresh tokens expire ~weekly; refresh failure surfaces a "reconnect" prompt rather than crashing.

### Mail triage

Gmail is polled read-only every 30 minutes, mirroring the Calendar OAuth pattern (CSRF state cookie, server-side tokens, auto-refresh). Multi-account: one `oauth_tokens` row per inbox plus a `mail_accounts` registry, every message tagged with its inbox. A deterministic pre-filter categorizes the obvious stuff before the LLM triages the rest. Scopes are `gmail.readonly` plus `gmail.compose` **only** to create drafts — drafts are created only on an explicit click, and nothing in the codebase can send mail.

### Notes (Obsidian)

`lib/notes.ts` reads and appends to your vault directly on disk via `OBSIDIAN_VAULT_PATH`. Every user-supplied note path is resolved and must stay inside the vault (path-traversal guard); `.obsidian`, `.trash`, `.git` are skipped. The agent's `append_note` defaults to today's daily note. Unconfigured vault → clear error state, never a crash.

### People (keep-in-touch)

Each person can have a contact cadence in days and a birthday. The People page computes who's overdue (days since `last_contacted` beyond cadence) and birthdays in the next 30 days. The agent's `log_contact` records a catch-up and, like `log_habit`, fails with the known-people list on a name mismatch.

### Career

Applications move through fixed stages (`wishlist → applied → screening → interview → offer / rejected / accepted`) with optional next action, contact, and link. The agent tracks new applications (`add_application`) and stage changes (`advance_application`); overdue follow-ups feed the morning brief.

### Reading list

Items of kind `book | article | course | paper | video` with statuses `queued | reading | done | abandoned`, sorted reading-first. Added from the UI or the agent (`add_to_reading_list`).

### Global search (hybrid)

`lib/search.ts` runs in two tiers:

1. **Exact tier** — deterministic `LIKE` matching across every local source — tasks, transactions, mail, notes, people, and more — grouped by source with each hit linking to its page. Instant, exact, and works with nothing else running.
2. **Semantic tier** — a local embedding index (`search_embeddings` table, vectors from Ollama `nomic-embed-text` via `lib/llm.ts embed()`) over tasks, note titles, and mail subjects. Cosine similarity catches fuzzy queries ("that email about the flight" when the subject says "itinerary"). Results the exact tier already found are not duplicated; fuzzy hits are appended per source.

The index refreshes on a 30-minute cron (plus launch catch-up) and only re-embeds rows whose text changed. If Ollama or the embedding model is down, search silently degrades to the exact tier — semantic is garnish, never a dependency.

### Slack check-in & morning brief

- **Check-in** (08:30): an outbound DM asks the enabled questions — sleep time, gym yes/no, LeetCode yes/no/count — idempotent per day. Replies are handled by deterministic parsers first, LLM only as fallback, and every answer writes through the *existing agent tool handlers* — one code path per tracker. (Inbound replies need a tunnel; the outbound DM works with just a bot token.)
- **Morning brief** (08:00): today's events, top tasks, overdue career follow-ups, important-unread mail count, category-budget warnings, and any goal/streak at risk. The brief is assembled deterministically; the LLM only rephrases it, with the plain rendering as the always-working fallback.

### Weekly digest

Sunday 21:00 (with launch catch-up and per-week idempotency): last week's spend by category with deltas vs. the prior week, goal/streak summary, portfolio move, and the upcoming week — assembled deterministically, prose written by the LLM, and if no model is running the structured markdown itself is appended to the vault. The digest never silently skips a week once the vault is configured.

### Textbook RAG sidecar (`sidecars/textbook-rag`, :8016)

Local study Q&A over your own math textbooks:

1. **Ingest**: `python -m rag.ingest book.pdf` converts PDF → Markdown (Marker when installed — it preserves LaTeX; MarkItDown as the light fallback, which loses equations rendered as images), then chunks with an **equation-safe splitter**: `$$…$$`, `\[…\]`, `\begin{env}…\end{env}`, and code fences are unsplittable, so a theorem, its proof, and its equations always travel together.
2. **Store**: chunks embed via Ollama `nomic-embed-text` into a persistent ChromaDB keyed `source::index` — re-ingesting a book replaces rather than duplicates, and shrinking re-ingests drop stale chunks.
3. **Ask**: `POST /ask {"question", "top_k"}` retrieves top-k chunks and has the primary Ollama model answer with numbered section citations. The app exposes this as the read-only `ask_textbook` agent tool, so "explain Green's theorem" in the chat box goes through your actual books.

Besides the CLI, the sidecar accepts `POST /ingest {"path"}` for a local file — same pipeline, same idempotent upsert. That's the endpoint the GoodNotes sync (below) feeds, and it works because the app and sidecar share a filesystem.

### GoodNotes ingestion (Drive → RAG)

GoodNotes auto-backs-up notebooks as PDFs to a Google Drive folder. `lib/goodnotes.ts` polls that folder hourly (offset to :15, plus launch catch-up):

1. **Find & diff** — locates the folder by name (`GOODNOTES_DRIVE_FOLDER`, default "GoodNotes Backup") using the same server-side OAuth tokens as Calendar, and compares each PDF's Drive `modifiedTime` against the `goodnotes_sync_state` table, so only new or edited notebooks are touched.
2. **Download** — changed PDFs land in the gitignored `/temp_notes` directory.
3. **Ingest** — each path is handed to the RAG sidecar's `POST /ingest`; because chunks are keyed by source, a re-exported notebook replaces its old chunks instead of duplicating them.

Sync state is written only after a successful ingest — if the sidecar or Ollama is down, the file simply retries next hour. Requires the `drive.readonly` scope, which was added to the Google OAuth consent: existing connections need a one-time reconnect from the Calendar tab (surfaced as a clear error, not a crash).

### System monitor

`GET /api/system` probes the host with the `systeminformation` package — CPU load and core count, memory used vs. total ("active" memory, matching what Activity Monitor/Task Manager report), and the OS disk (mount `/` on macOS, `C:` on Windows). The `<SystemMonitor />` client card polls it every 8 seconds with progress bars (red past 90%), clears its interval on unmount, and degrades to a quiet "stats unavailable" if the probe fails. Cross-platform by construction — the same code runs on the M3 MacBook and the Windows box.

### Screen time (ActivityWatch)

[ActivityWatch](https://activitywatch.net) tracks window and browser activity locally on `:5600`. `lib/activitywatch.ts` reads three bucket types since local midnight: the AFK watcher for **total active time** (sum of `not-afk` spans, falling back to window-focus time if no AFK watcher runs), the window watcher aggregated by app, and the web watcher aggregated by domain (www-stripped). The aggregation is pure and unit-tested. `GET /api/activity` proxies it and always answers 200 with an `available` flag — ActivityWatch not running is a normal state, and the `<ScreenTime />` card (refreshes every 60s) just shows a hint instead of an error.

### Voice input (`sidecars/voice`)

Two entry points share one lazily-loaded local **faster-whisper `large-v3-turbo`** model:

- **Mic button** — the 🎤 on the Ask Jarvis card records with the browser's MediaRecorder, POSTs the clip to `/api/transcribe`, which proxies it to the sidecar's HTTP server (`python -m voice.server`, `:8018`, `POST /transcribe`). The transcript is auto-sent through the agent — same routing as typing. Sidecar down, mic denied, or undecodable audio all surface as clear chat errors, never crashes.
- **Push-to-talk** — `python -m voice.push_to_talk`: hold **F9** (configurable via `PTT_KEY`) to record 16 kHz mono audio, release to transcribe, then POST the transcript to `/api/agent` exactly as the chat box does — printing the transcript and the agent's reply, including pending-confirmation notices. The compute path is a pure, unit-tested decision matrix over probed hardware: NVIDIA → CUDA fp16; AMD → CPU int8 with an explicit log that faster-whisper has no clean native AMD GPU path; Apple Silicon → CPU int8; everything overridable with `WHISPER_DEVICE` / `WHISPER_COMPUTE` / `WHISPER_MODEL`.

### PWA & remote access

- **Installable** — `app/manifest.ts` serves the web-app manifest (icons in `public/icons`) and `public/sw.js` is a minimal service worker (network-first, no aggressive caching of API responses — the data is live and local). On a phone, "Add to Home Screen" gives a standalone full-screen app.
- **Bearer-token auth** — set `JARVIS_AUTH_TOKEN` and `middleware.ts` requires every page and API request to present it: `Authorization: Bearer <token>` for API clients, or open `https://your-host/?token=<token>` once in a browser and a cookie keeps the session. Unset, the middleware is a no-op and localhost behaves exactly as before. This is what makes serving Jarvis over a Tailscale funnel or LAN reasonable — it is *not* internet-grade multi-user auth.

### Backup & restore

- `npm run backup` exports every table to one JSON file in `/backups` — with `oauth_tokens` deliberately excluded so backups are storable without leaking live Google credentials.
- `npm run restore` loads an export back: `npm run restore -- backups/jarvis-backup-<stamp>.json` (or with no argument, the newest file in `/backups`). It truncates each table present in the JSON (never `oauth_tokens`) and bulk-inserts the rows inside a single transaction — either the whole restore lands or none of it does. Your data is a plain SQLite file plus JSON exports; you are never locked in.

### Data model & privacy

All state lives in `jarvis.db` (better-sqlite3, migrations run idempotently on startup in `lib/db.ts`). Secrets stay in server-side env vars or the `oauth_tokens` table and never reach a client component. `.env*`, `jarvis.db`, `/statements`, and the vault path are gitignored. The only network calls are the ones you configure: your chosen LLM endpoint, quote APIs, Google OAuth, Slack, and the unofficial LeetCode API — finances, notes, health, and mail content are processed locally.

## Scheduler caveat

The `node-cron` scheduler lives **in the Next.js process** — when `npm run dev` (or `npm start`) stops, every scheduled job stops with it. Catch-up-on-launch heals the gaps for daily/weekly jobs the next time you start the app, but nothing runs while it's down. If you want the briefs, polls, and snapshots to fire without a terminal open, keep the app alive under a process manager:

```bash
npm install -g pm2
npm run build
pm2 start npm --name jarvis -- start   # runs `next start` on :3000
pm2 save && pm2 startup                # restart on reboot (follow the printed command)

pm2 logs jarvis                        # tail the cron/job logs
pm2 restart jarvis                     # after pulling changes + rebuild
```

`pm2` restarts the process if it crashes and brings it back after a reboot, which is all the "server" this project needs — it's still one local process on your own machine.

## Testing

`npm test` runs the node test suite; each Python sidecar has its own pytest suite run from its venv (`.venv/bin/python -m pytest`), with all model, mic, and network calls stubbed.

The testing philosophy follows the architecture's deterministic-first rule:

- **Deterministic logic gets real unit tests.** Anything that computes without a model — finance query building, brokerage/Slack/mail parsing, nutrition schema validation, ActivityWatch aggregation, the revert-action inverse mapper, budget overage math, semantic-search ranking/merging — lives in pure modules with no database or network imports, and is tested directly with `node --test` over exact inputs and expected outputs. If a parser or mapper is wrong, a test fails; we never rely on an LLM behaving well to make these paths correct.
- **LLM calls are never tested live — their fallbacks are.** Every LLM integration point (categorization, triage, brief phrasing, semantic search) is written as *deterministic result first, model as garnish*, so tests exercise the fallback path explicitly: categorization falls back to keyword rules, the brief falls back to its plain rendering, hybrid search falls back to `LIKE`. What gets asserted is that the system produces a correct, useful answer **with no model running at all**.
- **Model output is validated, not trusted.** Where a model's output does enter the system (tool-call args, JSON-mode extraction), the tests target the validation gate — zod/pydantic schemas reject malformed payloads — rather than the model itself. The contract under test is "unvalidated output never executes", which holds regardless of which model is behind `lib/llm.ts`.
- **Sidecar suites stub the world.** The RAG, macro, and voice pytest suites fake Ollama, the microphone, and the Jarvis HTTP endpoint, so they run green on a machine with no GPU and no models pulled. Live-model verification passes are tracked separately in [HANDOFF.md](HANDOFF.md).
