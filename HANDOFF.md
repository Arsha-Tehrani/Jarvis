# HANDOFF — updated after Phase 4 (2026-07-05)

All four phases are **built, verified as far as possible without live
credentials/models, and committed**. The app is feature-complete per
`jarvis-plan-final.md` §6. What remains is filling in your keys and running the
deferred-tests checklist below.

## Commits

| Commit | What |
|---|---|
| `d073f60` | Phase 1: spine — Next.js + SQLite, Tasks CRUD, agent with validated `add_task` |
| `fcfda2c` | Phase 2: trackers — gym heatmap, LeetCode pull + fallback, cron worker |
| `f361964` | Phase 3: finance — statement ingest, categorization, views, goals |
| `deaa6e9` | HANDOFF (phase 1–3 version) |
| `5526d55` | Phase 4: notes, stocks, calendar + backup export |
| (this file) | HANDOFF update |

Every phase finished on a green `npm run build` + `npm run typecheck`.
`jarvis.db` and the temp test env were deleted after verification — first boot
starts clean and recreates the schema.

## What Phase 4 added

- **Google Calendar (Testing mode, as you decided)**: Connect button on the
  Calendar tab → Google OAuth (CSRF state cookie) → redirect
  `http://localhost:3000/api/google/callback` → tokens in `oauth_tokens`
  (server-side only). Polls on app open + hourly (`lib/cron.ts`), read-back
  into `calendar_cache` — Google is the single source of truth, no webhooks.
  Access tokens auto-refresh; when the ~weekly testing-mode refresh token dies
  you get a clear "reconnect from the Calendar tab" error, not a crash.
- **Stocks**: holdings + watchlist with value / P&L / day move. Finnhub
  preferred, Alpha Vantage fallback; 15-minute in-memory quote cache + 15-min
  cron refresh (+ launch catch-up) keeps free tiers happy. No key → tab still
  works for tracking, quotes show a clear error.
- **Obsidian Notes**: today's daily note (found wherever it lives in the
  vault), recently edited list, content search with snippets, note viewer.
  Appends are additive-only and path-traversal-guarded.
- **Agent tools**: `append_note` (defaults to today's daily note),
  `create_calendar_event`, `set_reminder` (15-min calendar event → free phone
  notification). All zod-validated like everything else.
- **Today view**: today's events (from the poll cache) + portfolio day move
  (from the quote cache — no network during render).
- **Backup**: "Backup ↓" button in the header downloads a JSON dump of all 10
  tables and writes a copy to `backups/`; `npm run backup` does the same from
  the CLI. `oauth_tokens` is deliberately excluded from dumps.

## Env vars you still need to fill in (.env.local)

```
cp .env.example .env.local   # then fill in:
```

| Var | Needed for | Where to get it |
|---|---|---|
| `LLM_MODEL` (+ Ollama running) | agent chat, finance categorization | `ollama pull` a tool-capable model |
| `LEETCODE_USERNAME` | daily LeetCode pull | your leetcode.com username |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Calendar | Google Cloud Console → OAuth client (Web), **redirect URI exactly** `http://localhost:3000/api/google/callback`, app in *Testing* mode, add yourself as a test user |
| `FINNHUB_API_KEY` (preferred) or `ALPHAVANTAGE_API_KEY` | stock quotes | finnhub.io / alphavantage.co free signup |
| `OBSIDIAN_VAULT_PATH` | Notes tab | absolute path to your vault folder |

`LLM_PROVIDER`/`LLM_BASE_URL` defaults already point at local Ollama;
`ANTHROPIC_API_KEY` only if you flip `LLM_PROVIDER=anthropic`.

## Deferred tests — the full checklist

LLM-dependent (from phases 1–3):
1. Live agent turn: "add a task to review my budget Friday" → task lands with
   Friday's date; turn in `agent_log`.
2. Confirm gate live: "set my savings goal to 30%" → pending confirmation
   appears (must NOT auto-execute); Confirm commits it.
3. LLM categorization: copy `samples/*.csv` into `statements/`, Import on the
   Finance tab → "categorized by llm" instead of "rules".

Credential-dependent (new in Phase 4):
4. Real Google login: Calendar tab → Connect → sign in → lands back on
   /calendar?google=connected with upcoming events listed; `oauth_tokens` has
   a row; restart the app → catch-up poll logs `[google] calendar poll ok`.
5. Agent event + reminder: "put lunch with Sam on my calendar Friday at noon"
   and "remind me to submit the form at 5pm" → both appear in Google Calendar
   (reminder as a 15-min ⏰ event) and in the Calendar tab after the read-back.
6. Weekly-expiry path (whenever it happens): after ~7 days the Calendar tab
   should show the "reconnect" error and Connect should fix it.
7. Real quotes: add FINNHUB_API_KEY, add a holding → price/value/P&L/day move
   fill in; Today view shows portfolio day move after the next cron tick (or
   restart); `[stocks] refreshed N quotes` in the log every 15 min.
8. Real vault: set OBSIDIAN_VAULT_PATH → Notes tab shows your actual daily
   note and search works on your notes; "note down X" via the agent appends to
   today's daily note.
9. LeetCode live pull (from Phase 2): set LEETCODE_USERNAME → Refresh.

Verified this run (no credentials needed): all tabs render with graceful
unconfigured states; notes daily-note/search/append on a dummy vault incl.
default-append finding the existing daily note; path traversal rejected;
agent `append_note` executes, calendar tools fail cleanly when unconnected and
reject invalid args; stocks CRUD + no-key error state; google endpoints return
actionable 409s; OAuth callback rejects a bad CSRF state; backup button and
`npm run backup` both dump all 10 tables; all three new cron jobs schedule and
catch-up-skip cleanly at launch.

## Known limitations / notes

- Statement amount convention: negative = money out (debit/credit column
  layouts handled; an all-positive single-amount CSV would read as income).
- PDF statement parsing is best-effort (pdf-parse v2); clear "export as CSV"
  error when nothing parses.
- The Notes/Calendar/Stocks tabs assume one user on localhost — no auth on the
  API routes (same as the rest of the app, by design).
- `npm run backup` prints a harmless Node module-type warning.
- Dark mode styles exist but there's no theme toggle yet (app renders light).
- Deferred by plan (§7 — do not build yet): Slack capture, push sync, 24/7
  host, email triage, command palette, weekly digest.
