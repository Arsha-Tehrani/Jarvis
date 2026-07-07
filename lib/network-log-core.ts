// Pure pieces of the privacy/network audit log. No db/network imports so
// `node --test` exercises them directly; the getDb()-bound wrapper that
// call sites import lives in lib/network-log.ts.
//
// Design constraint (the whole point): METADATA ONLY. The log records the
// destination host, which feature triggered the call, the outcome, and how
// long it took — never the URL path, query params, headers, or bodies,
// which can contain OAuth tokens, PII, or finance data. This log must not
// become the thing that leaks what it exists to prove doesn't leak.

export type NetworkLogEntry = {
  feature: string; // e.g. "stocks-refresh", "calendar-poll", "agent-anthropic-call"
  host: string; // hostname only, never the path or query
  purpose: string; // short human string, e.g. "fetch quote"
  outcome: "ok" | "error";
  statusCode: number | null;
  latencyMs: number;
};

export type NetworkLogMeta = { feature: string; purpose: string };

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "(unparseable url)";
  }
}

type FetchLike = (url: string, opts?: RequestInit) => Promise<Response>;

// The wrapper around outbound fetch calls. Recording is fire-and-forget:
// `record` is called inside its own try/catch after the response (or
// failure) is already determined, so a logging problem can never break or
// meaningfully delay the actual call.
export async function loggedFetchWith(
  deps: { fetchImpl: FetchLike; record: (entry: NetworkLogEntry) => void },
  url: string,
  opts: RequestInit | undefined,
  meta: NetworkLogMeta
): Promise<Response> {
  const started = Date.now();
  const base = { feature: meta.feature, host: hostOf(url), purpose: meta.purpose };
  try {
    const res = await deps.fetchImpl(url, opts);
    tryRecord(deps.record, {
      ...base,
      outcome: res.ok ? "ok" : "error",
      statusCode: res.status,
      latencyMs: Date.now() - started,
    });
    return res;
  } catch (err) {
    tryRecord(deps.record, {
      ...base,
      outcome: "error",
      statusCode: null,
      latencyMs: Date.now() - started,
    });
    throw err;
  }
}

function tryRecord(record: (entry: NetworkLogEntry) => void, entry: NetworkLogEntry): void {
  try {
    record(entry);
  } catch {
    // Never let audit logging break the call it observed.
  }
}

// ---- storage (structural db type so tests can use an in-memory sqlite) ----

export type DbLike = {
  prepare(sql: string): { run(...args: unknown[]): unknown };
};

export const RETENTION_DAYS = 30;
export const MAX_ROWS = 10_000;

export function insertNetworkLog(db: DbLike, entry: NetworkLogEntry): void {
  db.prepare(
    `INSERT INTO network_log (feature, host, purpose, outcome, status_code, latency_ms)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    entry.feature,
    entry.host,
    entry.purpose,
    entry.outcome,
    entry.statusCode,
    entry.latencyMs
  );
}

// Bounded growth: drop rows past the retention window, and cap total rows
// as a backstop against a runaway poller. Cheap enough to run inline on a
// small fraction of writes (timestamp is indexed).
export function pruneNetworkLog(db: DbLike, now: Date = new Date()): void {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 86400_000).toISOString();
  db.prepare("DELETE FROM network_log WHERE timestamp < ?").run(cutoff);
  db.prepare(
    `DELETE FROM network_log
     WHERE id NOT IN (SELECT id FROM network_log ORDER BY id DESC LIMIT ?)`
  ).run(MAX_ROWS);
}
