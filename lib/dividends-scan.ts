import { getDb } from "@/lib/db";
import { yahooFinance } from "@/lib/stocks/yahoo-client";
import {
  calendarFromQuoteSummary,
  lastPaymentFromChart,
  runDividendScan,
  type DividendScanDeps,
} from "@/lib/dividends-auto";

// Cron glue for the automated dividend scan (docs/dividend-automation.md):
// binds the testable core in lib/dividends-auto.ts to the real DB and the
// shared audited Yahoo client (lib/stocks/yahoo-client.ts — same instance
// the stock-history path uses; calls appear in /network-log). Daily at
// 07:00 + catch-up-on-launch, NOT the 15-minute stock cadence: an ex-date
// changes at most once a day, so anything faster is pure waste against an
// unofficial API.

const CHART_LOOKBACK_DAYS = 400; // > 1 year — catches annual payers' last event

function yahooDeps(): DividendScanDeps {
  return {
    fetchCalendar: async (ticker) => {
      const qs = await yahooFinance.quoteSummary(ticker, {
        modules: ["calendarEvents", "summaryDetail"],
      });
      return calendarFromQuoteSummary(qs as Parameters<typeof calendarFromQuoteSummary>[0]);
    },
    fetchLastPaymentAmount: async (ticker) => {
      const chart = await yahooFinance.chart(ticker, {
        period1: new Date(Date.now() - CHART_LOOKBACK_DAYS * 86400_000),
        period2: new Date(),
        interval: "1mo",
        events: "dividends",
      });
      return lastPaymentFromChart(chart as Parameters<typeof lastPaymentFromChart>[0]);
    },
    log: (message) => console.log(`[dividend-scan] ${message}`),
  };
}

export async function dividendScanJob(): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const result = await runDividendScan(getDb(), yahooDeps(), today);
  if (result.inserted.length || result.promoted || result.failed.length) {
    console.log(
      `[dividend-scan] inserted: ${result.inserted.join(", ") || "none"} · promoted: ${result.promoted} · failed: ${result.failed.join(", ") || "none"}`
    );
  }
}
