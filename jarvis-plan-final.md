# Personal "Jarvis" Command Center — Finalized Build Plan (v3, merged)

One unified dashboard for your whole life — tasks, calendar, gym + LeetCode, finance, stocks, notes — plus a natural-language agent that can *act* on all of it. Runs **locally**, costs **$0**, keeps your sensitive data **on your machine**.

This is the master plan. Two companion files turn it into something Claude Code can execute:
- **`CLAUDE.md`** — drop into the repo root; Claude Code reads it automatically as persistent project context.
- **`jarvis-phase1-kickoff.md`** — the prompt you paste into Claude Code to start building, plus short kickoff stubs for the later phases.

---

## 0. The one decision, and why

Your v1 was hosted (Vercel + Supabase + Claude API). Your v2 was local + free (localhost + SQLite + Ollama). Finalized answer: **local-first foundation, with a pluggable LLM layer.**

Why local-first wins for *this* app specifically:
- **Finance privacy is free.** Statements, transactions, and categorization never leave your laptop. This is your most sensitive data; local removes the entire question.
- **Obsidian is trivial.** Read the vault folder straight off disk. No GitHub-repo workaround, no sync plugin.
- **It's actually $0.** No hosting bill, no API bill.

What we borrow from v1 (the hosted plan was better at these):
- The richer **data model** (§4).
- The **agent tool** design and the golden rules about secrets and one-source-of-truth (§5, §8).
- The **quality-of-life features** that shape the app: a composed *Today* view, a `goals` table, confirmation on money/destructive agent writes, and a backup export (§9).

The one hedge so you're never boxed in: the **LLM layer is an abstraction** (§3). Ollama is the default (free, private). Flip `LLM_PROVIDER=anthropic` and it uses the Claude API instead — better tool-calling when you want it, no rewrite. Same seam makes a future move to hosting a config change, not a redesign.

**In scope now:** tasks, agent, gym, LeetCode, finance, notes, stocks, calendar.
**Deferred (free when you add them):** Slack capture bot, real-time push sync, always-on 24/7, email triage. See §7.

---

## 1. Architecture (all on your machine)

```
   Browser (localhost:3000)
        │
        ▼
   ┌────────────────────────────────────────────┐
   │        Next.js app (your laptop)            │
   │                                             │
   │   UI ── tabs, charts, Today view, chat box  │
   │                                             │
   │   API routes:                               │
   │    /api/agent    → LLM (validated tools) ───┼──► lib/llm  →  Ollama (localhost:11434)  [default, free]
   │    /api/finance  → parse + categorize       │              └ or Anthropic API [optional, env flag]
   │    /api/google   → Calendar (OAuth)      ───┼──► Google Calendar API
   │    /api/notes    → read/append vault     ───┼──► ~/ObsidianVault (disk)
   │    /api/stocks   → quotes                 ──┼──► Finnhub / Alpha Vantage (free tier)
   │    /api/tasks, /api/gym, /api/leetcode      │
   │                                             │
   │   Background worker (node-cron, in-process) │───► stock refresh, leetcode pull, calendar poll
   │        + catch-up-on-launch                 │      (every job also runs once at startup)
   └───────────────────┬─────────────────────────┘
                       ▼
        SQLite file (jarvis.db)  +  /statements (CSV/PDF on disk)
```

---

## 2. Stack (final)

- **Framework:** Next.js (App Router, TypeScript). UI + backend in one repo.
- **Database:** SQLite via `better-sqlite3` (synchronous, zero-config, one file on disk).
- **LLM:** Ollama (default) behind a provider abstraction; Anthropic API optional via env.
- **UI:** Tailwind + shadcn/ui; Recharts for charts.
- **Scheduling:** `node-cron` in-process, plus catch-up-on-launch so gaps self-heal.
- **Market data:** Finnhub or Alpha Vantage (free tier).
- **Validation:** `zod` for tool-call args and API input.

All free, all local. (Claude Code should pin the current stable version of each at build time rather than trust versions written here.)

---

## 3. The LLM layer (Ollama by default, Claude optional)

Two models, never confused:
- **Build-time — Claude Code (Fable):** writes the code once.
- **Runtime — Ollama (or Claude API):** categorizes transactions and powers the agent, forever.

One module, `lib/llm.ts`, exposes a single `chat({ messages, tools })` function and routes by `LLM_PROVIDER`:
- `ollama` (default): OpenAI-compatible endpoint at `localhost:11434`.
- `anthropic`: Anthropic API, if you set a key.

**Model choice by RAM (Ollama):** 16 GB → a 7–8B tool-capable model; 24–32 GB → ~14B; 32 GB+/GPU → ~32B. Check `ollama.com/library` for the current recommended tool-calling model at setup time.

**Honest caveat:** local models do tool-calling but are flakier at it than Fable/Claude. Three mitigations, all mandatory in the build:
1. Keep the tool set small and descriptions crisp.
2. **Validate every tool call** (parse args against a zod schema) *before* executing. Never run a call you didn't parse and sanity-check.
3. Require **confirmation** for money-related or destructive actions before they commit.

Categorization (the finance part) is easy and works well even on 7–8B.

---

## 4. Data model (SQLite starter tables)

Booleans as `0/1`, timestamps as ISO text or epoch ms, JSON blobs as `TEXT`.

| Table | Key columns |
|---|---|
| `tasks` | id, title, due_at, priority, status, source, created_at |
| `agent_log` | id, user_text, tool_calls (json), result, created_at |
| `gym_logs` | id, date, notes |
| `leetcode_stats` | id, date, total_solved, streak, recent (json) |
| `transactions` | id, date, amount, merchant, category, raw_description, statement_id, is_recurring |
| `statements` | id, month, file_path, imported_at |
| `holdings` | id, ticker, shares, cost_basis |
| `watchlist` | id, ticker |
| `calendar_cache` | id, google_event_id, title, start, end, updated_at |
| `oauth_tokens` | provider, access_token, refresh_token, expires_at |
| `goals` | id, kind, target, period  (e.g. savings_rate, gym_days_per_week, leetcode_per_week) |

`goals` is first-class on purpose: finance cut-back tips and tracker nudges measure against real targets instead of vibes.

---

## 5. The agent (the "talk to it like Jarvis" part)

An LLM with tool-use: you describe functions, it reads your sentence and calls the right ones. `"Remind me to submit the form Friday and log gym today"` → two tool calls in one turn.

Tool set (add per phase, not all at once):

- `add_task(title, due?, priority?)`
- `log_gym(date?, notes?)`
- `log_leetcode(date?, count?, problems?)`
- `create_calendar_event(title, start, end, notes?)`
- `set_reminder(text, when)` → implemented as a calendar event
- `append_note(path, text)` → Obsidian
- `query_finance(question)` / `query_notes(question)`

**Flow:** user text → `/api/agent` → `lib/llm.chat` with the tool list → model returns tool calls → **validate args (zod)** → **confirm if money/destructive** → execute → log to `agent_log` → return confirmation.

**Golden rules:**
- Never execute an unvalidated tool call.
- Log every tool call to `agent_log`; show undo/confirm for destructive or money actions.
- Google Calendar is the **single source of truth** — read it back, never bidirectionally reconcile two mutable calendars.
- Secrets (API keys, OAuth tokens) live server-side only. Never ship them to the browser. Never commit `.env`.

---

## 6. Phased roadmap — BUILD NOW (ship at each phase)

Ship and *use* each phase before starting the next. A Jarvis you use at Phase 1 beats a perfect one you never finish.

**Phase 1 — Spine (weekend).**
Next.js + SQLite. Dashboard shell with tabs (mock data first so it feels real). **Tasks** CRUD on real DB data. **Agent chat box → LLM** with exactly one tool, `add_task`, with validation. Done when `"add a task to review my budget Friday"` lands in the Tasks list.

**Phase 2 — Trackers (week 1).**
**Gym** log → GitHub-style contribution heatmap. **LeetCode** daily pull via the unofficial `leetcode.com/graphql` endpoint by username (keep a manual-entry fallback — unofficial APIs break). Add tools `log_gym`, `log_leetcode`. Wire the first cron job + catch-up-on-launch.

**Phase 3 — Finance (weeks 2–3). The meatiest module — give it room.**
- Drop a statement CSV in `/statements` (PDF → parse to text first, then treat as rows).
- Ingest → LLM assigns categories → save to `transactions`.
- Views: spend by category (this vs last month); **recurring-charge detection** (same merchant + similar amount + ~monthly → your subscriptions); income vs. spend vs. invested if tagged; cut-back suggestions measured against `goals`.
- Redact account numbers on ingest. It never leaves your machine anyway.

**Phase 4 — Notes, Stocks, Calendar (week 4).**
- **Obsidian:** read the vault off disk — surface today's daily note, search, let the agent `append_note`.
- **Stocks:** `holdings` + `watchlist`; free-API quotes on open and on the 15-min cron; show value / P&L / day move; cache to respect rate limits.
- **Google Calendar:** OAuth from localhost; read + display; `create_calendar_event`; reminders written as calendar events (free phone notifications). **Poll** on open + hourly (Google = source of truth).

At the end of Phase 4 you have the whole thing you described, for $0.

**Woven throughout:** the **Today** view (§9) — build it early with whatever data exists and let each phase feed it.

---

## 7. Deferred (free when you add them)

- **Slack capture bot.** Needs a public endpoint → a free tunnel (Cloudflare Tunnel / ngrok). The in-app chat covers the same need until then.
- **Instant push sync** (edit in Google → appears here immediately). Needs `events.watch` → a public webhook (same tunnel). Polling replaces it for free now.
- **Always-on 24/7.** Repurpose an old laptop / Raspberry Pi as a home server so jobs run while your main machine sleeps.
- **Email triage.** Doable for free, but Gmail `readonly` is a *restricted* scope with extra OAuth friction — defer until the rest is solid.

---

## 8. Hard/annoying bits to know upfront

- **Laptop "continuous" = while awake and running.** Lid closed → cron pauses. Mitigation baked in: **every job also runs once at launch**, so gaps self-heal. True 24/7 is the deferred home-server upgrade.
- **Google OAuth token expiry (bites everyone).** While your Google Cloud app is in "testing" mode, refresh tokens for Calendar expire after ~7 days → periodic re-auth. Options: (a) accept weekly re-login; (b) publish the app (Calendar is doable); (c) Google Workspace "Internal" app → no expiry. Pick before building Calendar.
- **Two-way sync conflicts:** avoid entirely. One source of truth (Google) + read-back.
- **Unofficial APIs (LeetCode) break:** wrap them, log failures, keep a manual fallback.
- **Rate limits / LLM cost:** cache aggressively (stocks, categorization). Only process new/changed data.
- **Secrets:** server-side env / DB only; never in the browser; never commit `.env`.

---

## 9. Quality-of-life features folded in

- **A single "Today" view** composing everything: today's events, top 3 tasks, gym/LeetCode status, notable finance/portfolio deltas. Your actual homepage.
- **Goals as first-class data** (`goals` table) so cut-back tips and nudges measure against real targets.
- **Undo / confirm on agent writes:** every tool call logged to `agent_log`; confirmation for money/destructive actions before commit.
- **Local backup export:** a button that dumps all data to JSON — never locked in.
- **Command palette (⌘K):** faster than the chat box once you live in it. (Nice-to-have; after Phase 4.)
- **Weekly digest (deferred-adjacent):** a cron job that has the LLM write a Monday summary (last week's spend, streaks, upcoming week) into a note.
