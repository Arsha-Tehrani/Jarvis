import { z } from "zod";
import { chat } from "@/lib/llm";
import { getTool } from "@/lib/tools";
import { loggedFetch } from "@/lib/network-log";
import { getSetting, setSetting } from "@/lib/settings";
import { queueSyncPush } from "@/lib/sync/client";
import {
  parseLeetCodeAnswer,
  parseSleepAnswer,
  parseYesNo,
} from "@/lib/slack-parse";

// Slack morning check-in.
// OUTBOUND (works now, no tunnel): a cron DM with the enabled questions,
// idempotent per day. INBOUND (code ready, runtime deferred behind the
// tunnel): replies answer pending questions in order; deterministic
// parsers first, lib/llm.chat only as fallback. All tracker writes go
// through the existing agent tool handlers — one code path per tracker.

export const QUESTION_IDS = ["sleep", "gym", "leetcode"] as const;
export type QuestionId = (typeof QUESTION_IDS)[number];

export const QUESTIONS: Record<QuestionId, string> = {
  sleep: "What time did you sleep last night? (a time like 11:30, or hours like 7h)",
  gym: "Did you go to the gym yesterday? (yes/no)",
  leetcode: "Did you do a LeetCode yesterday? (yes/no or a count)",
};

const QUESTIONS_KEY = "slack_questions"; // JSON: {sleep:true,gym:true,leetcode:true}
const LAST_SENT_KEY = "slack_checkin_last_sent"; // YYYY-MM-DD
const PENDING_KEY = "slack_pending"; // JSON: {date, remaining: QuestionId[]}

export function isSlackConfigured(): boolean {
  return !!(process.env.SLACK_BOT_TOKEN && process.env.SLACK_USER_ID);
}

export function enabledQuestions(): Record<QuestionId, boolean> {
  const defaults: Record<QuestionId, boolean> = { sleep: true, gym: true, leetcode: true };
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

async function slackApi(
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

export async function sendDm(text: string): Promise<void> {
  const userId = process.env.SLACK_USER_ID;
  if (!userId) throw new Error("SLACK_USER_ID is not set");
  const open = (await slackApi("conversations.open", { users: userId })) as {
    channel?: { id?: string };
  };
  const channel = open.channel?.id;
  if (!channel) throw new Error("Slack conversations.open returned no channel");
  await slackApi("chat.postMessage", { channel, text });
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
  await sendDm(lines.join("\n"));
  setSetting(LAST_SENT_KEY, today);
  setSetting(PENDING_KEY, JSON.stringify({ date: today, remaining: ids }));
  return `Sent ${ids.length} question(s).`;
}

// Cron job: weekday-agnostic morning DM + catch-up (marker keeps it 1/day).
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

function yesterdayIso(): string {
  return new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
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
    case "gym": {
      let answer = parseYesNo(text);
      if (answer === null) answer = await llmFallbackYesNo(text, "went to the gym yesterday");
      if (answer === null) throw new Error(`couldn't read yes/no from "${text}"`);
      if (!answer) return "No gym yesterday — noted (nothing logged).";
      return await runTool("log_gym", { date: yesterdayIso() });
    }
    case "leetcode": {
      let answer = parseLeetCodeAnswer(text);
      if (!answer) {
        const yn = await llmFallbackYesNo(text, "did LeetCode problems yesterday");
        if (yn !== null) answer = { did: yn, count: yn ? 1 : 0 };
      }
      if (!answer) throw new Error(`couldn't read yes/no/count from "${text}"`);
      if (!answer.did) return "No LeetCode yesterday — noted (nothing logged).";
      return await runTool("log_leetcode", { date: yesterdayIso(), count: answer.count });
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

async function llmFallbackYesNo(text: string, topic: string): Promise<boolean | null> {
  try {
    const result = await chat({
      messages: [
        {
          role: "system",
          content: `The user was asked whether they ${topic}. Reply with exactly one word: yes, no, or unclear.`,
        },
        { role: "user", content: text },
      ],
    });
    const word = result.text?.trim().toLowerCase();
    if (word?.startsWith("yes")) return true;
    if (word?.startsWith("no")) return false;
    return null;
  } catch {
    return null;
  }
}
