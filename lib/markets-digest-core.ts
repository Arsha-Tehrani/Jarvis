import type { ContributionLookback } from "@/lib/stocks/contribution";

// Pure core for the markets digest: which window to report, which dividends
// fall inside it, and how the message reads. No DB / network / Slack imports,
// so `node --test` covers the weekday-vs-weekend branch over fixed dates
// rather than waiting for a Saturday.

export type DigestWindow = {
  kind: "day" | "week";
  // Lookback handed to the contribution engine — the SAME engine and the same
  // "1W" math the Stocks page toggle uses, just a different value passed in.
  lookback: ContributionLookback;
  // Inclusive start of the covered window (YYYY-MM-DD): yesterday on a
  // weekday, seven days back on a weekend.
  since: string;
  // Exclusive-of-today end, i.e. the last day covered.
  until: string;
  label: string; // human phrase used in the headline
};

const iso = (d: Date): string => d.toISOString().slice(0, 10);
const daysBefore = (now: Date, n: number): string => iso(new Date(now.getTime() - n * 86_400_000));

// Mon–Fri report the most recent trading day's move; Sat/Sun report the past
// week's. getDay() is 0=Sunday, 6=Saturday — read off the SERVER clock, the
// same convention the rest of the app's date-relative logic uses.
export function digestWindow(now: Date): DigestWindow {
  const day = now.getDay();
  const isWeekend = day === 0 || day === 6;
  return isWeekend
    ? {
        kind: "week",
        lookback: "1w",
        since: daysBefore(now, 7),
        until: daysBefore(now, 1),
        label: "This past week",
      }
    : {
        kind: "day",
        lookback: "1d",
        since: daysBefore(now, 1),
        until: daysBefore(now, 1),
        label: "Latest trading day",
      };
}

// ---- Dividends in the covered window -----------------------------------------

export type DigestDividend = {
  ticker: string;
  payout: number;
  status: "pending" | "confirmed";
  ex_date: string;
  payment_date: string | null;
};

// "Confirmed or newly pending in the window": a confirmed payout counts by the
// day the cash landed (payment_date), a pending entitlement by the day it was
// created (ex_date). Using the wrong date for either would report a payout in
// the wrong week, so the two statuses deliberately key off different columns.
export function dividendsInWindow<T extends DigestDividend>(
  events: T[],
  window: DigestWindow
): T[] {
  return events.filter((e) => {
    const relevant = e.status === "confirmed" ? e.payment_date : e.ex_date;
    return !!relevant && relevant >= window.since && relevant <= window.until;
  });
}

// ---- Message ------------------------------------------------------------------

export function money(v: number): string {
  const sign = v >= 0 ? "+" : "−";
  return `${sign}$${Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

export type MarketsDigestInput = {
  window: DigestWindow;
  // Portfolio move for the window. On a weekday this is `totalDayMove` from
  // computePortfolioTotal (the Stocks page's day-move-vs-previous-close figure,
  // never recomputed here); on a weekend it's the contribution engine's 7-day
  // net change.
  dollarChange: number | null;
  percentChange: number | null;
  // The CONCENTRATION_THRESHOLD rollup sentence from the contribution engine
  // (formatContributionAnswer), or null when there's no price history to
  // attribute the move to.
  drivers: string | null;
  dividends: DigestDividend[];
};

export function formatMarketsDigest(input: MarketsDigestInput): string {
  const { window, dollarChange, percentChange, drivers, dividends } = input;
  const lines: string[] = [];

  if (dollarChange == null) {
    lines.push(`📉 *${window.label}* — no portfolio valuation available.`);
  } else {
    const pct =
      percentChange != null
        ? ` (${percentChange >= 0 ? "+" : "−"}${Math.abs(percentChange).toFixed(2)}%)`
        : "";
    const emoji = dollarChange >= 0 ? "📈" : "📉";
    lines.push(`${emoji} *${window.label}* — portfolio ${money(dollarChange)}${pct}`);
  }

  if (drivers) lines.push(drivers);

  if (dividends.length > 0) {
    const confirmed = dividends.filter((d) => d.status === "confirmed");
    const pending = dividends.filter((d) => d.status === "pending");
    lines.push("💵 Dividends:");
    for (const d of confirmed) {
      lines.push(`• ${d.ticker} $${d.payout.toFixed(2)} paid ${d.payment_date}`);
    }
    for (const d of pending) {
      lines.push(`• ${d.ticker} $${d.payout.toFixed(2)} pending (ex-date ${d.ex_date})`);
    }
  }

  return lines.join("\n");
}
