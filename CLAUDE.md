# CLAUDE.md — Jarvis Command Center

This file is your persistent context for this repo. Read it fully before writing code. When something here conflicts with a one-off instruction in chat, ask before diverging.

## What this is

A local-first personal dashboard + natural-language agent. One Next.js app runs on the user's laptop at `localhost:3000` and is both the UI and the backend. It tracks tasks, gym, LeetCode, finances, stocks, notes, and calendar, and exposes an agent that can act on all of them via tool-calling. It runs **locally** and costs **$0**. Sensitive data (finances, notes) never leaves the machine.

Full product plan lives in `jarvis-plan-final.md`. This file is the engineering contract.

## Non-negotiable rules

1. **Validate before you execute.** Every agent tool call must have its arguments parsed and validated with a `zod` schema before the tool runs. Never execute an unparsed or unvalidated call. On validation failure, return a clear error to the model/user — do not guess-and-run.
2. **Confirm money/destructive actions.** Any tool that spends, deletes, or writes financial data must require an explicit confirmation step before it commits. Log the intended call, show it, commit only on confirm.
3. **Secrets are server-side only.** API keys and OAuth tokens live in server-side env vars or the `oauth_tokens` table. Never expose them to the browser or a client component. Never commit `.env*`. Add `.env*`, `jarvis.db`, `/statements`, and the Obsidian vault path to `.gitignore`.
4. **Google Calendar is the single source of truth.** Read it back; never maintain a second mutable calendar or bidirectionally reconcile.
5. **Everything logs.** Every agent turn writes to `agent_log` (user text, tool calls as JSON, result).
6. **Catch-up-on-launch.** Every scheduled job also runs once at app startup so gaps self-heal when the laptop was asleep.
7. **Build one phase at a time.** Do not scaffold later phases early. Finish, run, and verify the current phase before moving on. Half-built everything is the failure mode we are explicitly avoiding.

## Stack

- Next.js (App Router) + TypeScript.
- `better-sqlite3` (synchronous) → single file `jarvis.db`.
- `zod` for all tool-arg and API input validation.
- Tailwind + shadcn/ui; Recharts for charts.
- `node-cron` in-process for scheduling, plus catch-up-on-launch.
- LLM via a provider abstraction (see below). Default provider: Ollama at `http://localhost:11434` (OpenAI-compatible).
- Market data: Finnhub or Alpha Vantage (free tier).

Pin the current stable version of each dependency at install time — do not trust version numbers from memory. If a listed library is deprecated or a clearly better standard exists now, flag it and propose the swap before proceeding.

## Directory structure (target)

```
/app
  /api
    /agent/route.ts
    /tasks/route.ts
    /gym/route.ts
    /leetcode/route.ts
    /finance/route.ts
    /stocks/route.ts
    /google/route.ts
    /notes/route.ts
  /(dashboard)
    page.tsx            # Today view
    /tasks/page.tsx
    /trackers/page.tsx
    /finance/page.tsx
    /stocks/page.tsx
    /notes/page.tsx
    /calendar/page.tsx
  layout.tsx
/lib
  db.ts                 # better-sqlite3 connection + migrations
  llm.ts                # provider abstraction (ollama | anthropic)
  tools.ts              # tool registry: name, zod schema, handler
  cron.ts               # node-cron jobs + catch-up-on-launch
/components              # shadcn/ui + shared UI
/scripts
  backup.ts             # export all data to JSON
/statements             # gitignored; user drops CSV/PDF here
jarvis.db               # gitignored
.env.local              # gitignored
```

## Data model (SQLite)

Create these via a migration run on startup (`lib/db.ts`). Booleans `0/1`, timestamps ISO text, JSON as `TEXT`.

- `tasks(id, title, due_at, priority, status, source, created_at)`
- `agent_log(id, user_text, tool_calls, result, created_at)`
- `gym_logs(id, date, notes)`
- `leetcode_stats(id, date, total_solved, streak, recent)`
- `transactions(id, date, amount, merchant, category, raw_description, statement_id, is_recurring, account_type)`
- `statements(id, month, file_path, imported_at, kind, raw_text, ending_balance, balance_kind, balance_label, account_type)`
- `holdings(id, ticker, shares, cost_basis)`
- `watchlist(id, ticker)`
- `calendar_cache(id, google_event_id, title, start, end, updated_at)`
- `oauth_tokens(provider, access_token, refresh_token, expires_at)`
- `goals(id, kind, target, period)`

Only create the tables a phase needs when you build that phase, but keep the schema definitions centralized in `lib/db.ts`.

## LLM abstraction (`lib/llm.ts`)

Export one function:

```ts
chat({ messages, tools }): Promise<{ text?: string; toolCalls?: ToolCall[] }>
```

- Route by `process.env.LLM_PROVIDER`: `"ollama"` (default) or `"anthropic"`.
- Ollama: POST to the OpenAI-compatible `/v1/chat/completions` at `LLM_BASE_URL` (default `http://localhost:11434/v1`), model from `LLM_MODEL`.
- Anthropic: only if `ANTHROPIC_API_KEY` is set; same interface, tools mapped to Anthropic tool-use format.
- Callers never know which provider ran. Keep the seam clean so hosting later is a config change.

## Tool registry (`lib/tools.ts`)

Each tool = `{ name, description (crisp), schema (zod), handler, requiresConfirm }`. `/api/agent`:
1. calls `chat` with the registered tool list,
2. for each returned tool call: validate args with the tool's zod schema,
3. if `requiresConfirm`, return a pending-confirmation payload instead of executing,
4. else execute the handler, then
5. write the turn to `agent_log` and return a confirmation string.

Add tools per phase. Phase 1 ships exactly one: `add_task`.

## Dev / run

- `npm run dev` starts the app and the in-process cron worker (which also runs catch-up-on-launch).
- Document required env in `.env.example`: `LLM_PROVIDER`, `LLM_BASE_URL`, `LLM_MODEL`, optional `ANTHROPIC_API_KEY`, `FINNHUB_API_KEY` / `ALPHAVANTAGE_API_KEY`, `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`, `OBSIDIAN_VAULT_PATH`.
- After each phase: run it, confirm the acceptance criteria in the phase kickoff, then stop and report.

## How to work

- Work in small, verifiable steps. After a meaningful change, run the app / typecheck and confirm it works before continuing.
- Before any large or structural change, state your plan in 3–5 bullets and wait for confirmation.
- Prefer boring, readable code over clever code. This is a solo maintainer's project.
- If you hit an unofficial API (LeetCode) or an OAuth quirk, wrap it defensively, log failures, and keep the manual fallback path working.
