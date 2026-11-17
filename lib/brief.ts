import { getDb } from "@/lib/db";
import { followUpsDue } from "@/lib/career";
import { budgetAlerts } from "@/lib/finance/budgets";
import { computeGoalsProgress } from "@/lib/goals-progress";
import { chat } from "@/lib/llm";
import { getSetting, setSetting } from "@/lib/settings";
import { isSlackConfigured, postTo } from "@/lib/slack";
import { recordDigest } from "@/lib/slack/task-digest";

// Morning brief: today's events, top tasks, overdue follow-ups, important
// unread mail, and any goal/streak at risk. Assembled deterministically;
// lib/llm.chat only rephrases it, with the plain rendering as the always-
// working fallback. Sent over the Phase 7 outbound Slack path (no tunnel).

const LAST_SENT_KEY = "slack_brief_last_sent";

export type StreakRisk = {
  label: string;
  have: number;
  target: number;
  daysLeft: number;
  message: string;
};

type BriefFacts = {
  date: string;
  events: Array<{ title: string; start: string }>;
  tasks: Array<{ id: number; title: string; due_at: string | null }>;
  followUps: Array<{ company: string; next_action: string | null }>;
  importantUnread: number;
  risks: StreakRisk[];
  budgetAlerts: string[];
};

// Days left in the calendar week including today (Mon=start, Sun=end).
function daysLeftInWeek(now = new Date()): number {
  const dow = now.getDay(); // 0 = Sunday
  return dow === 0 ? 1 : 8 - dow;
}

// A weekly count goal is "at risk" when the remaining need exceeds the
// days left this week — you can no longer make it by doing one per day.
export function computeStreakRisks(now = new Date()): StreakRisk[] {
  const left = daysLeftInWeek(now);
  const risks: StreakRisk[] = [];
  for (const goal of computeGoalsProgress()) {
    const weeklyCount =
      goal.kind === "gym_days_per_week" ||
      goal.kind === "leetcode_per_week" ||
      goal.kind === "habit";
    if (!weeklyCount || goal.onTrack) continue;
    const need = Math.ceil(goal.target - goal.actual);
    if (need > left) {
      risks.push({
        label: goal.label,
        have: Math.round(goal.actual),
        target: goal.target,
        daysLeft: left,
        message: `${goal.label}: ${Math.round(goal.actual)}/${goal.target} this week with ${left} day${left === 1 ? "" : "s"} left — streak at risk`,
      });
    } else if (need === left) {
      risks.push({
        label: goal.label,
        have: Math.round(goal.actual),
        target: goal.target,
        daysLeft: left,
        message: `${goal.label}: ${Math.round(goal.actual)}/${goal.target} — needs every remaining day (${left}) to hit the week`,
      });
    }
  }
  return risks;
}

export function assembleBriefFacts(): BriefFacts {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);

  const events = db
    .prepare(
      `SELECT title, start FROM calendar_cache
       WHERE substr(start, 1, 10) = ? ORDER BY start ASC LIMIT 8`
    )
    .all(today) as Array<{ title: string; start: string }>;

  // Top 5 by llm_rank (deterministic ranks fill the field when no model has
  // run), falling back through due date and age like lib/tasks/sort.ts.
  const tasks = db
    .prepare(
      `SELECT id, title, due_at FROM tasks WHERE status = 'open' AND deleted_at IS NULL
       ORDER BY llm_rank IS NULL, llm_rank ASC,
         due_at IS NULL, due_at ASC, created_at ASC
       LIMIT 5`
    )
    .all() as Array<{ id: number; title: string; due_at: string | null }>;

  const importantUnread = (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM mail_messages WHERE importance = 'important' AND is_read = 0"
      )
      .get() as { n: number }
  ).n;

  return {
    date: today,
    events,
    tasks,
    followUps: followUpsDue().map((f) => ({
      company: f.company,
      next_action: f.next_action,
    })),
    importantUnread,
    risks: computeStreakRisks(),
    // Deterministic month-to-date spend vs. category_budgets (budget-math.ts).
    budgetAlerts: budgetAlerts(),
  };
}

function fmtTime(start: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(start)) return "all day";
  const d = new Date(start);
  return Number.isNaN(d.getTime())
    ? start
    : d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

// The deterministic rendering — also the no-model fallback.
export function renderPlainBrief(facts: BriefFacts): string {
  const lines: string[] = [`Good morning — ${facts.date}`];

  lines.push(
    facts.events.length === 0
      ? "📅 No events today."
      : `📅 ${facts.events.length} event${facts.events.length === 1 ? "" : "s"}: ${facts.events
          .map((e) => `${e.title} (${fmtTime(e.start)})`)
          .join("; ")}`
  );

  if (facts.tasks.length > 0) {
    lines.push("✅ Top tasks:");
    facts.tasks.forEach((t, i) =>
      lines.push(`${i + 1}. ${t.title}${t.due_at ? ` (due ${t.due_at.slice(0, 10)})` : ""}`)
    );
  }

  if (facts.followUps.length > 0) {
    lines.push(
      `💼 Follow-ups due: ${facts.followUps
        .map((f) => `${f.company}${f.next_action ? ` — ${f.next_action}` : ""}`)
        .join("; ")}`
    );
  }

  if (facts.importantUnread > 0) {
    lines.push(`📬 ${facts.importantUnread} important unread email${facts.importantUnread === 1 ? "" : "s"}.`);
  }

  for (const alert of facts.budgetAlerts) {
    lines.push(`💸 ${alert}`);
  }

  for (const risk of facts.risks) {
    lines.push(`⚠️ ${risk.message}`);
  }

  if (lines.length === 2 && facts.events.length === 0) {
    lines.push("Nothing pressing — good day to get ahead.");
  }
  return lines.join("\n");
}

// LLM phrasing is a nicety, never a dependency.
export async function briefText(): Promise<{ text: string; taskIds: number[] }> {
  const facts = assembleBriefFacts();
  const plain = renderPlainBrief(facts);
  const taskIds = facts.tasks.map((t) => t.id);
  try {
    const result = await chat({
      messages: [
        {
          role: "system",
          content:
            "Rewrite the user's morning brief as a friendly, concise Slack message. Keep every fact and number, keep the numbered task list EXACTLY in its given order and numbering, keep it under 120 words, keep the emoji, no preamble.",
        },
        { role: "user", content: plain },
      ],
    });
    return { text: result.text?.trim() || plain, taskIds };
  } catch {
    return { text: plain, taskIds }; // no model running — plain brief is the product
  }
}

export async function morningBriefJob(): Promise<void> {
  if (!isSlackConfigured()) {
    console.log("[brief] Slack not configured — skipping morning brief");
    return;
  }
  const today = new Date().toISOString().slice(0, 10);
  if (getSetting(LAST_SENT_KEY) === today) {
    console.log("[brief] already sent today");
    return;
  }
  try {
    const { text, taskIds } = await briefText();
    // SLACK_BRIEF_CHANNEL_ID if set, else the DM (unchanged for existing setups).
    await postTo("brief", { text });
    setSetting(LAST_SENT_KEY, today);
    // The brief IS the morning task digest — record which tasks were shown,
    // in displayed order, so "done 2" replies resolve against it.
    recordDigest(today, "morning", taskIds);
    console.log("[brief] morning brief sent");
  } catch (err) {
    console.error("[brief] send failed:", err);
  }
}
