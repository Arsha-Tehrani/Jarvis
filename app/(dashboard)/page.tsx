import Link from "next/link";
import { getDb } from "@/lib/db";
import { AgentChat } from "@/components/agent-chat";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";

type TaskRow = {
  id: number;
  title: string;
  due_at: string | null;
  priority: "low" | "medium" | "high";
};

export default function TodayPage() {
  const db = getDb();
  const tasks = db
    .prepare(
      `SELECT id, title, due_at, priority FROM tasks
       WHERE status = 'open'
       ORDER BY due_at IS NULL, due_at ASC,
         CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END
       LIMIT 5`
    )
    .all() as TaskRow[];

  const today = new Date().toISOString().slice(0, 10);
  const wentToday = !!db.prepare("SELECT 1 FROM gym_logs WHERE date = ?").get(today);
  const gymThisMonth = (
    db
      .prepare("SELECT COUNT(*) AS n FROM gym_logs WHERE date LIKE ?")
      .get(`${today.slice(0, 7)}%`) as { n: number }
  ).n;
  const leetcode = db
    .prepare(
      "SELECT date, total_solved, streak FROM leetcode_stats ORDER BY date DESC LIMIT 1"
    )
    .get() as { date: string; total_solved: number; streak: number } | undefined;

  return (
    <div className="flex flex-col gap-6">
      <AgentChat />
      <Card>
        <CardHeader>
          <CardTitle>
            <Link href="/trackers" className="hover:underline">
              Trackers
            </Link>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-6 text-sm">
          <div>
            <p className="font-medium">Gym</p>
            <p className="text-muted-foreground">
              {wentToday ? "Went today ✓" : "Not logged today"} · {gymThisMonth} this month
            </p>
          </div>
          <div>
            <p className="font-medium">LeetCode</p>
            <p className="text-muted-foreground">
              {leetcode
                ? `${leetcode.total_solved} solved · ${leetcode.streak} day streak (as of ${leetcode.date})`
                : "No stats yet"}
            </p>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>
            <Link href="/tasks" className="hover:underline">
              Top tasks
            </Link>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {tasks.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No open tasks. Add one in the Tasks tab or ask Jarvis.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {tasks.map((t) => (
                <li key={t.id} className="flex items-center gap-2 text-sm">
                  <span>{t.title}</span>
                  {t.due_at && (
                    <span className="text-muted-foreground">
                      due {t.due_at.slice(0, 10)}
                    </span>
                  )}
                  {t.priority !== "medium" && (
                    <Badge variant={t.priority === "high" ? "destructive" : "secondary"}>
                      {t.priority}
                    </Badge>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
