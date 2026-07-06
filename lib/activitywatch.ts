// ActivityWatch (activitywatch.net) runs locally on :5600 and is the
// screen-time source. aw-watcher-afk marks active vs afk spans,
// aw-watcher-window records the focused app, and the browser extension
// (aw-watcher-web) records the active tab. AW not running is a normal
// state — callers get { available: false }, never an exception.

const FETCH_TIMEOUT_MS = 3000;
const EVENT_LIMIT = 5000; // comfortably more than a day of events

function awBaseUrl(): string {
  return process.env.AW_BASE_URL ?? "http://localhost:5600";
}

export type AwEvent = {
  timestamp: string;
  duration: number; // seconds
  data: Record<string, unknown>;
};

export type UsageItem = { name: string; seconds: number };

export type ActivitySummary =
  | { available: false }
  | {
      available: true;
      totalSeconds: number;
      topApps: UsageItem[];
      topDomains: UsageItem[];
    };

// --- pure aggregation (unit-tested) ----------------------------------------

export function sumActiveSeconds(afkEvents: AwEvent[]): number {
  let total = 0;
  for (const e of afkEvents) {
    if (e.data.status === "not-afk" && e.duration > 0) total += e.duration;
  }
  return Math.round(total);
}

export function topByDuration(
  events: AwEvent[],
  key: (e: AwEvent) => string | null,
  n = 5
): UsageItem[] {
  const totals = new Map<string, number>();
  for (const e of events) {
    const name = key(e);
    if (!name || !(e.duration > 0)) continue;
    totals.set(name, (totals.get(name) ?? 0) + e.duration);
  }
  return [...totals.entries()]
    .map(([name, seconds]) => ({ name, seconds: Math.round(seconds) }))
    .sort((a, b) => b.seconds - a.seconds)
    .slice(0, n);
}

export function appOf(e: AwEvent): string | null {
  return typeof e.data.app === "string" && e.data.app.trim() ? e.data.app : null;
}

export function domainOf(e: AwEvent): string | null {
  if (typeof e.data.url !== "string") return null;
  try {
    const host = new URL(e.data.url).hostname.replace(/^www\./, "");
    return host || null;
  } catch {
    return null;
  }
}

// --- local API access -------------------------------------------------------

async function awGet(pathname: string): Promise<unknown> {
  const res = await fetch(`${awBaseUrl()}${pathname}`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`ActivityWatch ${pathname} → ${res.status}`);
  return res.json();
}

type BucketInfo = { type?: string };

export async function getTodayActivity(): Promise<ActivitySummary> {
  let buckets: Record<string, BucketInfo>;
  try {
    buckets = (await awGet("/api/0/buckets/")) as Record<string, BucketInfo>;
  } catch {
    return { available: false };
  }

  const idsOfType = (type: string) =>
    Object.entries(buckets)
      .filter(([, b]) => b?.type === type)
      .map(([id]) => id);

  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const range =
    `start=${encodeURIComponent(midnight.toISOString())}` +
    `&end=${encodeURIComponent(new Date().toISOString())}`;

  async function eventsOf(type: string): Promise<AwEvent[]> {
    const all: AwEvent[] = [];
    for (const id of idsOfType(type)) {
      const events = (await awGet(
        `/api/0/buckets/${encodeURIComponent(id)}/events?${range}&limit=${EVENT_LIMIT}`
      )) as AwEvent[];
      all.push(...events);
    }
    return all;
  }

  try {
    const [afk, windows, web] = await Promise.all([
      eventsOf("afkstatus"),
      eventsOf("currentwindow"),
      eventsOf("web.tab.current"),
    ]);
    // No AFK watcher running → fall back to summed window-focus time.
    const totalSeconds =
      afk.length > 0
        ? sumActiveSeconds(afk)
        : Math.round(windows.reduce((s, e) => s + Math.max(0, e.duration), 0));
    return {
      available: true,
      totalSeconds,
      topApps: topByDuration(windows, appOf),
      topDomains: topByDuration(web, domainOf),
    };
  } catch {
    return { available: false };
  }
}
