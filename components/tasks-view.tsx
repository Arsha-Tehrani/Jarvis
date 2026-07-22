"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { BulkImportPanel } from "@/components/bulk-import-panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { sortTasks } from "@/lib/tasks/sort";
import { cn } from "@/lib/utils";

type Priority = "urgent" | "high" | "later";

type Task = {
  id: number;
  title: string;
  description: string | null;
  due_at: string | null;
  priority: Priority;
  status: "open" | "done";
  source: string;
  created_at: string;
  gcal_event_id: string | null;
  completed_at: string | null;
  llm_rank: number | null;
  llm_rank_source: "deterministic" | "llm" | null;
  llm_suggested_priority: Priority | null;
  llm_rationale: string | null;
};

// Column header dot colors follow the ledger grammar: loss-red for Urgent,
// warn-ochre for High, muted ink for Later. (Numbers-only rule doesn't
// apply — these are fixed column identities, not money values.)
const COLUMNS: Array<{ priority: Priority; label: string; dot: string }> = [
  { priority: "urgent", label: "Urgent", dot: "bg-loss" },
  { priority: "high", label: "High", dot: "bg-warn" },
  { priority: "later", label: "Later", dot: "bg-ink-muted" },
];

const DAY_MS = 86_400_000;

function dueChipClass(dueAt: string): string {
  const due = new Date(dueAt.length === 10 ? `${dueAt}T23:59:59` : dueAt).getTime();
  const now = Date.now();
  if (due - now <= 2 * DAY_MS) return "bg-loss-bg text-loss"; // overdue or within 48h
  if (due - now <= 7 * DAY_MS) return "bg-warn-bg text-warn";
  return "border border-line text-muted-foreground";
}

function formatDue(dueAt: string): string {
  const d = new Date(dueAt.length === 10 ? `${dueAt}T12:00:00` : dueAt);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function TasksView() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [priority, setPriority] = useState<Priority>("high");
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [descDraft, setDescDraft] = useState("");
  const [showCompleted, setShowCompleted] = useState(false);

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

  // ?task={id} (the Calendar page's task-chip dispatch) expands that card
  // once the list has loaded, so a chip click lands on the task's edit UI.
  const urlTaskApplied = useRef(false);
  useEffect(() => {
    if (urlTaskApplied.current || tasks.length === 0) return;
    urlTaskApplied.current = true;
    const id = Number(new URLSearchParams(window.location.search).get("task"));
    const target = tasks.find((t) => t.id === id);
    if (target) {
      setExpandedId(target.id);
      setDescDraft(target.description ?? "");
    }
  }, [tasks]);

  async function addTask(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    const res = await fetch("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: title.trim(), due_at: due || null, priority }),
    });
    if (res.ok) {
      setTitle("");
      setDue("");
      setPriority("high");
      await load();
    } else {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "Failed to add task");
    }
  }

  async function patch(id: number, body: Record<string, unknown>) {
    const res = await fetch("/api/tasks", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, ...body }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "Failed to update task");
    }
    await load();
  }

  async function remove(task: Task) {
    if (!window.confirm(`Delete "${task.title}"? This can't be undone.`)) return;
    await fetch(`/api/tasks?id=${task.id}`, { method: "DELETE" });
    await load();
  }

  const open = tasks.filter((t) => t.status === "open");
  const completed = tasks
    .filter((t) => t.status === "done")
    .sort((a, b) =>
      (b.completed_at ?? b.created_at) < (a.completed_at ?? a.created_at) ? -1 : 1
    )
    .slice(0, 20);

  function toggleExpand(task: Task) {
    if (expandedId === task.id) {
      setExpandedId(null);
    } else {
      setExpandedId(task.id);
      setDescDraft(task.description ?? "");
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Quick-add: title + due + priority only — description is added by
          expanding a created card. */}
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
        <Select value={priority} onValueChange={(v) => setPriority(v as Priority)}>
          <SelectTrigger className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="urgent">Urgent</SelectItem>
            <SelectItem value="high">High</SelectItem>
            <SelectItem value="later">Later</SelectItem>
          </SelectContent>
        </Select>
        <Button type="submit" disabled={!title.trim()}>
          Add
        </Button>
      </form>

      <BulkImportPanel onCommitted={load} />

      {error && <p className="text-sm text-destructive">{error}</p>}
      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {COLUMNS.map((col) => {
            const colTasks = sortTasks(open.filter((t) => t.priority === col.priority));
            return (
              <section key={col.priority} className="flex min-w-0 flex-col gap-2">
                <header className="flex items-center gap-2 border-b border-line pb-1.5">
                  <span aria-hidden className={cn("size-2 rounded-full", col.dot)} />
                  <h2 className="text-sm font-medium">{col.label}</h2>
                  <span className="text-xs text-muted-foreground">{colTasks.length}</span>
                </header>
                {colTasks.length === 0 && (
                  <p className="py-2 text-xs text-muted-foreground">Nothing here.</p>
                )}
                {colTasks.map((task) => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    expanded={expandedId === task.id}
                    descDraft={descDraft}
                    onDescDraft={setDescDraft}
                    onToggleExpand={() => toggleExpand(task)}
                    onPatch={patch}
                    onRemove={() => remove(task)}
                  />
                ))}
              </section>
            );
          })}
        </div>
      )}

      {/* Completed: collapsed by default, last 20, struck through. */}
      {completed.length > 0 && (
        <section className="mt-2 border-t border-line pt-2">
          <button
            type="button"
            className="text-sm text-muted-foreground hover:text-foreground"
            onClick={() => setShowCompleted((v) => !v)}
            aria-expanded={showCompleted}
          >
            {showCompleted ? "▾" : "▸"} Completed ({completed.length})
          </button>
          {showCompleted && (
            <ul className="mt-2 flex flex-col gap-1">
              {completed.map((task) => (
                <li key={task.id} className="flex items-center gap-2 text-sm">
                  <span className="text-muted-foreground line-through">{task.title}</span>
                  {task.completed_at && (
                    <span className="text-xs text-muted-foreground">
                      {formatDue(task.completed_at)}
                    </span>
                  )}
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => patch(task.id, { completed: false })}
                  >
                    Reopen
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}

function TaskCard({
  task,
  expanded,
  descDraft,
  onDescDraft,
  onToggleExpand,
  onPatch,
  onRemove,
}: {
  task: Task;
  expanded: boolean;
  descDraft: string;
  onDescDraft: (v: string) => void;
  onToggleExpand: () => void;
  onPatch: (id: number, body: Record<string, unknown>) => Promise<void>;
  onRemove: () => void;
}) {
  const suggestion =
    task.llm_suggested_priority && task.llm_suggested_priority !== task.priority
      ? task.llm_suggested_priority
      : null;

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-line bg-card p-3">
      <div className="flex items-start gap-2">
        <button
          type="button"
          onClick={onToggleExpand}
          className="min-w-0 flex-1 text-left"
          aria-expanded={expanded}
        >
          <p className="text-sm font-medium">{task.title}</p>
          {task.description && !expanded && (
            <p className="mt-0.5 line-clamp-2 text-xs text-ink-muted">{task.description}</p>
          )}
        </button>
        <Button variant="ghost" size="icon-xs" onClick={onRemove} aria-label={`Delete "${task.title}"`}>
          ✕
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {task.due_at && (
          <span
            className={cn(
              "rounded-[var(--radius)] px-1.5 py-0.5 text-xs tabular-nums",
              dueChipClass(task.due_at)
            )}
          >
            due {formatDue(task.due_at)}
          </span>
        )}
        {task.gcal_event_id && (
          <span className="rounded-[var(--radius)] bg-gain-bg px-1.5 py-0.5 text-xs text-gain">
            ✓ calendar
          </span>
        )}
        {task.llm_rank != null && (
          <span className="rounded-[var(--radius)] border border-line px-1.5 py-0.5 text-xs tabular-nums text-ink-muted">
            #{task.llm_rank}
          </span>
        )}
        {task.source !== "manual" && (
          <span className="rounded-[var(--radius)] border border-line px-1.5 py-0.5 text-xs text-ink-muted">
            {task.source}
          </span>
        )}
      </div>

      {suggestion && (
        <p className="border-l-2 border-warn pl-2 text-xs text-warn">
          ↑ Jarvis suggests {suggestion}
          {task.llm_rationale ? ` — ${task.llm_rationale}` : ""}{" "}
          <button
            type="button"
            className="underline underline-offset-2"
            onClick={() =>
              onPatch(task.id, { priority: suggestion, clear_suggestion: true })
            }
          >
            Apply
          </button>{" "}
          <button
            type="button"
            className="underline underline-offset-2"
            onClick={() => onPatch(task.id, { clear_suggestion: true })}
          >
            Dismiss
          </button>
        </p>
      )}

      {expanded && (
        <div className="flex flex-col gap-2 border-t border-line pt-2">
          <textarea
            value={descDraft}
            onChange={(e) => onDescDraft(e.target.value)}
            placeholder="Description…"
            rows={3}
            maxLength={2000}
            className="w-full rounded-[var(--radius)] border border-line bg-transparent p-2 text-xs outline-none focus-visible:border-ring"
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="xs"
              variant="secondary"
              disabled={descDraft === (task.description ?? "")}
              onClick={() => onPatch(task.id, { description: descDraft || null })}
            >
              Save description
            </Button>
            <Select
              value={task.priority}
              onValueChange={(v) => onPatch(task.id, { priority: v })}
            >
              <SelectTrigger className="h-6 w-24 text-xs" aria-label="Priority">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="urgent">Urgent</SelectItem>
                <SelectItem value="high">High</SelectItem>
                <SelectItem value="later">Later</SelectItem>
              </SelectContent>
            </Select>
            <Input
              type="date"
              defaultValue={task.due_at?.slice(0, 10) ?? ""}
              onChange={(e) => onPatch(task.id, { due_at: e.target.value || null })}
              className="h-6 w-36 text-xs"
              aria-label="Due date"
            />
            <Button size="xs" onClick={() => onPatch(task.id, { completed: true })}>
              Mark done
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
