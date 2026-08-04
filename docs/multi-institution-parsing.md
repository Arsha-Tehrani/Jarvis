# Multi-institution parsing: is this dynamic, and is the local LLM good enough? (Phase 3)

**Question the user asked directly:** does statement classification generalize
across banks/brokerages today, and could the local Ollama model help where it
doesn't?

**Current answer, before this phase:** classification is 100% deterministic
keyword/structure scoring with **no LLM in the loop at all**
(`lib/finance/classify.ts`), and the brokerage PDF extractor
(`lib/finance/brokerage-parse.ts`) is hand-shaped around Fidelity's specific
layout. Neither is "dynamic" in the sense of adapting to a bank nobody's
written code for yet.

## Two options considered

**Option A — restructure into a signal table.** Keep classification fully
deterministic, but move the wording signals (which phrase means "this is a
brokerage statement" / "this is a checking account") out of hardcoded regexes
and into a data table keyed by institution + what the signal indicates.
Adding a new bank becomes "add a row," not "edit scoring logic." Matches this
project's stated principle that parsers stay deterministic and testable
("we never rely on an LLM behaving well to make these paths correct" —
README's Testing section).

**Option B — LLM assist as a fallback.** Add the local model as an assist
**only** when the deterministic scorer comes back `unknown` or below the
confidence floor — never overriding a confident deterministic verdict — and
surface any LLM-suggested classification as a confirm-gated suggestion in the
UI (same pattern as the net-worth balance suggestions), never auto-applied.

## Recommendation: do both, in that order — and that's what this phase built

**A first**, because it's strictly testable, lower-risk, and closes most of
the real-world gap on its own: most banks' statements use fairly formulaic
wording (running-balance structure, "Beginning/Ending Balance", "Minimum
Payment Due," letterhead names), so a growing table of known phrasings covers
a large fraction of statements without any model involved. **B on top**, as a
fallback layer for the genuine long tail — a bank nobody's added signals for
yet — since it costs little once A exists and gives the user a path forward
without ever silently trusting an unverified guess.

## Option A: what was built

`lib/finance/institution-signals.ts` is a new, plain data table:

```ts
type SignalTag = "brokerage_header" | "transaction_header" | "credit_card" | "savings" | "checking";
type SignalRow = { institution: string; tag: SignalTag; pattern: RegExp };
export const SIGNAL_TABLE: SignalRow[] = [ /* ... */ ];
export function tagMatches(text: string, tag: SignalTag): boolean;
```

`classify.ts` no longer has its own `BROKERAGE_HEADER` / `TXN_HEADER` /
`CREDIT_CARD_SIGNAL` / `SAVINGS_SIGNAL` / `CHECKING_STRUCTURE_SIGNAL` regex
constants — every place that used to test one of those now calls
`tagMatches(text, tag)`, which just checks whether *any* row tagged for that
purpose matches. The confidence thresholds, the holding-row/transaction-row
structural counts, and every existing decision boundary are **unchanged** —
this is a refactor of where the wording signals live, not a change to what
currently correctly classifies (verified: all 22 pre-existing
`finance-classify.test.ts` cases still pass unmodified after the refactor).

**What deliberately stayed out of the table:** anything structural — holding
rows that pass the qty×price arithmetic self-check
(`parseFidelityPdfHoldings`), dated transaction-row shape
(`countTransactionRecords`), and CSV column-name detection
(`looksLikeBrokerageTable`, the date/description/amount header check). These
already generalize across institutions for free, because they probe the
actual shape of the data rather than a bank's specific wording — that's the
whole reason classification was described as "deliberately structural" before
this phase, and it stays that way. Only the wording layer needed a table.

**No per-signal numeric weight.** The plan text mentions "signal list +
weight," but this implementation uses plain presence/absence per tag.
Confidence gradation already comes from the structural counts (how many
holding rows, how many transaction rows) and header presence booleans, not
from summing per-signal weights — adding a weight per row would be new
complexity with no decision it currently needs to make. If a future
institution's wording turns out to be ambiguous enough that boolean
presence isn't discriminating enough, weights are the natural next step, but
nothing in this phase's real data needed it.

**Proof that "add a bank" is a data change:** two fictional institutions,
never seen by this codebase before, were added as pure data rows —
`Second National Bank` (checking + savings wording) and `Summit Brokerage`
(brokerage letterhead) — with zero changes to `classify.ts`'s functions.
`tests/finance-classify.test.ts` asserts:

- A fictional Second National Bank checking statement (running-balance
  structure + "Second National Free Checking" wording) sub-classifies
  `checking`.
- A fictional Second National Bank savings statement sub-classifies
  `savings`, not `checking` — proving the new institution's two account
  types are still correctly told apart from each other.
- A fictional Summit Brokerage statement with only **one** extractable
  holding row (below the `holdingRows >= 2` structural threshold that would
  recognize it without any wording help) and **no** generic brokerage
  wording classifies as `brokerage` / `investment` — and a sanity-check test
  proves the *same* content **without** the new signal-table row does NOT
  classify as brokerage. That isolates exactly what the new row is doing.

## Option B: what was built

`lib/finance/classify-llm-assist.ts` exports `suggestClassification(text)`:
called **only** when the deterministic scorer already returned `kind ===
"unknown"` or confidence below `CONFIDENCE_FLOOR`. It sends the statement's
already-redacted extracted text (account numbers are stripped upstream,
before this ever runs — never sent) to `lib/llm.ts`'s `chat()` with a system
prompt asking specifically for `kind` / `subKind` / a plain-language `reason`,
and gates the response through a zod schema
(`llmAssistSchema`) — the same "model output is validated, not trusted"
contract every other LLM-touching path in this codebase follows (JSON
extracted from the response text, parsed, and rejected with a clear error on
any malformed shape).

The suggestion is attached to the existing `rejected` `ImportResult` as an
optional `llmSuggestion` field — it does **not** change the file's status
from `"rejected"`; the deterministic verdict (reject, don't guess) still
stands as the actual outcome of a plain import/scan. The Finance import UI
shows, next to the rejection reason, "This looks like a **[kind/subKind]**
statement (per the local model): *[reason]* — Tag it and import?" with an
explicit confirm button. Confirming calls a new
`POST /api/finance {action:"import_with_suggestion", file, kind, subKind}`,
which re-reads the same file and imports it via the exact same
`importBrokerage`/`importTransactions` paths a confident deterministic
classification would have used — but built from a `confidence: 1,
signals: ["classified via user-confirmed LLM suggestion"]` classification
object rather than the scorer's own verdict, so it's traceable in the
statement's retained signals which path a given import took. **Nothing is
ever auto-applied** — if the user never clicks confirm, the file stays
unimported, exactly like today's plain rejection.

**Ollama-down fallback:** `suggestClassification` throws (network
unreachable, non-JSON response, or a zod validation failure) and the caller
in `ingest.ts` catches it — the import result is the plain rejection with no
`llmSuggestion` attached, identical to behavior before this phase existed.
Verified live (not with a `node --test` mock, per this project's "LLM calls
are never tested live" rule) by running a small standalone script with
`LLM_BASE_URL` pointed at a closed port (not the real dev server's
environment) and confirming `suggestClassification` throws a clear "could not
reach the LLM" error, which `ingest.ts`'s catch turns into a silent
degradation — the exact same code path this project's other LLM integrations
(categorization, semantic search) already use.

## Empirical answer: is the local model good enough?

With Ollama actually running on this box (`llama3.1:8b`, confirmed via
`npm run doctor`), two deliberately-unmatched fixtures — a "Meridian Trust
Bank" checking excerpt and a "Meridian Capital Partners" one-holding-row
brokerage excerpt, both worded so that **no** row in
`institution-signals.ts` matches (confirmed first: both actually classify
`kind: "unknown", confidence: 0` through the real deterministic scorer, via a
temporary debug route hitting the real running dev app) — were handed to
`suggestClassification` for real, and the exact responses recorded here
(nothing paraphrased):

- **Meridian Trust Bank checking excerpt:** `{"kind":"transaction",
  "subKind":"checking","reason":"presence of 'Everyday Checking' and
  numerical transaction records for deposits and withdrawals."}`. **Correct.**
- **Meridian Capital Partners brokerage excerpt (one holding row):**
  `{"kind":"brokerage","subKind":"investment","reason":"Stock listing with
  ticker MSFT and share price"}`. **Correct.**

**Verdict: plausible and usable as a confirm-gated assist**, not a
replacement for Option A. Both fixtures the deterministic scorer would have
rejected as `unknown` got a *correct* suggestion from the local 8B model on
the first try, with a legible reason a user can sanity-check before
confirming. This is exactly the shape Option B is for — the long tail Option
A's table hasn't been taught yet — and the zod gate plus explicit confirm
step means an occasional wrong or malformed answer costs nothing (it's never
applied without a human looking at it first).

## A finding worth being honest about: Option B is a PDF-text story, not a CSV one

Live-verifying the confirm action (`import_with_suggestion`) surfaced a real
structural fact, not a bug: for CSVs, `classify.ts`'s "is this recognizable"
check and `parse.ts`'s `parseCsvStatement` "can I actually extract rows"
check both key off nearly the *same* column-name vocabulary (`date`,
`description`/`merchant`/`payee`/…, `amount`/`debit`/`credit`/…). A CSV whose
columns are unusual enough for the classifier to say `unknown` is, by
construction, almost always *also* too unusual for the parser to extract
transactions from — so confirming an LLM suggestion on such a CSV correctly
surfaces a second, honest rejection (verified live: a CSV with headers `Txn
Date, What, Value` got a correct LLM suggestion of "checking," but confirming
it still failed with `parseCsvStatement`'s own "Unrecognized CSV columns"
error, exactly as it should — `importWithForcedKind`'s job is to skip
*classification*, not to skip *parsing*). The confirm action's happy path —
force-importing successfully — was verified separately with a normally-shaped
CSV posted directly to `import_with_suggestion`. Option B's real value is for
**PDF-text statements**, where the deterministic scorer's wording signals can
miss an unfamiliar institution's letterhead/product-name phrasing while the
transaction-row *shape* underneath (dates, amounts, payee-like text) is still
extractable by the more permissive text-based parser — that's the genuine
long-tail gap this phase set out to close.
