# Stock chart feasibility spike (Phase 0)

**Question:** can clicking a holding on the Stocks page open a historical price
chart, given the app only has free-tier Finnhub/Alpha Vantage keys?

**Verdict: yes, with caching — but only through Alpha Vantage, not Finnhub.**

## What free tiers actually return today (verified 2026-07, not assumed from memory)

**Finnhub — `/stock/candle` is premium-gated, confirmed.** The endpoint exists
in Finnhub's docs and would be the natural fit (it's what `lib/stocks.ts`
already calls for quotes, same auth pattern), but multiple current
[Finnhub-API GitHub issues](https://github.com/finnhubio/Finnhub-API/issues/541)
show free keys getting `403 "You don't have access to this resource"` on this
endpoint specifically. Quotes, company profile, and symbol search stay free;
historical candles do not. This confirms the same pattern the project already
hit once — README already notes Finnhub's dividend endpoint is premium-only.
**Finnhub cannot serve history on the free tier. Full stop.**

**Alpha Vantage — one of `TIME_SERIES_DAILY` / `TIME_SERIES_DAILY_ADJUSTED` is
free, the other is premium-gated, and sources disagree on which.** Multiple
[GitHub](https://github.com/portfolio-performance/portfolio/issues/3275)
threads quote the exact error string `"This is a premium endpoint. You may
subscribe to any of the premium plans..."` — but attribute it to different
endpoint names depending on when the post was written (Alpha Vantage has
apparently swapped which of the two is gated at least once). **This has to be
verified live, with a real key, before Phase 6 writes any code that assumes
one is free** — the implementation should try one, catch the premium-error
response body (`Note`/`Information`, same fields `lib/stocks.ts` already
checks for rate limits), and treat "premium-gated" as just another flavor of
"unavailable," not a special case requiring its own error path.

Either way, this is a **daily-resolution, EOD-only** series — no intraday
chart is available on the free tier from either provider, so "historical
chart" here means a daily close line, not candlesticks with volume.

## Real cost against the 25 req/day budget

Alpha Vantage's free tier is 25 requests/day, 5/minute (confirmed current).
That budget is shared across the whole app — it's already the fallback quote
provider when `FINNHUB_API_KEY` is unset, and would now also serve history.

- **On page load for N holdings: infeasible.** A portfolio with more than
  ~20 positions exhausts the entire daily quota just opening the Stocks page
  once, before the user clicks anything, and leaves nothing for quote
  fallback or a second visit that day.
- **On click, uncached: fragile.** Clicking the same stock twice in one
  session re-spends quota for identical data (EOD data doesn't change
  intraday). A user idly clicking through a 10-holding portfolio twice in a
  day would burn 20 of the 25 requests.
- **On click, cached "once per day per ticker" in SQLite (not in-memory):
  sustainable.** EOD history for a given ticker is static until market close,
  so a per-ticker-per-day cache means the worst case is one request per
  distinct ticker clicked per day — well inside 25 for any realistic
  portfolio size, and it survives dev-server restarts (unlike the existing
  15-minute in-memory quote cache, which is fine for quotes because it's
  meant to expire fast, but wrong for daily history because restart-driven
  cache loss would waste quota re-fetching data that hasn't changed).

**This mirrors the existing 15-minute quote-cache pattern in intent
(`lib/stocks.ts`) but needs a longer-lived, persistent cache, not an
in-memory one, because the whole point is to spend the daily quota at most
once per ticker per day, not once per process lifetime.**

## Design sketch (Phase 6, not implemented in this phase)

- **Data source:** Alpha Vantage only (`ALPHAVANTAGE_API_KEY`). If unset, the
  chart click shows the same "unconfigured" degraded state the Stocks page
  already uses for missing keys — never a crash, never silently falls back to
  Finnhub (which can't serve this data at all).
- **Cache table:** `stock_history_cache(ticker, date, close, cached_at)` (or a
  single JSON blob per ticker keyed by `fetched_date` — a JSON blob is simpler
  given the whole series is replaced together, not queried by date range from
  SQL). Migration added the same idempotent way as every other table in
  `lib/db.ts`.
- **Cache TTL:** one calendar day per ticker (compare `cached_at`'s date to
  today, not a rolling 24h window, since EOD data only changes once a day at
  market close regardless of when it was first cached).
- **Fetch trigger:** lazy, on click only — never proactively for the whole
  holdings list on page load.
- **When the daily quota is already spent:** Alpha Vantage returns a
  `Note`/`Information` field instead of data (same shape `lib/stocks.ts`
  already parses for quotes) — surface that as the existing "quote
  unavailable, try later" degraded pattern in the chart panel, not an error
  boundary.
- **UI:** click a holding row → opens a panel/modal with a Recharts line
  chart of daily close, reusing the Recharts dependency already in the
  project (per CLAUDE.md, no new dependency needed).

## What Phase 6 must do before writing UI code

Confirm live, with a real `ALPHAVANTAGE_API_KEY`, which of
`TIME_SERIES_DAILY` / `TIME_SERIES_DAILY_ADJUSTED` actually returns data
(not a premium-error body) — this is a live-API check the project's own
testing philosophy defers (never tested live), so it's called out explicitly
here rather than guessed at in code.
