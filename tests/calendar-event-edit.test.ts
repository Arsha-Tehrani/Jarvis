import assert from "node:assert/strict";
import { test } from "node:test";
import { buildGoogleEventPatch } from "../lib/calendar-grid.ts";

// Edit payloads go through the same all-day-vs-timed detection creation uses
// (resolveGoogleEventTimes, already unit-tested in calendar-grid.test.ts) —
// these cover the PATCH-specific shape: only provided fields appear, and
// half-specified times are rejected instead of guessed.

test("title-only edit patches summary and nothing else", () => {
  assert.deepEqual(buildGoogleEventPatch({ title: "Dentist (moved)" }), {
    summary: "Dentist (moved)",
  });
});

test("timed edit produces a dateTime start/end pair", () => {
  const body = buildGoogleEventPatch({
    start: "2026-07-20T15:00:00",
    end: "2026-07-20T16:30:00",
  });
  assert.ok("start" in body && "end" in body);
  assert.ok((body.start as { dateTime: string }).dateTime);
  assert.ok((body.end as { dateTime: string }).dateTime);
});

test("timed edit without an end defaults to one hour (same as creation)", () => {
  const body = buildGoogleEventPatch({ start: "2026-07-20T15:00:00Z" });
  const start = Date.parse((body.start as { dateTime: string }).dateTime);
  const end = Date.parse((body.end as { dateTime: string }).dateTime);
  assert.equal(end - start, 60 * 60 * 1000);
});

test("all-day edit produces a date pair with Google's exclusive end", () => {
  const body = buildGoogleEventPatch({ title: "Trip", start: "2026-07-20" });
  assert.deepEqual(body, {
    summary: "Trip",
    start: { date: "2026-07-20" },
    end: { date: "2026-07-21" },
  });
});

test("an end without a start is rejected, not guessed", () => {
  assert.throws(() => buildGoogleEventPatch({ end: "2026-07-20T16:00:00" }), /requires a start/);
});

test("an empty edit is rejected", () => {
  assert.throws(() => buildGoogleEventPatch({}), /Nothing to update/);
});

test("an unparseable start throws instead of silently misdating", () => {
  assert.throws(() => buildGoogleEventPatch({ start: "next Tuesday" }), /Unparseable/);
});
