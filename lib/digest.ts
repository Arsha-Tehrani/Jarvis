import { getDb } from "@/lib/db";
import { followUpsDue } from "@/lib/career";
import { listHabits } from "@/lib/habits";
import { chat } from "@/lib/llm";
import { appendNote, isVaultConfigured } from "@/lib/notes";
import { overduePeople } from "@/lib/people";
import { getSetting, setSetting } from "@/lib/settings";

// Weekly digest: Sunday-night cron (+ catch-up-on-launch) gathers last
// week's numbers, has lib/llm.chat write a short Monday summary, and
// appends it to today's Obsidian daily note. Idempotent per week via a
// settings marker; an LLM/vault failure just logs and retries next launch.

const MARKER_KEY = "digest_last_run";

function isoDaysAgo(n: number): string {
  return new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);
}

// The most recent Sunday 21:00 local time (the scheduled moment).
function lastScheduledRun(now = new Date()): Date {
  const candidate = new Date(now);
  candidate.setHours(21, 0, 0, 0);
  while (candidate.getDay() !== 0 || candidate > now) {
    candidate.setDate(candidate.getDate() - 1);
    if (candidate.getDay() === 0) candidate.setHours(21, 0, 0, 0);
  }
  return candidate;
}

export function gatherWeekFacts(): string {
  const db = getDb();
  const weekAgo = isoDaysAgo(7);
  const lines: string[] = [];

  const spend = db
    .prepare(
      `SELECT category, SUM(-amount) AS s FROM transactions
       WHERE amount < 0 AND category NOT IN ('Transfer','Investment') AND date > ?
       GROUP BY category ORDER BY s DESC LIMIT 6`
    )
    .all(weekAgo) as { category: string; s: number }[];
  if (spend.length > 0) {
    lines.push(
      `Spend last 7 days: ${spend.map((r) => `${r.category} $${r.s.toFixed(0)}`).join(", ")}`
    );
  }

  const gymDays = (
    db.prepare("SELECT COUNT(*) AS n FROM gym_logs WHERE date > ?").get(weekAgo) as {
      n: number;
    }
  ).n;
  lines.push(`Gym: ${gymDays} day(s) in the last 7`);

  const lc = db
    .prepare("SELECT total_solved, streak FROM leetcode_stats ORDER BY date DESC LIMIT 1")
    .get() as { total_solved: number; streak: number } | undefined;
  if (lc) lines.push(`LeetCode: ${lc.total_solved} total solved, ${lc.streak}-day streak`);

  const habits = listHabits();
  if (habits.length > 0) {
    lines.push(
      `Habits: ${habits.map((h) => `${h.name} ${h.thisWeek}/7 days${h.streak > 1 ? ` (streak ${h.streak})` : ""}`).join("; ")}`
    );
  }

  const sleep = db
    .prepare(
      "SELECT AVG(value) AS avg FROM health_logs WHERE kind = 'sleep_hours' AND date > ?"
    )
    .get(weekAgo) as { avg: number | null };
  if (sleep.avg != null) lines.push(`Average sleep: ${sleep.avg.toFixed(1)}h`);

  const followUps = followUpsDue();
  if (followUps.length > 0) {
    lines.push(
      `Job-hunt follow-ups due: ${followUps
        .slice(0, 5)
        .map((f) => `${f.company} (${f.next_action ?? "follow up"})`)
        .join(", ")}`
    );
  }

  const overdue = overduePeople();
  if (overdue.length > 0) {
    lines.push(
      `People to catch up with: ${overdue.slice(0, 5).map((p) => p.name).join(", ")}`
    );
  }

  return lines.join("\n");
}

export async function weeklyDigestJob(): Promise<void> {
  if (!isVaultConfigured()) {
    console.log("[digest] vault not configured — skipping weekly digest");
    return;
  }
  const due = lastScheduledRun();
  const lastRun = getSetting(MARKER_KEY);
  if (lastRun && new Date(lastRun) >= due) {
    console.log("[digest] already written for this week");
    return;
  }

  const facts = gatherWeekFacts();
  let text: string;
  try {
    const result = await chat({
      messages: [
        {
          role: "system",
          content:
            "You write a short, encouraging Monday-morning weekly review for the user's personal journal. Markdown, max ~150 words: one line on how the week went, a few bullet highlights from the facts, and one concrete suggestion for the coming week. No preamble.",
        },
        { role: "user", content: `Facts from last week:\n${facts || "(no data logged)"}` },
      ],
    });
    if (!result.text) throw new Error("LLM returned no text");
    text = result.text;
  } catch (err) {
    // No marker written — the launch catch-up retries once Ollama is up.
    console.error("[digest] LLM unavailable, will retry next launch:", err);
    return;
  }

  try {
    const written = appendNote(
      undefined,
      `\n## Weekly digest (${new Date().toISOString().slice(0, 10)})\n\n${text.trim()}\n`
    );
    setSetting(MARKER_KEY, new Date().toISOString());
    console.log(`[digest] weekly digest appended to ${written}`);
  } catch (err) {
    console.error("[digest] failed to append digest note:", err);
  }
}
