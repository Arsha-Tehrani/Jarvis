# HANDOFF — fix-plan-2 run (2026-07-09; runs before this are below)

Continuous run, no pause between phases (per this run's own instructions). Each
phase: root-caused in writing, fixed, tested (`node --test`), live-verified
against the actually-running dev app with synthetic data (inserted, exercised,
cleaned up — real data confirmed untouched unless a phase says otherwise), and
committed separately.

Baseline at the start of this run: 6 real statements / 111 real transactions
(grown since the previous run's 4/62 baseline — the user imported more real
statements between runs; not touched by this run except where a phase says
so).

## Phase 1 (2026-07-09): Re-Analyze vs Re-Analyze All — dual-open confirmation

**Bug:** clicking Re-Analyze on one statement opened its confirm card; then
clicking Re-Analyze All opened a *second* card alongside it instead of
replacing the first. Confirming All didn't dismiss the leftover single card,
which could then be confirmed against already-changed data.

**Root cause, confirmed by reading `components/finance-view.tsx`:** pending
confirmation state was two independent variables — `reanalyzePreview` (single)
and `reanalyzeAllPreviews` (all) — so both could be simultaneously non-null.
Nothing modeled "at most one pending action."

**Fix:** replaced both booleans with one pending-action value,
`{type:'single',statementId}|{type:'all'}|null`, via a small pure reducer in
new `lib/finance/reanalyze-ui-state.ts` (`reanalyzeUiReducer`, actions
`open_single`/`open_all`/`close`) — opening either kind of confirmation always
replaces whatever was pending. The component now gates each card's render on
`reanalyzePending?.type`, and confirm/cancel both dispatch `close`.

- 6 new tests in `tests/finance-reanalyze-ui-state.test.ts`: open single →
  open single on a different statement (first closes); open single → open
  all (single closes, all opens); open all → open single (all closes);
  confirm/close on all leaves nothing pending, no stale single card; cancel
  one → the other type opens cleanly afterward; close on an already-null
  state is a no-op. `npm test`: 193 passing (up from 187).
- **Live-verified** against the running dev app: dropped two synthetic
  checking CSVs into `/statements`, scanned, confirmed they imported (8
  statements total). Clicked Re-Analyze on one — single card showed. Clicked
  Re-Analyze All — screenshotted proof that **only the "all" card was
  visible**, the single card gone (the exact reported bug, now fixed).
  Clicked Cancel on the all-card — confirmed zero cards pending. Reopened a
  single card on the other synthetic statement, clicked Confirm — confirmed
  it cleared with no leftover card after. Deliberately did **not** click
  "Confirm Re-Analyze All" for real, since that would have re-run the
  (still-buggy, pre-Phase-2) classifier over all 6 real statements as a side
  effect of a Phase 1 UI test — out of scope for this phase. Cleaned up:
  deleted both synthetic statements (DB cascade) and their CSV files;
  confirmed back to the exact pre-test baseline (6 statements / 111
  transactions).

## Phase 2 (2026-07-09): account-type tagging — checking↔savings mislabel, Fidelity untagged

Two symptoms, one shared root: `lib/finance/classify.ts`'s `account_type`
sub-type scoring.

**Symptom A investigation:** dumped the user's actual (account-number-redacted)
`raw_text` for the real May statement (id 23, classified `savings`) and the
real June statement (id 28, classified `checking`) — confirmed by their own
running-balance chain (May's Ending Balance $4,573.81 = June's Beginning
Balance $4,573.81) that these are literally the **same Chase Total Checking
account**, two consecutive cycles. Grepping May's full extracted text for
`/savings?/i` found the trigger: page 4 carries Chase's standard
overdraft-protection disclosure, "*We offer Overdraft Protection through a
link to a Chase savings account, which may be less expensive...*" — a mention
of a **different, linked** account, not this statement's own type. June's
statement (6,737 chars, fully captured — no truncation) simply didn't include
that disclosure page that cycle. `SAVINGS_SIGNAL`'s old
`/Savings Account|Regular Savings|Statement Savings|Total Savings/i` matched
the boilerplate's "savings account" substring directly, and `detectSubKind`
checked `isSavings` before `hasCheckingStructure`, so the incidental phrase
won over "Chase Total Checking" + a full Beginning/Ending Balance structure.
Real content difference, not a logic bug — confirmed per the fix-plan's own
instruction to settle which before fixing.

**Symptom B investigation:** `lib/finance/ingest.ts`'s `importBrokerage`
called `recordStatement(file, statementMonth, "brokerage", rawText)` — no
5th (`accountType`) argument, ever. Confirmed directly: not a
misclassification, `account_type` was simply never set for any
`brokerage`-kind statement, full stop.

**Fixes:**
1. `SAVINGS_SIGNAL` tightened to `/Regular Savings|Statement Savings|Total Savings|Savings Summary/i`
   — header-style phrases that name *this* statement's own account, never a
   bare "Savings Account" mention that can appear in unrelated prose. The
   existing `SAVINGS_PDF` fixture ("Chase Savings" / "Regular Savings Account
   Summary") still matches via "Regular Savings", so genuine savings
   detection is unaffected.
2. **Manual override**: a small `<select>` next to each statement's badge
   (Unlabeled/Checking/Savings/Credit Card/Investment) → new
   `POST /api/finance {action:"set_account_type"}` →
   `setStatementAccountType()` in `ingest.ts`, which writes `account_type`
   directly on that statement AND all its transactions. Not confirm-gated —
   same class of lightweight, freely-reversible correction as the existing
   transaction-category PATCH, not a delete. Scoped to one statement rather
   than a global by-merchant override (like `category_overrides`) because
   README's no-account-numbers-persisted rule means there's no stable
   cross-statement key to remember it by; noted in the README.
3. `AccountSubKind` gained a 4th value, `"investment"`, set **unconditionally**
   whenever `kind === "brokerage"` (a new `brokerage()` helper in
   `classify.ts` wraps every brokerage return path) — this isn't
   Fidelity-specific detection, any brokerage statement structurally IS an
   investment account, so no per-institution signal was needed for this
   badge alone. `importBrokerage` now passes `classification.subKind` through
   to `recordStatement` and the returned `ImportResult`.
   **Bug caught during live-verification**, not by a unit test:
   `previewReanalyze`'s brokerage branch built its own return object and
   also omitted `accountType` (same class of oversight, different call
   site) — the preview card showed "25 → 25 holdings" with no "— Investment"
   suffix even though the commit path was already fixed. Added the missing
   field; a fresh preview then showed the suffix correctly.
- 8 new tests in `tests/finance-classify.test.ts`: the real May/June excerpts
  (reproduced with the load-bearing sentences only — names, address, and
  transaction detail are the user's real PII and were deliberately **not**
  committed to a git-tracked fixture) both now classify `checking`; the
  existing synthetic savings fixture still classifies `savings` (regression
  guard against Symptom-A's fix making savings unreachable); a brokerage PDF
  and a Fidelity-letterhead PDF and a brokerage positions CSV all
  sub-classify `investment`. `npm test`: 199 passing (up from 193).
- **Live-verified against the running app, on the user's real data** (per
  the fix-plan's explicit instruction for this phase — the fix stays live,
  not cleaned up): Re-Analyzed the real May statement (id 23→32) — preview
  showed "Checking" instead of "Savings", confirmed. Re-Analyzed both real
  Fidelity statements (id 25→33, 26→34) — previews now show "— Investment"
  (after the previewReanalyze fix above), confirmed. Final real state: 2
  checking, 2 credit_card, 2 investment across the 6 real statements; 111
  transactions and 25 holdings unchanged in count. Screenshotted the
  Statements list showing all six badges + correction dropdowns.
  Separately, live-verified the **manual override** with disposable synthetic
  data (a no-signal CSV that imports unlabeled): set it to "Savings" via the
  dropdown, confirmed both `statements.account_type` and every one of its
  `transactions.account_type` rows updated in the DB and the badge/dropdown
  reflected it in the UI, then deleted the synthetic statement (back to 6
  statements / 111 transactions).

## Phase 3 (2026-07-09): multi-institution parsing — signal table + confirm-gated LLM assist

The user asked directly whether parsing is "dynamic" and whether the local
model is good enough to help. `docs/multi-institution-parsing.md` has the
full writeup; summary here.

**Option A (implemented): signal table.** `lib/finance/classify.ts`'s five
hardcoded wording regexes (brokerage/transaction headers, credit-card/
savings/checking sub-type wording) were replaced by `tagMatches(text, tag)`
reading a new flat data table, `lib/finance/institution-signals.ts`
(`{institution, tag, pattern}` rows). Everything structural (holding-row
arithmetic, transaction-row shape, CSV column names) stayed untouched — it
already generalized across institutions before this table existed. All 22
pre-existing `finance-classify.test.ts` cases pass unmodified after the
refactor (confirms it's a scoring-mechanism refactor, not a behavior change).
Two fictional institutions never seen by this codebase — "Second National
Bank" (checking + savings) and "Summit Brokerage" — were added as pure data
rows and proven correct via 5 new tests, including a sanity-check test that
the *same* Summit content **without** its new row does NOT classify as
brokerage (isolates that the row, not something else, is load-bearing).
Deliberately no per-signal numeric weight — confidence gradation already
comes from structural counts, not signal-weight sums; documented as a
scope decision, not an oversight.

**Option B (implemented): confirm-gated LLM assist.** New
`lib/finance/classify-llm-assist-schema.ts` (pure: zod schema +
`parseLlmAssistResponse`, no network import, loadable by `node --test` — same
pure/impure split as `lib/stocks/history-core.ts`/`history.ts`) and
`lib/finance/classify-llm-assist.ts` (`suggestClassification`: calls
`lib/llm.ts`'s `chat()`, delegates parsing to the pure module). Called
**only** when the deterministic scorer already returned `unknown` or
below-floor confidence, from `ingest.ts`'s `tryLlmAssist` — never overrides a
confident verdict. The suggestion attaches to the existing `rejected`
`ImportResult` as an optional `llmSuggestion` (the file's status stays
"rejected"; nothing changes automatically). New confirm action `POST
/api/finance {action:"import_with_suggestion", file, kind, subKind}` →
`importWithForcedKind()` re-reads the file and imports it via the exact same
`importBrokerage`/`importTransactions` paths, built from a `confidence: 1,
signals: ["classified via user-confirmed LLM suggestion"]` classification
object — traceable in the statement's retained signals, and a future
Re-Analyze re-runs the real deterministic scorer rather than remembering the
override forever. New Finance-import UI: "this looks like a **[type]**
statement, per the local model: *[reason]*" with **Tag it and import** /
**Skip** buttons.
- 14 new tests in `tests/finance-classify-llm-assist.test.ts`: the zod gate
  (well-formed, null/omitted subKind, invalid kind/subKind enums, missing/
  empty reason, non-object payload, wrong-keyed payload) and
  `parseLlmAssistResponse` (clean JSON, JSON with stray prose around it, no
  JSON object at all, brace-balanced-but-invalid JSON, valid JSON failing the
  zod gate). `npm test`: 217 passing (up from 203).
- **Ollama-down fallback, live-verified** (not mocked, per this project's
  "LLM calls are never tested live" rule): temporarily pointed
  `LLM_BASE_URL` at a closed port, restarted the dev server, confirmed
  `suggestClassification` throws "Could not reach the LLM at
  http://localhost:19999/v1..." — then restored the real URL and restarted
  again before continuing.
- **Empirical "is the model good enough" check** (real Ollama, `llama3.1:8b`,
  via a temporary debug route deleted after use): two fixtures worded so
  *no* signal-table row matches (confirmed first: both genuinely classify
  `unknown, confidence: 0` through the real scorer) were sent to
  `suggestClassification` for real. Exact responses (recorded verbatim in the
  docs file): a "Meridian Trust Bank" checking excerpt →
  `{"kind":"transaction","subKind":"checking","reason":"presence of 'Everyday
  Checking' and numerical transaction records..."}` (**correct**); a
  "Meridian Capital Partners" one-holding-row brokerage excerpt →
  `{"kind":"brokerage","subKind":"investment","reason":"Stock listing with
  ticker MSFT and share price"}` (**correct**). Verdict: plausible and usable
  as a confirm-gated assist, not a classifier replacement.
- **Live-verified end-to-end against the running app**: dropped a synthetic
  "Second National Bank" checking CSV (no Balance column, so only the new
  signal-table row — not the balance-column fallback — could produce
  `checking`) into `/statements`, scanned, confirmed it imported tagged
  `checking`. Separately posted directly to `import_with_suggestion` with a
  normally-shaped CSV to verify the confirm action's happy path (2
  transactions imported, `signals: ["classified via user-confirmed LLM
  suggestion"]`). **Real finding, not a bug**: confirming an LLM suggestion
  on a CSV with truly unrecognizable columns still correctly fails at the
  *parsing* stage (`parseCsvStatement`'s own column check), because
  classify.ts's and parse.ts's CSV column vocabularies are nearly identical —
  `importWithForcedKind` skips classification, not parsing, and this is
  exactly right. Documented in `docs/multi-institution-parsing.md` as the
  reason Option B's real value is PDF-text statements, not CSVs. Cleaned up:
  deleted all synthetic statements and files, back to 6 statements / 111
  transactions.

# HANDOFF — updated after the finance/stocks fix-plan run (2026-07-08/09; Phase 21 and earlier below)

## Fix-plan run (complete): stock chart feasibility + 6 finance/stocks fixes

Six phases plus a research spike, each closed on green `npm test` (169 → 187
node tests) and `npm run typecheck`; `npm run build` and `npm run doctor`
also run clean at the end with no new breakage. Every phase was root-caused
in writing before the fix landed, and every DB-touching change was
live-verified against the actually-running dev app (not just unit tests) —
synthetic statements/accounts/cache rows inserted, exercised through the
real API, then deleted, leaving the user's real data (4 statements, 62
transactions) exactly as found.

**What changed, in one paragraph per phase:** (1) statements now get a
content-based checking/savings/credit-card sub-type instead of one generic
bucket, and a transfer matcher stops the same payment from double-counting
as both spend and income; (2) net-worth balance suggestions are labeled by
that real sub-type instead of a hardcoded "Checking", which used to make a
savings statement collide with a checking suggestion; (3) a confirm-gated
Re-Analyze button lets a classifier/parser fix reach statements imported
under older code, plus manual triggers for textbook-RAG re-ingest and
GoodNotes sync; (4) one shared `portfolio-total.ts` function replaced three
independent (and disagreeing) portfolio-total implementations — the Today
card was silently dropping any cost-basis-fallback holding (confirmed live:
it would have shown ~$13,954 instead of the correct $18,776.75 on the user's
real portfolio); (5) that same shared function now also reports each
holding's % of portfolio, sortable; (6) click-to-chart daily price history
via Alpha Vantage (Finnhub's history endpoint is confirmed premium-gated),
cached at most once per ticker per day.

**Correction made at the start of this run**: the fix-plan's own instructions
said `AGENTS.md`'s claim about `node_modules/next/dist/docs/` didn't check
out. It does — that path holds 423 files of genuine upstream Next.js 16
docs bundled with the pinned `next@16.2.10`, `AGENTS.md` is tracked in git
since the repo's first commit, and the bundled v16 upgrade guide documents
real breaking changes (fully-async `cookies`/`headers`/`params`/
`searchParams`, `middleware.ts` → `proxy.ts`) relevant to the route handlers
touched in this run.

**Deferred — needs a human with live keys/models, not guessable from here:**
- **Alpha Vantage key**: this box has none configured (only `FINNHUB_API_KEY`
  is set). Phase 6's click-to-chart code is built and unit-tested, but which
  of `TIME_SERIES_DAILY` / `TIME_SERIES_DAILY_ADJUSTED` is actually free
  could not be settled — public reports disagree, and there's no key here to
  test with. First live session: add `ALPHAVANTAGE_API_KEY`, click a ticker,
  confirm the chart renders real prices (not a premium-error message).
- **The 3 pre-existing real statements** with `kind: null` (imported before
  this run's classifier/balance-label tracking existed) were deliberately
  left untouched — they're the user's real data, and Phase 3's Re-Analyze
  button is the intended path to backfill them, one click each, whenever
  convenient. Not urgent; just noting they won't self-heal.
- Ollama's chat model is pulled and responding on this box (`npm run doctor`
  confirms), so LLM-dependent categorization was exercised live during
  verification, not just through its rules fallback — no LLM item deferred
  from this run.

This section documents the whole run; see per-phase detail below.

- **Phase 0 (spike, no app code)**: `docs/stock-history-feasibility.md`.
  Finnhub's `/stock/candle` is confirmed premium-gated (403) on free keys.
  Alpha Vantage can serve daily history at 25 req/day, but sources disagree
  on whether `TIME_SERIES_DAILY` or `TIME_SERIES_DAILY_ADJUSTED` is the free
  one — **needs a live-key check before Phase 6 writes any code.** Verdict:
  yes-with-caching (persistent per-ticker-per-day cache, lazy on-click fetch
  only — proactive fetch for a whole holdings list blows the daily budget).
- **Phase 1: bank vs. credit-card statement merging.** Root cause: the
  classifier only ever produced `brokerage` / `transaction` / `unknown` — a
  checking statement and a credit-card statement both landed in the generic
  `transaction` bucket with no sub-type and no account link, so a credit-card
  payment could show as real spend on checking AND real income on the card
  (double-counted) with nothing to tell the two statements apart in the UI.
  - `lib/finance/classify.ts` now scores a content-based sub-type —
    `checking` / `savings` / `credit_card` — within `transaction` kind, for
    both the PDF-text and CSV-table paths. Content matching BOTH credit-card
    and checking/savings signals is a `subKindConflict`, rejected by
    `ingest.ts` rather than guessed. Content with no distinguishing signal at
    all (a bare Date/Description/Amount CSV) is left unbadged, not rejected —
    it's a real, valid import, just one the content doesn't disambiguate.
  - New `account_type` column on both `statements` and `transactions`
    (migration in `lib/db.ts`), surfaced as a badge (Checking/Savings/Credit
    Card) in the Finance UI next to each statement and each import result.
  - New `lib/finance/transfers.ts`: a pure, unit-tested matcher that pairs
    the SAME real payment appearing as an outflow on one account and an
    inflow on another (exact-cent opposite amounts, ≤5 days apart, different
    statements, at least one side reading like a payment) and forces both
    rows to `category='Transfer'` — the category `analyze.ts`'s `NON_SPEND`
    already excludes from spend/income totals, so no new totals-side plumbing
    was needed, just a more reliable way to reach that category than hoping
    a bank's exact wording matches a keyword rule (the existing keyword rule
    for this, `/PAYMENT THANK YOU/i`, misses the real-world hyphenated
    "PAYMENT - THANK YOU" wording — confirmed against the user's own June
    statement data during live verification, see below).
  - **Live-verified** against the running dev app (not just unit tests):
    synthetic checking + credit-card CSVs dropped into `/statements`,
    imported through the real `/api/finance` endpoint, confirmed correct
    `accountType` badges and confirmed the matched transfer pair landed on
    `category='Transfer'` — then the test statements/transactions were
    deleted (cascade) and the test files removed, leaving the DB exactly as
    found (4 statements, 62 transactions). Also surfaced a **pre-existing
    gap**, not fixed in this phase: 3 of the user's 4 real statements have
    `kind: null` (imported before kind-tracking existed) — exactly what
    Phase 3's Re-Analyze is for; not touched here since it's out of scope
    for Phase 1 and those files are the user's real data.
  - Tests: 9 new classify.ts sub-type cases (checking/savings/credit_card/
    conflict/ambiguous-CSV/balance-column CSV) in
    `tests/finance-classify.test.ts`; 7 new cases in new
    `tests/finance-transfers.test.ts` covering the match, the 40-day
    non-match, same-statement non-match, no-hint non-match, same-sign
    non-match, zero-amount, and picking the right pair among decoys.
  - **Correction to how this run started**: the fix-plan's own instructions
    said to disregard `AGENTS.md`'s claim that `node_modules/next/dist/docs/`
    contains real Next.js docs relevant to breaking changes. That claim
    actually checks out — the path is real (423 files, genuine upstream
    Next.js 16 docs bundled with the pinned `next@16.2.10`), `AGENTS.md` is
    tracked in git since the repo's first commit, and the bundled v16 upgrade
    guide documents real breaking changes (fully-async `cookies`/`headers`/
    `params`/`searchParams`, `middleware.ts` → `proxy.ts`) relevant to any
    route handler touched in this run.
- **Phase 2: net worth missing bank balances.** Root-caused by reading the
  code AND live-testing against the running app (not guessing): the
  extraction → suggestion → confirm-gated-apply pipeline (`extractStatementBalance`,
  `balanceSuggestions()`, the Net Worth page's apply button) **already works
  correctly today** for both checking (`Ending Balance` → cash) and
  credit-card (`New Balance` → debt) — verified live end-to-end (import →
  suggestion appears with the right label/balance → apply creates the
  account → suggestion clears → net worth total updates correctly), then
  cleaned up. The user's actual reported symptom (net worth showing only the
  brokerage holding, accounts empty) is fully explained by their 3 real
  statements predating `kind`/`raw_text`/`ending_balance` tracking entirely —
  the same historical gap Phase 1 found, not a bug in the current pipeline.
  `importNewStatements()` skips files already in the `statements` table, so
  these specific 3 files can only be fixed by Phase 3's Re-Analyze (or by
  hand-deleting their `statements` row and re-scanning today).
  - **Real bug found and fixed along the way**: `extractStatementBalance`
    hardcoded the suggestion's label to `"Checking"` regardless of the
    statement's actual account type — a savings statement (same
    `Ending Balance` structure as checking) would suggest a "Checking"
    account and **collide** with a real checking suggestion under the same
    label, since `balanceSuggestions()` groups by `balance_label`. Now takes
    an optional `accountLabel` param, wired from Phase 1's classified
    sub-type in `ingest.ts` (falls back to the old hardcoded defaults when
    the sub-type is undetermined, so ambiguous-content CSVs keep working).
  - Live-verified: synthetic checking + savings statements imported
    together produced two DISTINCT, correctly-labeled suggestions (not one
    colliding "Checking" entry); applying one correctly updates net worth
    totals. Test data cleaned up after (DB back to 4 statements / 62
    transactions / 0 accounts).
  - New test in `tests/finance-pdf.test.ts` for the label override + default
    fallback.
- **Phase 3: Re-Analyze.** `importNewStatements()` only ever scans for files
  NOT already in the `statements` table, so Phase 1/2's classifier and
  balance-label fixes could never reach the user's 3 real pre-existing
  statements without hand-deleting DB rows. Added:
  - `lib/finance/ingest.ts`: exported `importOne` (was private), plus new
    `previewReanalyze(statementId)` (zero-write — re-reads and re-classifies
    the original file, diffs against current DB counts/categories; category
    counts use the deterministic rules only, fast and side-effect-free) and
    `commitReanalyze(statementId)` (deletes the statement — cascades its
    transactions via the existing FK — then calls `importOne` for a full
    fresh import, reusing 100% of existing classify/parse/categorize logic).
    `category_overrides` survives automatically since it's untouched by the
    per-statement delete.
  - `app/api/finance/route.ts`: two new confirm-gated actions,
    `reanalyze_preview` and `reanalyze_commit` (CLAUDE.md rule 2 — a
    destructive financial-data write needs an explicit confirm step; split
    into preview/commit rather than one action so the UI has something real
    to show before committing).
  - `components/finance-view.tsx`: **Re-Analyze** button per statement +
    **Re-Analyze All**, both showing a before/after diff card (count +
    estimated category breakdown, or the rejection reason) with
    Confirm/Cancel before anything is deleted.
  - **Live-verified** end-to-end against the running app: imported a test
    checking statement, previewed re-analyze (confirmed zero DB writes,
    correct 2→2 count + category estimate), committed (confirmed old
    statement row replaced by a fresh one, transaction count unchanged), then
    specifically proved **category_overrides survives**: set a manual
    override on a merchant, re-analyzed again, confirmed the override — not
    the LLM/rules category — won. Cleaned up after (DB back to 4 statements
    / 62 transactions).
  - **Textbook RAG & GoodNotes manual triggers**: the plan assumed a
    "page that lists ingested textbooks" to put a per-book Re-Analyze button
    on — no such page exists (textbooks are ingested by absolute path via a
    CLI/agent tool only, no book-tracking table). Rather than build a whole
    book-management UI that was never asked for elsewhere, added the
    minimal real fix: a path field + **Re-ingest** button on `/status`'s
    existing textbook-rag sidecar card (new `POST /api/textbook/reingest`,
    a thin proxy to the sidecar's already-idempotent `/ingest`), and a
    **Sync GoodNotes now** button next to the Google Drive check (new
    `POST /api/goodnotes/sync`, calling the exact same `syncGoodNotes()`
    core the hourly cron uses). Both live-verified to fail gracefully
    (clear message, not a crash) when the sidecar is down / Drive isn't
    connected — the sidecar wasn't running and GoodNotes' Drive folder
    doesn't exist on this box, both surfaced correctly.
- **Phase 4: portfolio value mismatch (Today vs. Stocks).** Root-caused by
  reading all three places a portfolio total gets computed: `/api/stocks`
  and `lib/networth.ts`'s `computeNetWorth()` both correctly fell back to
  cost basis per holding (e.g. SPAXX, which has no Finnhub symbol), but the
  Today page's inline "Portfolio" card summed ONLY quote-priced holdings and
  silently DROPPED anything unpriced from the total — not a timing race, a
  real always-reproducible under-count whenever any holding lacked a live
  quote. New `lib/stocks/portfolio-total.ts` (`computePortfolioTotal`, pure,
  generic over extra fields like `/api/stocks`'s `id`) is now the one
  valuation function all three call sites use.
  - **Live-verified on the user's real portfolio** (25 holdings incl.
    SPAXX): `/api/stocks` totals **$18,776.75** (SPAXX alone contributes
    $4,823.03 at cost basis, `priced:false`). Before this fix, the Today
    card's old logic would have shown **~$13,954** — missing exactly SPAXX's
    contribution. After the fix, curled the Today page's server-rendered
    HTML directly and confirmed **both** the Net Worth card and the
    Portfolio card render `$18,777` (rounded) — matching each other and
    the Stocks page. Also confirmed the day-move sub-label still shows a
    real figure (`▲ $64 today`) for this mixed priced/cost-basis case,
    not a misleading `$0` — `dayMove` is deliberately `null` (not 0) only
    when NO holding has a live quote, so "unknown" is never shown as "zero".
  - 6 new tests in `tests/portfolio-total.test.ts`: all-priced, cost-basis-
    only (the exact regression), mixed, empty, zero-cost-basis (no
    divide-by-zero on `plPercent`), and case-insensitive ticker lookup.
- **Phase 5: % of portfolio, sortable.** Added `percentOfPortfolio` directly
  to `computePortfolioTotal` (Phase 4's shared function) — `value ÷
  totalValue × 100`, computed in a second pass once the final total is known
  — so it can't drift from the total shown anywhere else, and a
  cost-basis-fallback holding (SPAXX) gets a real percentage instead of
  being left out or null, same "never drop an unpriced holding" principle
  as the total itself. Added as a new sortable column in the Stocks page's
  existing click-to-sort holdings table (`stocks-view.tsx`'s `SortKey`
  union just gained one more value — same generic comparator, no bolted-on
  special case).
  - Live-verified on the user's real 25-holding portfolio: percentages sum
    to **exactly 100.0000%**; SPAXX (cost-basis-priced, no live quote) shows
    **25.69%** rather than being dropped or blank.
  - 3 new tests in `tests/portfolio-total.test.ts`: proportional split
    across two priced holdings, the SPAXX-cost-basis-fallback case with a
    sum-to-~100% assertion, and null-not-NaN when the total is 0.
- **Phase 6: click-to-chart price history.** Phase 0 said yes-with-caching,
  Alpha Vantage only. Built `lib/stocks/history-core.ts` (pure: caching
  decision + Alpha Vantage response parsing, unit-tested) and
  `lib/stocks/history.ts` (DB + network glue — same pure/impure split as
  `lib/sync/core.ts`/`client.ts`), a new `stock_history_cache` table
  (one JSON blob per ticker, replaced wholesale, keyed by `fetched_date` so
  a ticker fetches **at most once per calendar day**), `GET
  /api/stocks/history?ticker=`, and a click-a-ticker Recharts line-chart
  dialog on the Stocks page.
  - **Genuinely unresolved, not just untested**: this box has **no
    `ALPHAVANTAGE_API_KEY` configured** (checked `.env.local` without
    printing it — only `FINNHUB_API_KEY` is set). Phase 0 flagged that
    public reports disagree on whether `TIME_SERIES_DAILY` or
    `TIME_SERIES_DAILY_ADJUSTED` is the free one; without a real key,
    **that could not be settled in this run** and stays a deferred
    live-verification item — same category as this project's "LLM calls
    are never tested live" rule. The code tries
    `TIME_SERIES_DAILY_ADJUSTED` first and treats a premium-gated response
    the same as a rate limit (calm degraded state, not a crash) regardless
    of which one turns out to be free.
  - What **was** live-verified against the running app, using synthetic
    cache rows (inserted directly, cleaned up after): the not-configured
    state returns a calm 200 with a clear message; a same-day cache hit
    serves the cached series without touching the network or the
    missing-key check at all; a stale (2026-07-01) cache row correctly
    triggers a fresh-fetch attempt (which then hit the same
    not-configured path, proving `shouldFetch`'s "different day → fetch"
    branch is wired end-to-end, not just unit-tested in isolation).
  - 8 new tests in `tests/stock-history.test.ts`: the 3 caching-decision
    cases, plus 5 `parseAlphaVantageDaily` cases (valid response sorted
    oldest-first, premium-gated `Information` body, rate-limited `Note`
    body, unknown-symbol empty body, and a non-numeric close dropped
    instead of NaN-poisoning the series).
  - **Next live session, first thing**: add a real `ALPHAVANTAGE_API_KEY`
    and click a ticker — confirm which endpoint actually returns data (not
    a premium-error body) and that the chart renders real prices.

## Phase 21 (2026-07-06, third run): README, agent memory + undo, budgets + restore, hybrid search, PWA + auth

Four upgrade phases, each closed on green `npm test` (**49** node tests, up
from 36), `npm run typecheck`, and `npm run build`. Ollama was **not**
running on this box, so every LLM-dependent path was verified through its
fallback (which is the architecture's contract anyway); live-model passes
are deferred below.

- **README** rewritten: pitch + screenshot placeholder (`public/demo.gif`
  does not exist yet — drop a real capture there), quickstart up top, TOC,
  feature bullets clustered (Agent / Life tracking / Money / Knowledge /
  System & automation), a real Testing-philosophy section, and a
  "Scheduler caveat" section with a pm2 recipe (recipe not exercised).
- **Agent memory** (`lib/agent-memory.ts`): `POST /api/agent` now injects
  the last 8 turns from `agent_log` (user_text + result only, clipped to
  300 chars each; `tool_calls` JSON deliberately excluded) into the system
  prompt. Memory-read failure logs and continues — never blocks a turn.
- **Undo** (`revert_action`, `requiresConfirm: true`): pure inverse-SQL
  mapper in `lib/revert-plan.ts` (add_task, log_gym, log_leetcode,
  log_metric, log_habit, log_meal, add_application, add_to_reading_list;
  everything else refused with a reason — calendar/notes/overwrites have no
  clean inverse). `lib/revert.ts` scans `agent_log` for the newest
  un-reverted executed call, runs the inverse + a marker row in the new
  `reverted_actions` table in one transaction. Verified end-to-end via the
  confirm leg: add → revert (row deleted, marker written) → second revert
  correctly refused; date defaults resolve to the **log row's** date, not
  revert-day.
- **Category budgets**: `category_budgets` table, `GET/PUT
  /api/finance/budgets` (zod: fixed category enum, positive limit, null
  clears), pure math in `lib/finance/budget-math.ts` (≥80% warns, >100%
  over), and 💸 lines in the deterministic morning brief. Verified with a
  seeded July transaction: overage line rendered in `/api/brief`, bad PUT
  rejected 400.
- **Restore** (`npm run restore [-- file] [--yes]`): loads a backup JSON,
  truncates each known table present in it (never `oauth_tokens`), bulk
  inserts in ONE transaction, asks for the literal word "restore" unless
  `--yes`. Note: package.json uses `node scripts/restore.ts` (repo
  convention, Node 24 native TS) rather than tsx. Both backup scripts now
  share `lib/backup-tables.ts` — the old 10-table list was missing 15
  newer tables. Round-trip (backup → restore → identical counts) and the
  abort path verified live.
- **Hybrid search**: `lib/llm.ts` gained `embed(texts)` (always local
  Ollama `/v1/embeddings`, `EMBED_MODEL` default `nomic-embed-text`).
  `search_embeddings` table (float32 BLOBs) + incremental refresh
  (`lib/search-index.ts`, re-embeds only changed text, drops stale rows)
  on a `5,35 * * * *` cron with launch catch-up. `globalSearch` is now
  async: exact LIKE tier first, semantic tier appended after per-source
  dedupe (`lib/search-rank.ts`, cosine ≥ 0.5). Verified degradation live:
  with Ollama down and a populated index, `/api/search` still answers 200
  exact-only.
- **PWA + auth**: minimal no-cache `public/sw.js` + registration component
  (manifest/icons existed since P20); verified registered and active in
  the preview browser. Root `middleware.ts`: when `JARVIS_AUTH_TOKEN` is
  set, every page/API needs `Authorization: Bearer`, the `jarvis_auth`
  cookie, or a one-time `?token=` (sets HttpOnly cookie, 307-redirects to
  strip the URL). sw.js/manifest/icons stay exempt or install breaks.
  Verified all paths live (401 page + JSON 401 API, wrong bearer 401,
  right bearer 200, cookie flow, exemptions). Unset → verified no-op.
  **Gotcha:** the dev server does not hot-reload `JARVIS_AUTH_TOKEN` into
  the middleware worker — restart after changing it.

**Mic button on Ask Jarvis** (same run, follow-up request): the voice
sidecar gained an HTTP mode — `voice/server.py` (FastAPI, **:8018**,
`POST /transcribe` multipart `audio=` → `{"text"}`), reusing the same lazy
`FasterWhisperTranscriber` and decoding browser containers (webm/mp4/wav)
via faster-whisper's own PyAV path; 7 new pytest cases (stubbed
transcriber + decoder) → voice suite now **25 passing**. The app got
`POST /api/transcribe` (proxies to `VOICE_SIDECAR_URL`, default :8018,
zod-validates the sidecar reply, clear 502 "start it:" message when down)
and `components/agent-chat.tsx` grew a 🎤 button: MediaRecorder → upload →
transcript **auto-sends through `send()`** — the same agent tool-calling
path as typing, so spoken commands route to sections exactly like typed
ones (that routing already existed; nothing new was needed there).
Verified live end-to-end with `WHISPER_MODEL=tiny` and a macOS
`say`-synthesized clip: sidecar `{"text": "at a task to buy milk
tomorrow."}` (tiny-model mishearing; default model is much better), proxy
200, garbage bytes → 400/502 with clear detail, sidecar-down → 502 with
the start command. **This box's voice venv is Python 3.11** (3.13 isn't
installed), so `numpy` was re-pinned `2.5.1 → 2.4.6` (2.5.x dropped
py3.11; 2.4.6 works on both boxes). Also removed stray macOS `"* 2.ts"`
duplicate artifacts in `.next/` that broke `tsc`.

Deferred to a live session (needs `ollama pull nomic-embed-text` + a chat
model): a real agent turn exercising conversation memory ("make that high
priority") and "undo that" through the model; a real embedding index build
and a fuzzy search hit; PWA install from a phone over Tailscale with the
token flow on https; the pm2 recipe; a real-microphone click of the 🎤
button in desktop Chrome/Safari (the embedded preview browser hard-denies
`getUserMedia`, so only the API chain below the browser was exercised with
real audio) and a full-size `large-v3-turbo` transcription. DB was left
clean — all verification rows (tasks, transactions, budgets, agent_log,
embeddings) deleted, and the verification backup JSON removed.

# Previous handoff — Phase 19 (2026-07-06, second run; P16–18 notes below)

## Phase 19: GoodNotes sync, system monitor, screen time

Built on the macOS box (first run on this machine — Node 24 was present,
sidecar venvs were not).

- **GoodNotes → RAG (Drive)**: `lib/goodnotes.ts` polls the Drive folder
  named by `GOODNOTES_DRIVE_FOLDER` (default "GoodNotes Backup") hourly at
  :15 (+ launch catch-up), diffs each PDF's `modifiedTime` against the new
  `goodnotes_sync_state` table, downloads changed files to the gitignored
  `/temp_notes`, and posts the path to the RAG sidecar's **new
  `POST /ingest` endpoint** (added to `rag/server.py`, same pipeline as the
  CLI; 5 new pytest cases). Sync state commits only after a successful
  ingest, so failures retry. **`drive.readonly` was added to the Google
  SCOPES — existing connections must reconnect once from the Calendar tab**
  (a 403 surfaces exactly that message). `getAccessToken` is now exported
  as `getGoogleAccessToken`.
- **System monitor**: `GET /api/system` (via `systeminformation@5.31.13`,
  pinned at install) returns CPU load/cores, active vs total memory, and
  the OS-drive usage; `<SystemMonitor />` on the Today grid polls it every
  8 s and cleans up on unmount.
- **Screen time**: `lib/activitywatch.ts` reads the local ActivityWatch
  API (`AW_BASE_URL`, default :5600) — AFK bucket for active time (window
  time as fallback), window bucket by app, web bucket by domain; pure
  aggregation helpers have 3 node tests. `GET /api/activity` always
  answers 200 with an `available` flag; `<ScreenTime />` refreshes every
  60 s and shows a quiet hint when AW is offline.

Deferred to a live session: reconnect Google (new scope) and watch a real
GoodNotes PDF flow Drive → `/temp_notes` → sidecar → `ask_textbook`;
install/run ActivityWatch and eyeball the Screen time card against its own
UI; confirm the Windows box reports `C:` in the System card.

# Previous handoff — Phases 16–18 (2026-07-06)

Phases 1–18 are built and committed. Phases 16–18 are **Python sidecars**
under `sidecars/` — standalone services with their own venvs that talk to
Jarvis/Ollama over HTTP; nothing was added to the Next.js build. This run
had no live Ollama models pulled and no mic/GPU exercised; every
model-dependent test is *deferred* below. Each phase closed on green
`npm run build` + `npm run typecheck`; `npm test` runs **23 passing** node
tests and the three sidecars run **17 + 24 + 18 passing** pytest cases
(all model/mic/Jarvis calls stubbed). The `nutrition_logs` test row created
during verification was deleted — DB is clean.

The P9–15 handoff (env table, back-burner items, earlier deferred tests) is
in git history at `b3b63d2`; everything there still stands.

## Commits (this run)

| Commit | What |
|---|---|
| `bab8984` | Phase 16: math PDF parser + local RAG sidecar (`sidecars/textbook-rag`) |
| `8dd390b` | Phase 17: macro vision + text pipeline (`sidecars/macro` + nutrition in the app) |
| `42c89e0` | Phase 18: local voice transcription bridge (`sidecars/voice`) |

## What this run built

- **Textbook RAG (P16).** `sidecars/textbook-rag`: `python -m rag.ingest
  book.pdf` converts PDF→Markdown (**Marker** by default when installed —
  it's the engine that preserves LaTeX; **MarkItDown** is the installed
  light fallback and does *not* reconstruct equations from images), chunks
  it with an equation-safe splitter (headers + blank-line blocks; `$$…$$`,
  `\[…\]`, `\begin{env}…\end{env}`, and code fences are unsplittable, so
  theorem+proof+equation travel together — 8 unit tests incl. a
  force-tiny-chunks case), embeds via Ollama `nomic-embed-text`, and
  upserts into persistent ChromaDB keyed `source::index` (re-ingest
  replaces, never duplicates; shrinking re-ingests drop stale chunks).
  `python -m rag.server` serves `POST /ask {"question","top_k"}` on
  **:8016** → top-k chunks + the primary Ollama model explaining with
  numbered section citations. The app got one new read-only zod tool,
  `ask_textbook(question)` (`TEXTBOOK_RAG_URL` in `.env.example`).
  Marker is a multi-GB PyTorch install, so it lives in
  `requirements-marker.txt` (pinned `marker-pdf==1.10.2`, current stable,
  actively maintained) and is auto-detected at ingest time.
- **Macro pipeline (P17).** `sidecars/macro` on **:8017**:
  `POST /nutrition` takes a **food photo** (multipart `image=`) or **text**
  (JSON `{"text"}`); photos go through a local Ollama vision model to
  identify items/portions, then either path hits the primary model in
  **Ollama JSON mode** with a strict system prompt; output must validate as
  `{"item",calories,protein,carbs,fat}` (single or list, ≤20) against a
  pydantic gate — one repair pass showing the model its error, then hard
  reject with 422. Validated items POST to the app's new zod-validated
  `/api/nutrition`, which writes the new `nutrition_logs` table. App side
  also got: `log_meal` agent tool, `calories_per_day` goal kind (goals page
  treats it lower-is-better), and a "Macros today" card on Trackers with
  totals vs goal, per-item list, photo-approximation badge, and remove.
  **Honest note (in code + API responses): photo calorie estimates are
  rough approximations — portions guessed from one 2D image; the text path
  is more accurate.** Verified end-to-end on the running app with the model
  stubbed: insert → totals → goal → delete, and the zod gate rejecting bad
  entries.
- **Voice bridge (P18).** `sidecars/voice`: `python -m voice.push_to_talk`
  — hold **F9** (`PTT_KEY`) to record (sounddevice, 16 kHz mono), release
  to transcribe with **faster-whisper `large-v3-turbo`** and POST the text
  to `/api/agent` exactly as the chat box does, printing transcript +
  reply (with a pending-confirmation notice when the agent gates an
  action). Compute path is a pure, unit-tested decision matrix over probed
  hardware: NVIDIA→CUDA fp16; **AMD→CPU int8 with an explicit startup log
  that faster-whisper/CTranslate2 has no clean native AMD GPU path**
  (CUDA-only upstream; ROCm = experimental Linux-only community builds);
  Apple Silicon→CPU int8 (Accelerate/NEON, no Metal offload); else CPU
  int8. `WHISPER_DEVICE`/`WHISPER_COMPUTE`/`WHISPER_MODEL` env override
  everything. Live detection on this machine correctly identified the AMD
  GPU and fell back to CPU int8.

## Sidecar endpoints (exact payloads)

| Sidecar | Run | Endpoint / payload |
|---|---|---|
| textbook-rag | `sidecars/textbook-rag/.venv/Scripts/python -m rag.server` | `POST :8016/ask {"question": str, "top_k"?: 1–10}` → `{"answer", "sources":[{"source","section","snippet","distance"}]}`; `GET /health` |
| macro | `sidecars/macro/.venv/Scripts/python -m macro.server` | `POST :8017/nutrition` JSON `{"text": str, "date"?: "YYYY-MM-DD"}` **or** multipart `image=<file>[, text, date]` → `{"source","items":[…],"jarvis":{…},"note"?}`; `GET /health` shows whether models are pulled |
| voice | `sidecars/voice/.venv/Scripts/python -m voice.push_to_talk` | no server — it *calls* `POST {JARVIS_URL}/api/agent {"text": <transcript>}` |

Each sidecar: `py -3.13 -m venv .venv && .venv\Scripts\pip install -r
requirements.txt` (all pins captured at install on 2026-07-06), tests with
`.venv\Scripts\python -m pytest`. Venvs, `__pycache__`, and
`sidecars/textbook-rag/data/` (Chroma) are gitignored.

## Deferred tests (need Ollama + pulled models + hardware)

Do these in order the first live session:

1. `ollama pull nomic-embed-text` (~274 MB), then ingest a real math PDF —
   **first install Marker**: `sidecars/textbook-rag/.venv/Scripts/pip
   install -r requirements-marker.txt` (PyTorch, multi-GB; ~3 GB weights
   download on first conversion; MarkItDown fallback works today but
   loses LaTeX). Then `python -m rag.ingest <book.pdf>`, start the server,
   and ask the agent a course question → `ask_textbook` end-to-end with
   real embeddings + real citations. Verify Marker's 1.10.x import path
   (`marker.converters.pdf`) still matches `rag/convert.py` at install.
2. **Vision model**: check https://ollama.com/search?c=vision for the
   current best tag (default is `MACRO_VISION_MODEL=qwen2.5vl`;
   llava-family also works), `ollama pull` it, then POST a real food photo
   to :8017 → vision description → JSON-mode extraction → row lands in
   Trackers with the photo badge. Also test the text path and `log_meal`
   through the agent ("I ate two eggs and toast").
3. **Voice**: first run downloads large-v3-turbo (~1.6 GB from Hugging
   Face). On this AMD (6700 XT) box it runs **CPU int8** — if too slow,
   set `WHISPER_MODEL=small`. On an NVIDIA box it needs CUDA 12 + cuDNN 9
   runtimes for the fp16 path. Real-mic test: hold F9, say "log the gym",
   confirm the gym log appears. (The `keyboard` lib needs the console
   focused nowhere in particular on Windows; it hooks globally.)
4. Eyeball the Trackers "Macros today" card and the calories ring on
   /goals with a `calories_per_day` goal set.

## Known limitations (this run)

- MarkItDown path flattens equation images to nothing/alt-text — fine for
  smoke tests, wrong for real study; Marker is the intended engine.
- RAG retrieval is semantic-only (no keyword/BM25 hybrid); very
  symbol-heavy queries may retrieve loosely.
- Photo macros are estimates by design (labeled in UI + API).
- Vision default tag (`qwen2.5vl`) was chosen without a live registry
  check — verify against ollama.com before pulling (step 2 above).
- `keyboard` hooks keys globally (that's the point of push-to-talk) but
  means F9 is captured system-wide while the bridge runs; change `PTT_KEY`
  if it collides.
- Chunker treats an unclosed `$$`/`\begin{}` (bad conversion output) as
  protecting the rest of the document — a malformed book can yield one
  giant chunk; visible in ingest's chunk count.

## Env vars added this run

Next app (`.env.example`): `TEXTBOOK_RAG_URL=http://localhost:8016`.
Sidecar-side (documented in each README, not app env): `OLLAMA_BASE_URL`,
`EMBED_MODEL`, `CHROMA_DIR`, `RAG_PORT/RAG_TOP_K/CHUNK_*`;
`MACRO_VISION_MODEL`, `JARVIS_URL`, `MACRO_PORT`; `WHISPER_MODEL`,
`WHISPER_DEVICE`, `WHISPER_COMPUTE`, `PTT_KEY`. No new secrets anywhere.
