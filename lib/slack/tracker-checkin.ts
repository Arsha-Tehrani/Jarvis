import { z } from "zod";
import { getDb } from "@/lib/db";
import { getSetting, setSetting } from "@/lib/settings";
import { postTo } from "@/lib/slack";
import { getTool } from "@/lib/tools";
import { queueSyncPush } from "@/lib/sync/client";
import {
  checkinBlocks,
  checkinFallbackText,
  selectUnconfirmed,
  type CheckinCandidate,
} from "@/lib/slack/checkin-core";
import {
  handleTrackerResponse,
  type CheckinAnswer,
  type TrackerHabit,
  type TrackerResponseResult,
} from "@/lib/slack/tracker-response";

export type { CheckinAnswer };

// DB + Slack glue for the retroactive "did you do this?" check-in. The
// decisions (who's unconfirmed, what the Block Kit payload looks like, how an
// answered row is rewritten) all live in the pure lib/slack/checkin-core.ts;
// this file only talks to SQLite and Slack.

const LAST_SENT_KEY = "slack_tracker_checkin_last_sent"; // YYYY-MM-DD (the ASKED-ABOUT day)

export function yesterdayIso(now: Date = new Date()): string {
  return new Date(now.getTime() - 86400_000).toISOString().slice(0, 10);
}

type HabitRow = { id: number; name: string; source: string | null };

// Trackers opted into the morning nag. Sourced trackers whose source has no
// completion table are excluded here rather than silently never resolving.
export function checkinCandidates(): CheckinCandidate[] {
  const rows = getDb()
    .prepare(
      `SELECT id, name, source FROM habits
       WHERE checkin_enabled = 1 AND deleted_at IS NULL ORDER BY name`
    )
    .all() as HabitRow[];
  return rows
    .filter((r) => r.source === null || r.source === "gym_logs" || r.source === "leetcode")
    .map((r) => ({ habitId: r.id, name: r.name, source: r.source }));
}

// Does this tracker have a completion record for `date`, in whatever table it
// actually logs to? (Never a second mutable copy — same rule as everywhere
// else: completion truth lives in one place per tracker.)
export function hasCompletion(candidate: CheckinCandidate, date: string): boolean {
  const db = getDb();
  if (candidate.source === "gym_logs") {
    return !!db
      .prepare("SELECT 1 FROM gym_logs WHERE date = ? AND deleted_at IS NULL")
      .get(date);
  }
  if (candidate.source === "leetcode") {
    return !!db
      .prepare("SELECT 1 FROM leetcode_stats WHERE date = ? AND deleted_at IS NULL")
      .get(date);
  }
  return !!db
    .prepare("SELECT 1 FROM habit_logs WHERE habit_id = ? AND date = ? AND deleted_at IS NULL")
    .get(candidate.habitId, date);
}

export function missedHabitIds(date: string): number[] {
  return (
    getDb().prepare("SELECT habit_id FROM tracker_misses WHERE date = ?").all(date) as {
      habit_id: number;
    }[]
  ).map((r) => r.habit_id);
}

// Everything still unanswered for `date`. Completions and existing misses are
// both exclusions — the miss check is what makes catch-up-on-launch safe to
// re-run after the user has already tapped No.
export function unconfirmedFor(date: string): CheckinCandidate[] {
  const candidates = checkinCandidates();
  const completed = candidates.filter((c) => hasCompletion(c, date)).map((c) => c.habitId);
  return selectUnconfirmed(candidates, completed, missedHabitIds(date));
}

// Send the check-in for yesterday. Idempotent per asked-about day, and silent
// when there's nothing unconfirmed — same "don't send an empty message"
// pattern as the task digests.
export async function sendTrackerCheckin(
  force = false,
  now: Date = new Date()
): Promise<string> {
  const date = yesterdayIso(now);
  if (!force && getSetting(LAST_SENT_KEY) === date) {
    return `Already asked about ${date}.`;
  }
  const unconfirmed = unconfirmedFor(date);
  if (unconfirmed.length === 0) {
    setSetting(LAST_SENT_KEY, date);
    return `Everything already logged for ${date} — nothing sent.`;
  }
  const sent = await postTo("checkin", {
    text: checkinFallbackText(unconfirmed, date),
    blocks: checkinBlocks(unconfirmed, date),
  });
  if (!sent) return "No check-in destination configured.";
  setSetting(LAST_SENT_KEY, date);
  return `Asked about ${unconfirmed.length} tracker(s) for ${date}.`;
}

export async function trackerCheckinJob(): Promise<void> {
  console.log(`[tracker-checkin] ${await sendTrackerCheckin()}`);
}

// ---- Answering ---------------------------------------------------------------
// The decision logic lives in lib/slack/tracker-response.ts (db injected, no
// Slack types, unit-tested). This file only binds it to the real DB and the
// real tool registry.

// A "yes" goes through the SAME registered agent tool the UI and the agent
// use for that tracker — one write path per tracker, validate-then-execute
// (non-negotiable #1), with the HISTORICAL date passed explicitly. All three
// loggers already accept an optional `date` that defaults to today, so no
// existing caller changes.
async function logCompletion(habit: TrackerHabit, date: string): Promise<string> {
  const [name, args] =
    habit.source === "gym_logs"
      ? ["log_gym", { date }]
      : habit.source === "leetcode"
        ? ["log_leetcode", { date, count: 1 }]
        : ["log_habit", { name: habit.name, date }];
  const tool = getTool(name as string);
  if (!tool) throw new Error(`Tool ${name} not registered`);
  const parsed = tool.schema.safeParse(args);
  if (!parsed.success) {
    throw new Error(`Invalid args for ${name}: ${z.prettifyError(parsed.error)}`);
  }
  return await tool.handler(parsed.data);
}

// Apply one button press. Returns the habit (for the chat.update rewrite) and
// the confirmation line.
export async function applyCheckinAnswer(
  habitId: number,
  date: string,
  answer: CheckinAnswer
): Promise<TrackerResponseResult> {
  const result = await handleTrackerResponse(
    { db: getDb(), logCompletion },
    { habitId, date, response: answer }
  );
  queueSyncPush(); // debounced, no-op unless SYNC_ROLE=client
  return result;
}
