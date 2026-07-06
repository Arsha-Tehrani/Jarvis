import { getDb } from "@/lib/db";
import { computeGoalsProgress } from "@/lib/goals-progress";
import { chat } from "@/lib/llm";
import { weeklyDelta } from "@/lib/networth";
import { appendNote, isVaultConfigured } from "@/lib/notes";
import { overduePeople } from "@/lib/people";
import { getSetting, setSetting } from "@/lib/settings";

// Weekly life + finance digest: Sunday-night cron (+ catch-up-on-launch)
// assembles last week's numbers deterministically — spend by category with
// deltas vs the prior week, goal/streak summary, portfolio move, and the
// upcoming week — then lib/llm.chat writes the prose. When no model is
// running the structured markdown itself is appended (the digest never
// silently skips a week once the vault is configured). Additive append
// only, through the existing appendNote guards. Idempotent per week.

const MARKER_KEY = "digest_last_run";

function isoDaysAgo(n: number): string {
  return new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);
}

function isoDaysAhead(n: number): string {
  return new Date(Date.now() + n * 86400_000).toISOString().slice(0, 10);
}

const usd = (v: number) =>
  `$${Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

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

export type DigestFacts = {
  weekOf: string;
  spend: Array<{ category: string; amount: number; delta: number }>;
  totalSpend: number;
  totalSpendDelta: number;
  goals: Array<{ label: string; display: string; onTrack: boolean }>;
  gymDays: number;
  sleepAvg: number | null;
  netWorthWeeklyDelta: number | null;
  upcomingEvents: Array<{ title: string; start: string }>;
  upcomingFollowUps: Array<{ company: string; next_action: string | null; when: string }>;
  peopleOverdue: string[];
};

export function assembleDigestFacts(): DigestFacts {
  const db = getDb();
  const weekAgo = isoDaysAgo(7);
  const twoWeeksAgo = isoDaysAgo(14);

  // Spend by category, this week vs the prior week.
  const rows = db
    .prepare(
      `SELECT category,
              SUM(CASE WHEN date > ? THEN -amount ELSE 0 END) AS this_week,
              SUM(CASE WHEN date <= ? AND date > ? THEN -amount ELSE 0 END) AS prior_week
       FROM transactions
       WHERE amount < 0 AND category NOT IN ('Transfer','Investment') AND date > ?
       GROUP BY category`
    )
    .all(weekAgo, weekAgo, twoWeeksAgo, twoWeeksAgo) as {
    category: string;
    this_week: number;
    prior_week: number;
  }[];
  const spend = rows
    .map((r) => ({
      category: r.category,
      amount: r.this_week,
      delta: r.this_week - r.prior_week,
    }))
    .filter((r) => r.amount > 0 || r.delta !== 0)
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 8);
  const totalSpend = rows.reduce((s, r) => s + r.this_week, 0);
  const totalSpendDelta = totalSpend - rows.reduce((s, r) => s + r.prior_week, 0);

  const goals = computeGoalsProgress().map((g) => ({
    label: g.label,
    display: `${g.displayActual}/${g.target}${g.unit === "%" ? "%" : ""}`,
    onTrack: g.onTrack,
  }));

  const gymDays = (
    db.prepare("SELECT COUNT(*) AS n FROM gym_logs WHERE date > ?").get(weekAgo) as {
      n: number;
    }
  ).n;

  const sleepAvg = (
    db
      .prepare(
        "SELECT AVG(value) AS avg FROM health_logs WHERE kind = 'sleep_hours' AND date > ?"
      )
      .get(weekAgo) as { avg: number | null }
  ).avg;

  const today = new Date().toISOString().slice(0, 10);
  const upcomingEvents = db
    .prepare(
      `SELECT title, start FROM calendar_cache
       WHERE substr(start, 1, 10) >= ? AND substr(start, 1, 10) <= ?
       ORDER BY start ASC LIMIT 10`
    )
    .all(today, isoDaysAhead(7)) as Array<{ title: string; start: string }>;

  const upcomingFollowUps = (
    db
      .prepare(
        `SELECT company, next_action, next_action_at FROM applications
         WHERE stage IN ('wishlist','applied','screening','interview','offer')
           AND next_action_at IS NOT NULL
           AND substr(next_action_at, 1, 10) <= ?
         ORDER BY next_action_at ASC LIMIT 10`
      )
      .all(isoDaysAhead(7)) as Array<{
      company: string;
      next_action: string | null;
      next_action_at: string;
    }>
  ).map((f) => ({
    company: f.company,
    next_action: f.next_action,
    when: f.next_action_at.slice(0, 10),
  }));

  return {
    weekOf: today,
    spend,
    totalSpend,
    totalSpendDelta,
    goals,
    gymDays,
    sleepAvg,
    netWorthWeeklyDelta: weeklyDelta(),
    upcomingEvents,
    upcomingFollowUps,
    peopleOverdue: overduePeople()
      .slice(0, 5)
      .map((p) => p.name),
  };
}

// Structured markdown — both the LLM's input and the no-model fallback.
export function renderStructuredDigest(facts: DigestFacts): string {
  const lines: string[] = [];

  lines.push(`### Money`);
  lines.push(
    `- Spend last 7 days: **${usd(facts.totalSpend)}** (${facts.totalSpendDelta >= 0 ? "+" : "−"}${usd(facts.totalSpendDelta)} vs prior week)`
  );
  for (const s of facts.spend) {
    lines.push(
      `  - ${s.category}: ${usd(s.amount)}${s.delta !== 0 ? ` (${s.delta > 0 ? "+" : "−"}${usd(s.delta)})` : ""}`
    );
  }
  if (facts.netWorthWeeklyDelta != null) {
    lines.push(
      `- Net worth: ${facts.netWorthWeeklyDelta >= 0 ? "up" : "down"} ${usd(facts.netWorthWeeklyDelta)} this week`
    );
  }

  lines.push(``, `### Streaks & goals`);
  if (facts.goals.length === 0) {
    lines.push(`- No goals set yet`);
  }
  for (const g of facts.goals) {
    lines.push(`- ${g.onTrack ? "✅" : "▫️"} ${g.label}: ${g.display}`);
  }
  lines.push(`- Gym: ${facts.gymDays} day${facts.gymDays === 1 ? "" : "s"} last week`);
  if (facts.sleepAvg != null) {
    lines.push(`- Sleep: ${facts.sleepAvg.toFixed(1)}h average`);
  }

  lines.push(``, `### The week ahead`);
  lines.push(
    facts.upcomingEvents.length === 0
      ? `- No events on the calendar`
      : `- Events: ${facts.upcomingEvents
          .map((e) => `${e.title} (${e.start.slice(0, 10)})`)
          .join("; ")}`
  );
  if (facts.upcomingFollowUps.length > 0) {
    lines.push(
      `- Follow-ups: ${facts.upcomingFollowUps
        .map((f) => `${f.company}${f.next_action ? ` — ${f.next_action}` : ""} (${f.when})`)
        .join("; ")}`
    );
  }
  if (facts.peopleOverdue.length > 0) {
    lines.push(`- Catch up with: ${facts.peopleOverdue.join(", ")}`);
  }

  return lines.join("\n");
}

async function digestBody(): Promise<{ text: string; via: "llm" | "structured" }> {
  const structured = renderStructuredDigest(assembleDigestFacts());
  try {
    const result = await chat({
      messages: [
        {
          role: "system",
          content:
            "You write a short Monday-morning weekly review for the user's journal from the structured facts below. Markdown, max ~200 words: one honest line on how the week went, the notable numbers (keep every figure accurate), and one concrete suggestion for the coming week. Keep the ### section structure. No preamble.",
        },
        { role: "user", content: structured },
      ],
    });
    if (!result.text) throw new Error("LLM returned no text");
    return { text: result.text.trim(), via: "llm" };
  } catch (err) {
    console.log("[digest] no model — appending structured digest:", err instanceof Error ? err.message : err);
    return { text: structured, via: "structured" };
  }
}

export async function weeklyDigestJob(force = false): Promise<string | null> {
  if (!isVaultConfigured()) {
    console.log("[digest] vault not configured — skipping weekly digest");
    return null;
  }
  if (!force) {
    const due = lastScheduledRun();
    const lastRun = getSetting(MARKER_KEY);
    if (lastRun && new Date(lastRun) >= due) {
      console.log("[digest] already written for this week");
      return null;
    }
  }

  const { text, via } = await digestBody();
  try {
    const written = appendNote(
      undefined,
      `\n## Weekly digest (${new Date().toISOString().slice(0, 10)})\n\n${text}\n`
    );
    setSetting(MARKER_KEY, new Date().toISOString());
    console.log(`[digest] weekly digest (${via}) appended to ${written}`);
    return written;
  } catch (err) {
    console.error("[digest] failed to append digest note:", err);
    return null;
  }
}
