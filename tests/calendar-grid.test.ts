import assert from "node:assert/strict";
import { test } from "node:test";
import {
  eventDayKeys,
  eventTimeLabel,
  isAllDay,
  localDateKey,
  monthGrid,
  nextLocalDay,
  resolveGoogleEventTimes,
  taskDayKey,
  taskMirrorEventIds,
  weekOf,
} from "../lib/calendar-grid.ts";

// NOTE: timed-event fixtures use offset-less ISO strings ("2026-07-08T09:00:00")
// which Date parses as LOCAL time, so these assertions hold in any timezone.

test("monthGrid: 42 Sunday-first cells containing the whole month", () => {
  const days = monthGrid(2026, 6); // July 2026 — the 1st is a Wednesday
  assert.equal(days.length, 42);
  assert.equal(days[0].getDay(), 0); // starts on a Sunday
  assert.equal(localDateKey(days[0]), "2026-06-28"); // Sunday before Jul 1
  const keys = days.map(localDateKey);
  assert.ok(keys.includes("2026-07-01"));
  assert.ok(keys.includes("2026-07-31"));
});

test("weekOf: Sunday through Saturday around the anchor", () => {
  const days = weekOf(new Date(2026, 6, 8)); // Wed Jul 8 2026
  assert.equal(days.length, 7);
  assert.equal(localDateKey(days[0]), "2026-07-05");
  assert.equal(localDateKey(days[6]), "2026-07-11");
});

test("date-only event stays on its own day — no UTC shift", () => {
  // new Date("2026-07-08") is UTC midnight; behind UTC that's Jul 7 local.
  // eventDayKeys must parse date-only strings locally instead.
  assert.deepEqual(eventDayKeys("2026-07-08", "2026-07-09"), ["2026-07-08"]);
});

test("all-day multi-day event honors Google's exclusive end date", () => {
  assert.deepEqual(eventDayKeys("2026-07-08", "2026-07-11"), [
    "2026-07-08",
    "2026-07-09",
    "2026-07-10",
  ]);
});

test("timed event spanning days paints each day", () => {
  assert.deepEqual(
    eventDayKeys("2026-07-08T22:00:00", "2026-07-09T02:00:00"),
    ["2026-07-08", "2026-07-09"]
  );
});

test("timed event ending exactly at midnight stays on the evening before", () => {
  assert.deepEqual(
    eventDayKeys("2026-07-08T20:00:00", "2026-07-09T00:00:00"),
    ["2026-07-08"]
  );
});

test("garbage dates degrade to empty / single-day, never throw", () => {
  assert.deepEqual(eventDayKeys("not-a-date", "also-not"), []);
  assert.deepEqual(eventDayKeys("2026-07-08T09:00:00", "garbage"), ["2026-07-08"]);
});

test("a runaway multi-month event is capped, not rendered forever", () => {
  const keys = eventDayKeys("2026-01-01", "2027-01-01");
  assert.equal(keys.length, 60);
});

test("time labels: timed events get a clock, all-day gets none", () => {
  assert.equal(isAllDay("2026-07-08"), true);
  assert.equal(isAllDay("2026-07-08T09:00:00"), false);
  assert.equal(eventTimeLabel("2026-07-08"), "");
  assert.equal(eventTimeLabel("2026-07-08T09:30:00"), "9:30 AM");
});

test("taskDayKey: date-only due dates are kept verbatim (no UTC shift)", () => {
  assert.equal(taskDayKey("2026-07-20"), "2026-07-20");
});

test("taskDayKey: null/empty/undefined due date has no day", () => {
  assert.equal(taskDayKey(null), null);
  assert.equal(taskDayKey(undefined), null);
  assert.equal(taskDayKey(""), null);
});

test("taskDayKey: a full local ISO timestamp maps to that local day", () => {
  // Offset-less ISO parses as LOCAL time, so this holds in any timezone.
  assert.equal(taskDayKey("2026-07-20T09:30:00"), "2026-07-20");
});

test("taskDayKey: an unparseable due date is treated as no day, never a crash", () => {
  assert.equal(taskDayKey("not a date"), null);
});

test("taskMirrorEventIds: an open task with a due date and a linked event is included", () => {
  const ids = taskMirrorEventIds([
    { status: "open", due_at: "2026-07-20", gcal_event_id: "evt1" },
  ]);
  assert.deepEqual([...ids], ["evt1"]);
});

test("taskMirrorEventIds: a done task's linked event is excluded (no chip to collide with)", () => {
  const ids = taskMirrorEventIds([
    { status: "done", due_at: "2026-07-20", gcal_event_id: "evt1" },
  ]);
  assert.deepEqual([...ids], []);
});

test("taskMirrorEventIds: a task with no due date is excluded (never renders a chip)", () => {
  const ids = taskMirrorEventIds([
    { status: "open", due_at: null, gcal_event_id: "evt1" },
  ]);
  assert.deepEqual([...ids], []);
});

test("taskMirrorEventIds: a task with no linked event contributes nothing", () => {
  const ids = taskMirrorEventIds([
    { status: "open", due_at: "2026-07-20", gcal_event_id: null },
  ]);
  assert.deepEqual([...ids], []);
});

test("taskMirrorEventIds: multiple open+due tasks all contribute their event ids", () => {
  const ids = taskMirrorEventIds([
    { status: "open", due_at: "2026-07-20", gcal_event_id: "evt1" },
    { status: "open", due_at: "2026-07-21", gcal_event_id: "evt2" },
    { status: "done", due_at: "2026-07-22", gcal_event_id: "evt3" },
  ]);
  assert.deepEqual([...ids].sort(), ["evt1", "evt2"]);
});

test("taskMirrorEventIds: empty task list is an empty set, never a crash", () => {
  assert.deepEqual([...taskMirrorEventIds([])], []);
});

test("nextLocalDay: plain +1 day", () => {
  assert.equal(nextLocalDay("2026-07-20"), "2026-07-21");
});

test("nextLocalDay: rolls over month and year boundaries", () => {
  assert.equal(nextLocalDay("2026-07-31"), "2026-08-01");
  assert.equal(nextLocalDay("2026-12-31"), "2027-01-01");
});

test("nextLocalDay: rejects a non-date-only string rather than silently misparsing", () => {
  assert.throws(() => nextLocalDay("2026-07-20T09:00:00"));
});

test("resolveGoogleEventTimes: all-day with no end defaults to a single day (exclusive end +1)", () => {
  assert.deepEqual(resolveGoogleEventTimes("2026-07-20"), {
    start: { date: "2026-07-20" },
    end: { date: "2026-07-21" },
  });
});

test("resolveGoogleEventTimes: all-day with an explicit end date is honored as-is", () => {
  assert.deepEqual(resolveGoogleEventTimes("2026-07-20", "2026-07-23"), {
    start: { date: "2026-07-20" },
    end: { date: "2026-07-23" },
  });
});

test("resolveGoogleEventTimes: timed with no end defaults to one hour later", () => {
  const r = resolveGoogleEventTimes("2026-07-20T09:00:00");
  assert.equal("dateTime" in r.start && r.start.dateTime, new Date("2026-07-20T09:00:00").toISOString());
  assert.equal(
    "dateTime" in r.end && r.end.dateTime,
    new Date(new Date("2026-07-20T09:00:00").getTime() + 60 * 60 * 1000).toISOString()
  );
});

test("resolveGoogleEventTimes: timed with an explicit end is honored", () => {
  const r = resolveGoogleEventTimes("2026-07-20T09:00:00", "2026-07-20T10:30:00");
  assert.equal("dateTime" in r.end && r.end.dateTime, new Date("2026-07-20T10:30:00").toISOString());
});

test("resolveGoogleEventTimes: an unparseable start throws rather than silently misdating", () => {
  assert.throws(() => resolveGoogleEventTimes("not-a-date"));
});

test("resolveGoogleEventTimes: an unparseable timed end throws", () => {
  assert.throws(() => resolveGoogleEventTimes("2026-07-20T09:00:00", "not-a-date"));
});
