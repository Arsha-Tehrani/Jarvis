// Per-holding contribution analysis: "how much of my portfolio's move over
// the past week/month is actually just one or two stocks?" Pure — no DB or
// network imports — so `node --test` exercises it directly (same pure-core /
// DB-glue split as history-core.ts vs. history.ts; the glue lives in
// contribution-data.ts).
//
// `currentValue` is fed in already valued by computePortfolioTotal
// (lib/stocks/portfolio-total.ts) — live quote × shares, or the cost-basis
// fallback for a holding with no live quote (e.g. the SPAXX money-market
// core). We never reimplement that valuation here.

// The analysis windows offered by the Stocks page toggle. Lives here (the
// pure, client-safe module) so the React card can import it without dragging
// in the DB/network glue.
export const CONTRIBUTION_PERIODS = ["1w", "2w", "1m"] as const;
export type ContributionPeriod = (typeof CONTRIBUTION_PERIODS)[number];

// Every lookback the engine can compute, including "1d" — used by the markets
// digest for the weekday "what drove today's move" rollup. Deliberately NOT
// added to CONTRIBUTION_PERIODS: that set is the UI's toggle, and a 1-day
// button isn't wanted there.
export const CONTRIBUTION_LOOKBACKS = ["1d", ...CONTRIBUTION_PERIODS] as const;
export type ContributionLookback = (typeof CONTRIBUTION_LOOKBACKS)[number];

// A holding whose cumulative |contribution| helps cross this share of the
// total absolute move is part of the "N holdings drove your portfolio"
// rollup. Named, not a magic number buried in the component.
export const CONCENTRATION_THRESHOLD = 0.8;

export type ContributionHoldingInput = {
  ticker: string;
  shares: number;
  // Current value from computePortfolioTotal (quote×shares or cost-basis
  // fallback). Never recomputed here.
  currentValue: number;
};

// ticker (any case) → period-start close price. A missing/null entry means we
// have no historical price for that ticker this period → the "no data" case,
// never an assumed $0.
export type HistoricalPrices = Record<string, number | null | undefined>;

export type HoldingContribution = {
  ticker: string;
  shares: number;
  currentValue: number;
  startValue: number | null; // shares × period-start close; null when no data
  dollarContribution: number | null; // currentValue − startValue; null when no data
  percentOfTotalChange: number | null; // dollarContribution / net total change; null when total is 0
  percentReturn: number | null; // dollarContribution / startValue; null when startValue is 0/missing
  hasData: boolean; // false = no historical price this period (flagged, never dropped)
};

export type ConcentrationSummary = {
  topN: number; // holdings needed to cross CONCENTRATION_THRESHOLD of the total move
  holdingsWithData: number; // denominator "M" in "N of M holdings"
  coverageFraction: number; // cumulative |contribution| of those topN / total |move| (≥ threshold)
};

export type ContributionResult = {
  // Holdings WITH data sorted by |dollarContribution| desc, then the "no data"
  // holdings (ticker-sorted) appended last so they never pollute the ranking.
  holdings: HoldingContribution[];
  totalPortfolioDollarChange: number; // signed net change across holdings with data
  totalStartValue: number; // sum of startValue across holdings with data
  totalCurrentValue: number; // sum of currentValue across holdings with data
  totalPortfolioPercentChange: number | null; // net change / totalStartValue; null when start is 0
  totalAbsChange: number; // sum of |dollarContribution| — the denominator for concentration
  concentration: ConcentrationSummary | null; // null when there's no movement to attribute
};

const upper = (t: string) => t.toUpperCase();

// The closest trading-day close AT OR BEFORE `target` (YYYY-MM-DD) from an
// oldest-first daily series — the period-start price a holding is measured
// against. Null when the series starts after `target` (e.g. a newly-bought
// position with no history that far back), which the caller turns into the
// "no data" case rather than a fabricated number. Pure so it's unit-testable
// without a live Yahoo call.
export function closeOnOrBefore(
  series: Array<{ date: string; close: number }>,
  target: string
): number | null {
  let chosen: number | null = null;
  for (const p of series) {
    if (p.date.slice(0, 10) <= target) chosen = p.close;
    else break; // series is sorted oldest-first, so nothing later can qualify
  }
  return chosen;
}

// One holding's contribution given the period-start price map. `startPrice`
// missing/null/non-finite → the "no data" case (contribution null, hasData
// false) so a newly-bought position or an unofficial-API gap is flagged, not
// silently zeroed.
function contributionFor(
  h: ContributionHoldingInput,
  historical: HistoricalPrices,
  totalNetChange: number
): HoldingContribution {
  const startPrice = historical[upper(h.ticker)];
  const hasData = typeof startPrice === "number" && Number.isFinite(startPrice);
  if (!hasData) {
    return {
      ticker: h.ticker,
      shares: h.shares,
      currentValue: h.currentValue,
      startValue: null,
      dollarContribution: null,
      percentOfTotalChange: null,
      percentReturn: null,
      hasData: false,
    };
  }
  const startValue = h.shares * (startPrice as number);
  const dollarContribution = h.currentValue - startValue;
  return {
    ticker: h.ticker,
    shares: h.shares,
    currentValue: h.currentValue,
    startValue,
    dollarContribution,
    // Guard the divide-by-zero the spec calls out: a flat net portfolio has no
    // meaningful "share of the move", so percent is null (never Infinity/NaN).
    percentOfTotalChange:
      totalNetChange !== 0 ? (dollarContribution / totalNetChange) * 100 : null,
    // Return vs. the period-start basis; null when that basis is 0 (a % return
    // off zero is meaningless), never a divide-by-zero.
    percentReturn: startValue !== 0 ? (dollarContribution / startValue) * 100 : null,
    hasData: true,
  };
}

// Smallest set of top movers (by |contribution|) whose cumulative |move|
// crosses `threshold` of the total |move|. Assumes `withData` is already
// sorted by |dollarContribution| desc. Null when there's nothing to attribute.
function concentrationSummary(
  withData: HoldingContribution[],
  totalAbsChange: number,
  threshold: number
): ConcentrationSummary | null {
  if (withData.length === 0 || totalAbsChange <= 0) return null;
  let cumulative = 0;
  let n = 0;
  for (const h of withData) {
    cumulative += Math.abs(h.dollarContribution as number);
    n += 1;
    if (cumulative >= threshold * totalAbsChange) break;
  }
  return {
    topN: n,
    holdingsWithData: withData.length,
    coverageFraction: cumulative / totalAbsChange,
  };
}

const PERIOD_WORDS: Record<ContributionLookback, string> = {
  "1d": "the past day",
  "1w": "the past week",
  "2w": "the past two weeks",
  "1m": "the past month",
};

// Plain-language answer for the read-only agent tool, from the same result the
// API returns. Pure so it's unit-testable without a live model or network.
export function formatContributionAnswer(
  result: ContributionResult & { period: ContributionLookback }
): string {
  const withData = result.holdings.filter((h) => h.hasData);
  const when = PERIOD_WORDS[result.period];
  if (withData.length === 0) {
    return `No price history is available yet to attribute your portfolio's move over ${when}.`;
  }
  const money = (v: number) =>
    `${v >= 0 ? "+" : "−"}$${Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  const pct =
    result.totalPortfolioPercentChange != null
      ? ` (${result.totalPortfolioPercentChange >= 0 ? "+" : "−"}${Math.abs(
          result.totalPortfolioPercentChange
        ).toFixed(1)}%)`
      : "";

  const top = withData.slice(0, 3).map((h) => {
    const share =
      h.percentOfTotalChange != null ? `, ${Math.abs(h.percentOfTotalChange).toFixed(0)}% of the move` : "";
    return `${h.ticker} ${money(h.dollarContribution as number)}${share}`;
  });

  let answer = `Over ${when}, your portfolio moved ${money(
    result.totalPortfolioDollarChange
  )}${pct}. Biggest movers: ${top.join("; ")}.`;
  if (result.concentration) {
    answer += ` ${result.concentration.topN} of ${result.concentration.holdingsWithData} holdings account for ${Math.round(
      result.concentration.coverageFraction * 100
    )}% of the move.`;
  }
  const noData = result.holdings.filter((h) => !h.hasData);
  if (noData.length > 0) {
    answer += ` No price data over ${when} for ${noData.map((h) => h.ticker).join(", ")}.`;
  }
  return answer;
}

export function computeContribution(
  holdings: ContributionHoldingInput[],
  historical: HistoricalPrices,
  threshold: number = CONCENTRATION_THRESHOLD
): ContributionResult {
  // First pass over holdings WITH data to get the net total change, which is
  // the denominator for each holding's percentOfTotalChange.
  const startValues = new Map<string, number>();
  let totalNetChange = 0;
  let totalStartValue = 0;
  let totalCurrentValue = 0;
  for (const h of holdings) {
    const startPrice = historical[upper(h.ticker)];
    if (typeof startPrice !== "number" || !Number.isFinite(startPrice)) continue;
    const startValue = h.shares * startPrice;
    startValues.set(h.ticker, startValue);
    totalNetChange += h.currentValue - startValue;
    totalStartValue += startValue;
    totalCurrentValue += h.currentValue;
  }

  const computed = holdings.map((h) => contributionFor(h, historical, totalNetChange));

  const withData = computed
    .filter((h) => h.hasData)
    .sort(
      (a, b) =>
        Math.abs(b.dollarContribution as number) - Math.abs(a.dollarContribution as number) ||
        a.ticker.localeCompare(b.ticker)
    );
  const noData = computed
    .filter((h) => !h.hasData)
    .sort((a, b) => a.ticker.localeCompare(b.ticker));

  const totalAbsChange = withData.reduce(
    (s, h) => s + Math.abs(h.dollarContribution as number),
    0
  );

  return {
    holdings: [...withData, ...noData],
    totalPortfolioDollarChange: totalNetChange,
    totalStartValue,
    totalCurrentValue,
    totalPortfolioPercentChange:
      totalStartValue !== 0 ? (totalNetChange / totalStartValue) * 100 : null,
    totalAbsChange,
    concentration: concentrationSummary(withData, totalAbsChange, threshold),
  };
}
