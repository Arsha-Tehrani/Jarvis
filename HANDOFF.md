# HANDOFF — autonomous run, 2026-07-04 → 07-05

Phases 1–3 are **built, verified (non-LLM paths), and committed**. Stopped before
Phase 4 as instructed (Google OAuth needs your decision + secrets). Ollama was not
running during this run, so everything that needs a live model is deferred — the
checklist below is exactly what to test when you're back.

## Commits

| Commit | What |
|---|---|
| `d073f60` | Phase 1: spine — Next.js + SQLite, Tasks CRUD, agent with validated `add_task` |
| `fcfda2c` | Phase 2: trackers — gym heatmap, LeetCode pull + fallback, cron worker |
| `f361964` | Phase 3: finance — statement ingest, categorization, views, goals |
| (this file) | HANDOFF |

Every phase finished on a green `npm run build` + `npm run typecheck`.

## What exists

- **Spine**: Next.js 16 (App Router, TS) + Tailwind v4 + shadcn/ui at repo root.
  `lib/db.ts` (better-sqlite3, WAL, idempotent startup migrations — all 7 tables for
  phases 1–3), `lib/llm.ts` (`chat()` routed by `LLM_PROVIDER`: ollama default,
  anthropic behind key), `lib/tools.ts` (registry: `add_task`, `log_gym`,
  `log_leetcode`, `set_goal`). `jarvis.db` was deleted after testing — the app
  starts with a clean DB and recreates it on first boot.
- **Agent** (`/api/agent`): every tool call is zod-validated before execution
  (garbled → rejected with the zod error; unknown tool → refused). `set_goal` has
  `requiresConfirm=true` → returned as a pending payload; the chat UI shows
  Confirm/Cancel and the confirm leg re-validates before executing. Every turn
  (including errors) is written to `agent_log`.
- **Tasks**: full CRUD API + UI, persists across restarts, feeds the Today view.
- **Trackers**: gym "I went today" toggle + GitHub-style heatmap; LeetCode card
  with refresh-from-leetcode.com (defensive, unofficial API), manual-entry
  fallback that always works, and a daily cron pull at 08:00 with
  **catch-up-on-launch** (verified firing on restart via `instrumentation.ts`).
- **Finance**: drop CSV/PDF in `statements/` → Import button ingests new files,
  redacts account numbers (verified: `NETFLIX.COM ••••7890`), categorizes via
  `lib/llm.chat` with a **keyword-rule fallback** (so import works with no model),
  detects recurring charges (same merchant + similar amount + 21–38-day cadence —
  caught rent + Netflix, ignored one-offs in the synthetic test), and renders
  spend-by-category (this vs last month, chart + table), income/spend/invested
  tiles, subscriptions list, and a goals editor whose `savings_rate` goal drives
  cut-back suggestions (verified: 70% target → concrete cut list; 30% → on track).

## Verification results

Passed: tasks CRUD + persistence; agent validation/refusal/error-logging paths;
gym log/unlog + date validation; LeetCode manual entry; cron schedule + catch-up
on restart; statement import (16 synthetic transactions, correct month
attribution); redaction; rule-based categories; recurring detection;
goals CRUD + cutback math; all pages 200; builds green.

Nothing failed. Skipped (not failures): live-LLM paths below, and a visual
eyeball of the heatmap/chart (pages render, but I couldn't look at pixels —
glance at Trackers and Finance tabs when you first open them).

## Deferred tests — run these when you're back

Setup: install Ollama, `ollama pull` a tool-capable model sized to your RAM,
`cp .env.example .env.local` and set `LLM_MODEL` (+ `LEETCODE_USERNAME`), then
`npm run dev`.

1. **Live agent turn**: chat "add a task to review my budget Friday" → task
   appears in Tasks with Friday's date, turn in `agent_log`.
2. **Confirm gate live**: chat "set my savings goal to 30%" → should return a
   pending confirmation (NOT execute); Confirm button commits it.
3. **Live LeetCode pull**: set `LEETCODE_USERNAME`, click Refresh on Trackers
   (or restart the app — catch-up runs it) → real stats land.
4. **LLM categorization**: copy `samples/*.csv` into `statements/`, click Import
   on the Finance tab → results should say "categorized by llm" instead of
   "rules". Then try a real bank CSV; if its columns aren't recognized the error
   names the headers it saw.
5. **PDF ingest** (best-effort parser): drop a real statement PDF; if no rows are
   recognized you'll get a clear "export as CSV" error rather than bad data.

## Known limitations / notes

- Amount convention: negative = money out. If your bank exports charges as
  positive with a separate debit/credit column, both layouts are handled; a
  single all-positive "Amount" column would import spend as income — check the
  first import.
- `log_leetcode` (manual agent tool) adds `count` to the last known total and
  carries the streak; the daily pull is the authoritative source.
- pdf-parse v2 (`2.4.5`) is installed but untested against a real bank PDF.
- Dark mode: chart/heatmap colors have validated dark variants keyed off the
  shadcn `.dark` class, but the app has no theme toggle yet (always light).

## Phase 4 — your decision needed before building (per CLAUDE.md)

**Google OAuth path** (pick one, then Phase 4 can start):
1. **Testing mode** — zero setup beyond OAuth client, but refresh tokens die
   every ~7 days → weekly re-login. Fine to start.
2. **Publish the app** (Calendar scopes are doable) — one-time verification
   hassle, tokens persist. Best long-term for a personal Gmail account.
3. **Google Workspace "Internal"** — no expiry, but only if you have a Workspace
   account (not plain Gmail).

If you're on a regular @gmail.com account (arshatehrani06@gmail.com), the real
choice is 1 (accept weekly re-auth) vs 2 (publish once). Recommendation: start
with 1 to get building, publish later if the weekly re-auth annoys you.

Also needed for Phase 4: `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` (create an
OAuth client, redirect `http://localhost:3000/api/google/callback`), a
`FINNHUB_API_KEY` or `ALPHAVANTAGE_API_KEY` (free tier), and `OBSIDIAN_VAULT_PATH`.
