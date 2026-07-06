# HANDOFF — updated after Phases 9–15 (2026-07-06)

Phases 1–15 are built and committed. This run (9–15) again had no live Ollama
and no credentials; everything marked *deferred* needs your keys and a
walkthrough. Every phase closed on green `npm run build` + `npm run typecheck`;
`npm test` runs **19 passing unit tests**. Test data was cleaned — first boot
starts with a fresh DB.

## Commits (this run)

| Commit | What |
|---|---|
| `73c011c` | Phase 9: Fidelity brokerage CSV → holdings |
| `0db5a62` | Phase 10: recurring-bill radar + renewal→calendar |
| `f096873` | Phase 11: goals dashboard |
| `1bb1e8c` | Phase 12: ask & search (`query_finance` + global search) |
| `7f136eb` | Phase 13: morning brief + streak-risk alerts |
| `2b1c628` | Phase 14: fuller weekly digest → Obsidian |
| `7970553` | Phase 15: Gmail flag → one-click task |

(Phases 5–8: `99439a9`…`8eca66b`; phases 1–4: `d073f60`…`5526d55` — see git log.)

## What this run built

- **Brokerage import (P9).** Drop a Fidelity *Positions* export (or an
  Accounts-history CSV) into `statements/` and hit Import on the Finance tab —
  the header is sniffed, rows upsert `holdings` (ticker/shares/per-share cost
  basis), the `SPAXX**` suffix and Pending-Activity rows are handled, account
  numbers are never persisted, and re-imports update instead of duplicating.
  Import is strictly upsert (never deletes), so multiple accounts or manual
  holdings coexist. `samples/fidelity-positions-synthetic.csv` is the test file.
- **Bill radar (P10).** Deterministic: next-renewal ETA per subscription from
  its median gap, "renews in ~N days" (≤14) and "+N% price jump" (>10% vs the
  usual) flags; Finance-page section + hub Bills card. The recurring-detection
  amount band widened 15%→25% so a priced-up subscription stays detected while
  the radar flags the jump. Renewal→calendar is propose-then-confirm: check the
  renewals, click once, and events are created through the `create_calendar_event`
  tool (re-validated, logged to `agent_log`) — nothing is auto-created.
- **Goals dashboard (P11).** `/goals` shows every target — savings rate, gym
  days, LeetCode/week, average sleep (new `sleep_hours` goal kind), plus each
  habit's weekly goal — with actuals computed from the real tables, rings for
  counts, bars for rates, inline target editing via the existing goals CRUD,
  and a hub "X/Y on track" card.
- **Ask & search (P12).** `query_finance` agent tool: the model fills a
  zod-validated args object (metric/category/merchant text/month/date range)
  and a **pure, parameterized query builder** runs it — the model can never
  emit SQL; 7 unit tests cover LIKE-escaping and injection text staying in
  bound params. `/search` is a deterministic global search across tasks,
  transactions, mail, people, reading, career, habits, and Obsidian notes,
  grouped with links.
- **Morning brief (P13).** 08:00 Slack cron (+ catch-up, 1/day marker):
  today's events, top 3 tasks, overdue follow-ups, important-unread count, and
  streak-risk warnings ("gym 1/4 this week, 2 days left") computed against the
  calendar week. Assembled deterministically; `lib/llm.chat` only rephrases,
  with the plain rendering as fallback. Preview at `GET /api/brief`; manual
  send via `POST /api/slack {"action":"send_brief"}`.
- **Fuller weekly digest (P14).** The Sunday-night job now writes spend by
  category **with prior-week deltas**, goal/streak summary, net-worth weekly
  move, upcoming week's events + follow-ups, and overdue people. When no model
  is running it appends the structured markdown itself instead of skipping the
  week. Verified end-to-end on a dummy vault. `GET /api/digest` previews;
  `POST {"action":"run","force":true}` re-runs.
- **Mail → task (P15).** "Make task" on any triaged message creates
  `Reply: <subject> — <sender>` in the local tasks table through the
  `add_task` handler (source badge "mail", open-task dedupe). Optional LLM
  due-date suggestion defaults to no due date without a model. Gmail remains
  read-only + drafts.

## Deferred tests (new this run — see the P5–8 list in git history for the rest)

Credential-dependent: real Fidelity Positions/history export through Import
(then Finnhub key → value/P&L/day-move fill in); renewal events landing in
Google Calendar after connecting it; morning brief + check-in DMs with a Slack
token; radar on your real statements.

LLM-dependent: agent using `query_finance` end-to-end ("how much did I spend
on food in June?"); brief LLM phrasing (fallback already verified); digest LLM
prose (structured fallback already verified on the dummy vault); LLM
due-date suggestion on Make-task.

Visual: eyeball `/goals`, `/search`, and the Finance bill-radar section.

## Env vars — unchanged from Phases 5–8

Same table as before: `LLM_MODEL` + Ollama, `LEETCODE_USERNAME`,
`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` (redirect URIs for both
`/api/google/callback` and `/api/mail/callback`), `FINNHUB_API_KEY`,
`OBSIDIAN_VAULT_PATH`, `SLACK_BOT_TOKEN`/`SLACK_USER_ID`
(+ `SLACK_SIGNING_SECRET` behind the tunnel). Nothing new was added this run.

## Back-burner (unchanged, per the ACCESS NOTE)

Cross-device access/tunnel, Slack inbound runtime, Gmail push. All recorded in
the P5–8 handoff section of git history; nothing this run depends on them.

## Known limitations

- Brokerage history reconstruction is best-effort (net quantity +
  buy-weighted average cost); the Positions export is the reliable path and
  the error messages steer there.
- Bill-radar ETAs assume roughly steady billing cycles; annual subscriptions
  need two occurrences (~2 years of data) to register.
- Streak-risk math uses the calendar week (Mon–Sun) while the goals dashboard
  shows rolling 7-day actuals — the brief can flag a risk the dashboard ring
  doesn't show yet; both are labeled.
- Global search is LIKE-based (no fuzzy matching/stemming), capped at 8 hits
  per source.
- `query_finance` totals follow the statement convention (negative = money
  out) and exclude Transfers (and Investments from "spend").
