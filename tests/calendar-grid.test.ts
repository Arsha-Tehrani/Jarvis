import assert from "node:assert/strict";
import { test } from "node:test";
import {
  eventDayKeys,
  eventTimeLabel,
  isAllDay,
  localDateKey,
  monthGrid,
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
