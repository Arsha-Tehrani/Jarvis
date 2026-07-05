# HANDOFF — updated after Phases 5–8 (2026-07-05)

Phases 1–8 are built and committed. This run (5–8) had no live Ollama and no
credentials, so everything below marked *deferred* still needs your keys and a
walkthrough. Every phase finished on a green `npm run build` + `npm run
typecheck`; `npm test` runs 8 passing unit tests. The test DB was deleted —
first boot starts clean.

## Commits (this run)

| Commit | What |
|---|---|
| `99439a9` | Phase 5: minimalist hub restyle, PWA basics, responsive pass |
| `cd36aab` | 6a: sleep + health metrics (`log_metric`) |
| `f018590` | 6b: generic habits + shared heatmap (`log_habit`) |
| `72e1bf2` | 6c: career/job hunt (`add_application`, `advance_application`) |
| `1530cfa` | 6d: reading & learning (`add_to_reading_list`, /notes?path= links) |
| `96cbe86` | 6e: people/keep-in-touch (`log_contact`) |
| `876f60a` | 6f: net worth rollup (accounts + daily snapshots) |
| `946673c` | 6g: weekly digest (Sunday cron → LLM → daily note) |
| `1a913be` | Phase 7: Slack morning check-in |
| `8eca66b` | Phase 8: Gmail triage |

(Earlier: `d073f60` P1, `fcfda2c` P2, `f361964` P3, `5526d55` P4.)

## What this run built

**Phase 5 — restyle.** Tokens only (globals.css + card.tsx): light-neutral
page, white cards, single indigo accent, 1rem radius, soft shadows. Slim icon
sidebar (bottom bar on phones), top bar with page title + backup. Home is a
hub of metric cards (events, tasks, gym ring, sleep, habits, follow-ups,
people, reading, mail, spend, net worth, portfolio) — every card links to its
detail page. Sparkline component has the dotted-guide hover tooltip; RingGauge
is the one gauge card. PWA: manifest + generated icons; installable from
Chrome/Safari on the phone *later* — cross-device access itself is deferred
(see back-burner).

**Phase 6 — life areas.** Each follows the same pattern (table in lib/db.ts →
/api route → page → hub card → zod-validated agent tool):
- Health: sleep_hours / bedtime / weight / mood, one per day, trend charts.
- Habits: create habits, per-habit contribution heatmap, streaks, weekly goals.
- Career: applications by stage, follow-ups due, agent can add/advance.
- Reading: queue/reading/done, links into Obsidian notes (`/notes?path=`).
- People: contact cadence → overdue list, birthdays (reminders via the
  existing `set_reminder` tool through the agent).
- Net worth: manual accounts (debt subtracts) + holdings (cached quotes, cost
  basis as stated fallback), daily snapshot cron → over-time chart + weekly
  delta.
- Weekly digest: Sunday 21:00 cron (+ catch-up) gathers the week's facts →
  `lib/llm.chat` writes a short review → appended to today's daily note.
  Idempotent per week; while Ollama is down it logs and retries next launch.

**Phase 7 — Slack check-in.** Outbound works now: 08:30 cron (+ catch-up,
1/day marker) DMs the enabled questions (sleep/gym/leetcode toggles via
`/api/slack`). Inbound is code-complete but needs the deferred tunnel: signed
events webhook (`/api/slack/events`), replies answer pending questions in
order, deterministic parsers first (unit-tested), LLM only for ambiguity, all
writes through the existing tool handlers.

**Phase 8 — Gmail triage.** Multi-account OAuth (per-inbox token rows,
`gmail:<email>`), 30-min poll cron (+ catch-up) fetching From/Subject/snippet
metadata only, deterministic newsletter pre-filter, LLM triage into
Important / Can-wait / Noise with one-line reasons, bucketed Mail tab tagged
by inbox, hub card with important-unread count. Read-only; "Draft reply"
creates a Gmail draft (gmail.compose) only on click — nothing can ever send.

## Env vars still blank (.env.local)

| Var | For |
|---|---|
| `LLM_MODEL` + Ollama running | agent, categorization, triage, digest, draft replies |
| `LEETCODE_USERNAME` | daily LeetCode pull |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Calendar **and** Gmail. Redirect URIs needed on the OAuth client: `http://localhost:3000/api/google/callback` and `http://localhost:3000/api/mail/callback` |
| `FINNHUB_API_KEY` (or `ALPHAVANTAGE_API_KEY`) | quotes, net-worth market pricing |
| `OBSIDIAN_VAULT_PATH` | Notes tab, reading links, weekly digest |
| `SLACK_BOT_TOKEN`, `SLACK_USER_ID` | outbound morning DM |
| `SLACK_SIGNING_SECRET` | inbound webhook (tunnel-gated) |

**Slack app setup (outbound):** create an app at api.slack.com → OAuth scopes
`chat:write`, `im:write` → install to your workspace → copy the bot token
(xoxb-…) and your member ID (profile → three dots → Copy member ID). Test with
`POST /api/slack {"action":"send_now"}` or wait for the 08:30 cron.

**Gmail restricted-scope caveat:** `gmail.readonly` is a *restricted* Google
scope. In Testing mode with yourself as a test user it works without
verification (same weekly token expiry as Calendar), but publishing the app
would require a security assessment — stay in Testing mode for this. Add both
Gmail scopes when the consent screen asks.

## Deferred tests

LLM-dependent: live agent turn; confirm-gate on `set_goal`; finance
categorization on `samples/*.csv`; weekly digest content (`[digest]` log line
Monday-ish or on launch); mail triage buckets + reasons; draft-reply quality;
Slack ambiguous-answer fallback; agent use of the seven new Phase 6 tools.

Credential-dependent: Google Calendar connect/poll/event; Gmail link → poll →
triage → draft (then link a second account); LeetCode pull; real quotes (+ net
worth switching from cost-basis to market pricing); real vault (notes, reading
links, digest target); Slack morning DM.

Visual: eyeball the restyle on desktop + a phone (cards, sidebar/bottom nav,
charts, heatmaps); install the PWA from the browser menu and check the icon.

## Back-burner (explicitly NOT built this run, per the access note)

- **Cross-device access**: no LAN binding, no tunnel. When wanted: a
  Cloudflare Tunnel (or Tailscale for private-only) in front of
  localhost:3000, then the PWA works from the phone anywhere.
- **Slack inbound** rides that tunnel: expose `/api/slack/events`, set the
  Events API request URL to `<tunnel>/api/slack/events` (the url_verification
  handshake is implemented), subscribe to `message.im`, set
  `SLACK_SIGNING_SECRET`, and reply to a morning check-in to test end-to-end.
- **Gmail push notifications** (watch/webhooks) — polling covers it for now.
- Plan §7/§9 extras: 24/7 home server, email send, command palette.

## Known limitations

- Hub cards for habits/reading/mail appear only once that area has data.
- Slack inbound answers map to "yesterday" for gym/LeetCode and today for
  sleep — by design of the morning questions.
- Mail poll reads the 25 most recent INBOX messages per account per cycle;
  older backlog isn't imported.
- `npm test` prints a harmless module-type warning (package.json has no
  `"type"` field; adding one would affect other tooling).
- Statement amount convention unchanged (negative = money out); PDF ingest
  still best-effort.
