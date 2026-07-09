# Jarvis — Local-First Personal Command Center

Jarvis is a personal dashboard and natural-language agent that runs entirely on your own machine. One Next.js app at `localhost:3000` is both the UI and the backend; a single SQLite file (`jarvis.db`) is the database; a local LLM (Ollama) is the brain. It costs $0 to run, and sensitive data — finances, notes, health logs — never leaves the laptop.

![Jarvis Today View](./public/demo.gif)

## Quickstart

```bash
npm install
npm run dev        # starts the app AND the in-process cron worker
```

Open `http://localhost:3000`. With no configuration you get tasks, trackers, notes-free features, and the dashboard; add a local Ollama model for the agent, and API keys per feature as you need them (see [Configuration](#configuration)).

Other commands: `npm run build`, `npm run typecheck`, `npm test` (node test runner), `npm run backup`, `npm run restore`, and `npm run doctor` — a one-shot pre-flight report that checks Ollama and the configured models are pulled, sidecar venvs exist, and paths/keys point at real things (exit code 0 unless something *configured* is broken, so it works as a CI gate).

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
- **Trackers** — gym visits, LeetCode progress (auto-pulled daily), sleep/bedtime/weight/mood, user-defined habits with streaks and heatmaps, and daily macros — one page that visualizes everything you track.
- **Nutrition / macros** — log a meal by text, through the agent, or by **photo**: a local vision model estimates portions and a JSON-mode extraction produces validated calories/protein/carbs/fat.
- **Goals are just Tracker targets** — savings rate, gym days/week, LeetCode/week, average sleep, calories/day are targets attached to Trackers (progress rings, computed from real data), not a separate static list. Setting one still requires confirmation, and at-risk targets feed the morning brief.
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
- **System status** — the `/status` page probes every optional integration (Ollama, sidecars, ActivityWatch, vault, Google Calendar/Gmail/Drive, Slack, LeetCode, quote APIs) and shows ok / degraded / down / not-configured per check; a compact "10/12 healthy" card sits on the Today view. Backed by `GET /api/status` with a ~20s server-side cache.
- **Network audit log** — the `/network-log` page lists every outbound network call Jarvis has made: destination host, which feature triggered it, outcome, and latency — **never** request contents, URLs, or headers. Calls to localhost (Ollama, sidecars) don't leave the machine and aren't logged. This makes "sensitive data never leaves the laptop except calls you configured" provable rather than asserted.
- **System monitor** — a live dashboard card with CPU load, memory, and disk usage for the machine Jarvis is running on.
- **Screen time** — total active time today and top apps/sites, read from a local ActivityWatch instance.
- **PWA & remote access** — installable on a phone (manifest + service worker), with optional bearer-token auth (`JARVIS_AUTH_TOKEN`) so the app can be served over Tailscale or a local mesh without being wide open.
- **Device sync (optional)** — run Jarvis on two machines and keep the derived tracker tables (tasks, gym, unified habits/trackers, LeetCode stats, net-worth snapshots) in sync through one always-on "host" over Tailscale. Strictly allowlist-based: finance transactions, mail, notes, and OAuth tokens never leave the machine they live on, by construction.
- **Sidecar setup & start/stop** — the `/status` page has Set up / Start / Stop buttons and a live log panel for the macro and textbook-RAG sidecars; "Set up" creates the venv and installs requirements right from the browser, so a from-scratch install or a missing-dependency crash is recoverable with no terminal at all. ActivityWatch gets the same card with best-effort launch/quit (it's a third-party tray app — Jarvis detects it, points at the installer when missing, and never pretends a quit landed when it didn't).
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

Everything runs from `npm run dev`. The sidecars are standalone Python services with their own venvs that talk to the app and Ollama over HTTP — nothing Python is in the Next.js build. They are fully managed from the `/status` page: **Set up** creates `sidecars/<name>/.venv` and pip-installs `requirements.txt` (confined to that folder, idempotent, output streamed to the in-app log panel), and **Start/Stop** spawn the venv's own python (`.venv/bin/python -m rag.server` / `macro.server`, `Scripts\python.exe` on Windows) with logs captured to the same panel. The status card distinguishes *no environment*, *environment missing packages* (named specifically), and *ready*; common crashes get a plain-language hint (missing dependency → re-offer Set up, port already taken). Any sidecar Jarvis started is shut down with the server so nothing gets orphaned. Manual setup/run from a terminal still works exactly as before and is the fallback: `cd sidecars/<name> && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt`, then `.venv/bin/python -m <module>`. ActivityWatch gets the same card as best-effort control — it's a third-party tray app, so Jarvis launches/quits the installed app per-OS, links to [activitywatch.net](https://activitywatch.net/downloads/) when it isn't installed, and reports "couldn't confirm it stopped" rather than pretending.

## Configuration

Configure `.env.local` (all optional except the LLM if you want the agent). For which Ollama model to pull for each job — chat/tool-calling, vision, embeddings — see **[docs/MODELS.md](docs/MODELS.md)**; `npm run doctor` verifies what's actually installed.

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
| `MACRO_SIDECAR_URL` | macro sidecar, for the status probe (default `http://localhost:8017`) |
| `GOODNOTES_DRIVE_FOLDER` | Drive folder GoodNotes backs up to (default `GoodNotes Backup`) |
| `AW_BASE_URL` | ActivityWatch API (default `http://localhost:5600`) |
| `VOICE_SIDECAR_URL` | voice transcription server for the mic button (default `http://localhost:8018`) |
| `JARVIS_AUTH_TOKEN` | if set, every page/API request must present this bearer token |
| `SYNC_ROLE` | `host` or `client`; unset = device sync disabled (default) |
| `SYNC_HOST_URL` | client only — the host's Tailscale address, e.g. `http://home-pc:3000` |
| `SYNC_AUTH_TOKEN` | shared sync secret, required on both sides (a secret like any other: env-only, never backed up) |
| `DEVICE_ID` | optional stable machine id; auto-generated and persisted on first run if unset |

---

## How each piece works

### The agent

`POST /api/agent { text }` is one agent turn. The route builds a system prompt with today's date plus a compact transcript of the last few turns (pulled from `agent_log`, large tool-call JSON excluded), calls `lib/llm.ts` `chat()` with the full tool registry from `lib/tools.ts`, and then processes each tool call the model returns under three hard rules:

1. **Validate before execute.** Arguments are parsed against the tool's zod schema; anything unknown or invalid is refused with a clear error instead of guessed at.
2. **Confirm money/destructive actions.** Tools flagged `requiresConfirm` (e.g. `set_goal`, `revert_action`) are not executed — the route returns a *pending confirmation* payload showing exactly what would run. The UI displays it; `POST /api/agent { confirmedCalls, originalText }` re-validates and executes only on your confirm.
3. **Everything logs.** Every turn — user text, tool calls as JSON, result — is written to the `agent_log` table.

Current tools: `add_task`, `log_gym`, `log_leetcode`, `set_goal`, `append_note`, `create_calendar_event`, `set_reminder`, `log_metric`, `log_habit`, `add_application`, `advance_application`, `add_to_reading_list`, `log_contact`, `query_finance`, `log_meal`, `ask_textbook`, `revert_action`. Adding a new one is a ~30-line recipe — see **[docs/adding-a-tool.md](docs/adding-a-tool.md)**.

Each turn also records **cost/latency telemetry** on its `agent_log` row: provider, model, latency, token counts (when the API reports them — never estimated), and dollar cost. With local Ollama the cost is always $0; point `LLM_PROVIDER` at a hosted model and fill in `lib/pricing.ts` (rates change — the shipped table is deliberately empty) to see tokens and running monthly cost on the `/status` page.

**Undo** (`revert_action`): because every executed tool call is logged with its validated arguments, a deterministic mapper (`lib/revert-plan.ts`) translates a logged action into its inverse SQL — `add_task` → delete that task, `log_gym` → delete that day's row, `log_meal` → delete that meal, and so on. Only cleanly invertible tools are revertible; anything else (calendar events, notes appends, stage changes that lose prior state) is refused with an explanation. Reverts are tracked in a `reverted_actions` table so the same action can't be undone twice, and the tool always requires confirmation.

### LLM abstraction

`lib/llm.ts` exports `chat({ messages, tools })` and routes by `LLM_PROVIDER`: Ollama's OpenAI-compatible `/v1/chat/completions` by default, or the Anthropic API if configured (model recommendations per job live in [docs/MODELS.md](docs/MODELS.md)). Callers never know which provider ran, so moving to a hosted model later is a config change, not a refactor. It also exports `embed(texts)` for the semantic search index, which always talks to the local Ollama embeddings endpoint (`EMBED_MODEL`, default `nomic-embed-text`) — Anthropic has no embeddings API, and embeddings of personal data should stay local anyway.

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
- **Habits / user trackers** — user-defined trackers with `daily` cadence (consecutive-day streak) or `weekly` cadence (this week's count vs. a per-week target), rendered as a GitHub-style heatmap over the last ~53 weeks on the Trackers page. `log_habit` fails with the list of known trackers if the name doesn't match, so the model can self-correct. See the unified **Trackers/Habits/Goals** model below.

### Nutrition / macros

Three ways in, one validated table (`nutrition_logs`):

1. **Agent text** — "I ate two eggs and toast" → the `log_meal` tool, with the model estimating sensible integer macros.
2. **Macro sidecar text** — `POST :8017/nutrition {"text": ...}` runs the primary Ollama model in **JSON mode** under a strict system prompt.
3. **Macro sidecar photo** — multipart `image=` goes through a local Ollama **vision model** that describes items and portions, then the same JSON-mode extraction.

Either sidecar path must validate as `{item, calories, protein, carbs, fat}` against a pydantic gate — one repair pass showing the model its own error, then a hard 422 reject. Unvalidated output never touches the database. Validated items POST to the app's zod-validated `/api/nutrition`. Honest by design: photo estimates are labeled as rough approximations (portions guessed from one 2D image) in both the UI and API; the text path is more accurate. The Trackers page shows a "Macros today" card with totals vs. goal, a per-item list, a photo-approximation badge, and per-item remove.

### Trackers, Habits & Goals — one unified model

Goals and Habits used to be two systems that overlapped (the same real-world thing, e.g. "gym", could be logged/shown in two disconnected places, and a Goal was a static number with nothing behind it). They're now **one Tracker model**: a Tracker is a row in the generalized `habits` table. `source` links it to a built-in feed (`gym_logs`, `leetcode`, `sleep_hours`, `calories`, `savings_rate`) or is null for a manual habit; `target` is the numeric goal that used to live in the separate `goals` table.

- **One home for visualization** — the **Trackers page** renders everything: sourced trackers (the former Goals) as progress **rings** vs. their target; manual trackers as **heatmaps** with a cadence-correct label. Labels respect cadence — `daily` speaks in streaks ("12-day streak"), `weekly` in count-vs-target ("4 of 6 this week") — never "per week" for a daily streak (a real bug this fixes; `lib/tracker-progress.ts`, unit-tested).
- **Habits page = management** — name/cadence/target and a link into Trackers, not a second chart. Creating a tracker runs a **duplicate check** against every existing tracker: deterministic normalized-name/keyword similarity first (`lib/tracker-dedupe.ts`, always runs), with an optional LLM pass for closer semantic matches — always a *suggestion* ("this looks like your existing 'Gym' — use it, or create anyway?"), never a silent block.
- **Goals retired** — a goal is just a target on a Tracker, so progress is always computed from real logged data, never a static number. The standalone **Goals page redirects** to Trackers. An **idempotent migration** (`lib/trackers-migrate.ts`) folds each legacy `goals` row into a Tracker, mapping all five kinds (`calories` stays a ceiling, not a floor) and **merging** a pre-existing habit/goal pair for the same thing into one Tracker instead of duplicating it. `goals` is kept as a legacy table for backup/restore but is no longer written.
- **Downstream** — the agent's `set_goal` is now an alias that sets a Tracker's target (still confirm-gated); the morning brief's "goals at risk" and the weekly digest read from the unified Tracker progress (`computeGoalsProgress`, now sourced from `lib/trackers.ts`).

### Finance

Drop CSV or PDF bank statements into the gitignored `/statements` folder and hit Import:

0. **Classify first** (`lib/finance/classify.ts`) — before any parsing, each file is routed by what it *contains*, not its extension: a content-based classifier scores brokerage signals (Symbol/Quantity/Market Value columns, arithmetically-consistent holding rows, brokerage letterhead) against transaction signals (dated running-balance rows, statement headers). CSV tables and PDF text both feed the same classifier and converge on one verdict — `brokerage`, `transaction`, or `unknown` — with a confidence score. A file that classifies below the confidence floor (or whose extracted holdings fail the qty×price ≈ market-value sanity check) is **rejected with a specific, visible reason** rather than imported with wrong or zeroed numbers; a confident wrong number is worse than a clear "couldn't parse this". The import UI shows a per-file result — parsed cleanly / parsed with named warnings / rejected with the reason — and a redacted excerpt of the extracted text/table is retained on the `statements` row (`raw_text`) for debugging.

   A `transaction`-kind file also gets a content-based **account sub-type** — `checking`, `savings`, or `credit_card` — from the same signals a human would read (running-balance structure + "Beginning/Ending Balance" vs. "Minimum Payment Due"/"New Balance"/credit-limit wording vs. "Savings Account"), never the filename. A statement whose content matches both credit-card *and* checking/savings wording is a **conflict** and gets rejected rather than guessed. Content with no distinguishing signal at all (a bare Date/Description/Amount CSV) still imports — it's just left unbadged, since that's a real, valid import, not an error. The sub-type is stored on both `statements.account_type` and `transactions.account_type` and shown as a badge (Checking / Savings / Credit Card) next to each statement in the Finance UI.
1. **Ingest** (`lib/finance/ingest.ts`) scans for files not yet in the `statements` table, parses them (redacting account numbers), and stores transactions. Everything stays on this machine. A **transfer matcher** (`lib/finance/transfers.ts`) then re-scans all transactions and pairs up the same real payment appearing on two accounts — e.g. a credit-card bill paid from checking shows as an outflow on one statement and an inflow on the other — by exact-cent opposite amounts, a few days apart, across two different statements, with at least one side reading like a payment ("PAYMENT - THANK YOU", "AUTOPAY", "ONLINE PMT", …). Matched pairs are forced to the `Transfer` category (the same category already excluded from spend/income totals), so the same dollar movement is never counted as both an expense and income.
2. **Categorization** (`categorize.ts`) is LLM-first — only merchant/amount lines are sent, never full statements — with keyword rules as the always-working fallback so import succeeds even with no model running. Fifteen fixed categories (Income, Rent, Groceries, Dining, …).
3. **Recurring radar** (`radar.ts`) is fully deterministic (dates + amounts, no LLM): it estimates each subscription's next renewal from its median gap and flags "renews in ~N days" (≤14) and "amount jumped >10% vs. usual".
4. **Brokerage statements** — Fidelity has no free personal API, so holdings come in the same way. A positions/history **CSV** is shape-detected; a brokerage **PDF** is now recognized by the classifier and its holdings table extracted into the *same* `{ticker, shares, cost_basis}` shape, so both paths validate against one zod schema (`lib/finance/holdings-schema.ts`) before write. The PDF extractor stitches **wrapped rows** (long security names push the numeric columns onto the next line) and captures the **core money-market position** (SPAXX, cost "not applicable" → its $1 price), so the whole account is represented — not the third of it an earlier build caught. A **positions snapshot takes precedence**: it *replaces* prior holdings (the newest statement wins, so a sold-out position doesn't linger and inflate net worth), while a `history` export upserts. Account-number columns are never persisted. (Single-portfolio assumption: a full snapshot wipes hand-entered holdings the statement doesn't mention.)
5. **Agent queries** — the read-only `query_finance` tool answers spend/earn questions filtered by category, merchant text, month, or date range, returning a total plus a small category breakdown.

**Re-Analyze.** The scan in step 1 only ever looks at files *not yet* in the `statements` table — a classifier or parser fix (like the sub-type/transfer-matching work above) doesn't reach a file already imported under older logic. Each statement in the Finance UI has a **Re-Analyze** button (plus a bulk **Re-Analyze All**) that previews the change first — `POST /api/finance {action:"reanalyze_preview"}` re-reads and re-classifies the original file with zero writes, showing current vs. estimated-new row counts and categories (category counts use the deterministic rules only, for a fast, side-effect-free preview; the actual commit still runs the full LLM-first pipeline) — and only on an explicit confirm click does `reanalyze_commit` delete the statement (cascading its transactions) and re-import the file fresh through the exact same path a new file takes. `category_overrides` survives automatically since it's a global merchant-keyed table, untouched by the delete. Brokerage re-analyze has no per-statement rows to delete (holdings aren't statement-scoped) — it just re-runs the same positions-replace/history-upsert logic. This is a destructive financial-data write (CLAUDE.md rule 2), hence the mandatory preview-then-confirm split. At most one confirmation card (a single statement's, or "all") is ever pending at once — opening either kind replaces whatever was previously pending, via a small pure reducer (`lib/finance/reanalyze-ui-state.ts`) rather than two independent booleans that could both be true at the same time.

**Months come from the data, not the clock.** This is a statement-based app: statements lag, so "this month" on the system clock is reliably empty. `lib/finance/period.ts` (pure, unit-tested) derives the current period from the most recent imported transaction and the comparison period from the month before it (only when that month has data — otherwise the UI says "not enough history yet" instead of $0-vs-$0). The Finance page labels the real month ("June 2026") and lets you page through any month with data (`GET /api/finance?month=YYYY-MM`), disabled past the imported range.

**Category explainer & the "why".** An in-app panel lists the 15 categories with the keywords that map to each, generated *from the real rules* in `categorize-rules.ts` (never a separate copy that can drift). `GET /api/finance/transactions` carries a derived "why" per row (which keyword matched, or "assigned by the model"), and `PATCH` re-categorizes a transaction — optionally remembering the correction (`category_overrides`, keyed by merchant) so future imports of that merchant stick.

**Amount Invested.** Outgoing brokerage ACH transfers (e.g. the real Fidelity descriptor `Fid Bkg Svc … Moneyline`, which an "FIDELITY" keyword never catches) are matched deterministically on description text only — never amount, since a weekly contribution grows over time — and *force* the `Investment` category over the LLM. "Amount Invested" is then a reliable per-month sum, so a growing weekly pattern shows as a trend.

### Category budgets

The `category_budgets` table maps each of the 15 fixed transaction categories to an optional monthly limit (`GET`/`PUT /api/finance/budgets`, zod-validated). `lib/finance/budgets.ts` computes month-to-date spend per category and compares it to the limit with plain arithmetic — no LLM anywhere. Categories at ≥80% of budget warn, categories over budget flag an overage, and both lines feed the deterministic part of the Slack morning brief.

### Stocks & watchlist

Quotes come from Finnhub (preferred, 60 req/min free) or Alpha Vantage (fallback, ~25 req/day free). A 15-minute in-memory cache plus the 15-minute cron re-warm keep usage far inside both free tiers. No API key means a clear error state in the UI, never a crash.

The holdings table is **click-to-sort** (ticker, value, % of portfolio, day move, overall P/L — click a header, click again to reverse; pure client-side over already-fetched data). Every P/L figure shows its **percentage** next to the dollar amount — daily from previous close, overall from cost basis, e.g. `+$1,204 (+13.7%)`. Each row also shows its **% of portfolio** (`value ÷ portfolio total`, from the same `portfolio-total.ts` total the page's own header uses — including a cost-basis-fallback holding like SPAXX, which gets a real percentage instead of being left out).

**One valuation function, three call sites.** `lib/stocks/portfolio-total.ts` computes per-holding value + day move + P/L (falling back to cost basis for a holding with no live quote, e.g. the SPAXX money-market core) and the aggregate total, and `/api/stocks`, the Today page's Portfolio card, and `lib/networth.ts`'s `computeNetWorth()` all call it. Before this existed, the Today card had its own inline sum that only totaled *quote-priced* holdings and silently dropped anything unpriced instead of falling back — a real, always-reproducible mismatch against the Stocks page total whenever any holding lacked a live quote, not a timing race. Pure and unit-tested (`tests/portfolio-total.test.ts`): all-priced, cost-basis-only, and mixed sets, plus the zero-cost-basis and case-insensitive-ticker edge cases.

**Dividends** are logged manually: Finnhub's dividend endpoint is premium and Alpha Vantage dropped free dividend data, so — like LeetCode's manual entry — you enter ex-date + amount/share and the app computes payout (`shares × amount/share`) into a running total and per-holding breakdown. Without a recorded share count for the ex-date it uses the current share count, clearly flagged `≈` as an approximation. Payout math is pure and unit-tested (`lib/dividends-math.ts`).

**Click a ticker for its price history.** Finnhub's `/stock/candle` is premium-gated on free keys (confirmed — see `docs/stock-history-feasibility.md`), so this is **Alpha Vantage only** (`ALPHAVANTAGE_API_KEY`), fetched lazily on click and cached in `stock_history_cache` **once per ticker per calendar day** — the free tier is 25 requests/day, and EOD data doesn't change until market close regardless of when it was first cached. A stale (prior-day) cache entry triggers exactly one fresh fetch; a same-day hit never touches the network. No key, a spent daily quota, an unknown symbol, or a premium-gated response are all the same calm degraded state in the chart dialog — never a crash. `lib/stocks/history-core.ts` is the pure, unit-tested half (caching decision + response parsing); `lib/stocks/history.ts` is the DB/network glue, same split as `lib/sync/core.ts` vs. `lib/sync/client.ts`.

### Net worth

Net worth = manual account balances (`accounts`, where `debt` subtracts) + holdings value. Holdings use the cached market quote when warm and fall back to cost basis — stated in the UI as a valuation proxy, not a promise. A single unknown symbol (the SPAXX money-market core has no Finnhub quote) no longer blanks the whole portfolio — that holding falls back to cost basis and is labelled, so the Stocks total stays honest. The daily 18:00 snapshot (plus launch catch-up) builds the over-time chart on the Net Worth page.

Account balances are entered by hand, so an account with no manual entry reads $0 even after importing a statement that states the balance. Ingest now captures the statement's summary balance (checking/savings "Ending Balance" → cash; credit-card "New Balance" → debt), **labeled with the statement's classified account sub-type** (Checking/Savings/Credit Card — see Finance above) rather than a hardcoded "Checking", so a savings statement suggests a *Savings* account instead of colliding with a checking suggestion under the same label. The Net Worth page surfaces it as a **suggestion** — "Checking (June 2026) shows a balance of $X — update?" — that writes only through the existing confirm-gated accounts endpoint. Nothing is auto-applied.

Note: statements imported before this account-type tracking existed have no sub-type or summary balance recorded (both are populated at import time only) — they show no suggestion until re-imported. That's what Phase 3's Re-Analyze is for; deleting the old `statements` row and re-scanning the folder backfills it today even without that feature.

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

Besides the CLI, the sidecar accepts `POST /ingest {"path"}` for a local file — same pipeline, same idempotent upsert. That's the endpoint the GoodNotes sync (below) feeds, and it works because the app and sidecar share a filesystem. The app's `/status` page also exposes this directly: next to the textbook-rag sidecar's Start/Stop controls, a path field + **Re-ingest** button calls `POST /api/textbook/reingest`, a thin proxy to the same `/ingest` endpoint — useful after a parser fix or an edited book, with no separate book-tracking UI needed since `/ingest` is keyed by file path already.

### GoodNotes ingestion (Drive → RAG)

GoodNotes auto-backs-up notebooks as PDFs to a Google Drive folder. `lib/goodnotes.ts` polls that folder hourly (offset to :15, plus launch catch-up):

1. **Find & diff** — locates the folder by name (`GOODNOTES_DRIVE_FOLDER`, default "GoodNotes Backup") using the same server-side OAuth tokens as Calendar, and compares each PDF's Drive `modifiedTime` against the `goodnotes_sync_state` table, so only new or edited notebooks are touched.
2. **Download** — changed PDFs land in the gitignored `/temp_notes` directory.
3. **Ingest** — each path is handed to the RAG sidecar's `POST /ingest`; because chunks are keyed by source, a re-exported notebook replaces its old chunks instead of duplicating them.

Sync state is written only after a successful ingest — if the sidecar or Ollama is down, the file simply retries next hour. Requires the `drive.readonly` scope, which was added to the Google OAuth consent: existing connections need a one-time reconnect from the Calendar tab (surfaced as a clear error, not a crash). A **"Sync GoodNotes now"** button on `/status` (next to the Google Drive check, once it's `ok`) calls `POST /api/goodnotes/sync` for an immediate run instead of waiting for the hourly tick — same `syncGoodNotes()` core the cron job calls, so behavior is identical either way.

### System status & network audit

`lib/status.ts` runs twelve independent probes (each try/caught — one failing integration never hides another) and caches the result ~20s. `/status` polls it every 30s with a manual-refresh button and also hosts the agent cost/latency panel, the sidecar Start/Stop controls, and the Sync section; the Today view shows the compact summary card. Probes are deliberately cheap: presence checks for rate-limited APIs (a missing Finnhub key is "unconfigured", a live quote failure surfaces in the Stocks UI), the last stored cron result for LeetCode, and one small request where liveness matters (Ollama, sidecars, Slack `auth.test`, Drive scope).

`lib/network-log.ts` wraps the handful of genuinely outbound `fetch` call sites in `loggedFetch`, which records **metadata only** — host, feature, purpose, outcome, latency — to the `network_log` table (30-day / 10k-row retention, pruned amortized on write). Bodies, query params, and headers are never stored, so the audit log can't become the leak it exists to rule out. `/network-log` renders it filterable by feature and day. `npm run doctor` is the CLI cousin for first-time setup.

### Device sync (selective, host/client)

Jarvis instances on multiple machines can sync a small **allowlist** of derived tables — `tasks`, `gym_logs`, `habits`/`habit_logs` (the unified Trackers, including their `source`/`target`), `leetcode_stats`, `networth_snapshots` — defined in one place (`lib/sync/tables.ts`) with the exclusion rule commented above it. The legacy `goals` table is no longer synced (folded into `habits`). Raw imports never sync: transactions, statements, mail, notes, and `oauth_tokens` are rejected by both endpoints even if explicitly requested (there's a test for exactly that).

Setup:

1. **Host** (the always-on machine): set `SYNC_ROLE=host` and `SYNC_AUTH_TOKEN=<shared secret>` in its `.env.local`. It serves `POST /api/sync/push` and `GET /api/sync/pull` — and refuses both unless the role and token check out.
2. **Client** (each other machine): set `SYNC_ROLE=client`, the same `SYNC_AUTH_TOKEN`, and `SYNC_HOST_URL=http://<host-tailscale-name>:3000`.
3. That's it — a cron tick every 5 minutes (plus launch catch-up, plus a debounced push right after writes) pushes local changes and pulls everyone else's. Sync traffic shows up in `/network-log`, and `/status` has a Sync section with per-table push/pull times and pending counts.

How conflicts resolve: every row carries a `sync_id` (cross-device identity; the local autoincrement id stays internal) and an `updated_at` that the **host stamps with its own clock at receipt time**. Device clocks are never trusted for ordering — the last write to *reach the host* wins, deterministically. A locally-edited row is never overwritten by a pull until its own push has landed. Deletes are not propagated (sync is additive), and two devices logging the same thing independently (same gym date, same goal kind) merge by natural key instead of duplicating.

> ⚠ The sync endpoints are designed to sit **behind Tailscale only**. The shared token is the entire auth story — do not port-forward `/api/sync/*` to the open internet.

The host needs no push worker for its own writes: clients pulling from it read its live `jarvis.db` directly. `sync_state` (cursors) is included in backups; `device_meta` (this machine's identity) deliberately is not, so restoring a backup onto a second machine can't clone identities — and `SYNC_AUTH_TOKEN` lives only in `.env.local`, never in any table or export.

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

- `npm run backup` exports every table to one JSON file in `/backups` — with `oauth_tokens` deliberately excluded so backups are storable without leaking live Google credentials. (`network_log`, the `agent_log` telemetry columns, and the sync cursors in `sync_state` are included — hosts and counts, no secrets. `device_meta` is excluded so a restore can't clone another machine's sync identity, and `SYNC_AUTH_TOKEN` lives only in `.env.local`, like every secret.)
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
