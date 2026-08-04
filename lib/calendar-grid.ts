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

/**
 * The calendar day after `date` (YYYY-MM-DD in, YYYY-MM-DD out), in local
 * time. Google's all-day events use an EXCLUSIVE end date, so a one-day
 * all-day event on the 20th needs end date "…-21" — this is that +1.
 */
export function nextLocalDay(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new Error(`Expected YYYY-MM-DD, got "${date}"`);
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1);
  return localDateKey(d);
}

export type GoogleEventTimes =
  | { start: { date: string }; end: { date: string } }
  | { start: { dateTime: string }; end: { dateTime: string } };

/**
 * The {start,end} shape Google's Calendar API expects, from a plain
 * `start`/`end` pair a form or tool call would naturally produce: a
 * date-only "YYYY-MM-DD" (all-day, same convention as `isAllDay`) or a full
 * ISO datetime (timed). All-day events use Google's EXCLUSIVE end-date
 * convention (`nextLocalDay`), defaulting to a single day when no end is
 * given; timed events default to one hour after start (unchanged from the
 * pre-existing create_calendar_event behavior). Throws on an unparseable
 * start/end rather than silently misdating the event — the caller decides
 * how to surface that.
 */
export function resolveGoogleEventTimes(start: string, end?: string): GoogleEventTimes {
  if (isAllDay(start)) {
    const endDate = end ? end.slice(0, 10) : nextLocalDay(start);
    return { start: { date: start }, end: { date: endDate } };
  }
  const startMs = Date.parse(start);
  if (Number.isNaN(startMs)) throw new Error(`Unparseable start time: "${start}"`);
  const endIso = end ?? new Date(startMs + 60 * 60 * 1000).toISOString();
  const endMs = Date.parse(endIso);
  if (Number.isNaN(endMs)) throw new Error(`Unparseable end time: "${end}"`);
  return {
    start: { dateTime: new Date(startMs).toISOString() },
    end: { dateTime: new Date(endMs).toISOString() },
  };
}

/**
 * Google event-PATCH body from the partial fields an edit form or tool call
 * sends. Only the provided fields appear in the body (PATCH semantics: absent
 * fields stay untouched on Google). A time change goes through the same
 * resolveGoogleEventTimes as creation, so all-day-vs-timed detection is never
 * forked. `end` without `start` is rejected — Google needs both halves to
 * move an event, and guessing the start would silently misdate it.
 */
export function buildGoogleEventPatch(fields: {
  title?: string;
  start?: string;
  end?: string;
  description?: string;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (fields.title !== undefined) body.summary = fields.title;
  if (fields.description !== undefined) body.description = fields.description;
  if (fields.start !== undefined) {
    Object.assign(body, resolveGoogleEventTimes(fields.start, fields.end));
  } else if (fields.end !== undefined) {
    throw new Error("An end time requires a start time");
  }
  if (Object.keys(body).length === 0) {
    throw new Error("Nothing to update — provide at least one field");
  }
  return body;
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

/**
 * The local calendar day a task's due date lands on, or null when it has no
 * due date. `due_at` is either a date-only YYYY-MM-DD (kept verbatim, no UTC
 * shift) or a full ISO timestamp (mapped to the viewer's local day) — the two
 * shapes the `tasks.due_at` column holds, read the same way the Tasks page
 * reads it. Lets the Calendar page place a due task on the right cell.
 */
export function taskDayKey(dueAt: string | null | undefined): string | null {
  if (!dueAt) return null;
  if (DATE_ONLY.test(dueAt)) return dueAt;
  const d = new Date(dueAt);
  if (Number.isNaN(d.getTime())) return null;
  return localDateKey(d);
}

/**
 * Google event ids that are mere MIRRORS of tasks already rendered as
 * color-coded task chips, so the Calendar page's generic event list can
 * exclude them and never show a task twice.
 *
 * Every task write (any source — UI, agent, mail import, this page's own
 * quick-add) mirrors a real Google Calendar event titled "Task: {title}"
 * (lib/tasks/calendar-plan.ts) so the task is visible on Google itself. Once
 * that mirror event round-trips through the hourly/on-open poll, it's
 * indistinguishable from a genuine event UNLESS we cross-reference it against
 * `tasks.gcal_event_id` (already returned by GET /api/tasks) — exactly the
 * set this computes. Only OPEN tasks with a due date are included, because
 * those are the only ones that render as a task chip; a completed task's
 * renamed "✓ {title}" event has no chip to collide with and stays visible as
 * a real calendar record.
 */
export function taskMirrorEventIds(
  tasks: ReadonlyArray<{
    status: string;
    due_at: string | null | undefined;
    gcal_event_id: string | null | undefined;
  }>
): Set<string> {
  const ids = new Set<string>();
  for (const t of tasks) {
    if (t.status === "open" && t.gcal_event_id && taskDayKey(t.due_at)) {
      ids.add(t.gcal_event_id);
    }
  }
  return ids;
}

/** "9:30 AM" for timed events, "" for all-day. */
export function eventTimeLabel(start: string): string {
  if (isAllDay(start)) return "";
  const d = new Date(start);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}
