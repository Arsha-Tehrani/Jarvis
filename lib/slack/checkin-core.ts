// Pure core for the retroactive "did you do this?" morning check-in.
// No DB / network / Slack imports so `node --test` exercises every decision
// directly (same pure-core / glue split as tracker-progress.ts vs trackers.ts).
// The glue lives in lib/slack/tracker-checkin.ts.

// Magnitude-based trackers answer a NUMBER, not a yes/no — a Yes button for
// "calories" or "sleep_hours" would be meaningless, so they default off.
// (Sleep keeps its own separate numeric question in lib/slack.ts.)
export const MAGNITUDE_SOURCES = ["sleep_hours", "calories", "savings_rate"] as const;

// Default for the per-tracker `checkin_enabled` toggle. Used in three places
// that must agree: the column migration's backfill, tracker creation, and the
// docs. Weekly cadence is off because "did you do this yesterday?" doesn't
// frame a weekly count.
export function defaultCheckinEnabled(
  source: string | null | undefined,
  cadence: "daily" | "weekly"
): boolean {
  if (cadence !== "daily") return false;
  if (source && (MAGNITUDE_SOURCES as readonly string[]).includes(source)) return false;
  return true;
}

// One check-in-eligible tracker as the cron job sees it.
export type CheckinCandidate = {
  habitId: number;
  name: string;
  source: string | null; // 'gym_logs' | 'leetcode' | null (manual habit)
};

// Which trackers still need an answer for `date`: enabled, with neither a
// completion record nor an already-recorded miss. Both exclusions matter —
// the miss check is what makes catch-up-on-launch safe to fire repeatedly
// after the user has already tapped No.
export function selectUnconfirmed(
  candidates: CheckinCandidate[],
  completedHabitIds: Iterable<number>,
  answeredHabitIds: Iterable<number>
): CheckinCandidate[] {
  const done = new Set(completedHabitIds);
  const answered = new Set(answeredHabitIds);
  return candidates.filter((c) => !done.has(c.habitId) && !answered.has(c.habitId));
}

// ---- Block Kit ---------------------------------------------------------------
// Buttons rather than free text: several trackers need independent answers in
// one message, which reply-parsing can't do reliably.

export type SlackBlock = Record<string, unknown>;

// {habitId, date} encoded into the button's `value` (Slack caps it at 2000
// chars; this is ~40). Parsed back by the interactions route.
export function encodeActionValue(habitId: number, date: string): string {
  return JSON.stringify({ habitId, date });
}

export function parseActionValue(raw: string): { habitId: number; date: string } | null {
  try {
    const parsed = JSON.parse(raw) as { habitId?: unknown; date?: unknown };
    if (
      typeof parsed.habitId !== "number" ||
      !Number.isInteger(parsed.habitId) ||
      parsed.habitId <= 0 ||
      typeof parsed.date !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(parsed.date)
    ) {
      return null;
    }
    return { habitId: parsed.habitId, date: parsed.date };
  } catch {
    return null;
  }
}

export const YES_ACTION = "checkin_yes";
export const NO_ACTION = "checkin_no";

// One section + one actions row per unconfirmed tracker, all in a single
// message. block_id carries the habit id so chat.update can replace exactly
// the row that was answered and leave the others tappable.
export function checkinBlocks(unconfirmed: CheckinCandidate[], date: string): SlackBlock[] {
  const blocks: SlackBlock[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Yesterday (${date})* — I don't have these logged. Did you do them?`,
      },
    },
  ];
  for (const c of unconfirmed) {
    blocks.push({
      type: "section",
      block_id: `checkin_label_${c.habitId}`,
      text: { type: "mrkdwn", text: `*${c.name}*` },
    });
    blocks.push({
      type: "actions",
      block_id: `checkin_${c.habitId}`,
      elements: [
        {
          type: "button",
          action_id: YES_ACTION,
          text: { type: "plain_text", text: "Yes" },
          style: "primary",
          value: encodeActionValue(c.habitId, date),
        },
        {
          type: "button",
          action_id: NO_ACTION,
          text: { type: "plain_text", text: "No" },
          value: encodeActionValue(c.habitId, date),
        },
      ],
    });
  }
  return blocks;
}

export function checkinFallbackText(unconfirmed: CheckinCandidate[], date: string): string {
  return `Yesterday (${date}) — unlogged: ${unconfirmed.map((c) => c.name).join(", ")}`;
}

// Replace the answered tracker's label + button row with a single static
// result line. Everything else is passed through untouched, so a second tap
// on an already-answered row has nothing left to tap (no double-logging) while
// the other trackers stay answerable.
export function applyAnswerToBlocks(
  blocks: SlackBlock[],
  habitId: number,
  name: string,
  answer: "yes" | "no"
): SlackBlock[] {
  const labelId = `checkin_label_${habitId}`;
  const actionsId = `checkin_${habitId}`;
  const resultText =
    answer === "yes" ? `✅ *${name}* — logged` : `🔴 *${name}* — marked missed`;
  const out: SlackBlock[] = [];
  for (const block of blocks) {
    const id = block.block_id;
    if (id === labelId) {
      out.push({
        type: "section",
        block_id: labelId,
        text: { type: "mrkdwn", text: resultText },
      });
      continue;
    }
    if (id === actionsId) continue; // buttons removed
    out.push(block);
  }
  return out;
}
