import { getDb } from "@/lib/db";

// Unofficial leetcode.com/graphql client. Unofficial APIs break — every
// caller must treat failure as normal: we log it, keep the last stored row,
// and the manual-entry fallback always works.

export type RecentProblem = { title: string; titleSlug: string; timestamp: string };

export type LeetCodeStats = {
  totalSolved: number;
  streak: number;
  recent: RecentProblem[];
};

const QUERY = `
query jarvisStats($username: String!) {
  matchedUser(username: $username) {
    submitStatsGlobal { acSubmissionNum { difficulty count } }
    userCalendar { streak }
  }
  recentAcSubmissionList(username: $username, limit: 10) {
    title
    titleSlug
    timestamp
  }
}`;

export async function fetchLeetCodeStats(username: string): Promise<LeetCodeStats> {
  const res = await fetch("https://leetcode.com/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Referer: `https://leetcode.com/${username}/`,
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    },
    body: JSON.stringify({ query: QUERY, variables: { username } }),
  });
  if (!res.ok) {
    throw new Error(`LeetCode responded ${res.status}`);
  }
  const data = (await res.json()) as {
    errors?: Array<{ message?: string }>;
    data?: {
      matchedUser?: {
        submitStatsGlobal?: { acSubmissionNum?: Array<{ difficulty: string; count: number }> };
        userCalendar?: { streak?: number };
      } | null;
      recentAcSubmissionList?: RecentProblem[] | null;
    };
  };
  if (data.errors?.length) {
    throw new Error(`LeetCode GraphQL error: ${data.errors[0]?.message ?? "unknown"}`);
  }
  const user = data.data?.matchedUser;
  if (!user) {
    throw new Error(`LeetCode user "${username}" not found`);
  }
  const all = user.submitStatsGlobal?.acSubmissionNum?.find(
    (r) => r.difficulty === "All"
  );
  return {
    totalSolved: all?.count ?? 0,
    streak: user.userCalendar?.streak ?? 0,
    recent: data.data?.recentAcSubmissionList ?? [],
  };
}

// Store one row per date: pulls and manual entries both land here.
export function saveLeetCodeStats(date: string, stats: LeetCodeStats): void {
  const db = getDb();
  const save = db.transaction(() => {
    db.prepare("DELETE FROM leetcode_stats WHERE date = ?").run(date);
    db.prepare(
      "INSERT INTO leetcode_stats (date, total_solved, streak, recent) VALUES (?, ?, ?, ?)"
    ).run(date, stats.totalSolved, stats.streak, JSON.stringify(stats.recent));
  });
  save();
}

export function latestLeetCodeRow():
  | { date: string; total_solved: number; streak: number; recent: string | null }
  | undefined {
  return getDb()
    .prepare(
      "SELECT date, total_solved, streak, recent FROM leetcode_stats ORDER BY date DESC LIMIT 1"
    )
    .get() as
    | { date: string; total_solved: number; streak: number; recent: string | null }
    | undefined;
}

// The daily pull (also run once at startup by the cron catch-up).
export async function pullLeetCodeJob(): Promise<void> {
  const username = process.env.LEETCODE_USERNAME;
  if (!username) {
    console.log("[leetcode] LEETCODE_USERNAME not set — skipping pull (manual entry still works)");
    return;
  }
  try {
    const stats = await fetchLeetCodeStats(username);
    saveLeetCodeStats(new Date().toISOString().slice(0, 10), stats);
    console.log(
      `[leetcode] pulled stats for ${username}: total=${stats.totalSolved} streak=${stats.streak}`
    );
  } catch (err) {
    console.error("[leetcode] pull failed (unofficial API — manual fallback available):", err);
  }
}
