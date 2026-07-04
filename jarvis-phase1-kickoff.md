# Claude Code kickoff prompts — Jarvis

How to use this file:
1. Put `CLAUDE.md` and `jarvis-plan-final.md` in your (empty) project folder.
2. Open Claude Code in that folder with the Fable model selected.
3. Paste the **Phase 1 prompt** below. Build, run, use it.
4. When Phase 1 is solid, paste the next stub. One phase at a time — this is deliberate.

---

## ▶ PHASE 1 — Spine (paste this first)

```
You are building a local-first personal dashboard called Jarvis. Read CLAUDE.md and
jarvis-plan-final.md in this repo before doing anything — they are the source of truth,
especially the "Non-negotiable rules" in CLAUDE.md.

Goal for THIS session (Phase 1 only — do not build later phases):
Stand up the spine of the app: a Next.js + SQLite project, a dashboard shell, a working
Tasks feature on real DB data, and an agent chat box wired to the LLM with exactly one
validated tool, add_task.

Do it in these steps, and after each step run the app / typecheck and confirm it works
before moving on:

1. Scaffold: create-next-app (App Router, TypeScript), add Tailwind + shadcn/ui,
   better-sqlite3, zod, node-cron. Set up .gitignore for .env*, jarvis.db, /statements,
   and the vault path. Add a .env.example with the env vars listed in CLAUDE.md.

2. lib/db.ts: better-sqlite3 connection + a migration run on startup. For Phase 1 create
   only the `tasks` and `agent_log` tables (schemas per CLAUDE.md).

3. lib/llm.ts: the provider abstraction exactly as specified in CLAUDE.md — one chat()
   function, routed by LLM_PROVIDER, defaulting to Ollama's OpenAI-compatible endpoint.
   Include the Anthropic branch behind the env flag but you don't need a key to build it.

4. Dashboard shell: a layout with tabs for Today, Tasks, Trackers, Finance, Stocks, Notes,
   Calendar. Only Today and Tasks are real this phase; the rest are placeholder pages.
   The Today view can start minimal (it will show top tasks now, more later).

5. Tasks: /api/tasks (CRUD) against the real DB, and a Tasks tab UI to add / list / complete /
   delete tasks. No mock data once this is wired.

6. lib/tools.ts: a tool registry with exactly one tool, add_task, including its zod schema,
   a crisp description, and requiresConfirm=false.

7. /api/agent: takes user text → calls lib/llm.chat with the add_task tool → validates the
   returned tool-call args with the zod schema (never execute an unvalidated call) →
   executes → writes the turn to agent_log → returns a confirmation. Add a chat box in the UI
   that posts here.

Definition of done (verify all before you stop):
- App runs at localhost:3000. Typecheck passes.
- I can add, complete, and delete tasks in the Tasks tab and they persist across restart.
- Typing "add a task to review my budget Friday" in the chat box makes a task appear in the
  Tasks list, with a due date parsed to Friday.
- An invalid/garbled tool call is rejected by validation instead of executing.
- Every agent turn is recorded in agent_log.

Constraints: secrets server-side only; no keys in client code; don't scaffold Phase 2+
tables or features. Before any large structural change, show me a 3–5 bullet plan and wait.

When done, run it, then give me a short summary of what exists and how to test it manually.
```

---

## ▶ PHASE 2 — Trackers (paste when Phase 1 is solid)

```
Phase 1 is working. Now build Phase 2 (Trackers) only. Follow CLAUDE.md rules.

- Add gym_logs and leetcode_stats tables.
- Gym: /api/gym + a "went today" button, and a GitHub-style contribution heatmap on the
  Trackers tab (Recharts or a small custom grid).
- LeetCode: /api/leetcode that pulls a public profile from the unofficial
  leetcode.com/graphql endpoint by username (total solved, streak, recent accepted).
  Wrap it defensively, log failures, and keep a manual-entry fallback that always works.
- lib/cron.ts: set up node-cron with a daily LeetCode pull, AND catch-up-on-launch so every
  job also runs once at startup. Wire the worker into the dev server.
- Add tools log_gym and log_leetcode to the registry (validated), so the agent can log them.
- Feed gym + LeetCode status into the Today view.

Done when: I can log gym via button or agent and see the heatmap update; LeetCode stats show
and refresh on the daily job + on launch; killing and restarting the app runs the catch-up.
Show me the plan first if anything is structural. One phase only.
```

---

## ▶ PHASE 3 — Finance (paste when Phase 2 is solid)

```
Phase 3 (Finance) only. This is the meatiest module — take it carefully. Follow CLAUDE.md,
especially privacy and money-confirmation rules.

- Add transactions and statements tables, and a goals table.
- Ingest: read a statement CSV from /statements (support PDF by parsing to text first, then
  treating rows the same way). Redact account numbers on ingest.
- Categorize: feed transaction lines (not identity-laden full PDFs) to lib/llm.chat to assign
  categories; store in transactions.
- Views on the Finance tab: spend by category (this month vs last), recurring-charge detection
  (same merchant + similar amount + ~monthly cadence → subscriptions list), income vs spend vs
  invested if tagged, and cut-back suggestions measured against goals.
- Add a goals editor UI.
- Any agent tool that writes financial data requires confirmation before commit.

Done when: dropping a sample CSV in /statements imports + categorizes it; the category and
recurring views render; setting a savings goal changes the cut-back suggestions. One phase only.
```

---

## ▶ PHASE 4 — Notes, Stocks, Calendar (paste when Phase 3 is solid)

```
Phase 4 only: Notes, Stocks, Calendar. Follow CLAUDE.md — Google is the single source of
truth; secrets server-side; poll, don't push.

- Obsidian Notes: /api/notes reads the vault folder at OBSIDIAN_VAULT_PATH off disk. Surface
  today's daily note, basic search, and an append_note agent tool.
- Stocks: holdings + watchlist tables; /api/stocks pulls quotes from Finnhub/Alpha Vantage on
  load and on a 15-min cron job; cache to respect free-tier limits; show value, P/L, day move.
- Google Calendar: OAuth from localhost (scope calendar/calendar.events); store tokens in
  oauth_tokens; read + display upcoming events; a create_calendar_event tool; set_reminder
  implemented as a calendar event. Poll on open + hourly. Do NOT set up webhooks/push.
- Feed today's events + portfolio day-change into the Today view.
- Add a backup export script/button that dumps all tables to JSON.

Before starting, tell me which Google OAuth path I should pick (weekly re-auth vs publish vs
Workspace Internal) per CLAUDE.md, and wait for my answer. Then build. One phase only.
Done when: notes/stocks/calendar tabs are live, the agent can create an event and append a
note, and the backup button produces a JSON dump.
```

---

## Tips while building

- If Claude Code drifts or over-builds, reply: **"Phase N only — stop and re-read the Non-negotiable rules in CLAUDE.md."**
- Before setting up Ollama, run `ollama list` / check `ollama.com/library` and pull a current tool-capable model sized to your RAM; set `LLM_MODEL` to it.
- Commit after each phase so you always have a working checkpoint to fall back to.
