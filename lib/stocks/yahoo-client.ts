import YahooFinance from "yahoo-finance2";
import { loggedFetch } from "@/lib/network-log";

// One shared Yahoo Finance client for the whole app — stock history imports
// it here, and the dividend automation reuses the same instance rather than
// constructing its own. yahoo-finance2 v3 requires instantiation (the v2
// call-the-default-export style no longer works).
//
// Unofficial API, so two ground rules apply everywhere it's used:
// 1. Failure is normal — wrap calls in try/catch, log, degrade calmly
//    (the LeetCode-puller posture). isYahooError() names the library's
//    error classes for log specificity; the degraded behavior is the same
//    for any thrown error, including "No data found, symbol may be
//    delisted" (a delisted ticker stops returning history entirely, even
//    for ranges that used to work — same degraded state, not a special
//    case).
// 2. Every outbound call must appear in the /network-log audit — the
//    injected fetch below routes through loggedFetch (metadata only),
//    with the purpose derived from the Yahoo API path.

function purposeFromPath(pathname: string): string {
  if (pathname.includes("/chart/")) return "daily price history (chart)";
  if (pathname.includes("quoteSummary")) return "dividend calendar (quoteSummary)";
  return pathname;
}

const auditedFetch: typeof fetch = (input, init) => {
  const url =
    typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  let purpose = "yahoo request";
  try {
    purpose = purposeFromPath(new URL(url).pathname);
  } catch {
    // unparseable URL — keep the generic purpose
  }
  return loggedFetch(url, init, { feature: "yahoo-finance", purpose });
};

export const yahooFinance = new YahooFinance({
  suppressNotices: ["yahooSurvey"],
  fetch: auditedFetch,
});

// yahoo-finance2 3.x doesn't export its error classes from the package root
// (verified against the installed 3.15.4 — no `errors` namespace on the
// class, instance, or module), but every class sets a stable `name`. Match
// on that for logging; unknown names still degrade the same way.
const YAHOO_ERROR_NAMES = new Set([
  "HTTPError",
  "FailedYahooValidationError",
  "BadRequestError",
  "InvalidOptionsError",
  "NoEnvironmentError",
]);

export function isYahooError(err: unknown): boolean {
  return err instanceof Error && YAHOO_ERROR_NAMES.has(err.name);
}
