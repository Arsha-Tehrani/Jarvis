// Single source of truth for "what is a holding worth right now". Before
// this existed, three call sites (the Today page's Portfolio card,
// /api/stocks, and lib/networth.ts's computeNetWorth) each summed holdings
// independently — and only two of the three actually fell back to cost
// basis for a holding with no live quote (e.g. the SPAXX money-market core,
// which has no Finnhub symbol). The Today card silently DROPPED an unpriced
// holding from its sum instead of falling back, so it under-counted the
// portfolio total relative to the Stocks page whenever any holding lacked a
// live quote — a real, always-reproducible mismatch, not a timing race.
// All three now call this.

export type HoldingInput = { ticker: string; shares: number; cost_basis: number };

export type Priced = {
  priced: boolean; // true = live market quote, false = cost-basis fallback
  price: number | null;
  value: number; // price*shares (priced) or cost_basis*shares (fallback) — never dropped
  percentOfPortfolio: number | null; // value / totalValue * 100; null only when totalValue is 0
  dayMove: number | null; // quote.change*shares; null when cost-basis-priced (no day-move concept)
  changePercent: number | null;
  pl: number | null; // (price-cost_basis)*shares; null when unpriced
  plPercent: number | null; // null when unpriced or cost_basis is 0 (a % return is meaningless)
};

export type PortfolioTotal<T extends HoldingInput> = {
  holdings: (T & Priced)[];
  totalValue: number;
  totalDayMove: number;
  pricedBy: "market" | "cost-basis" | "mixed" | "none";
};

// Minimal shape a quote lookup needs to return — callers can pass
// lib/stocks.ts's getCachedQuote directly, or a Map-backed lookup built from
// a fresh getQuotes() fetch (as /api/stocks does).
export type QuoteLike = { price: number; change: number; changePercent: number };
export type QuoteLookup = (ticker: string) => QuoteLike | undefined;

// Generic over T so callers can pass rows with extra fields (e.g. /api/stocks's
// `id`) and get them back on each priced result — never a separate re-lookup
// to reattach identity after the fact.
export function computePortfolioTotal<T extends HoldingInput>(
  holdings: T[],
  getQuote: QuoteLookup
): PortfolioTotal<T> {
  let totalValue = 0;
  let totalDayMove = 0;
  let anyMarket = false;
  let anyCostBasis = false;

  // First pass: per-holding value + the running total. percentOfPortfolio
  // needs the FINAL total, which isn't known until every holding is priced,
  // hence the second pass below rather than computing it inline here.
  const valued = holdings.map((h) => {
    const q = getQuote(h.ticker.toUpperCase());
    const value = q ? q.price * h.shares : h.cost_basis * h.shares;
    totalValue += value;
    if (q) {
      totalDayMove += q.change * h.shares;
      anyMarket = true;
    } else {
      anyCostBasis = true;
    }
    return { h, q, value };
  });

  const priced: (T & Priced)[] = valued.map(({ h, q, value }) => ({
    ...h,
    priced: !!q,
    price: q?.price ?? null,
    value,
    percentOfPortfolio: totalValue > 0 ? (value / totalValue) * 100 : null,
    dayMove: q ? q.change * h.shares : null,
    changePercent: q?.changePercent ?? null,
    pl: q ? (q.price - h.cost_basis) * h.shares : null,
    plPercent: q && h.cost_basis > 0 ? ((q.price - h.cost_basis) / h.cost_basis) * 100 : null,
  }));

  const pricedBy =
    holdings.length === 0
      ? "none"
      : anyMarket && anyCostBasis
        ? "mixed"
        : anyMarket
          ? "market"
          : "cost-basis";

  return { holdings: priced, totalValue, totalDayMove, pricedBy };
}
