import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatAmbiguousReply,
  formatCompletionReply,
  formatCurrentDigestReply,
  formatDigestMessage,
  matchTitles,
  numberedTaskLines,
  parseTaskReply,
  resolveDigestIndex,
} from "../lib/slack/task-replies.ts";

// Deterministic parsing for reply-to-complete. Contract: anything that
// isn't clearly a completion returns null and flows to the check-in/agent
// pipeline unchanged — existing behavior must not regress.

// ---- parseTaskReply ------------------------------------------------------------

test('"done 2" parses as a 1-based digest index', () => {
  assert.deepEqual(parseTaskReply("done 2"), { kind: "by-number", index: 2 });
});

test('"Done #1" is case-insensitive and tolerates the hash', () => {
  assert.deepEqual(parseTaskReply("Done #1"), { kind: "by-number", index: 1 });
});

test('"finished 3" and trailing "2 done" both resolve by number', () => {
  assert.deepEqual(parseTaskReply("finished 3"), { kind: "by-number", index: 3 });
  assert.deepEqual(parseTaskReply("2 done"), { kind: "by-number", index: 2 });
});

test('"finished the recruiter email" parses as words', () => {
  assert.deepEqual(parseTaskReply("finished the recruiter email"), {
    kind: "by-words",
    words: "the recruiter email",
  });
});

test("non-completion messages fall through as null", () => {
  assert.equal(parseTaskReply("yes"), null);
  assert.equal(parseTaskReply("7h"), null);
  assert.equal(parseTaskReply("no gym yesterday"), null);
  assert.equal(parseTaskReply("done"), null); // bare word, no operand
  assert.equal(parseTaskReply("remind me to call the bank"), null);
});

// ---- digest indexing -----------------------------------------------------------

test("digest indexing is 1-based against the stored task_ids order", () => {
  const stored = [42, 7, 19];
  assert.equal(resolveDigestIndex(stored, 1), 42);
  assert.equal(resolveDigestIndex(stored, 3), 19);
});

test("out-of-range or nonsense indexes resolve to null", () => {
  const stored = [42, 7, 19];
  assert.equal(resolveDigestIndex(stored, 0), null);
  assert.equal(resolveDigestIndex(stored, 9), null);
  assert.equal(resolveDigestIndex([], 1), null);
});

// ---- title matching ------------------------------------------------------------

const OPEN = [
  { id: 1, title: "Reply: Invitation for assessments — Optiver" },
  { id: 2, title: "Email the recruiter about next steps" },
  { id: 3, title: "Reply: Advising meeting" },
];

test("exactly one case-insensitive substring hit completes", () => {
  assert.deepEqual(matchTitles("RECRUITER", OPEN), { kind: "one", id: 2 });
});

test("ambiguous substring (two matches) returns the candidates", () => {
  const match = matchTitles("reply:", OPEN);
  assert.equal(match.kind, "many");
  assert.deepEqual(
    (match as { candidates: Array<{ id: number }> }).candidates.map((c) => c.id),
    [1, 3]
  );
});

test("zero matches falls through as none (LLM territory)", () => {
  assert.deepEqual(matchTitles("the dentist thing", OPEN), { kind: "none" });
  assert.deepEqual(matchTitles("   ", OPEN), { kind: "none" });
});

// ---- reply generation ----------------------------------------------------------

test("digest message: header count, numbered top tasks, reply hint", () => {
  const msg = formatDigestMessage(5, [
    { id: 42, title: "File taxes", due_at: "2026-07-14" },
    { id: 7, title: "Backlog idea", due_at: null },
  ]);
  assert.ok(msg);
  const lines = msg!.split("\n");
  assert.equal(lines[0], "Task check — 5 open");
  assert.equal(lines[1], "1. File taxes — due Jul 14");
  assert.equal(lines[2], "2. Backlog idea — no date");
  assert.match(lines[3], /Reply "done 2" or "done <task words>"/);
});

test("zero open tasks produce no digest at all", () => {
  assert.equal(formatDigestMessage(0, []), null);
  assert.equal(formatDigestMessage(3, []), null);
});

test("completion reply includes still-due-today only when non-empty", () => {
  assert.equal(formatCompletionReply("File taxes", []), "✓ Completed: File taxes");
  assert.equal(
    formatCompletionReply("File taxes", ["Call bank", "Send form"]),
    "✓ Completed: File taxes\nStill due today: Call bank; Send form"
  );
});

test("unresolvable-number reply re-shows the current numbered list", () => {
  const reply = formatCurrentDigestReply("Couldn't match that.", [
    { id: 1, title: "A", due_at: null },
  ]);
  assert.equal(reply, "Couldn't match that.\n1. A — no date");
  assert.match(
    formatCurrentDigestReply("Couldn't match that.", []),
    /Nothing is open right now/
  );
});

test("ambiguous reply numbers the candidates and explains how to answer", () => {
  const reply = formatAmbiguousReply([
    { id: 1, title: "Reply: Optiver" },
    { id: 3, title: "Reply: Advising" },
  ]);
  const lines = reply.split("\n");
  assert.match(lines[0], /more than one/);
  assert.equal(lines[1], "1. Reply: Optiver");
  assert.equal(lines[2], "2. Reply: Advising");
  assert.match(lines[3], /done <number>/);
});

test("numbered lines format dates and null dates consistently", () => {
  assert.deepEqual(
    numberedTaskLines([
      { id: 1, title: "A", due_at: "2026-12-31" },
      { id: 2, title: "B", due_at: null },
    ]),
    ["1. A — due Dec 31", "2. B — no date"]
  );
});
