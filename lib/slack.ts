import { z } from "zod";
import { chat } from "@/lib/llm";
import { getTool } from "@/lib/tools";
import { loggedFetch } from "@/lib/network-log";
import { getSetting, setSetting } from "@/lib/settings";
import { queueSyncPush } from "@/lib/sync/client";
import { parseSleepAnswer } from "@/lib/slack-parse";

// Slack morning check-in — the NUMERIC half.
// The gym / LeetCode yes-no questions that used to live here were replaced by
// the generalized retroactive tracker check-in (lib/slack/tracker-checkin.ts),
// which covers every daily-cadence tracker with Yes/No buttons instead of
// three hardcoded free-text questions. Sleep stays here because it needs a
// number, and a number doesn't fold into a two-button flow.
//
// OUTBOUND (works now, no tunnel): a cron message with the enabled questions,
// idempotent per day. INBOUND (needs the tunnel): replies answer pending
// questions in order; deterministic parsers first, lib/llm.chat only as
// fallback. All tracker writes go through the existing agent tool handlers —
// one code path per tracker.

export const QUESTION_IDS = ["sleep"] as const;
export type QuestionId = (typeof QUESTION_IDS)[number];

export const QUESTIONS: Record<QuestionId, string> = {
  sleep: "What time did you sleep last night? (a time like 11:30, or hours like 7h)",
};

const QUESTIONS_KEY = "slack_questions"; // JSON: {sleep:true}
const LAST_SENT_KEY = "slack_checkin_last_sent"; // YYYY-MM-DD
const PENDING_KEY = "slack_pending"; // JSON: {date, remaining: QuestionId[]}

export function isSlackConfigured(): boolean {
  return !!(process.env.SLACK_BOT_TOKEN && process.env.SLACK_USER_ID);
}

export function enabledQuestions(): Record<QuestionId, boolean> {
  const defaults: Record<QuestionId, boolean> = { sleep: true };
  const raw = getSetting(QUESTIONS_KEY);
  if (!raw) return defaults;
  try {
    return { ...defaults, ...(JSON.parse(raw) as Partial<Record<QuestionId, boolean>>) };
  } catch {
    return defaults;
  }
}

export function setEnabledQuestions(next: Record<QuestionId, boolean>): void {
  setSetting(QUESTIONS_KEY, JSON.stringify(next));
}

export async function slackApi(
  method: string,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new Error("SLACK_BOT_TOKEN is not set");
  const res = await loggedFetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  }, { feature: "slack", purpose: `call ${method}` });
  const data = (await res.json()) as { ok: boolean; error?: string } & Record<
    string,
    unknown
  >;
  if (!data.ok) throw new Error(`Slack ${method} failed: ${data.error ?? res.status}`);
  return data;
}

async function dmChannelId(): Promise<string> {
  const userId = process.env.SLACK_USER_ID;
  if (!userId) throw new Error("SLACK_USER_ID is not set");
  const open = (await slackApi("conversations.open", { users: userId })) as {
    channel?: { id?: string };
  };
  const channel = open.channel?.id;
  if (!channel) throw new Error("Slack conversations.open returned no channel");
  return channel;
}

export async function sendDm(text: string): Promise<void> {
  await slackApi("chat.postMessage", { channel: await dmChannelId(), text });
}

// ---- Channel routing ---------------------------------------------------------
// One bot, many channels: chat.postMessage takes the channel per call, so the
// single SLACK_BOT_TOKEN posts anywhere it's a member of (or anywhere public
// with the chat:write.public scope). No second app install, no second token.
//
// checkin/brief fall back to the DM when their channel var is unset, so an
// existing setup keeps working unchanged. `markets` has NO fallback — an
// unconfigured feature is a clear no-op here, never a surprise DM.

export type SlackDestination = "checkin" | "brief" | "markets";

const CHANNEL_ENV: Record<SlackDestination, string> = {
  checkin: "SLACK_CHECKIN_CHANNEL_ID",
  brief: "SLACK_BRIEF_CHANNEL_ID",
  markets: "SLACK_MARKETS_CHANNEL_ID",
};

export function configuredChannelId(dest: SlackDestination): string | null {
  return process.env[CHANNEL_ENV[dest]]?.trim() || null;
}

// Resolve a destination to a concrete channel id. Null means "configured to
// go nowhere" — only possible for `markets`, and the caller skips the post.
export async function resolveChannel(dest: SlackDestination): Promise<string | null> {
  const configured = configuredChannelId(dest);
  if (configured) return configured;
  if (dest === "markets") return null;
  return await dmChannelId();
}

// The one send used by the check-in, the brief, and the markets digest.
// Returns the posted message's {channel, ts} (needed by chat.update for the
// check-in buttons), or null when the destination is a deliberate no-op.
export async function postTo(
  dest: SlackDestination,
  message: { text: string; blocks?: unknown[] }
): Promise<{ channel: string; ts: string } | null> {
  const channel = await resolveChannel(dest);
  if (!channel) return null;
  const res = (await slackApi("chat.postMessage", {
    channel,
    text: message.text, // always set: the notification/fallback line for blocks
    ...(message.blocks ? { blocks: message.blocks } : {}),
  })) as { ts?: string };
  return { channel, ts: res.ts ?? "" };
}

// Send the morning check-in DM (used by the cron job and the send_now API).
export async function sendMorningCheckin(force = false): Promise<string> {
  const today = new Date().toISOString().slice(0, 10);
  if (!force && getSetting(LAST_SENT_KEY) === today) {
    return "Already sent today.";
  }
  const enabled = enabledQuestions();
  const ids = QUESTION_IDS.filter((id) => enabled[id]);
  if (ids.length === 0) return "No questions enabled.";

  const lines = [
    "Good morning! Quick check-in — reply to each in order:",
    ...ids.map((id, i) => `${i + 1}. ${QUESTIONS[id]}`),
  ];
  await postTo("checkin", { text: lines.join("\n") });
  setSetting(LAST_SENT_KEY, today);
  setSetting(PENDING_KEY, JSON.stringify({ date: today, remaining: ids }));
  return `Sent ${ids.length} question(s).`;
}

// Cron job: weekday-agnostic morning check-in + catch-up (marker keeps each
// half 1/day). Two independent messages on purpose — the numeric sleep
// question can't share a yes/no button flow — and each is try/caught
// separately so one failing never suppresses the other.
export async function slackCheckinJob(): Promise<void> {
  if (!isSlackConfigured()) {
    console.log("[slack] SLACK_BOT_TOKEN / SLACK_USER_ID not set — skipping check-in");
    return;
  }
  try {
    const result = await sendMorningCheckin();
    console.log(`[slack] morning check-in: ${result}`);
  } catch (err) {
    console.error("[slack] check-in failed:", err);
  }
  try {
    // Imported lazily: tracker-checkin pulls in the DB layer, and lib/slack.ts
    // is also imported by request paths that shouldn't pay for that.
    const { sendTrackerCheckin } = await import("@/lib/slack/tracker-checkin");
    console.log(`[slack] tracker check-in: ${await sendTrackerCheckin()}`);
  } catch (err) {
    console.error("[slack] tracker check-in failed:", err);
  }
}

// ---- Inbound (behind the deferred tunnel) ----

type Pending = { date: string; remaining: QuestionId[] };

function getPending(): Pending | null {
  const raw = getSetting(PENDING_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Pending;
    return parsed.remaining.length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

async function runTool(name: string, args: unknown): Promise<string> {
  const tool = getTool(name);
  if (!tool) throw new Error(`Tool ${name} not registered`);
  // Same non-negotiable as /api/agent: validate before executing.
  const parsed = tool.schema.safeParse(args);
  if (!parsed.success) {
    throw new Error(`Invalid args for ${name}: ${z.prettifyError(parsed.error)}`);
  }
  return await tool.handler(parsed.data);
}

// Apply one reply to the next pending question. Returns the reply text to
// send back to the user (also surfaces what still needs answering).
export async function handleCheckinReply(text: string): Promise<string> {
  const pending = getPending();
  if (!pending) {
    return "No check-in questions pending. (Morning check-in state resets each day.)";
  }
  const [current, ...rest] = pending.remaining;

  let result: string;
  try {
    result = await applyAnswer(current, text);
  } catch (err) {
    return `Couldn't log that: ${err instanceof Error ? err.message : "unknown error"}. Try again?`;
  }

  setSetting(PENDING_KEY, JSON.stringify({ date: pending.date, remaining: rest }));
  queueSyncPush(); // the answer wrote a tracker table; debounced, no-op unless client
  const next = rest[0];
  return next ? `${result}\nNext: ${QUESTIONS[next]}` : `${result}\nThat's everything — have a good one!`;
}

async function applyAnswer(question: QuestionId, text: string): Promise<string> {
  switch (question) {
    case "sleep": {
      let parsed = parseSleepAnswer(text);
      if (!parsed) parsed = await llmFallbackSleep(text);
      if (!parsed) throw new Error(`couldn't read a time or duration from "${text}"`);
      return await runTool("log_metric", { kind: parsed.kind, value: parsed.value });
    }
  }
}

// LLM fallbacks — only reached when the deterministic parse fails.
async function llmFallbackSleep(
  text: string
): Promise<{ kind: "bedtime" | "sleep_hours"; value: number } | null> {
  try {
    const result = await chat({
      messages: [
        {
          role: "system",
          content:
            'Extract a sleep answer. Reply ONLY with JSON: {"kind":"bedtime","value":<decimal hour 0-24>} for a time they went to bed, or {"kind":"sleep_hours","value":<hours>} for a duration, or null if neither.',
        },
        { role: "user", content: text },
      ],
    });
    const match = result.text?.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = z
      .object({ kind: z.enum(["bedtime", "sleep_hours"]), value: z.number() })
      .safeParse(JSON.parse(match[0]));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
