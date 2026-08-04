import assert from "node:assert/strict";
import { test } from "node:test";
import { utcOffsetLabel, zoneAbbreviation } from "../lib/clock.ts";

test("utcOffsetLabel: whole-hour offsets, both signs", () => {
  assert.equal(utcOffsetLabel(-240), "UTC-4"); // New York (EDT)
  assert.equal(utcOffsetLabel(-300), "UTC-5"); // New York (EST)
  assert.equal(utcOffsetLabel(60), "UTC+1"); // Berlin (CET)
  assert.equal(utcOffsetLabel(540), "UTC+9"); // Tokyo
});

test("utcOffsetLabel: zero is plain UTC", () => {
  assert.equal(utcOffsetLabel(0), "UTC");
});

test("utcOffsetLabel: half/quarter-hour zones keep their minutes", () => {
  assert.equal(utcOffsetLabel(330), "UTC+5:30"); // India
  assert.equal(utcOffsetLabel(345), "UTC+5:45"); // Nepal
  assert.equal(utcOffsetLabel(-210), "UTC-3:30"); // Newfoundland
});

test("zoneAbbreviation resolves a short name for a known IANA zone", () => {
  // July 10 is summer time in New York → EDT.
  const zone = zoneAbbreviation(new Date("2026-07-10T12:00:00Z"), "America/New_York", -240);
  assert.equal(zone, "EDT");
});

test("zoneAbbreviation falls back to the numeric label for a bogus zone", () => {
  const zone = zoneAbbreviation(new Date("2026-07-10T12:00:00Z"), "Not/A_Zone", -240);
  assert.equal(zone, "UTC-4");
});
