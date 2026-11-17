import assert from "node:assert/strict";
import { test } from "node:test";
import {
  NO_ACTION,
  YES_ACTION,
  applyAnswerToBlocks,
  checkinBlocks,
  defaultCheckinEnabled,
  encodeActionValue,
  parseActionValue,
  selectUnconfirmed,
  type CheckinCandidate,
} from "../lib/slack/checkin-core.ts";
import { dailyStreak, manualTrackerLabel } from "../lib/tracker-progress.ts";

// The retroactive check-in's decisions are all deterministic, so they're
// tested directly over fixed inputs — no Slack, no LLM, no clock.

const gym: CheckinCandidate = { habitId: 1, name: "Gym", source: "gym_logs" };
const leet: CheckinCandidate = { habitId: 2, name: "LeetCode", source: "leetcode" };
const read: CheckinCandidate = { habitId: 3, name: "Read", source: null };
const ALL = [gym, leet, read];

// ---- which trackers get the nag by default ----------------------------------

test("defaultCheckinEnabled: daily gym/leetcode/manual default on", () => {
  assert.equal(defaultCheckinEnabled("gym_logs", "daily"), true);
  assert.equal(defaultCheckinEnabled("leetcode", "daily"), true);
  assert.equal(defaultCheckinEnabled(null, "daily"), true);
});

test("defaultCheckinEnabled: magnitude-based sources default off", () => {
  assert.equal(defaultCheckinEnabled("sleep_hours", "daily"), false);
  assert.equal(defaultCheckinEnabled("calories", "daily"), false);
  assert.equal(defaultCheckinEnabled("savings_rate", "daily"), false);
});

test("defaultCheckinEnabled: weekly cadence defaults off whatever the source", () => {
  assert.equal(defaultCheckinEnabled(null, "weekly"), false);
  assert.equal(defaultCheckinEnabled("gym_logs", "weekly"), false);
});

// ---- "which trackers are unconfirmed for yesterday" --------------------------

test("selectUnconfirmed: everything unlogged and unanswered is asked about", () => {
  assert.deepEqual(selectUnconfirmed(ALL, [], []), ALL);
});

test("selectUnconfirmed: a completion for that day excludes the tracker", () => {
  assert.deepEqual(
    selectUnconfirmed(ALL, [gym.habitId], []).map((c) => c.habitId),
    [leet.habitId, read.habitId]
  );
});

test("selectUnconfirmed: an existing miss excludes it too (re-ask protection)", () => {
  // This is what makes catch-up-on-launch safe: a "no" already recorded must
  // not come back as a fresh question on the next launch.
  assert.deepEqual(
    selectUnconfirmed(ALL, [], [leet.habitId]).map((c) => c.habitId),
    [gym.habitId, read.habitId]
  );
});

test("selectUnconfirmed: nothing left means no message is sent at all", () => {
  assert.deepEqual(selectUnconfirmed(ALL, [gym.habitId, read.habitId], [leet.habitId]), []);
});

// ---- Block Kit payload shape -------------------------------------------------

test("checkinBlocks: one label + one Yes/No actions row per unconfirmed tracker", () => {
  const blocks = checkinBlocks([gym, read], "2026-08-07");
  // 1 header + 2 per tracker
  assert.equal(blocks.length, 5);
  const actions = blocks.filter((b) => b.type === "actions") as Array<{
    block_id: string;
    elements: Array<{ action_id: string; value: string }>;
  }>;
  assert.deepEqual(
    actions.map((a) => a.block_id),
    ["checkin_1", "checkin_3"]
  );
  for (const row of actions) {
    assert.deepEqual(
      row.elements.map((e) => e.action_id),
      [YES_ACTION, NO_ACTION]
    );
  }
  // Each button encodes {habitId, date} — the historical date, not today.
  assert.deepEqual(parseActionValue(actions[0].elements[0].value), {
    habitId: 1,
    date: "2026-08-07",
  });
});

test("parseActionValue: rejects malformed, non-integer, and bad-date values", () => {
  assert.equal(parseActionValue("not json"), null);
  assert.equal(parseActionValue(JSON.stringify({ habitId: "1", date: "2026-08-07" })), null);
  assert.equal(parseActionValue(JSON.stringify({ habitId: 1.5, date: "2026-08-07" })), null);
  assert.equal(parseActionValue(JSON.stringify({ habitId: 1, date: "07/08/2026" })), null);
  assert.equal(parseActionValue(JSON.stringify({ habitId: -1, date: "2026-08-07" })), null);
  assert.deepEqual(parseActionValue(encodeActionValue(9, "2026-01-02")), {
    habitId: 9,
    date: "2026-01-02",
  });
});

test("applyAnswerToBlocks: answered row becomes static, others stay tappable", () => {
  const blocks = checkinBlocks([gym, read], "2026-08-07");
  const updated = applyAnswerToBlocks(blocks, gym.habitId, gym.name, "yes");
  // Gym's buttons are gone (a double-tap has nothing to hit) …
  assert.equal(
    updated.some((b) => b.block_id === "checkin_1"),
    false
  );
  const label = updated.find((b) => b.block_id === "checkin_label_1") as {
    text: { text: string };
  };
  assert.match(label.text.text, /✅/);
  // … while the other tracker is untouched.
  assert.equal(
    updated.some((b) => b.block_id === "checkin_3"),
    true
  );
});

test("applyAnswerToBlocks: a No renders the missed marker", () => {
  const updated = applyAnswerToBlocks(
    checkinBlocks([read], "2026-08-07"),
    read.habitId,
    read.name,
    "no"
  );
  const label = updated.find((b) => b.block_id === "checkin_label_3") as {
    text: { text: string };
  };
  assert.match(label.text.text, /🔴/);
});

// ---- streak: a miss breaks it, no-data behaves as before ---------------------

test("dailyStreak: an unlogged today keeps the grace period (unchanged)", () => {
  const logged = ["2026-08-05", "2026-08-06", "2026-08-07"];
  assert.equal(dailyStreak(logged, [], "2026-08-08"), 3);
});

test("dailyStreak: an explicit miss today revokes the grace and breaks the streak", () => {
  const logged = ["2026-08-05", "2026-08-06", "2026-08-07"];
  assert.equal(dailyStreak(logged, ["2026-08-08"], "2026-08-08"), 0);
});

test("dailyStreak: a logged today counts, and earlier gaps still stop the walk", () => {
  const logged = ["2026-08-04", "2026-08-07", "2026-08-08"];
  assert.equal(dailyStreak(logged, [], "2026-08-08"), 2);
});

test("dailyStreak: an older miss stops the walk just like a plain gap", () => {
  const logged = ["2026-08-07", "2026-08-08"];
  assert.equal(dailyStreak(logged, ["2026-08-06"], "2026-08-08"), 2);
});

test("manualTrackerLabel: says 'missed today' for an explicit miss", () => {
  const base = { streak: 0, thisWeek: 2, goal: 5, doneToday: false };
  assert.equal(manualTrackerLabel("daily", base), "0-day streak · not yet today");
  assert.equal(
    manualTrackerLabel("daily", { ...base, missedToday: true }),
    "0-day streak · missed today"
  );
});
