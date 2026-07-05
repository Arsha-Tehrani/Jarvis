import {
  BookOpen,
  Briefcase,
  Calendar,
  Code2,
  Dumbbell,
  HeartPulse,
  ListChecks,
  Repeat,
  TrendingUp,
  Users,
  Wallet,
} from "lucide-react";
import { getDb } from "@/lib/db";
import { followUpsDue } from "@/lib/career";
import { listHabits } from "@/lib/habits";
import { birthdaysThisWeek, overduePeople } from "@/lib/people";
import { currentReads } from "@/lib/reading";
import { formatBedtime, latestMetric } from "@/lib/health";
import { getCachedQuote } from "@/lib/stocks";
import { AgentChat } from "@/components/agent-chat";
import { MetricCard } from "@/components/metric-card";
import { RingGauge } from "@/components/ring-gauge";
import { Sparkline, type SparkPoint } from "@/components/sparkline";

export const dynamic = "force-dynamic";

const usd = (v: number) =>
  `$${v.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

function isoDaysAgo(n: number): string {
  return new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);
}

export default function TodayPage() {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);

  // Tasks
  const openTasks = (
    db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE status = 'open'").get() as { n: number }
  ).n;
  const dueToday = (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM tasks WHERE status = 'open' AND substr(due_at,1,10) <= ?"
      )
      .get(today) as { n: number }
  ).n;
  const topTask = db
    .prepare(
      `SELECT title FROM tasks WHERE status = 'open'
       ORDER BY due_at IS NULL, due_at ASC,
         CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END
       LIMIT 1`
    )
    .get() as { title: string } | undefined;

  // Calendar (poll cache — Google is the source of truth)
  const todaysEvents = db
    .prepare(
      `SELECT title, start FROM calendar_cache
       WHERE substr(start, 1, 10) = ? ORDER BY start ASC`
    )
    .all(today) as { title: string; start: string }[];
  const nextEvent = todaysEvents.find(
    (e) => /^\d{4}-\d{2}-\d{2}$/.test(e.start) || Date.parse(e.start) >= Date.now()
  );

  // Gym: rolling 7 days vs weekly goal
  const gymWeek = (
    db
      .prepare("SELECT COUNT(*) AS n FROM gym_logs WHERE date > ?")
      .get(isoDaysAgo(7)) as { n: number }
  ).n;
  const gymGoal =
    (
      db.prepare("SELECT target FROM goals WHERE kind = 'gym_days_per_week'").get() as
        | { target: number }
        | undefined
    )?.target ?? 4;
  const wentToday = !!db.prepare("SELECT 1 FROM gym_logs WHERE date = ?").get(today);

  // LeetCode: latest + trend
  const leetcode = db
    .prepare(
      "SELECT date, total_solved, streak FROM leetcode_stats ORDER BY date DESC LIMIT 1"
    )
    .get() as { date: string; total_solved: number; streak: number } | undefined;
  const lcTrend = (
    db
      .prepare(
        "SELECT date, total_solved FROM leetcode_stats ORDER BY date DESC LIMIT 14"
      )
      .all() as { date: string; total_solved: number }[]
  )
    .reverse()
    .map<SparkPoint>((r) => ({ label: r.date, value: r.total_solved }));

  // Spend this month + last-14-day daily spend
  const spendMonth = (
    db
      .prepare(
        `SELECT COALESCE(SUM(-amount), 0) AS s FROM transactions
         WHERE amount < 0 AND category NOT IN ('Transfer','Investment')
           AND substr(date, 1, 7) = ?`
      )
      .get(today.slice(0, 7)) as { s: number }
  ).s;
  const spendRows = db
    .prepare(
      `SELECT substr(date, 1, 10) AS d, SUM(-amount) AS s FROM transactions
       WHERE amount < 0 AND category NOT IN ('Transfer','Investment') AND date > ?
       GROUP BY d`
    )
    .all(isoDaysAgo(14)) as { d: string; s: number }[];
  const spendByDay = new Map(spendRows.map((r) => [r.d, r.s]));
  const spendTrend: SparkPoint[] = Array.from({ length: 14 }, (_, i) => {
    const d = isoDaysAgo(13 - i);
    return { label: d.slice(5), value: spendByDay.get(d) ?? 0 };
  });

  // Career: follow-ups due
  const dueFollowUps = followUpsDue();

  // Reading: current reads
  const reads = currentReads();

  // People: overdue + birthdays within 7 days
  const overdue = overduePeople();
  const birthdays = birthdaysThisWeek();

  // Habits: done today + best streak
  const habits = listHabits();
  const habitsDoneToday = habits.filter((h) => h.doneToday).length;
  const bestStreak = habits.reduce(
    (best, h) => (h.streak > (best?.streak ?? 0) ? h : best),
    undefined as (typeof habits)[number] | undefined
  );

  // Health: last night's sleep + latest mood
  const sleep = latestMetric("sleep_hours");
  const mood = latestMetric("mood");
  const sleepTrend = (
    db
      .prepare(
        "SELECT date, value FROM health_logs WHERE kind = 'sleep_hours' ORDER BY date DESC LIMIT 14"
      )
      .all() as { date: string; value: number }[]
  )
    .reverse()
    .map<SparkPoint>((r) => ({ label: r.date.slice(5), value: r.value }));
  const bedtime = latestMetric("bedtime");

  // Portfolio from the quote cache only (no network in render)
  const holdings = db
    .prepare("SELECT ticker, shares FROM holdings")
    .all() as { ticker: string; shares: number }[];
  let portfolioValue: number | null = null;
  let dayMove: number | null = null;
  if (holdings.length > 0) {
    let value = 0;
    let move = 0;
    let covered = false;
    for (const h of holdings) {
      const q = getCachedQuote(h.ticker);
      if (q) {
        value += q.price * h.shares;
        move += q.change * h.shares;
        covered = true;
      }
    }
    if (covered) {
      portfolioValue = value;
      dayMove = move;
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <AgentChat />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <MetricCard
          href="/calendar"
          label="Events"
          icon={<Calendar />}
          hero={todaysEvents.length}
          unit={todaysEvents.length === 1 ? "event today" : "events today"}
          sub={
            nextEvent
              ? `next: ${nextEvent.title}${
                  /^\d{4}-\d{2}-\d{2}$/.test(nextEvent.start)
                    ? " (all day)"
                    : ` at ${new Date(nextEvent.start).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`
                }`
              : "nothing scheduled"
          }
        />
        <MetricCard
          href="/tasks"
          label="Tasks"
          icon={<ListChecks />}
          hero={openTasks}
          unit="open"
          sub={
            topTask
              ? `${dueToday > 0 ? `${dueToday} due · ` : ""}top: ${topTask.title}`
              : "all clear"
          }
        />
        <MetricCard
          href="/trackers"
          label="Gym"
          icon={<Dumbbell />}
          hero={
            <span className="inline-flex items-center gap-4">
              <RingGauge value={gymWeek} target={gymGoal} />
            </span>
          }
          sub={wentToday ? "logged today ✓" : "not logged today"}
          range="Past 7 days"
        />
        <MetricCard
          href="/career"
          label="Follow-ups"
          icon={<Briefcase />}
          hero={dueFollowUps.length}
          unit="due"
          sub={
            dueFollowUps[0]
              ? `next: ${dueFollowUps[0].company} — ${dueFollowUps[0].next_action ?? "follow up"}`
              : "nothing due"
          }
        />
        {habits.length > 0 && (
          <MetricCard
            href="/habits"
            label="Habits"
            icon={<Repeat />}
            hero={`${habitsDoneToday}/${habits.length}`}
            unit="done today"
            sub={
              bestStreak && bestStreak.streak > 0
                ? `best streak: ${bestStreak.name} (${bestStreak.streak}d)`
                : "log one to start a streak"
            }
          />
        )}
        <MetricCard
          href="/health"
          label="Sleep"
          icon={<HeartPulse />}
          hero={sleep ? sleep.value : "—"}
          unit={sleep ? "hours" : undefined}
          sub={
            sleep
              ? `${sleep.date === today ? "last night" : `as of ${sleep.date}`}${
                  bedtime ? ` · bed ${formatBedtime(bedtime.value)}` : ""
                }${mood ? ` · mood ${mood.value}/5` : ""}`
              : "not logged yet"
          }
        >
          {sleepTrend.length > 1 && <Sparkline data={sleepTrend} />}
        </MetricCard>
        <MetricCard
          href="/trackers"
          label="LeetCode"
          icon={<Code2 />}
          hero={leetcode?.total_solved ?? "—"}
          unit="solved"
          sub={leetcode ? `${leetcode.streak}-day streak` : "no stats yet"}
        >
          {lcTrend.length > 1 && <Sparkline data={lcTrend} />}
        </MetricCard>
        <MetricCard
          href="/people"
          label="People"
          icon={<Users />}
          hero={overdue.length}
          unit="to catch up with"
          sub={
            birthdays.length > 0
              ? `🎂 ${birthdays
                  .slice(0, 2)
                  .map((p) =>
                    p.birthdayInDays === 0 ? `${p.name} today` : `${p.name} in ${p.birthdayInDays}d`
                  )
                  .join(", ")}`
              : overdue[0]
                ? `start with ${overdue[0].name}`
                : "all caught up"
          }
        />
        {reads.length > 0 && (
          <MetricCard
            href="/reading"
            label="Reading"
            icon={<BookOpen />}
            hero={reads.length}
            unit={reads.length === 1 ? "in progress" : "in progress"}
            sub={`now: ${reads[0].title}${reads[0].author ? ` — ${reads[0].author}` : ""}`}
          />
        )}
        <MetricCard
          href="/finance"
          label="Spend"
          icon={<Wallet />}
          hero={usd(spendMonth)}
          unit="this month"
          range="Past 14 days"
        >
          {spendTrend.some((p) => p.value > 0) && (
            <Sparkline
              data={spendTrend}
              variant="bars"
              formatValue={(v) => usd(v)}
            />
          )}
        </MetricCard>
        <MetricCard
          href="/stocks"
          label="Portfolio"
          icon={<TrendingUp />}
          hero={portfolioValue != null ? usd(portfolioValue) : "—"}
          sub={
            holdings.length === 0 ? (
              "no holdings yet"
            ) : dayMove == null ? (
              "quotes not loaded yet"
            ) : (
              <span
                className={
                  dayMove >= 0
                    ? "text-emerald-600 dark:text-emerald-500"
                    : "text-destructive"
                }
              >
                {dayMove >= 0 ? "▲" : "▼"} {usd(Math.abs(dayMove))} today
              </span>
            )
          }
        />
      </div>
    </div>
  );
}
