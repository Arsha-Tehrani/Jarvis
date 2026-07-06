# Jarvis — Local-First Personal Command Center

Jarvis is a personal dashboard and natural-language agent that runs entirely on your own machine. One Next.js app at `localhost:3000` is both the UI and the backend; a single SQLite file (`jarvis.db`) is the database; a local LLM (Ollama) is the brain. It costs $0 to run, and sensitive data — finances, notes, health logs — never leaves the laptop.

## What Jarvis does

- **Natural-language agent** — type (or speak) "remind me to call the bank Friday" or "I ate two eggs and toast" and the agent calls the right tool. Every tool call is zod-validated before it executes; money/destructive actions require explicit confirmation; every turn is logged.
- **Tasks** — a task list with due dates and priorities, fed by hand or by the agent.
- **Trackers** — gym visits, LeetCode progress (auto-pulled daily), sleep/bedtime/weight/mood, generic habits with streaks and heatmaps, and daily macros.
- **Nutrition / macros** — log a meal by text, through the agent, or by **photo**: a local vision model estimates portions and a JSON-mode extraction produces validated calories/protein/carbs/fat.
- **Goals** — savings rate, gym days per week, LeetCode per week, average sleep, calories per day — each with on-track math on the Goals page and in the morning brief.
- **Finance** — drop bank statement CSVs/PDFs into `/statements`, hit Import: parsing (with account-number redaction), LLM categorization with keyword fallback, recurring-charge detection, a renewal "radar", and a read-only agent tool for questions like "how much did I spend on dining in May?".
- **Stocks & watchlist** — live quotes via Finnhub or Alpha Vantage free tiers, cached to stay inside rate limits; holdings imported from brokerage CSV exports.
- **Net worth** — manual account balances plus market-priced holdings, snapshotted daily into an over-time chart.
- **Google Calendar** — OAuth-connected, read back hourly into a local cache; the agent can create events and phone-notifying reminders. Google stays the single source of truth.
- **Mail triage** — read-only Gmail polling (multi-account) with LLM triage into categories; drafts are created only on explicit click, and nothing can ever send mail.
- **Notes** — read and append to your Obsidian vault straight off disk, with a path-traversal guard.
- **People** — a keep-in-touch list with contact cadences, overdue flags, and upcoming birthdays.
- **Career** — job-application pipeline (wishlist → applied → … → offer) with next actions and follow-up nudges.
- **Reading list** — books, articles, courses, papers, videos with statuses.
- **Global search** — one search box across every local source, no model involved.
- **Slack check-in & morning brief** — a morning DM asking about sleep/gym/LeetCode, and a daily brief of events, tasks, follow-ups, unread mail, and goals at risk.
- **Weekly digest** — Sunday-night life + finance summary appended to your Obsidian vault.
- **Textbook Q&A (RAG sidecar)** — ingest math textbooks (PDF → Markdown → equation-safe chunks → local embeddings) and ask conceptual questions; answers cite sections.
- **Voice bridge (sidecar)** — hold F9, talk, release; local Whisper transcribes and sends the text to the agent exactly as if typed.
- **Backups** — one command exports every table to JSON (OAuth tokens deliberately excluded). Never locked in.

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

Everything below runs from `npm run dev`. The sidecars are standalone Python services with their own venvs that talk to the app and Ollama over HTTP — nothing Python is in the Next.js build.

## Getting started

```bash
npm install
npm run dev        # starts the app AND the in-process cron worker
```

Configure `.env.local` (all optional except the LLM if you want the agent):

| Variable | Purpose |
|---|---|
| `LLM_PROVIDER` | `ollama` (default) or `anthropic` |
| `LLM_BASE_URL` | Ollama OpenAI-compatible endpoint (default `http://localhost:11434/v1`) |
| `LLM_MODEL` | chat model name |
| `ANTHROPIC_API_KEY` | only if `LLM_PROVIDER=anthropic` |
| `FINNHUB_API_KEY` / `ALPHAVANTAGE_API_KEY` | stock quotes |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Calendar + Gmail OAuth |
| `LEETCODE_USERNAME` | daily LeetCode auto-pull |
| `OBSIDIAN_VAULT_PATH` | notes + weekly digest |
| `SLACK_BOT_TOKEN` / `SLACK_USER_ID` / `SLACK_SIGNING_SECRET` | check-in, brief |
| `TEXTBOOK_RAG_URL` | textbook sidecar (default `http://localhost:8016`) |

Other commands: `npm run build`, `npm run typecheck`, `npm test` (node test runner), `npm run backup`.

---

## How each piece works

### The agent

`POST /api/agent { text }` is one agent turn. The route builds a system prompt with today's date, calls `lib/llm.ts` `chat()` with the full tool registry from `lib/tools.ts`, and then processes each tool call the model returns under three hard rules:

1. **Validate before execute.** Arguments are parsed against the tool's zod schema; anything unknown or invalid is refused with a clear error instead of guessed at.
2. **Confirm money/destructive actions.** Tools flagged `requiresConfirm` (e.g. `set_goal`) are not executed — the route returns a *pending confirmation* payload showing exactly what would run. The UI displays it; `POST /api/agent { confirmedCalls, originalText }` re-validates and executes only on your confirm.
3. **Everything logs.** Every turn — user text, tool calls as JSON, result — is written to the `agent_log` table.

Current tools: `add_task`, `log_gym`, `log_leetcode`, `set_goal`, `append_note`, `create_calendar_event`, `set_reminder`, `log_metric`, `log_habit`, `add_application`, `advance_application`, `add_to_reading_list`, `log_contact`, `query_finance`, `log_meal`, `ask_textbook`.

### LLM abstraction

`lib/llm.ts` exports one function, `chat({ messages, tools })`, and routes by `LLM_PROVIDER`: Ollama's OpenAI-compatible `/v1/chat/completions` by default, or the Anthropic API if configured. Callers never know which provider ran, so moving to a hosted model later is a config change, not a refactor.

### Scheduling: cron + catch-up-on-launch

`lib/cron.ts` runs an in-process `node-cron` scheduler. Every job also fires **once at startup**, so if the laptop was asleep past a scheduled time the gap self-heals on next launch. Jobs:

| Job | Schedule |
|---|---|
| LeetCode daily pull | 08:00 daily |
| Slack morning brief | 08:00 daily |
| Slack morning check-in | 08:30 daily |
| Stocks refresh | every 15 min |
| Calendar poll | hourly |
| Net-worth snapshot | 18:00 daily |
| Mail poll | every 30 min |
| Weekly digest | Sunday 21:00 |

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

### Global search

`lib/search.ts` runs deterministic `LIKE` matching across every local source — tasks, transactions, notes, people, and more — grouped by source with each hit linking to its page. No model involved, so it's instant and exact.

### Slack check-in & morning brief

- **Check-in** (08:30): an outbound DM asks the enabled questions — sleep time, gym yes/no, LeetCode yes/no/count — idempotent per day. Replies are handled by deterministic parsers first, LLM only as fallback, and every answer writes through the *existing agent tool handlers* — one code path per tracker. (Inbound replies need a tunnel; the outbound DM works with just a bot token.)
- **Morning brief** (08:00): today's events, top tasks, overdue career follow-ups, important-unread mail count, and any goal/streak at risk. The brief is assembled deterministically; the LLM only rephrases it, with the plain rendering as the always-working fallback.

### Weekly digest

Sunday 21:00 (with launch catch-up and per-week idempotency): last week's spend by category with deltas vs. the prior week, goal/streak summary, portfolio move, and the upcoming week — assembled deterministically, prose written by the LLM, and if no model is running the structured markdown itself is appended to the vault. The digest never silently skips a week once the vault is configured.

### Textbook RAG sidecar (`sidecars/textbook-rag`, :8016)

Local study Q&A over your own math textbooks:

1. **Ingest**: `python -m rag.ingest book.pdf` converts PDF → Markdown (Marker when installed — it preserves LaTeX; MarkItDown as the light fallback, which loses equations rendered as images), then chunks with an **equation-safe splitter**: `$$…$$`, `\[…\]`, `\begin{env}…\end{env}`, and code fences are unsplittable, so a theorem, its proof, and its equations always travel together.
2. **Store**: chunks embed via Ollama `nomic-embed-text` into a persistent ChromaDB keyed `source::index` — re-ingesting a book replaces rather than duplicates, and shrinking re-ingests drop stale chunks.
3. **Ask**: `POST /ask {"question", "top_k"}` retrieves top-k chunks and has the primary Ollama model answer with numbered section citations. The app exposes this as the read-only `ask_textbook` agent tool, so "explain Green's theorem" in the chat box goes through your actual books.

### Voice bridge sidecar (`sidecars/voice`)

`python -m voice.push_to_talk`: hold **F9** (configurable via `PTT_KEY`) to record 16 kHz mono audio, release to transcribe with **faster-whisper `large-v3-turbo`**, then POST the transcript to `/api/agent` exactly as the chat box does — printing the transcript and the agent's reply, including pending-confirmation notices. The compute path is a pure, unit-tested decision matrix over probed hardware: NVIDIA → CUDA fp16; AMD → CPU int8 with an explicit log that faster-whisper has no clean native AMD GPU path; Apple Silicon → CPU int8; everything overridable with `WHISPER_DEVICE` / `WHISPER_COMPUTE` / `WHISPER_MODEL`.

### Backup

`npm run backup` exports every table to one JSON object — with `oauth_tokens` deliberately excluded so backups are storable without leaking live Google credentials. Your data is a plain SQLite file plus JSON exports; you are never locked in.

### Data model & privacy

All state lives in `jarvis.db` (better-sqlite3, migrations run idempotently on startup in `lib/db.ts`). Secrets stay in server-side env vars or the `oauth_tokens` table and never reach a client component. `.env*`, `jarvis.db`, `/statements`, and the vault path are gitignored. The only network calls are the ones you configure: your chosen LLM endpoint, quote APIs, Google OAuth, Slack, and the unofficial LeetCode API — finances, notes, health, and mail content are processed locally.

## Testing

`npm test` runs the node test suite (finance query building, brokerage/Slack/mail parsing, nutrition schema). Each sidecar has its own pytest suite run from its venv (`.venv/bin/python -m pytest`), with all model, mic, and network calls stubbed. See [HANDOFF.md](HANDOFF.md) for the live-model tests still deferred and current known limitations.
