# Automated dividend detection (fix-plan-3 Phase 6)

Scans portfolio tickers daily for a dividend going ex **today**, locks in the
held share count, and inserts a **pending** payout that only counts toward
the dividend running total on the **payment date** — cash you're entitled to
is not cash in hand until it lands. Manual entry stays fully available and
unchanged: Yahoo is an unofficial API, and the manual path is the always-
working fallback (the same posture as LeetCode's manual entry and the
Yahoo-history chart's calm degraded state).

## Step 0 — the field mapping, verified empirically (2026-07-10)

Yahoo's field names are not self-explanatory (its own web UI labels what is
actually the *payment* date as "Dividend Date"), so the mapping was verified
against real tickers and a real public source before anything was wired —
never assumed from the field name.

`yahooFinance.quoteSummary(ticker, { modules: ["calendarEvents", "summaryDetail"] })`
on 2026-07-10 (yahoo-finance2 3.15.4), three tickers — AAPL as the classic
control, GOOGL and META because they're real holdings in this portfolio:

| ticker | `calendarEvents.exDividendDate` | `calendarEvents.dividendDate` | `summaryDetail.dividendRate` | trailing rate |
|---|---|---|---|---|
| AAPL | 2026-05-11 | 2026-05-14 | 1.08 | 1.04 |
| GOOGL | 2026-06-08 | 2026-06-15 | 0.88 | 0.84 |
| META | 2026-06-15 | 2026-06-25 | 2.10 | 2.10 |

Cross-checked against **Apple's own investor-relations dividend history page**
(investor.apple.com/dividend-history), fetched the same day:

> Declared April 30, 2026 · Record date **May 11, 2026** · Payment date
> **May 14, 2026** · **$0.27** per share (Regular Cash)

Verdict, recorded for the record:

- **`calendarEvents.exDividendDate` = the ex-dividend date.** Yahoo's
  2026-05-11 equals Apple's record date — under T+1 settlement (US markets
  since May 2024) the ex-date and record date coincide, so this is
  consistent, and it is always the *earlier* of the two Yahoo dates.
- **`calendarEvents.dividendDate` = the payment date.** Yahoo's 2026-05-14
  is exactly Apple's stated payment date. (This is the field Yahoo's web UI
  calls "Dividend Date" — the non-obvious direction to get backwards, now
  pinned.)
- **`summaryDetail.dividendRate` is the forward ANNUALIZED rate, not a
  per-payment amount** — AAPL's 1.08 is 4 × the $0.27 quarterly payment, not
  $0.27. It is therefore NOT usable as the upcoming payment's amount.
- **Per-payment amounts come from chart events.**
  `chart(ticker, { events: "dividends", ... })` returns actual historical
  per-payment amounts keyed by ex-date — AAPL's most recent event is
  `{ amount: 0.27, date: 2026-05-11 }`, matching Apple IR's $0.27 exactly
  (and GOOGL's `{0.22, 2026-06-08}` matches its raised quarterly dividend).

**Amount fallback rule:** since no reliable *forward* per-payment figure is
exposed, the automation uses the **most recent actual per-share amount** from
the ticker's chart dividend events as an **estimate**, labeled as such in the
row's note and shown with the same "this is approximate" honesty the photo
macro estimates get. A company that changes its dividend between payments
will be off by the delta until the user corrects the row by hand (manual
upsert on the same ticker+ex-date wins).

## Schema

`dividend_log` (existing table — extended, not replaced; the plan's guessed
name `dividends` was wrong, and its "(ticker, ex_date) uniqueness guard"
requirement turned out to already exist as the table's original
`UNIQUE(ticker, ex_date)`):

- `status TEXT NOT NULL DEFAULT 'confirmed'` — `pending` | `confirmed`.
  Existing manual rows default to `confirmed`: a human typed them in after
  the fact.
- `payment_date TEXT` — nullable; manual entries may not have one.
- `source TEXT NOT NULL DEFAULT 'manual'` — `manual` | `yahoo_auto`.

Dedupe: the existing `UNIQUE(ticker, ex_date)`. The automation inserts with
`ON CONFLICT DO NOTHING` — an existing row of either source wins, so a
repeated cron tick can't duplicate, a hand-logged dividend never gets an
auto twin, and a hand-corrected auto row is never clobbered by the next tick.

## The daily job

`dividend-scan`, 07:00 daily (ahead of market open) + catch-up-on-launch.
**Deliberately NOT the 15-minute stock-refresh cadence the original ask
suggested**: an ex-dividend date changes at most once a day, so 15-minute
checks would be ~96 unofficial-API calls per ticker per day for information
that is stale after the first — flagged as a deviation, reasoning stated.

Per run: for each distinct `holdings` ticker (each wrapped in its own
try/catch — one ticker's failure never blocks the rest, the LeetCode-puller
posture), fetch `calendarEvents`; if the verified ex-date field equals
today (the same `toISOString().slice(0,10)` "today" the rest of the app
uses) and no `(ticker, ex_date)` row exists, insert
`{ status: 'pending', source: 'yahoo_auto', payment_date, shares_at_date:
<current holdings.shares>, amount_per_share: <estimate above> }`.

**Known limitation (stated, not papered over):** `shares_at_date` is the
last-imported-statement share count, not a true point-in-time balance as of
market open on the ex-date — Jarvis has no live brokerage feed, only
periodic statement imports. If shares changed since the last import, the
captured count is off until corrected by hand.

Second pass, same run: every `pending` row with `payment_date <= today`
flips to `confirmed`.

## Pending vs confirmed — the actual point

`dividendSummary()`'s running total and per-holding breakdown count
**confirmed rows only**. A `pending` row renders in the Dividends card as an
entitlement (badge + expected payment date + a separate "+$X pending" line)
and contributes **zero** to the running total until promoted. This is the
one place getting it backwards would show a wrong number a user could act
on, so it has a direct unit test over a mixed pending/confirmed fixture.

(Note: net worth itself never folded dividend cash in — `networth.ts` and
`portfolio-total.ts` were checked and contain no dividend term; the running
total in the Dividends card is the only aggregate this touches.)

## Confirm-gating (CLAUDE.md rule 2) — reasoned, not assumed

The cron path writes financial data with no interactive confirm. This sits
with the existing automatic financial writes the app already ships
unconfirmed (the daily net-worth snapshot, the stock-quote cache warm), not
with `set_goal`/`revert_action`'s judgment-laden interactive writes: a
`pending` insert moves no total and is trivially hand-deletable; the
promotion is a pure date comparison, not a new financial judgment. So: no
confirm gate on the cron path. Revisit if it proves wrong in practice.
