import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseLeetCodeAnswer,
  parseSleepAnswer,
  parseYesNo,
} from "../lib/slack-parse.ts";

test("sleep: clock times become bedtime decimal hours", () => {
  assert.deepEqual(parseSleepAnswer("11:30"), { kind: "bedtime", value: 23.5 });
  assert.deepEqual(parseSleepAnswer("11:30pm"), { kind: "bedtime", value: 23.5 });
  assert.deepEqual(parseSleepAnswer("23:15"), { kind: "bedtime", value: 23.25 });
  assert.deepEqual(parseSleepAnswer("11pm"), { kind: "bedtime", value: 23 });
  assert.deepEqual(parseSleepAnswer("1am"), { kind: "bedtime", value: 1 });
  assert.deepEqual(parseSleepAnswer("12am"), { kind: "bedtime", value: 0 });
  assert.deepEqual(parseSleepAnswer("midnight"), { kind: "bedtime", value: 0 });
  assert.deepEqual(parseSleepAnswer("around 12"), { kind: "bedtime", value: 0 });
  assert.deepEqual(parseSleepAnswer("at 2"), { kind: "bedtime", value: 2 });
});

test("sleep: durations become sleep_hours", () => {
  assert.deepEqual(parseSleepAnswer("7h"), { kind: "sleep_hours", value: 7 });
  assert.deepEqual(parseSleepAnswer("7.5 hours"), { kind: "sleep_hours", value: 7.5 });
  assert.deepEqual(parseSleepAnswer("8 hrs"), { kind: "sleep_hours", value: 8 });
  assert.deepEqual(parseSleepAnswer("slept 6"), { kind: "sleep_hours", value: 6 });
});

test("sleep: garbage is null (LLM fallback territory)", () => {
  assert.equal(parseSleepAnswer(""), null);
  assert.equal(parseSleepAnswer("pretty late lol"), null);
  assert.equal(parseSleepAnswer("99:99"), null);
});

test("yes/no variants", () => {
  for (const yes of ["yes", "y", "Yeah", "yep", "YUP", "did", "done", "✅", "yes!"]) {
    assert.equal(parseYesNo(yes), true, yes);
  }
  for (const no of ["no", "n", "Nope", "nah", "didn't", "didnt", "skipped", "missed it", "❌"]) {
    assert.equal(parseYesNo(no), false, no);
  }
  assert.equal(parseYesNo("kind of"), null);
  assert.equal(parseYesNo(""), null);
});

test("leetcode: counts and yes/no", () => {
  assert.deepEqual(parseLeetCodeAnswer("yes"), { did: true, count: 1 });
  assert.deepEqual(parseLeetCodeAnswer("no"), { did: false, count: 0 });
  assert.deepEqual(parseLeetCodeAnswer("3"), { did: true, count: 3 });
  assert.deepEqual(parseLeetCodeAnswer("solved 2"), { did: true, count: 2 });
  assert.deepEqual(parseLeetCodeAnswer("did 1 problem"), { did: true, count: 1 });
  assert.deepEqual(parseLeetCodeAnswer("0"), { did: false, count: 0 });
  assert.equal(parseLeetCodeAnswer("a few"), null);
});
