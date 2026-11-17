import assert from "node:assert/strict";
import { test } from "node:test";
import {
  digestWindow,
  dividendsInWindow,
  formatMarketsDigest,
  money,
  type DigestDividend,
} from "../lib/markets-digest-core.ts";

// The weekday/weekend branch is deterministic, so it's tested over fixed dates
// rather than by waiting for a Saturday. Slack is not involved at all here.

// 2026-08-03 is a Monday; 08-08 Saturday; 08-09 Sunday.
const monday = new Date("2026-08-03T12:00:00");
const friday = new Date("2026-08-07T12:00:00");
const saturday = new Date("2026-08-08T12:00:00");
const sunday = new Date("2026-08-09T12:00:00");

test("weekdays report the latest trading day with a 1-day lookback", () => {
  for (const d of [monday, friday]) {
    const w = digestWindow(d);
    assert.equal(w.kind, "day");
    assert.equal(w.lookback, "1d");
  }
  // Monday's 1-day window starts on Sunday; the contribution engine's
  // closest-close-at-or-before then lands on Friday, so no special-casing here.
  assert.equal(digestWindow(monday).since, "2026-08-02");
});

test("weekends report the past week with a 7-day lookback", () => {
  for (const d of [saturday, sunday]) {
    const w = digestWindow(d);
    assert.equal(w.kind, "week");
    assert.equal(w.lookback, "1w");
  }
  assert.equal(digestWindow(saturday).since, "2026-08-01");
  assert.equal(digestWindow(saturday).until, "2026-08-07");
});

// ---- dividends in the covered window -----------------------------------------

const dividends: DigestDividend[] = [
  // Confirmed → counts by payment_date (in Friday's window).
  { ticker: "VOO", payout: 42.5, status: "confirmed", ex_date: "2026-07-01", payment_date: "2026-08-06" },
  // Pending → counts by ex_date (in Friday's window).
  { ticker: "SCHD", payout: 18.25, status: "pending", ex_date: "2026-08-06", payment_date: null },
  // Confirmed but paid long ago — out of every window here.
  { ticker: "MSFT", payout: 9, status: "confirmed", ex_date: "2026-06-01", payment_date: "2026-06-15" },
  // Pending whose ex_date is in the week but not on Friday's single day.
  { ticker: "AAPL", payout: 5, status: "pending", ex_date: "2026-08-03", payment_date: null },
];

test("weekday window includes only that day's dividends, keyed by the right column", () => {
  const picked = dividendsInWindow(dividends, digestWindow(friday)).map((d) => d.ticker);
  assert.deepEqual(picked, ["VOO", "SCHD"]);
});

test("weekend window widens to the full week", () => {
  const picked = dividendsInWindow(dividends, digestWindow(saturday)).map((d) => d.ticker);
  assert.deepEqual(picked, ["VOO", "SCHD", "AAPL"]);
});

test("a confirmed dividend with no payment_date is never counted", () => {
  const orphan: DigestDividend[] = [
    { ticker: "X", payout: 1, status: "confirmed", ex_date: "2026-08-06", payment_date: null },
  ];
  assert.deepEqual(dividendsInWindow(orphan, digestWindow(friday)), []);
});

// ---- message composition -------------------------------------------------------

test("money renders a signed, rounded dollar figure", () => {
  assert.equal(money(1234.6), "+$1,235");
  assert.equal(money(-1234.6), "−$1,235");
});

test("formatMarketsDigest: gains, drivers, and both dividend statuses", () => {
  const text = formatMarketsDigest({
    window: digestWindow(friday),
    dollarChange: 512.4,
    percentChange: 1.234,
    drivers: "Over the past day, your portfolio moved +$512.",
    dividends: dividendsInWindow(dividends, digestWindow(friday)),
  });
  assert.match(text, /📈 \*Latest trading day\* — portfolio \+\$512 \(\+1\.23%\)/);
  assert.match(text, /Over the past day/);
  assert.match(text, /VOO \$42\.50 paid 2026-08-06/);
  assert.match(text, /SCHD \$18\.25 pending \(ex-date 2026-08-06\)/);
});

test("formatMarketsDigest: a loss flips the emoji and sign", () => {
  const text = formatMarketsDigest({
    window: digestWindow(saturday),
    dollarChange: -800,
    percentChange: -2,
    drivers: null,
    dividends: [],
  });
  assert.match(text, /📉 \*This past week\* — portfolio −\$800 \(−2\.00%\)/);
  assert.equal(text.includes("Dividends"), false);
});

test("formatMarketsDigest: no valuation says so rather than reporting $0", () => {
  const text = formatMarketsDigest({
    window: digestWindow(friday),
    dollarChange: null,
    percentChange: null,
    drivers: null,
    dividends: [],
  });
  assert.match(text, /no portfolio valuation available/);
  assert.equal(text.includes("$0"), false);
});
