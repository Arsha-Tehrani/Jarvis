// Pure date math for the calendar grid — no database, no network, no React.
// Everything works in LOCAL time on purpose: the grid answers "what day does
// this event land on for the person looking at the screen", and parsing
// date-only strings via `new Date("YYYY-MM-DD")` would shift them through UTC.

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** YYYY-MM-DD in local time. */
export function localDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function isAllDay(start: string): boolean {
  return DATE_ONLY.test(start);
}

/** Parse date-only strings as LOCAL midnight; anything else as-is. */
function parseLocal(s: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return new Date(s);
}

/**
 * The 42 days (6 weeks, Sunday-first) shown for a month view.
 * `month` is 0-based like Date. Always 6 rows so the grid never jumps height.
 */
export function monthGrid(year: number, month: number): Date[] {
  const first = new Date(year, month, 1);
  const startOffset = first.getDay(); // 0 = Sunday
  const days: Date[] = [];
  for (let i = 0; i < 42; i++) {
    days.push(new Date(year, month, 1 - startOffset + i));
  }
  return days;
}

/** The Sunday-to-Saturday week containing `anchor`. */
export function weekOf(anchor: Date): Date[] {
  const sunday = new Date(
    anchor.getFullYear(),
    anchor.getMonth(),
    anchor.getDate() - anchor.getDay()
  );
  const days: Date[] = [];
  for (let i = 0; i < 7; i++) {
    days.push(new Date(sunday.getFullYear(), sunday.getMonth(), sunday.getDate() + i));
  }
  return days;
}

/**
 * Local date keys an event covers, so multi-day events paint every cell they
 * span. Google's conventions are honored:
 *  - all-day events carry a date-only, EXCLUSIVE end (a one-day event on the
 *    8th has end "…-09"), so the end date itself is not included;
 *  - timed events ending exactly at midnight end on the PREVIOUS day (a party
 *    running 20:00–00:00 belongs to one evening, not two).
 * Capped at 60 days so one malformed year-long row can't flood the grid.
 */
export function eventDayKeys(start: string, end: string): string[] {
  const s = parseLocal(start);
  if (Number.isNaN(s.getTime())) return [];

  let e = parseLocal(end);
  if (Number.isNaN(e.getTime())) e = s;

  if (DATE_ONLY.test(end) && e > s) {
    e = new Date(e.getFullYear(), e.getMonth(), e.getDate() - 1); // exclusive end
  } else if (
    !DATE_ONLY.test(end) &&
    e > s &&
    e.getHours() === 0 &&
    e.getMinutes() === 0 &&
    e.getSeconds() === 0
  ) {
    e = new Date(e.getTime() - 1); // midnight end = previous evening
  }

  const keys: string[] = [];
  const cur = new Date(s.getFullYear(), s.getMonth(), s.getDate());
  const last = new Date(e.getFullYear(), e.getMonth(), e.getDate());
  while (cur.getTime() <= last.getTime() && keys.length < 60) {
    keys.push(localDateKey(cur));
    cur.setDate(cur.getDate() + 1);
  }
  if (keys.length === 0) keys.push(localDateKey(s));
  return keys;
}

/** "9:30 AM" for timed events, "" for all-day. */
export function eventTimeLabel(start: string): string {
  if (isAllDay(start)) return "";
  const d = new Date(start);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}
