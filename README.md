# Jarvis — Local-First Personal Command Center

Jarvis is a personal dashboard and natural-language agent that runs entirely on your own machine. One Next.js app at `localhost:3000` is both the UI and the backend; a single SQLite file (`jarvis.db`) is the database; a local LLM (Ollama) is the brain. It costs $0 to run, and sensitive data — finances, notes, health logs — never leaves the laptop.

![Jarvis Today View](./public/demo.gif)

## Table of contents

- [Setup](#setup)
  - [Prerequisites & install](#prerequisites--install)
  - [Environment variables](#environment-variables)
  - [Google Calendar, Gmail & Drive](#google-calendar-gmail--drive)
  - [Slack check-in & brief](#slack-check-in--brief)
  - [Sidecars & ActivityWatch](#sidecars--activitywatch)
  - [Device sync (Tailscale)](#device-sync-tailscale)
  - [Running continuously (pm2)](#running-continuously-pm2)
  - [Verify your setup](#verify-your-setup)
  - [Troubleshooting quick reference](#troubleshooting-quick-reference)
- [What Jarvis does](#what-jarvis-does)
  - [Agent](#agent)
  - [Life tracking](#life-tracking)
  - [Money](#money)
  - [Knowledge](#knowledge)
  - [System & automation](#system--automation)
- [Architecture at a glance](#architecture-at-a-glance)
- [How each piece works](#how-each-piece-works)
- [Scheduler caveat](#scheduler-caveat)
- [Testing](#testing)

## Setup

### Prerequisites & install

Requires Node.js 20 LTS or newer. See [requirements.txt](./requirements.txt) for the full prerequisite checklist (including optional Python sidecars).

**macOS / Linux (Terminal):**

```bash
npm install
npm run dev        # starts the app AND the in-process cron worker
```

**Windows (PowerShell or Command Prompt):**

```powershell
npm install
npm run dev
```

Open `http://localhost:3000`. With no configuration you get tasks, trackers, notes-free features, and the dashboard; add a local Ollama model for the agent, and API keys per feature as you need them (see [Environment variables](#environment-variables)).

Other commands: `npm run build`, `npm run typecheck`, `npm test` (node test runner), `npm run backup`, `npm run restore`, and `npm run doctor` — a one-shot pre-flight report that checks Ollama and the configured models are pulled, sidecar venvs exist, and paths/keys point at real things (exit code 0 unless something *configured* is broken, so it works as a CI gate).

### Environment variables

Configure `.env.local` (all optional except the LLM if you want the agent). For which Ollama model to pull for each job — chat/tool-calling, vision, embeddings — see **[docs/MODELS.md](docs/MODELS.md)**; `npm run doctor` verifies what's actually installed.

| Variable | Purpose |
|---|---|
| `LLM_PROVIDER` | `ollama` (default) or `anthropic` |
| `LLM_BASE_URL` | Ollama OpenAI-compatible endpoint (default `http://localhost:11434/v1`) |
| `LLM_MODEL` | chat model name |
| `EMBED_MODEL` | embedding model for semantic search (default `nomic-embed-text`) |
| `ANTHROPIC_API_KEY` | only if `LLM_PROVIDER=anthropic` |
| `FINNHUB_API_KEY` / `ALPHAVANTAGE_API_KEY` | live stock quotes (price history needs no key — it uses `yahoo-finance2`) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Calendar + Gmail OAuth |
| `LEETCODE_USERNAME` | daily LeetCode auto-pull |
| `OBSIDIAN_VAULT_PATH` | notes + weekly digest |
| `SLACK_BOT_TOKEN` / `SLACK_USER_ID` | check-in, brief, markets digest (outbound) |
| `SLACK_APP_TOKEN` | app-level `xapp-…` token for Socket Mode — required for anything *inbound* (check-in buttons, DM replies) |
| `SLACK_SIGNING_SECRET` | **unused.** It authenticated inbound Slack *HTTP* requests; Socket Mode replaced those, so nothing reads it |
| `SLACK_CHECKIN_CHANNEL_ID` | channel for the morning tracker check-in; falls back to DMing `SLACK_USER_ID` if unset |
| `SLACK_BRIEF_CHANNEL_ID` | channel for the morning brief; same DM fallback |
| `SLACK_MARKETS_CHANNEL_ID` | channel for the markets digest. **No fallback** — unset means the job simply doesn't post |
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

### Google Calendar, Gmail & Drive

Set `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` (see [Environment variables](#environment-variables)) to enable Calendar, Gmail, and GoodNotes-via-Drive. A few things worth knowing before you connect:

- **Mail triage** requests `gmail.readonly` plus `gmail.compose` (compose only to create drafts) — nothing in the codebase can send mail.
- **GoodNotes ingestion** needs the `drive.readonly` scope. If you connected Google before this scope existed, do a one-time reconnect from the Calendar tab.
- OAuth refresh tokens expire roughly weekly in Google's testing mode. When that happens the UI shows a "reconnect" prompt instead of failing silently — just reconnect from the Calendar tab.

### Slack check-in & brief

Set `SLACK_BOT_TOKEN` and `SLACK_USER_ID` (see [Environment variables](#environment-variables)) to enable the morning check-in, the daily brief, and the markets digest. Add `SLACK_APP_TOKEN` to enable anything *inbound* — the check-in's Yes/No buttons and DM replies.

**Channels.** One bot, many channels: `chat.postMessage` takes the channel per call, so the single `SLACK_BOT_TOKEN` posts anywhere it's a member of. Multiple bot identities would mean separate app installs and separate tokens for no benefit here. Set `SLACK_CHECKIN_CHANNEL_ID` / `SLACK_BRIEF_CHANNEL_ID` / `SLACK_MARKETS_CHANNEL_ID` to route each feed; check-in and brief fall back to a DM when unset, so an existing setup keeps working unchanged.

**Inbound uses Socket Mode — no tunnel, no Request URL.** Jarvis opens an outbound WebSocket to Slack and Slack pushes events down it (`lib/slack/socket.ts`), so there's nothing to expose publicly and nothing to re-paste when a tunnel hostname changes. Setup:

1. In your Slack app config (api.slack.com/apps → your app): enable **Socket Mode**, generate an **app-level token** with the `connections:write` scope, and reinstall the app.
2. Put that `xapp-…` token in `SLACK_APP_TOKEN`.
3. Give the bot `chat:write` plus either `chat:write.public`, or `/invite @YourBot` into each of the three channels — a bot can't post into a channel it isn't a member of without that scope.

There's no HTTP endpoint to secure, so `SLACK_SIGNING_SECRET` is no longer read by anything, and Slack needs no exemption from the `JARVIS_AUTH_TOKEN` gate. Inbound payloads are still checked against `SLACK_USER_ID` before any write, so another member of a shared channel can't log trackers on your behalf.

The socket is opened once per server process from `instrumentation.ts`, alongside the cron scheduler, guarded against dev hot-reload double-connects (two sockets would handle every button press twice). Like the scheduler, **it only works while the process is running** — see [Running continuously (pm2)](#running-continuously-pm2). `/status`'s Slack probe reports both halves: bot auth, and whether the socket is actually connected.

### Sidecars & ActivityWatch

Sidecars are fully managed from the `/status` page: **Set up** creates `sidecars/<name>/.venv` and pip-installs `requirements.txt` (confined to that folder, idempotent, output streamed to the in-app log panel), and **Start/Stop** spawn the venv's own python (`.venv/bin/python -m rag.server` / `macro.server`, `Scripts\python.exe` on Windows) with logs captured to the same panel. The status card distinguishes *no environment*, *environment missing packages* (named specifically), and *ready*; common crashes get a plain-language hint (missing dependency → re-offer Set up, port already taken). Any sidecar Jarvis started is shut down with the server so nothing gets orphaned. Manual setup/run from a terminal still works exactly as before and is the fallback: `cd sidecars/<name> && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt`, then `.venv/bin/python -m <module>`. ActivityWatch gets the same card as best-effort control — it's a third-party tray app, so Jarvis launches/quits the installed app per-OS, links to [activitywatch.net](https://activitywatch.net/downloads/) when it isn't installed, and reports "couldn't confirm it stopped" rather than pretending.

### Device sync (Tailscale)

**Prerequisites.** Two machines each running Jarvis, and a private network between them — [Tailscale](https://tailscale.com) is the assumed setup: install it on both so the client can reach the host by its Tailscale name (e.g. `home-pc`) on port 3000. Pick one **always-on** machine as the host (a desktop that's usually awake); every other machine is a client. You also need one shared secret string — generate it however you like, e.g. `openssl rand -hex 32` — that goes in *both* `.env.local` files. This is a star topology: clients talk only to the host, never to each other.

**1. Connect both machines with Tailscale first.** Sync rides on top of a [Tailscale](https://tailscale.com/download) mesh network, not your regular internet/Wi-Fi — install the Tailscale app on both the host and every client machine, sign in to the **same** Tailscale account on each (this is what puts them on the same private "tailnet"; being on the same router/ISP does nothing by itself), and leave it running. Confirm they can see each other before touching `.env.local`:
   - Run `tailscale status` on either machine — both should be listed and reachable (not "offline").
   - From the client, `ping <host-tailscale-name>` (or `tailscale ping <host-tailscale-name>`) should get a response. That `<host-tailscale-name>` — the host's Tailscale machine name — is exactly what goes into `SYNC_HOST_URL` below. Find it under the host's device in the [Tailscale admin console](https://login.tailscale.com/admin/machines) or via `tailscale status` on the host itself.
   - The host machine needs to actually be awake and running `npm run dev` for sync to succeed — if it's asleep or the app isn't running, clients will log `fetch failed` and just retry next tick (harmless, but nothing will sync until it's back).

**2. Host** (the always-on machine) — in its `.env.local`, then restart the app:

```
SYNC_ROLE=host
SYNC_AUTH_TOKEN=<shared secret>
```

The host serves `POST /api/sync/push` and `GET /api/sync/pull`, and refuses both unless the role *and* token check out (`404` if the role isn't `host` — the routes look absent when disabled; `503` if `SYNC_AUTH_TOKEN` is missing; `401` on a bad token). It runs **no sync worker of its own** — clients read its live `jarvis.db` directly — so there is nothing else to start on the host.

**3. Client** (each other machine) — in its `.env.local`, then restart the app:

```
SYNC_ROLE=client
SYNC_AUTH_TOKEN=<same shared secret>
SYNC_HOST_URL=http://<host-tailscale-name>:3000
DEVICE_ID=laptop            # optional; a UUID is generated + persisted if unset
```

From here it's automatic: a cron tick **every 5 minutes** (plus once at launch, plus a **~3-second debounced push** right after you write something) pushes the client's changed rows to the host and pulls everyone else's back, table by table. Note the asymmetry — the debounced nudge is **push-only**, so your local edits reach the host within seconds, but you only *receive* other machines' changes on the 5-minute pull tick or at app launch. When you don't want to wait for the tick, the **Sync** section of `/status` has a **Sync now** button (client only) that runs one full push+pull pass on demand (`POST /api/sync/run`) and refreshes the per-table marks in place.

**⚠ If the host also sets `JARVIS_AUTH_TOKEN`** (the remote-access gate), that middleware sits in front of `/api/sync/*` too, and the client only ever sends its `SYNC_AUTH_TOKEN`. So either leave `JARVIS_AUTH_TOKEN` unset on the host (Tailscale is already gating access) or set it to the **same** value as `SYNC_AUTH_TOKEN` — otherwise every sync request is turned away with a `401` before it reaches the sync handler.

**4. Verify.** Open `/status` on either machine — the **Sync** section shows this device's role and id, and per-table pending counts with last push/pull timestamps. Every sync call also appears in `/network-log` (feature `sync-push` / `sync-pull`) with its outcome and latency. Quick end-to-end check: add a task on the client, watch `pending` for `tasks` drop to 0 within a few seconds (push landed), then confirm the task appears on the host — and the reverse within 5 minutes.

**Troubleshooting.** An unreachable or misconfigured host is a *normal, non-fatal* state: the client logs it (to the console and `/network-log`) and retries next tick — sync never crashes the app. If nothing moves: `404` from the host means that machine isn't `SYNC_ROLE=host`; `401` means the tokens don't match (or the `JARVIS_AUTH_TOKEN` clash above); `503` means the host is `SYNC_ROLE=host` but has no `SYNC_AUTH_TOKEN`. Persistent `fetch failed` entries almost always mean step 1 isn't actually satisfied — re-check `tailscale status` on both machines. A row that references another (a `habit_log` whose `habit` hasn't synced yet) is held back and re-pulled on the next tick, so a brand-new tracker can take one extra cycle to fully appear on other devices.

> ⚠ The sync endpoints are designed to sit **behind Tailscale only**. The shared token is the entire auth story — do not port-forward `/api/sync/*` to the open internet.

### Running continuously (pm2)

By default the scheduler **and the Slack Socket Mode connection** only run while `npm run dev` (or `npm start`) is running in an open terminal — they're both process-lifetime things started from `instrumentation.ts`, not per-request handlers. To keep briefs, polls, snapshots, and Slack buttons/DM replies working without that, run the app under a process manager:

```bash
npm install -g pm2
npm run build
pm2 start npm --name jarvis -- start   # runs `next start` on :3000
pm2 save && pm2 startup                # restart on reboot (follow the printed command)

pm2 logs jarvis                        # tail the cron/job logs
pm2 restart jarvis                     # after pulling changes + rebuild
```

`pm2` restarts the process if it crashes and brings it back after a reboot — that's all the "server" this project needs; it's still one local process on your own machine.

### Verify your setup

After configuring anything, three ways to check it worked:

- **`npm run doctor`** — a one-shot pre-flight report: confirms Ollama and the configured models are pulled, sidecar venvs exist, and configured paths/keys point at real things. Exit code 0 unless something *configured* is broken, so it doubles as a CI gate.
- **`/status`** — thirteen independent probes (Ollama, sidecars, ActivityWatch, vault, Google Calendar/Gmail/Drive, Slack, LeetCode, quote APIs, …), cached ~20s, each showing ok / degraded / down / not-configured.
- **`npm test`** runs the Node test suite; each Python sidecar has its own pytest suite (`.venv/bin/python -m pytest`), with model, mic, and network calls stubbed. See [Testing](#testing) for the full philosophy.

### Troubleshooting quick reference

- **Sync `404`** — that machine isn't set to `SYNC_ROLE=host`. **`401`** — tokens don't match (or `JARVIS_AUTH_TOKEN` is clashing with `SYNC_AUTH_TOKEN`, see above). **`503`** — host is `SYNC_ROLE=host` but has no `SYNC_AUTH_TOKEN` set. Persistent `fetch failed` — Tailscale isn't actually connected; re-check `tailscale status` on both machines.
- **Sidecar won't start** — the `/status` page distinguishes *no environment*, *environment missing packages* (named specifically), and *ready*. A named missing dependency means re-run **Set up**; "port already taken" is the other common crash.
- **Google feature erroring** — OAuth refresh tokens expire in testing mode; reconnect from the Calendar tab.
- **No LLM running** — nothing breaks. Categorization, briefs, and search all fall back to deterministic behavior; see [Testing](#testing) for how that's guaranteed.

## What Jarvis does

### Agent

- **Natural-language agent** — type (or speak) "remind me to call the bank Friday" or "I ate two eggs and toast" and the agent calls the right tool. Every tool call is zod-validated before it executes; money/destructive actions require explicit confirmation; every turn is logged.
- **Conversation memory** — each turn sees a rolling window of the recent conversation (from the `agent_log` table), so "make that high priority" works without re-explaining what "that" is.
- **Undo** — "undo that" invokes the `revert_action` tool, which maps a logged action (added task, logged workout, logged meal, …) to its inverse database operation and asks for confirmation before running it.
- **Voice input** — two paths, one local Whisper model: a 🎤 button on the Ask Jarvis card records in the browser and auto-sends the transcript through the agent (with a Ready/Starting/Down/Needs-setup indicator, and auto-start on click if the sidecar's down), and a push-to-talk sidecar (hold F9, talk, release) does the same from anywhere on the desktop. Either way, "remind me to call the bank Friday" spoken aloud is routed by the agent to the right section, exactly like typing it.

### Life tracking

- **Tasks** — a task list with due dates and priorities, fed by hand, by the agent, or straight from a day on the Calendar page. Due tasks also show on the calendar alongside your Google events.
- **Trackers** — gym visits, LeetCode progress (auto-pulled daily), sleep/bedtime/weight/mood, user-defined habits with streaks and heatmaps, and daily macros — one page that visualizes everything you track.
- **Nutrition / macros** — log a meal by text, through the agent, or by **photo**: a local vision model estimates portions and a JSON-mode extraction produces validated calories/protein/carbs/fat.
- **Goals are just Tracker targets** — savings rate, gym days/week, LeetCode/week, average sleep, calories/day are targets attached to Trackers (progress rings, computed from real data), not a separate static list. Setting one still requires confirmation, and at-risk targets feed the morning brief.
- **Google Calendar** — OAuth-connected, read back hourly into a local cache; the agent can create events and phone-notifying reminders. Google stays the single source of truth.
- **People** — a keep-in-touch list with contact cadences, overdue flags, and upcoming birthdays.
- **Career** — job-application pipeline (wishlist → applied → … → offer) with next actions and follow-up nudges.

### Money

- **Finance** — drop bank statement CSVs/PDFs into `/statements`, hit Import: parsing (with account-number redaction), LLM categorization with keyword fallback, recurring-charge detection, a renewal "radar", and a read-only agent tool for questions like "how much did I spend on dining in May?".
- **Category budgets** — set a monthly limit per spending category; month-to-date spend is checked against it deterministically and overages surface in the morning brief.
- **Stocks & watchlist** — live quotes via Finnhub or Alpha Vantage free tiers, cached to stay inside rate limits; holdings imported from brokerage CSV exports. A value-over-time chart at the top of the page shows holdings and cash/account balances stacking to your total, drawn from the same daily snapshot the Net Worth page uses. A "what's driving your portfolio" card attributes the week's/month's move to the individual holdings behind it, so a broad move isn't mistaken for one or two names.
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
- **System status** — the `/status` page probes every optional integration (Ollama, sidecars, ActivityWatch, vault, Google Calendar/Gmail/Drive, Slack, LeetCode, quote APIs) and shows ok / degraded / down / not-configured per check; a compact "10/13 healthy" card sits on the Today view. Backed by `GET /api/status` with a ~20s server-side cache.
- **Network audit log** — the `/network-log` page lists every outbound network call Jarvis has made: destination host, which feature triggered it, outcome, and latency — **never** request contents, URLs, or headers. Calls to localhost (Ollama, sidecars) don't leave the machine and aren't logged. This makes "sensitive data never leaves the laptop except calls you configured" provable rather than asserted.
- **System monitor** — a live dashboard card with CPU load, memory, and disk usage for the machine Jarvis is running on.
- **System clock** — an always-visible date/time/timezone readout in the header of every page (and on `/status`, where cron-timing questions get debugged). It shows the **server's** clock (`GET /api/system/clock` — the same process running the scheduler), synced every 60s and ticking locally per second in between, so "what time does Jarvis think it is" is never in doubt; so much of Jarvis is date-relative (catch-up-on-launch, statement-derived months, relative-date resolution, cron) that a silent server/browser timezone or drift mismatch would otherwise be a confusing bug. If the server is unreachable it falls back to the browser clock, labeled as such.
- **Screen time** — total active time today and top apps/sites, read from a local ActivityWatch instance.
- **PWA & remote access** — installable on a phone (manifest + service worker), with optional bearer-token auth (`JARVIS_AUTH_TOKEN`) so the app can be served over Tailscale or a local mesh without being wide open.
- **Device sync (optional)** — run Jarvis on two machines and keep chosen data categories in sync through one always-on "host" over Tailscale, configured per device on the **`/sync` page**. Tracker tables sync by default; finance, contacts, and more are opt-in toggles (off until you enable them). A locked core — OAuth tokens, device identity, and sync bookkeeping — can never sync, by construction.
- **Sidecar setup & start/stop** — the `/status` page has Set up / Start / Stop buttons and a live log panel for the macro, textbook-RAG, and voice sidecars; "Set up" creates the venv and installs requirements right from the browser, so a from-scratch install or a missing-dependency crash is recoverable with no terminal at all. Adding a sidecar to this system is one registry entry (`lib/sidecars/registry.ts`) — the status probe, the `/status` card, and the Start/Stop/Set-up/logs API routes are all generic over whatever's registered there. ActivityWatch gets the same card with best-effort launch/quit (it's a third-party tray app — Jarvis detects it, points at the installer when missing, and never pretends a quit landed when it didn't).
- **Backups & restore** — one command exports every table to JSON (OAuth tokens deliberately excluded); a matching restore command loads an export back into `jarvis.db`. Never locked in.

## Architecture at a glance

```
Next.js app (localhost:3000)          Python sidecars (optional)
├─ UI: dashboard pages                ├─ textbook-rag  :8016  (PDF → RAG → cited answers)
├─ API routes under /app/api          ├─ macro         :8017  (food photo/text → macros)
├─ lib/db.ts      SQLite (jarvis.db)  ├─ voice         :8018  (mic → transcript; also
├─ lib/llm.ts     Ollama | Anthropic  │                        push-to-talk → /api/agent)
├─ lib/tools.ts   agent tool registry          Ollama (localhost:11434)
└─ lib/cron.ts    scheduler + catch-up         └─ chat, vision, embedding models
```

Everything runs from `npm run dev`. The sidecars are standalone Python services with their own venvs that talk to the app and Ollama over HTTP — nothing Python is in the Next.js build. See [Setup → Sidecars & ActivityWatch](#sidecars--activitywatch) for how to install, start, and stop them.

## How each piece works

### The agent

`POST /api/agent { text }` is one agent turn. The route builds a system prompt with today's date plus a compact transcript of the last few turns (pulled from `agent_log`, large tool-call JSON excluded), calls `lib/llm.ts` `chat()` with the full tool registry from `lib/tools.ts`, and then processes each tool call the model returns under three hard rules:

1. **Validate before execute.** Arguments are parsed against the tool's zod schema; anything unknown or invalid is refused with a clear error instead of guessed at.
2. **Confirm money/destructive actions.** Tools flagged `requiresConfirm` (e.g. `set_goal`, `revert_action`) are not executed — the route returns a *pending confirmation* payload showing exactly what would run. The UI displays it; `POST /api/agent { confirmedCalls, originalText }` re-validates and executes only on your confirm.
3. **Everything logs.** Every turn — user text, requested vs. executed tool calls, result — is written to the `agent_log` table, through a single `logAgentTurn` call so no branch can skip it. Each row carries a terminal **`status`** (`ok` / `validation_error` / `execution_error` / `llm_error` / `pending_confirmation`, never null going forward), an **`error_message`** when it wasn't `ok` (the zod issues, the caught exception, or the LLM connection error), and an **`input_source`** (`typed` / `voice_mic`). `requested_calls` holds what the model asked for *before* validation; `executed_calls` holds what actually ran (with a per-call `error` instead of a `result` when a handler threw) — so a routing mistake ("the mic mis-transcribed" vs. "it picked the wrong tool") is diagnosable after the fact. Even a total failure — Ollama unreachable — writes a row rather than vanishing into a thrown error. Read it all on the **`/agent-log`** page (filter by status/date/text, expand a row for the full JSON), reachable from the **Log** button on the Ask Jarvis card — which shows a red badge when there were errors in the last 24h. The orchestration lives in `lib/agent/core.ts` (injectable, unit-tested without Ollama); `agent_log` is never auto-pruned because it also powers conversation memory and undo.

Current tools: `add_task`, `log_gym`, `log_leetcode`, `set_goal`, `append_note`, `create_calendar_event`, `set_reminder`, `log_metric`, `log_habit`, `delete_habit`, `add_application`, `advance_application`, `add_to_reading_list`, `log_contact`, `query_finance`, `query_stock_contribution`, `log_meal`, `ask_textbook`, `revert_action`. Adding a new one is a ~30-line recipe — see **[docs/adding-a-tool.md](docs/adding-a-tool.md)**.

Each turn also records **cost/latency telemetry** on its `agent_log` row: provider, model, latency, token counts (when the API reports them — never estimated), and dollar cost. With local Ollama the cost is always $0; point `LLM_PROVIDER` at a hosted model and fill in `lib/pricing.ts` (rates change — the shipped table is deliberately empty) to see tokens and running monthly cost on the `/status` page.

**Undo** (`revert_action`): because every executed tool call is logged with its validated arguments, a deterministic mapper (`lib/revert-plan.ts`) translates a logged action into its inverse SQL — `add_task` → delete that task, `log_gym` → delete that day's row, `log_meal` → delete that meal, and so on. Only cleanly invertible tools are revertible; anything else (calendar events, notes appends, stage changes that lose prior state) is refused with an explanation. Reverts are tracked in a `reverted_actions` table so the same action can't be undone twice, and the tool always requires confirmation.

### LLM abstraction

`lib/llm.ts` exports `chat({ messages, tools })` and routes by `LLM_PROVIDER`: Ollama's OpenAI-compatible `/v1/chat/completions` by default, or the Anthropic API if configured (model recommendations per job live in [docs/MODELS.md](docs/MODELS.md)). Callers never know which provider ran, so moving to a hosted model later is a config change, not a refactor. It also exports `embed(texts)` for the semantic search index, which always talks to the local Ollama embeddings endpoint (`EMBED_MODEL`, default `nomic-embed-text`) — Anthropic has no embeddings API, and embeddings of personal data should stay local anyway.

### Scheduling: cron + catch-up-on-launch

`lib/cron.ts` runs an in-process `node-cron` scheduler. Every job also fires **once at startup**, so if the laptop was asleep past a scheduled time the gap self-heals on next launch. Jobs:

| Job | Schedule |
|---|---|
| Dividend scan (ex-date detection + pending→confirmed promotion) | 07:00 daily |
| LeetCode daily pull | 08:00 daily |
| Slack morning brief | 08:00 daily |
| Markets digest (weekday day-move / weekend week-move + dividends) | 08:20 daily |
| Slack morning check-in (sleep question + retroactive tracker check-in) | 08:30 daily |
| Stocks refresh | every 15 min |
| Calendar poll | hourly |
| GoodNotes → RAG sync | hourly (:15) |
| Search embedding index refresh | every 30 min (:05/:35) |
| Net-worth snapshot | 18:00 daily |
| Mail poll | every 30 min |
| Weekly digest | Sunday 21:00 |

See the [Scheduler caveat](#scheduler-caveat) below — the scheduler only runs while the app process runs.

### Tasks

A plain task table (`title`, `description`, `due_at`, `priority`, `status`, `source`) surfaced on the Tasks page and the Today view. `description` is the free-text detail field (phone numbers, links, why-context) shown on an expanded card. Tasks arrive from the UI or from the agent's `add_task` tool; the agent resolves relative dates ("Friday") to concrete ISO dates itself. The `source` column tags provenance — `manual`, `agent`, `calendar`, or `bulk_import` — so a task's origin stays visible in the data.

**Quick-add from the Calendar page.** Every day on the calendar shows the tasks *due* that day next to its Google events (rendered distinctly, with a `○` marker), and hovering a day reveals a `+` that opens an inline add-task form pre-filled to that day — title, priority, and an editable due date. It writes through the same `POST /api/tasks` endpoint the Tasks page uses (no new endpoint, no duplicated schema) with `source: 'calendar'`, so the new task appears immediately on the calendar, the Tasks page, and the Today view without any special refresh path. These are ordinary **local** tasks, not Google events — Tasks stay a separate local list and Google remains the calendar's single source of truth, so nothing is written to Google here. Which local day a task lands on is a pure, unit-tested function (`taskDayKey` in `lib/calendar-grid.ts`) that reads date-only and full-timestamp due dates the same way the Tasks page does, with no UTC shift. The calendar grid now renders with or without Google connected — the connection prompt is a banner above it, not a wall — so the quick-add works even before you link Google.

Separately, every task write (from any source — UI, agent, mail import, this page's own quick-add) already mirrors a real Google Calendar event titled "Task: {title}" so the task is visible on Google too (see Google Calendar & reminders below). Once that mirror event round-trips back through the poll, it would be indistinguishable from a genuine event and render a second, plain entry alongside the task's own color-coded chip — the same task showing twice. The calendar page cross-references the polled events against `tasks.gcal_event_id` (`taskMirrorEventIds` in `lib/calendar-grid.ts`, pure and unit-tested) and excludes any event that's just a mirror of a task already shown as a chip, so each task renders exactly once; a genuine Google event with no matching task is unaffected.

**Bulk import (parse, group, reason, log).** The Tasks page's collapsible **Bulk import** panel takes an arbitrarily large, messy paste — a checklist, meeting notes, a to-do dump — and turns it into grouped task proposals. One core pipeline (`lib/bulk-import/`) backs the panel, `POST /api/tasks/bulk-import`, and the agent's `bulk_import_tasks` tool. It detects whether the paste is **already structured** (its own section headers — those groups are respected verbatim, never re-clustered) or **unstructured** (the model proposes thematic groups and must state a per-group `reasoning`, schema-required). Per task it extracts a short action title, moves detail (phone numbers, URLs, contacts, sub-bullets) into the description, resolves only *explicit* dates (null over a guess), maps stated urgency to a priority, expands independently-actionable sub-items into separate tasks (collapsible back in the preview), flags depends-on relationships as a plain note, and marks hard date-anchored triggers as "make this a calendar reminder instead" candidates. Model output passes the same strict JSON→zod gate as every other LLM extraction point (one repair pass showing the model its own error, then a hard reject); oversized pastes are chunked on the source's own structural boundaries, never mid-sentence.

**Nothing is created without the preview.** Analyze only records a proposal; the preview shows every group, its reasoning, and each task's inferred fields with per-task exclude checkboxes, inline edits, split/merge controls, and the reminder toggle — only the confirmed selection is written, in one transaction, as `source: 'bulk_import'` tasks (reminder-toggled items become Google Calendar events via the same `createCalendarEvent` path instead). Every import is logged in the `bulk_imports` table — raw pasted text, source mode, the validated pre-edit proposal, the confirmed selection, and the created task ids — which gives traceability ("where did this task come from"), a record of the model's reasoning, and **bulk undo**: one click (confirm-gated) tombstones exactly the tasks that import created. **Privacy:** pasted dumps routinely contain sensitive personal content, so `bulk_imports` sync is **off by default** — it's a toggle on the `/sync` page you opt into, not something that syncs automatically — and it's excluded from `npm run backup` entirely (the created tasks themselves still sync and back up normally, like any tasks).

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
- **Three heatmap states, not two** — **completed** (a log entry exists, `--heat-4`), **missed** (a `tracker_misses` row: you were asked in the morning check-in and said no, `--tracker-missed` red), and **no data** (neither — never asked, check-in off, or the tracker didn't exist yet, `--heat-1`). "Missed" gets its own token rather than a shade of the ramp because it's a different *kind* of day, not a weaker version of done. An explicit miss for today also revokes the "not yet today" grace period and breaks a daily streak; an ambiguous no-data day behaves exactly as it always has (`dailyStreak` in `lib/tracker-progress.ts`, unit-tested). A day later logged wins over a stale miss row, so a correction never leaves a red cell behind.
- **Habits page = management** — name/cadence/target, the per-tracker **morning check-in** switch, **deletion**, and a link into Trackers, not a second chart. Deleting is two different things and the confirm copy says which: a **manual habit** is deleted along with all its logged entries (real, irreversible data loss — the dialog states the exact count), while "deleting" a **sourced tracker** only removes the target/cadence config; the underlying `gym_logs`/`leetcode_stats`/health data belongs to its own feature, stays untouched, and a new tracker can point at the same source later. One handler (`lib/tracker-delete.ts`) backs the UI button, the API route, and the confirm-gated `delete_habit` agent tool — which is deliberately *not* revertible via `revert_action` (a manual habit's cascaded logs can't be restored, and a fake inverse would be worse than refusing). Creating a tracker runs a **duplicate check** against every existing tracker: deterministic normalized-name/keyword similarity first (`lib/tracker-dedupe.ts`, always runs), with an optional LLM pass for closer semantic matches — always a *suggestion* ("this looks like your existing 'Gym' — use it, or create anyway?"), never a silent block.
- **Goals retired** — a goal is just a target on a Tracker, so progress is always computed from real logged data, never a static number. The standalone **Goals page redirects** to Trackers. An **idempotent migration** (`lib/trackers-migrate.ts`) folds each legacy `goals` row into a Tracker, mapping all five kinds (`calories` stays a ceiling, not a floor) and **merging** a pre-existing habit/goal pair for the same thing into one Tracker instead of duplicating it. `goals` is kept as a legacy table for backup/restore but is no longer written.
- **Downstream** — the agent's `set_goal` is now an alias that sets a Tracker's target (still confirm-gated); the morning brief's "goals at risk" and the weekly digest read from the unified Tracker progress (`computeGoalsProgress`, now sourced from `lib/trackers.ts`).

### Finance

Drop CSV or PDF bank statements into the gitignored `/statements` folder and hit Import:

0. **Classify first** (`lib/finance/classify.ts`) — before any parsing, each file is routed by what it *contains*, not its extension: a content-based classifier scores brokerage signals (Symbol/Quantity/Market Value columns, arithmetically-consistent holding rows, brokerage letterhead) against transaction signals (dated running-balance rows, statement headers). CSV tables and PDF text both feed the same classifier and converge on one verdict — `brokerage`, `transaction`, or `unknown` — with a confidence score. A file that classifies below the confidence floor (or whose extracted holdings fail the qty×price ≈ market-value sanity check) is **rejected with a specific, visible reason** rather than imported with wrong or zeroed numbers; a confident wrong number is worse than a clear "couldn't parse this". The import UI shows a per-file result — parsed cleanly / parsed with named warnings / rejected with the reason — and a redacted excerpt of the extracted text/table is retained on the `statements` row (`raw_text`) for debugging.

   **Multi-institution signals live in a data table, not hardcoded regexes.** The wording that means "this is a brokerage statement" or "this is a checking account" — as opposed to the *structural* checks (holding-row arithmetic, transaction-row shape, CSV column names) that already generalize for free — lives in `lib/finance/institution-signals.ts`: a flat table of `{institution, tag, pattern}` rows. Adding support for a new bank or brokerage is a data change (append rows), never a change to `classify.ts`'s scoring logic — see `docs/multi-institution-parsing.md` for the full design writeup and the fictional "Second National Bank" / "Summit Brokerage" fixtures that prove it. **When the table still can't place a statement** (`kind: "unknown"` or below the confidence floor), a confirm-gated **LLM assist** (`lib/finance/classify-llm-assist.ts`) sends the already-redacted excerpt to the local model asking for a `kind`/`subKind`/reason, validated through a zod gate like every other model-output path in this codebase. It's surfaced in the import UI as "this looks like a **[type]** statement, per the local model: *[reason]*" with an explicit **Tag it and import** button — nothing is ever auto-applied, and if Ollama is down or the reply is malformed, this silently degrades back to today's plain rejection.

   A `transaction`-kind file also gets a content-based **account sub-type** — `checking`, `savings`, or `credit_card` — from the same signals a human would read (running-balance structure + "Beginning/Ending Balance" vs. "Minimum Payment Due"/"New Balance"/credit-limit wording vs. a genuine savings-account header like "Regular Savings"/"Total Savings"), never the filename. Deliberately **not** a bare "Savings Account" phrase: a real Chase checking statement's standard overdraft-protection disclosure reads "...a link to a Chase savings account..." — a mention of a different, linked account, not this statement's own type — and that incidental phrase was confirmed to be exactly what made one real checking statement misclassify as savings while an otherwise-identical one from the same account didn't. A statement whose content matches both credit-card *and* checking/savings wording is a **conflict** and gets rejected rather than guessed. Content with no distinguishing signal at all (a bare Date/Description/Amount CSV) still imports — it's just left unbadged, since that's a real, valid import, not an error. Every `brokerage`-kind statement gets sub-type `investment` unconditionally — there's no ambiguity to resolve there, any brokerage statement (Fidelity or otherwise) IS an investment account. The sub-type is stored on both `statements.account_type` and `transactions.account_type` and shown as a badge (Checking / Savings / Credit Card / Investment) next to each statement in the Finance page's **import log** — a dialog opened from the "N statements imported · view import log" summary line, so the file list isn't permanently in the open — alongside a small dropdown to **manually correct** it — no keyword heuristic is 100% across every bank's wording forever. The correction writes directly to that one statement's (and its transactions') `account_type`; unlike merchant `category_overrides`, there's no persisted account fingerprint to key a global by-institution override off of (account numbers are deliberately never stored), so the fix is scoped to that statement and reapplied by hand if a future Re-Analyze reclassifies it differently.
1. **Ingest** (`lib/finance/ingest.ts`) scans for files not yet in the `statements` table, parses them (redacting account numbers), and stores transactions. Everything stays on this machine. A **transfer matcher** (`lib/finance/transfers.ts`) then re-scans all transactions and pairs up the same real payment appearing on two accounts — e.g. a credit-card bill paid from checking shows as an outflow on one statement and an inflow on the other — by exact-cent opposite amounts, a few days apart, across two different statements, with at least one side reading like a payment ("PAYMENT - THANK YOU", "AUTOPAY", "ONLINE PMT", …). Matched pairs are forced to the `Transfer` category (the same category already excluded from spend/income totals), so the same dollar movement is never counted as both an expense and income.

   **Four tabs on the Transactions section, built on the account-type tagging above.** The Transactions card is tabbed — Total (the pre-existing combined view, unchanged), Checking & Savings (both sub-types together, since a household typically has both and only asked for one tab here), Credit Card, and Investment (current holdings from `/api/stocks` plus any transaction tagged the `Investment` category — e.g. the "Amount Invested" ACH transfer out of checking — so it answers "what's going on with my investing" as one view, not an empty transaction list, since brokerage imports are positions, not transactions). The filtering itself is a pure, unit-tested function (`lib/finance/finance-tabs.ts`'s `transactionsForTab`); a transaction can appear in more than one tab (a checking-account ACH transfer into brokerage is real activity on both). Untagged transactions (a valid, non-error state — see above) stay visible in Total with a small "N unclassified by account type" badge rather than silently vanishing from the whole-picture view.
2. **Categorization** (`categorize.ts`) is LLM-first — only merchant/amount lines are sent, never full statements — with keyword rules as the always-working fallback so import succeeds even with no model running. Fifteen fixed categories (Income, Rent, Groceries, Dining, …).
3. **Recurring radar** (`radar.ts`) is fully deterministic (dates + amounts, no LLM): it estimates each subscription's next renewal from its median gap and flags "renews in ~N days" (≤14) and "amount jumped >10% vs. usual".
4. **Brokerage statements** — Fidelity has no free personal API, so holdings come in the same way. A positions/history **CSV** is shape-detected; a brokerage **PDF** is now recognized by the classifier and its holdings table extracted into the *same* `{ticker, shares, cost_basis}` shape, so both paths validate against one zod schema (`lib/finance/holdings-schema.ts`) before write. The PDF extractor stitches **wrapped rows** (long security names push the numeric columns onto the next line) and captures the **core money-market position** (SPAXX, cost "not applicable" → its $1 price), so the whole account is represented — not the third of it an earlier build caught. A **positions snapshot takes precedence**: it *replaces* prior holdings (the newest statement wins, so a sold-out position doesn't linger and inflate net worth), while a `history` export upserts. Account-number columns are never persisted. (Single-portfolio assumption: a full snapshot wipes hand-entered holdings the statement doesn't mention.)
5. **Agent queries** — the read-only `query_finance` tool answers spend/earn questions filtered by category, merchant text, month, or date range, returning a total plus a small category breakdown.

**Re-Analyze.** The scan in step 1 only ever looks at files *not yet* in the `statements` table — a classifier or parser fix (like the sub-type/transfer-matching work above) doesn't reach a file already imported under older logic. Each statement in the import-log dialog has a **Re-Analyze** button (plus a bulk **Re-Analyze All**) that previews the change first — `POST /api/finance {action:"reanalyze_preview"}` re-reads and re-classifies the original file with zero writes, showing current vs. estimated-new row counts and categories (category counts use the deterministic rules only, for a fast, side-effect-free preview; the actual commit still runs the full LLM-first pipeline) — and only on an explicit confirm click does `reanalyze_commit` delete the statement (cascading its transactions) and re-import the file fresh through the exact same path a new file takes. `category_overrides` survives automatically since it's a global merchant-keyed table, untouched by the delete. Brokerage re-analyze has no per-statement rows to delete (holdings aren't statement-scoped) — it just re-runs the same positions-replace/history-upsert logic. This is a destructive financial-data write (CLAUDE.md rule 2), hence the mandatory preview-then-confirm split. At most one confirmation card (a single statement's, or "all") is ever pending at once — opening either kind replaces whatever was previously pending, via a small pure reducer (`lib/finance/reanalyze-ui-state.ts`) rather than two independent booleans that could both be true at the same time.

**Months come from the data, not the clock.** This is a statement-based app: statements lag, so "this month" on the system clock is reliably empty. `lib/finance/period.ts` (pure, unit-tested) derives the current period from the most recent imported transaction and the comparison period from the month before it (only when that month has data — otherwise the UI says "not enough history yet" instead of $0-vs-$0). The Finance page labels the real month ("June 2026") and lets you page through any month with data (`GET /api/finance?month=YYYY-MM`), disabled past the imported range.

**Category explainer & the "why".** An in-app panel lists the 15 categories with the keywords that map to each, generated *from the real rules* in `categorize-rules.ts` (never a separate copy that can drift). `GET /api/finance/transactions` carries a derived "why" per row (which keyword matched, or "assigned by the model"), and `PATCH` re-categorizes a transaction — optionally remembering the correction (`category_overrides`, keyed by merchant) so future imports of that merchant stick.

**Amount Invested.** Outgoing brokerage ACH transfers (e.g. the real Fidelity descriptor `Fid Bkg Svc … Moneyline`, which an "FIDELITY" keyword never catches) are matched deterministically on description text only — never amount, since a weekly contribution grows over time — and *force* the `Investment` category over the LLM. "Amount Invested" is then a reliable per-month sum, so a growing weekly pattern shows as a trend.

### Category budgets

The `category_budgets` table maps each of the 15 fixed transaction categories to an optional monthly limit (`GET`/`PUT /api/finance/budgets`, zod-validated). `lib/finance/budgets.ts` computes month-to-date spend per category and compares it to the limit with plain arithmetic — no LLM anywhere. Categories at ≥80% of budget warn, categories over budget flag an overage, and both lines feed the deterministic part of the Slack morning brief.

### Stocks & watchlist

Quotes come from Finnhub (preferred, 60 req/min free) or Alpha Vantage (fallback, ~25 req/day free). A 15-minute in-memory cache plus the 15-minute cron re-warm keep usage far inside both free tiers. No API key means a clear error state in the UI, never a crash.

The holdings table is **click-to-sort** (ticker, value, % of portfolio, day move, overall P/L — click a header, click again to reverse; pure client-side over already-fetched data). Every P/L figure shows its **percentage** next to the dollar amount — daily from previous close, overall from cost basis, e.g. `+$1,204 (+13.7%)`. Each row also shows its **% of portfolio** (`value ÷ portfolio total`, from the same `portfolio-total.ts` total the page's own header uses — including a cost-basis-fallback holding like SPAXX, which gets a real percentage instead of being left out).

**One valuation function, three call sites.** `lib/stocks/portfolio-total.ts` computes per-holding value + day move + P/L (falling back to cost basis for a holding with no live quote, e.g. the SPAXX money-market core) and the aggregate total, and `/api/stocks`, the Today page's Portfolio card, and `lib/networth.ts`'s `computeNetWorth()` all call it. Before this existed, the Today card had its own inline sum that only totaled *quote-priced* holdings and silently dropped anything unpriced instead of falling back — a real, always-reproducible mismatch against the Stocks page total whenever any holding lacked a live quote, not a timing race. Pure and unit-tested (`tests/portfolio-total.test.ts`): all-priced, cost-basis-only, and mixed sets, plus the zero-cost-basis and case-insensitive-ticker edge cases.

**Dividends** are detected **automatically**: a daily 07:00 cron (plus catch-up-on-launch) checks each holding's ex-dividend calendar via the shared Yahoo client and, on the ex-date, locks in the held share count and inserts a **pending** payout — `pending` rows show a badge with the expected payment date and contribute **zero** to the running total until the payment date arrives and they're promoted to `confirmed` (cash you're entitled to isn't cash in hand). Amounts are estimated from the ticker's last actual payment (Yahoo's forward `dividendRate` is annualized — verified against Apple IR, see `docs/dividend-automation.md` for the full field-mapping verification) and labeled `(est.)`. Dedupe rides the `(ticker, ex_date)` unique key: a hand-logged dividend never gets an auto twin, and a hand-corrected auto row is never clobbered by the next tick. **Manual entry stays fully available and unchanged** — Yahoo is an unofficial API, so like LeetCode's manual entry it's the always-working fallback: enter ex-date + amount/share and the app computes payout (`shares × amount/share`). Without a recorded share count for the ex-date it uses the current share count, clearly flagged `≈`. Payout math and the pending/confirmed totals are pure and unit-tested (`lib/dividends-math.ts`, `lib/dividends-auto.ts`).

**Investment account — value over time.** The card at the top of the Stocks page plots your investment/brokerage account's value across a selectable window (1D / 1W / 1M / 3M / 6M / YTD / 1Y / All). It's scoped to the investment account **only** — no manual bank/checking/savings balances ever appear here; that blended accounts+holdings view lives exactly once, on the Net Worth page below. It does *not* introduce a second snapshot mechanism — it reads the very rows the daily 18:00 net-worth snapshot already writes (`networth_snapshots`), so the Net Worth page's own chart is untouched.

Within the investment account, value splits into two series: **Stocks** (equity holdings — anything with a real ticker price) and **Cash** (money-market/cash-sweep positions that function as cash but live inside the brokerage, e.g. Fidelity's SPAXX core). A holding's classification is a real, per-holding column (`holdings.is_cash_equivalent`) seeded once from a small data table of known sweep-fund tickers (`lib/stocks/cash-equivalents.ts` — SPAXX, FDRXX, FZFXX, VMFXX, SWVXX, and a few siblings; the same "data table, not scattered regex" convention as `lib/finance/institution-signals.ts`), and correctable by hand from a "Type" dropdown next to each holding on the Stocks page — the same pattern as the Finance import log's account-type correction. A correction sticks: the seed table is only ever consulted once, at migration time, never re-derived on render. Stocks and Cash are drawn as a **stacked area** in genuinely distinct colors (green `--gain` for Stocks, a new teal `--cash-equivalent` token for Cash — not two shades of the same gray) — the band's top edge is the investment account's own total. The split math (`lib/stocks/cash-equivalents.ts`'s `splitStocksAndCashEquivalent`) and the windowing (`lib/stocks/portfolio-history.ts`) are both pure and unit-tested. Snapshots taken before this split was recorded carry a null breakdown; those points render as a **gap**, never a fabricated $0 (past share counts aren't reliably reconstructable — see the positions-snapshot note above), and a window with *only* such rows quietly falls back to a single total line. A new install with fewer than two snapshots shows a calm "not enough history yet" note rather than an empty chart.

**Ranges and resolution.** One row of brokerage-style buttons — 1D / 1W / 1M / 3M / 6M / YTD / 1Y / All — and no separate Daily/Weekly toggle: resolution follows the window automatically (`autoGranularity` in `lib/stocks/portfolio-history.ts`). Points are daily until the plotted span passes ~13 months, then each ISO week collapses to its *last* available snapshot (`collapseToWeekly`, never an average). The x-axis is real time, so a missing stretch takes its true width instead of being squeezed between two neighbouring labels. Gaps of up to 7 days (weekends, the laptop asleep, a snapshot with no stocks/cash split) are drawn straight across; anything longer is a visible break, because a line across weeks of missing data would invent a trend. A lone snapshot after a break gets a dot so it doesn't vanish. All of this shaping (`toChartSeries`) is pure and unit-tested.

**1D (today, intraday).** The first button is the exception to everything above: there is no snapshot for a session that is still happening, so 1D doesn't read `networth_snapshots` at all. It takes **today's positions** — the live `holdings` rows — and values them at **intraday prices**, 5-minute bars from the same cached, audited Yahoo client the per-ticker click-to-chart dialog uses (`getStockChart(ticker, "1D")`). That has one consequence worth stating plainly: **a trade made today shows at the new share count all day**, not just from the moment it filled, because the whole session is priced against the positions you hold now. The other ranges are the opposite — each past point carries the share count that was actually recorded on that date. Nothing intraday is ever written back: 1D persists no rows in `networth_snapshots` or anywhere else, and the only thing bounding the Yahoo call rate is the existing 15-minute per-(ticker, interval) `stock_chart_cache`. While 1D is on screen the view refreshes every 5 minutes, and only while the tab is visible.

The axis is the fixed **9:30 AM – 4:00 PM ET** session, so an in-progress day fills from the left and leaves the rest empty the way a brokerage app does, with ticks on the hour and the time of day in the tooltip. A dashed **Prev close** line marks where the day started, and the header's change is measured from *that* — not from the first point of the day, which would hide the overnight gap. Both ends of that subtraction come from the **same bars**: the baseline is the previous session's close read out of the ticker's own 5-minute series (a 1D plan already fetches ~6 days to pad past weekends, so it costs no extra call), with the live quote only as a fallback. Mixing providers there doesn't work — a price-level disagreement between the quote feed and the bars cancels out of a subtraction only if both sides came from the same place. Note also that a bar is stamped with the **start** of its interval, so a session's last bar is the one at **15:55**, not 16:00 (that one is the first post-market window). Given the same prices on both sides the figure equals the holdings table's day move to the cent (`computePortfolioTotal`'s `totalDayMove`; asserted in `tests/portfolio-intraday.test.ts`); against live data the two sit within a few dollars on a five-figure portfolio, because the last completed bar and the official closing print are not quite the same number. Because bars for different tickers don't line up, each ticker carries its **last close at or before** each timestamp, and its **previous close** before its first bar of the day — never a $0, and never a later price applied to an earlier time. A ticker whose fetch fails simply holds its previous close for the session while everything else renders normally; if Yahoo degrades the request to daily bars, the label says so. Money-market/sweep positions are **never fetched intraday** (no meaningful intraday price, and Yahoo serves one stale NAV bar for them) — they're a flat line for the session, and the Cash toggle works exactly as on the other ranges. On a weekend, a holiday, or before the open, the label names the session being shown ("Last session · Fri, Nov 13") rather than claiming it's today; with no bars at all you get a quiet "No trading data for today yet", not an error. The shaping is pure and unit-tested (`lib/stocks/portfolio-intraday.ts`).

**Cash toggle.** A **Cash** button next to the ranges hides the money-market/sweep band. With cash shown, Stocks + Cash stack from a $0 baseline (the band's height is the value); with it hidden, the Stocks line gets a tight, padded y-axis so its movement is readable. The header shows the latest value and the change across the selected range for whichever view is on (on 1D, the change since the previous close). The chosen range and cash setting are remembered per browser (localStorage, wrapped so blocked storage never breaks the chart).

**What's driving your portfolio.** A card on the Stocks page answers the question a raw holdings table can't: *how much of this week's (or month's) move is actually just one or two stocks?* A **1W / 2W / 1M** toggle picks the lookback window — the middle option is the same `computeContribution` engine with a 14-calendar-day lookback instead of 7 or 30, no special-cased logic. For each current holding it computes the dollar contribution to the portfolio's move — `currentValue − (shares × the period-start close)` — using the **same** `portfolio-total.ts` valuation for the current side (so an unpriced holding like SPAXX is valued at cost basis, not dropped), then its share of the net move and its own period return. The attribution math is a pure, unit-tested module (`lib/stocks/contribution.ts`) with every guard the spec demands: divide-by-zero on a flat portfolio returns `null` (never `Infinity`/`NaN`), a holding with no period-start price is flagged **"no data"** and shown in a muted row at the bottom rather than silently counted as $0, and a named `CONCENTRATION_THRESHOLD` (80%) drives the one-line rollup — "*11 of 24 holdings account for 83% of the move over this week*" — as the fewest top movers by absolute contribution whose cumulative move crosses that threshold. Period-start closes come through the **same** audited Yahoo client and `stock_chart_cache` that click-to-chart uses (`lib/stocks/contribution-data.ts` requests a daily 3M chart per holding, reused once per ticker per calendar day) — no second cache, no second client, no bypass of the rate protection; a ticker whose history can't be fetched degrades to the "no data" case for just that row, never blocking the rest. `GET /api/stocks/contribution?period=1w|2w|1m` (zod-validated, defaulting to `1w`) serves it, and the read-only `query_stock_contribution` agent tool answers "which stocks moved my portfolio this week" in the chat from the same core.

**Click a ticker for its price history.** Daily EOD history comes from **`yahoo-finance2`** — no API key required (this replaced the original Alpha-Vantage-only path; Finnhub's `/stock/candle` remains premium-gated on free keys — see `docs/stock-history-feasibility.md` for the full history). Fetched lazily on click through a shared, audit-logged Yahoo client (`lib/stocks/yahoo-client.ts` — every call shows up in `/network-log`) and cached in `stock_history_cache` **once per ticker per calendar day**: EOD data doesn't change until market close, and an unofficial endpoint shouldn't be hammered for identical data. A stale (prior-day) cache entry triggers exactly one fresh fetch; a same-day hit never touches the network. A fetch failure or an unknown/delisted symbol (delisted tickers stop returning history entirely, even for ranges that used to work) is the same calm degraded state in the chart dialog — never a crash. `lib/stocks/history-core.ts` is the pure, unit-tested half (caching decision + response parsing); `lib/stocks/history.ts` is the DB/network glue, same split as `lib/sync/core.ts` vs. `lib/sync/client.ts`.

### Net worth

Net worth = manual account balances (`accounts`, where `debt` subtracts) + holdings value. Holdings use the cached market quote when warm and fall back to cost basis — stated in the UI as a valuation proxy, not a promise. A single unknown symbol (the SPAXX money-market core has no Finnhub quote) no longer blanks the whole portfolio — that holding falls back to cost basis and is labelled, so the Stocks total stays honest. The daily 18:00 snapshot (plus launch catch-up) builds the over-time chart on the Net Worth page.

Account balances are entered by hand, so an account with no manual entry reads $0 even after importing a statement that states the balance. Ingest now captures the statement's summary balance (checking/savings "Ending Balance" → cash; credit-card "New Balance" → debt), **labeled with the statement's classified account sub-type** (Checking/Savings/Credit Card — see Finance above) rather than a hardcoded "Checking", so a savings statement suggests a *Savings* account instead of colliding with a checking suggestion under the same label. The Net Worth page surfaces it as a **suggestion** — "Checking (June 2026) shows a balance of $X — update?" — that writes only through the existing confirm-gated accounts endpoint. Nothing is auto-applied.

Note: statements imported before this account-type tracking existed have no sub-type or summary balance recorded (both are populated at import time only) — they show no suggestion until re-imported. That's what Phase 3's Re-Analyze is for; deleting the old `statements` row and re-scanning the folder backfills it today even without that feature.

### Google Calendar & reminders

OAuth tokens live server-side in the `oauth_tokens` table — never in the browser. **Google is the single source of truth**: Jarvis polls (on page open and hourly) and reads events into `calendar_cache`; it never maintains a second mutable calendar or reconciles bidirectionally. The agent's `create_calendar_event` writes real events and `set_reminder` creates a short event so your phone notifies you. Testing-mode OAuth refresh tokens expire ~weekly; refresh failure surfaces a "reconnect" prompt rather than crashing.

**Event vs. task, from the same day cell.** The Calendar page's quick-add covers both kinds of thing you'd put on a day, and neither one is the other:

- **+ Task** — a row in the local `tasks` table (unchanged from its original quick-add), never synced to Google.
- **+ Event** — a real Google Calendar event, created deterministically (no LLM involved) through `POST /api/calendar/events`, which calls the exact same `createCalendarEvent()` function the agent's `create_calendar_event`/`set_reminder` tools use — one Google-write implementation total, just two entry points. It supports a timed event (start + optional end, defaulting to one hour) or an all-day event (a plain date, defaulting to a single day); which shape to send is decided the same way the rest of the calendar code detects all-day (`isAllDay`/`resolveGoogleEventTimes` in `lib/calendar-grid.ts`, pure and unit-tested). Because `createCalendarEvent` already re-polls Google as a read-back after writing (Google stays the source of truth even for the immediate-feedback case), the new event shows up right away without an optimistic fake row and without a second polling implementation. An OAuth/reconnection failure surfaces the exact same error text the rest of the page's Google actions already use ("…reconnect from the Calendar tab") — no separate error UI.

Both actions live in the same day-detail panel (click a day, or hover it for the `+`/🗓 shortcuts) with a small Task/Event tab toggle — no navigating away from the Calendar page.

**Edit & delete.** Clicking a genuine Google event (a grid chip or a day-detail row) opens an inline edit form (title, date, all-day vs. timed) plus a confirm-gated Delete, backed by `PATCH`/`DELETE /api/calendar/events/:googleEventId` → `updateCalendarEvent()`/`deleteCalendarEvent()` in the same module as creation, reusing the same `isAllDay`/`resolveGoogleEventTimes` shape logic (`buildGoogleEventPatch`, pure and unit-tested) and the same read-back re-poll after every write. Clicking a **task chip** instead routes to the Tasks page's own edit UI (`/tasks?task=<id>` expands that card) — editing a task's mirror event directly would desync it from the task, so the dispatch keys off the same `taskMirrorEventIds` cross-reference the rendering already uses. The agent grew matching confirm-gated `edit_calendar_event`/`delete_calendar_event` tools (they resolve "my 3pm dentist thing" against `calendar_cache`, refuse ambiguous matches, and refuse task mirrors with a pointer to the task tools). Calendar deletes stay non-revertible via `revert_action`, consistent with the existing rule that Google-side actions aren't cleanly invertible.

### Mail triage

Gmail is polled read-only every 30 minutes, mirroring the Calendar OAuth pattern (CSRF state cookie, server-side tokens, auto-refresh). Multi-account: one `oauth_tokens` row per inbox plus a `mail_accounts` registry, every message tagged with its inbox. A deterministic pre-filter categorizes the obvious stuff before the LLM triages the rest. Scopes are `gmail.readonly` plus `gmail.compose` **only** to create drafts — drafts are created only on an explicit click, and nothing in the codebase can send mail.

### Notes (Obsidian)

`lib/notes.ts` reads and appends to your vault directly on disk via `OBSIDIAN_VAULT_PATH`. Every user-supplied note path is resolved and must stay inside the vault (path-traversal guard); `.obsidian`, `.trash`, `.git` are skipped. The agent's `append_note` defaults to today's daily note. Unconfigured vault → clear error state, never a crash.

### People (keep-in-touch)

Each person can have a contact cadence in days and a birthday. The People page computes who's overdue (days since `last_contacted` beyond cadence) and birthdays in the next 30 days. The agent's `log_contact` records a catch-up and, like `log_habit`, fails with the known-people list on a name mismatch.

### Career

Applications move through fixed stages (`wishlist → applied → screening → interview → offer / rejected / accepted`) with optional next action, contact, and link. Each application records the **date it was submitted** (`date_applied`): the add form defaults it to today (editable), the agent resolves relative dates itself ("applied last Tuesday" → a concrete ISO date) and defaults to today when unstated, and it's set once at creation — stage moves never touch it. Rows tracked before this field existed show "—" rather than a guessed date. The agent tracks new applications (`add_application`) and stage changes (`advance_application`); overdue follow-ups feed the morning brief.

### Reading list

Items of kind `book | article | course | paper | video` with statuses `queued | reading | done | abandoned`, sorted reading-first. Added from the UI or the agent (`add_to_reading_list`).

### Global search (hybrid)

`lib/search.ts` runs in two tiers:

1. **Exact tier** — deterministic `LIKE` matching across every local source — tasks, transactions, mail, notes, people, and more — grouped by source with each hit linking to its page. Instant, exact, and works with nothing else running.
2. **Semantic tier** — a local embedding index (`search_embeddings` table, vectors from Ollama `nomic-embed-text` via `lib/llm.ts embed()`) over tasks, note titles, and mail subjects. Cosine similarity catches fuzzy queries ("that email about the flight" when the subject says "itinerary"). Results the exact tier already found are not duplicated; fuzzy hits are appended per source.

The index refreshes on a 30-minute cron (plus launch catch-up) and only re-embeds rows whose text changed. If Ollama or the embedding model is down, search silently degrades to the exact tier — semantic is garnish, never a dependency.

### Slack check-in & morning brief

- **Check-in** (08:30): two messages, each idempotent per day.
  - *Retroactive tracker check-in.* Looks at **yesterday**, finds every check-in-enabled tracker with no completion record for that day, and asks "did you do this?" with a Yes/No button pair per tracker in one Block Kit message. **Yes** logs it for that historical date through the existing agent tool (`log_gym` / `log_leetcode` / `log_habit`, each of which already accepted an explicit `date`); **No** writes a `tracker_misses` row — an *explicit* miss, which is a different thing from "no data". Presses arrive over Socket Mode; the socket handler only decodes the payload and calls `handleTrackerResponse` (`lib/slack/tracker-response.ts` — db injected, no Slack types, unit-tested against an in-memory DB). Either way the button row is replaced via `chat.update` with a static ✅/🔴 line, so a double-tap can't double-log. Trackers already answered (logged or missed) are never re-asked, which is what makes launch catch-up safe; if nothing is unconfirmed, no message is sent at all.
  - *Sleep* stays its own free-text question, since it needs a number rather than a toggle. Replies are handled by deterministic parsers first, LLM only as fallback.

  Which trackers get nagged is a per-tracker switch (`habits.checkin_enabled`) on the **Habits** page. Defaults follow the source and cadence: daily gym / LeetCode / manual habits **on**; magnitude-based trackers (`sleep_hours`, `calories`, `savings_rate`) and every weekly-cadence tracker **off**, since neither a number nor a weekly count is framed by "did you do this yesterday?". New trackers get the same rule the migration backfilled with.
- **Markets digest** (08:20 → `SLACK_MARKETS_CHANNEL_ID`): Mon–Fri, the most recent trading day's portfolio move (the same `computePortfolioTotal` day-move figure the Stocks page shows) plus the `CONCENTRATION_THRESHOLD` "what's driving it" rollup at a 1-day lookback. Sat/Sun, the past week's move from the *same* contribution engine at a 7-day lookback — the exact calculation behind the Stocks page's "1W" toggle, just a different lookback passed in. Both include dividends confirmed (by payment date) or newly pending (by ex-date) inside the covered window, using the existing dividend tables and payout math. No math is re-derived anywhere in the job.
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

`lib/status.ts` runs thirteen independent probes (each try/caught — one failing integration never hides another) and caches the result ~20s. `/status` polls it every 30s with a manual-refresh button and also hosts the agent cost/latency panel, the sidecar Start/Stop controls, and the Sync section; the Today view shows the compact summary card. Probes are deliberately cheap: presence checks for rate-limited APIs (a missing Finnhub key is "unconfigured", a live quote failure surfaces in the Stocks UI), the last stored cron result for LeetCode, and one small request where liveness matters (Ollama, sidecars, Slack `auth.test`, Drive scope).

`lib/network-log.ts` wraps the handful of genuinely outbound `fetch` call sites in `loggedFetch`, which records **metadata only** — host, feature, purpose, outcome, latency — to the `network_log` table (30-day / 10k-row retention, pruned amortized on write). Bodies, query params, and headers are never stored, so the audit log can't become the leak it exists to rule out. `/network-log` renders it filterable by feature and day. `npm run doctor` is the CLI cousin for first-time setup.

### Device sync (selective, host/client)

> See [Setup → Device sync](#device-sync-tailscale) to connect two machines over Tailscale.

Jarvis instances on multiple machines sync a **user-configurable** set of categories, chosen per device on the **`/sync` page** (the Sync Control Center) and persisted in the local `sync_config` table. The registry of every category lives in one place (`lib/sync/tables.ts`); on first upgrade the set that shipped syncing stays on — `tasks`, `gym_logs`, `habits`/`habit_logs` (the unified Trackers, including their `source`/`target`), `leetcode_stats`, `networth_snapshots`, `applications` (the career pipeline), `reading`, `watchlist`, and `holdings` — and everything newly exposed as a toggle (bank transactions & statements, category budgets, merchant overrides, meal/macro logs, contacts, bulk-import history) starts **off**, so nobody's data begins syncing that wasn't already. Flip them on from `/sync`; `/status` shows a compact summary with a **Manage sync →** link. The legacy `goals` table is no longer synced (folded into `habits`). Turning a category off never deletes local data — it only pauses future push/pull for it.

Effective sync for any table is the **intersection** of host-enabled and client-enabled, so for a two-device setup keep the same toggles on both. A small set stays **permanently locked** (greyed out, no toggle) because syncing them would break the app, not merely leak data: `oauth_tokens` (live rotating credentials), `device_meta` (per-device sync identity), and `sync_state`/`sync_config` (per-device bookkeeping). These are hard-excluded — filtered server-side and impossible to even name on the wire, even if a config row somehow said otherwise (there's a test for exactly that). Notes/Obsidian aren't a database table (they're files — use Obsidian Sync/Syncthing/a synced folder for the vault). Two known, accepted limitations: (1) if two devices both run brokerage imports *before* syncing, `holdings` resolution is per-row, so the merged set may match neither statement — keep imports on one machine; (2) `transactions` merge safely on a content key (date + amount + description + account), but the `statements` containers themselves have no cross-device identity, so both devices may keep duplicate statement rows if each imported the same file before syncing.

How conflicts resolve: every row carries a `sync_id` (cross-device identity; the local autoincrement id stays internal) and an `updated_at` that the **host stamps with its own clock at receipt time**. Device clocks are never trusted for ordering — the last write to *reach the host* wins, deterministically. A locally-edited row is never overwritten by a pull until its own push has landed. Deletes propagate as **tombstones**: deleting a row sets its `deleted_at` timestamp (the row is hidden everywhere, never physically removed), and that write syncs exactly like an edit — a delete is just "the newest write happened to be a delete", with the same host-stamped last-write-wins resolution, so an edit newer than a delete correctly un-deletes the row. Tombstones are kept indefinitely (purging one before every device pulled it would let a stale device resurrect the row) and are included in backups so a restore can't undelete anything. The one exception: deleting a **manual habit** cascades a genuine, irreversible hard delete of the habit and its logs — the confirm dialog promises exactly that, and it deliberately does not propagate. Two devices logging the same thing independently (same gym date, same goal kind) merge by natural key instead of duplicating.

On **backups**: `sync_state` (the pull cursors) is included so a restored client resumes where it left off; `device_meta` (this machine's sync identity) deliberately is **not**, so restoring a backup onto a second machine can't clone identities — and `SYNC_AUTH_TOKEN` lives only in `.env.local`, never in any table or export.

### System monitor

`GET /api/system` probes the host with the `systeminformation` package — CPU load and core count, memory used vs. total ("active" memory, matching what Activity Monitor/Task Manager report), and the OS disk (mount `/` on macOS, `C:` on Windows). The `<SystemMonitor />` client card polls it every 8 seconds with progress bars (red past 90%), clears its interval on unmount, and degrades to a quiet "stats unavailable" if the probe fails. Cross-platform by construction — the same code runs on the M3 MacBook and the Windows box.

### Screen time (ActivityWatch)

[ActivityWatch](https://activitywatch.net) tracks window and browser activity locally on `:5600`. `lib/activitywatch.ts` reads three bucket types since local midnight: the AFK watcher for **total active time** (sum of `not-afk` spans, falling back to window-focus time if no AFK watcher runs), the window watcher aggregated by app, and the web watcher aggregated by domain (www-stripped). The aggregation is pure and unit-tested. `GET /api/activity` proxies it and always answers 200 with an `available` flag — ActivityWatch not running is a normal state, and the `<ScreenTime />` card (refreshes every 60s) just shows a hint instead of an error.

### Voice input (`sidecars/voice`)

Two entry points share one lazily-loaded local **faster-whisper `large-v3-turbo`** model:

- **Mic button** — the 🎤 on the Ask Jarvis card records with the browser's MediaRecorder, POSTs the clip to `/api/transcribe`, which proxies it to the sidecar's HTTP server (`python -m voice.server`, `:8018`, `POST /transcribe`). The transcript is auto-sent through the agent — same routing as typing. A small indicator next to the button (Ready / Starting… / Down / Needs setup) reflects the sidecar's real state, reusing the same `/api/sidecars` data the `/status` page's card shows — no second probe. Clicking the mic while it reads **Down** auto-starts the sidecar (the same action `/status`'s Start button uses) and proceeds with recording once it's ready, instead of surfacing a raw "sidecar not running, start it yourself" error. **Needs setup** (no venv, or missing packages) shows the specific reason and a direct link to `/status`'s Set-up flow rather than a terminal command. Mic denied or undecodable audio still surface as clear chat errors, never crashes.
- **Voice sidecar is one entry in the shared sidecar registry** (`lib/sidecars/registry.ts`) — the same Set up / Start / Stop / logs machinery, `/status` card, and health probe that the macro and textbook-RAG sidecars already use, all generic over whatever's registered there.
- **Push-to-talk** — `python -m voice.push_to_talk`: hold **F9** (configurable via `PTT_KEY`) to record 16 kHz mono audio, release to transcribe, then POST the transcript to `/api/agent` exactly as the chat box does — printing the transcript and the agent's reply, including pending-confirmation notices. The compute path is a pure, unit-tested decision matrix over probed hardware: NVIDIA → CUDA fp16; AMD → CPU int8 with an explicit log that faster-whisper has no clean native AMD GPU path; Apple Silicon → CPU int8; everything overridable with `WHISPER_DEVICE` / `WHISPER_COMPUTE` / `WHISPER_MODEL`.

### PWA & remote access

- **Installable** — `app/manifest.ts` serves the web-app manifest (icons in `public/icons`) and `public/sw.js` is a minimal service worker (network-first, no aggressive caching of API responses — the data is live and local). On a phone, "Add to Home Screen" gives a standalone full-screen app.
- **Bearer-token auth** — set `JARVIS_AUTH_TOKEN` and `middleware.ts` requires every page and API request to present it: `Authorization: Bearer <token>` for API clients, or open `https://your-host/?token=<token>` once in a browser and a cookie keeps the session. Unset, the middleware is a no-op and localhost behaves exactly as before. This is what makes serving Jarvis over a Tailscale funnel or LAN reasonable — it is *not* internet-grade multi-user auth.

### Backup & restore

- `npm run backup` exports every table to one JSON file in `/backups` — with `oauth_tokens` deliberately excluded so backups are storable without leaking live Google credentials. (`network_log`, the `agent_log` telemetry columns — now including the Agent Log viewer's `status`/`error_message`/`input_source`/`requested_calls`/`executed_calls`, which ride along automatically as columns of the already-backed-up `agent_log` table, no new exclusion decision — and the sync cursors in `sync_state` are included: hosts and counts, no secrets. `device_meta` is excluded so a restore can't clone another machine's sync identity, and `SYNC_AUTH_TOKEN` lives only in `.env.local`, like every secret.)
- `npm run restore` loads an export back: `npm run restore -- backups/jarvis-backup-<stamp>.json` (or with no argument, the newest file in `/backups`). It truncates each table present in the JSON (never `oauth_tokens`) and bulk-inserts the rows inside a single transaction — either the whole restore lands or none of it does. Your data is a plain SQLite file plus JSON exports; you are never locked in.

### Data model & privacy

All state lives in `jarvis.db` (better-sqlite3, migrations run idempotently on startup in `lib/db.ts`). Secrets stay in server-side env vars or the `oauth_tokens` table and never reach a client component. `.env*`, `jarvis.db`, `/statements`, and the vault path are gitignored. The only network calls are the ones you configure: your chosen LLM endpoint, quote APIs, Google OAuth, Slack, and the unofficial LeetCode API — finances, notes, health, and mail content are processed locally.

## Scheduler caveat

The `node-cron` scheduler lives **in the Next.js process** — when `npm run dev` (or `npm start`) stops, every scheduled job stops with it. Catch-up-on-launch heals the gaps for daily/weekly jobs the next time you start the app, but nothing runs while it's down. The **Slack Socket Mode connection** has exactly the same lifetime and the same fix, so treat them as one concern: with the process down, check-in buttons and DM replies do nothing (and unlike cron, there's no catch-up — a button pressed while the app was down is simply never delivered; press it again once it's back). See [Setup → Running continuously (pm2)](#running-continuously-pm2) to keep both alive without an open terminal.

## Testing

`npm test` runs the node test suite; each Python sidecar has its own pytest suite run from its venv (`.venv/bin/python -m pytest`), with all model, mic, and network calls stubbed.

The testing philosophy follows the architecture's deterministic-first rule:

- **Deterministic logic gets real unit tests.** Anything that computes without a model — finance query building, brokerage/Slack/mail parsing, nutrition schema validation, ActivityWatch aggregation, the revert-action inverse mapper, budget overage math, semantic-search ranking/merging — lives in pure modules with no database or network imports, and is tested directly with `node --test` over exact inputs and expected outputs. If a parser or mapper is wrong, a test fails; we never rely on an LLM behaving well to make these paths correct.
- **LLM calls are never tested live — their fallbacks are.** Every LLM integration point (categorization, triage, brief phrasing, semantic search) is written as *deterministic result first, model as garnish*, so tests exercise the fallback path explicitly: categorization falls back to keyword rules, the brief falls back to its plain rendering, hybrid search falls back to `LIKE`. What gets asserted is that the system produces a correct, useful answer **with no model running at all**.
- **Model output is validated, not trusted.** Where a model's output does enter the system (tool-call args, JSON-mode extraction), the tests target the validation gate — zod/pydantic schemas reject malformed payloads — rather than the model itself. The contract under test is "unvalidated output never executes", which holds regardless of which model is behind `lib/llm.ts`.
- **Sidecar suites stub the world.** The RAG, macro, and voice pytest suites fake Ollama, the microphone, and the Jarvis HTTP endpoint, so they run green on a machine with no GPU and no models pulled. Live-model verification passes are tracked separately in [HANDOFF.md](HANDOFF.md).