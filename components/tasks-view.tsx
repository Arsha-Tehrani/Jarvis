"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

type Task = {
  id: number;
  title: string;
  due_at: string | null;
  priority: "low" | "medium" | "high";
  status: "open" | "done";
  source: string;
  created_at: string;
};

export function TasksView() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [priority, setPriority] = useState<"low" | "medium" | "high">("medium");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/tasks");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load tasks");
      setTasks(data.tasks);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load tasks");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function addTask(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    const res = await fetch("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: title.trim(),
        due_at: due || null,
        priority,
      }),
    });
    if (res.ok) {
      setTitle("");
      setDue("");
      setPriority("medium");
      await load();
    } else {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "Failed to add task");
    }
  }

  async function toggle(task: Task) {
    await fetch("/api/tasks", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: task.id,
        status: task.status === "open" ? "done" : "open",
      }),
    });
    await load();
  }

  async function remove(id: number) {
    await fetch(`/api/tasks?id=${id}`, { method: "DELETE" });
    await load();
  }

  return (
    <div className="flex flex-col gap-4">
      <form onSubmit={addTask} className="flex flex-wrap items-center gap-2">
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="New task…"
          className="min-w-48 flex-1"
        />
        <Input
          type="date"
          value={due}
          onChange={(e) => setDue(e.target.value)}
          className="w-40"
          aria-label="Due date"
        />
        <Select
          value={priority}
          onValueChange={(v) => setPriority(v as typeof priority)}
        >
          <SelectTrigger className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="low">Low</SelectItem>
            <SelectItem value="medium">Medium</SelectItem>
            <SelectItem value="high">High</SelectItem>
          </SelectContent>
        </Select>
        <Button type="submit" disabled={!title.trim()}>
          Add
        </Button>
      </form>

      {error && <p className="text-sm text-destructive">{error}</p>}
      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : tasks.length === 0 ? (
        <p className="text-sm text-muted-foreground">No tasks yet.</p>
      ) : (
        <ul className="flex flex-col divide-y">
          {tasks.map((task) => (
            <li key={task.id} className="flex items-center gap-3 py-2">
              <Checkbox
                checked={task.status === "done"}
                onCheckedChange={() => toggle(task)}
                aria-label={`Mark "${task.title}" ${task.status === "open" ? "done" : "open"}`}
              />
              <div className="flex flex-1 flex-wrap items-center gap-2">
                <span
                  className={cn(
                    "text-sm",
                    task.status === "done" && "text-muted-foreground line-through"
                  )}
                >
                  {task.title}
                </span>
                {task.due_at && (
                  <span className="text-xs text-muted-foreground">
                    due {task.due_at.slice(0, 10)}
                  </span>
                )}
                {task.priority !== "medium" && (
                  <Badge
                    variant={task.priority === "high" ? "destructive" : "secondary"}
                  >
                    {task.priority}
                  </Badge>
                )}
                {task.source !== "manual" && <Badge variant="outline">{task.source}</Badge>}
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => remove(task.id)}
                aria-label={`Delete "${task.title}"`}
              >
                ✕
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
