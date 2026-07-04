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
  const tasks = getDb()
    .prepare(
      `SELECT id, title, due_at, priority FROM tasks
       WHERE status = 'open'
       ORDER BY due_at IS NULL, due_at ASC,
         CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END
       LIMIT 5`
    )
    .all() as TaskRow[];

  return (
    <div className="flex flex-col gap-6">
      <AgentChat />
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
