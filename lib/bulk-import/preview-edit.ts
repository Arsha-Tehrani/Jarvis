// Pure preview-edit transitions for the Bulk Import panel: the "nudge the
// sub-item expansion call" controls (spec §2A) — split one task's noted
// sub-bullets into separate tasks, or merge several tasks back into one.
// Pure so `node --test` covers them directly; the UI just applies the result.

import type { BulkGroup, BulkTask } from "./schema.ts";

const BULLET_RE = /^\s*(?:[-*•‣▪]|☐|☑|✓|\[[ xX]?\])\s+/;

/** The bullet lines inside a task's notes (what a split would expand). */
export function noteBullets(notes: string | null): string[] {
  if (!notes) return [];
  return notes
    .split(/\r?\n/)
    .filter((l) => BULLET_RE.test(l))
    .map((l) => l.replace(BULLET_RE, "").trim())
    .filter(Boolean);
}

export function canSplit(task: BulkTask): boolean {
  return noteBullets(task.notes).length >= 2;
}

/**
 * Expand task `taskIndex`'s noted sub-bullets into separate sibling tasks —
 * one per bullet, each independently checkable, inheriting the parent's
 * due/priority/flags with the parent's non-bullet notes as shared context.
 */
export function splitTask(group: BulkGroup, taskIndex: number): BulkGroup {
  const task = group.tasks[taskIndex];
  if (!task) return group;
  const bullets = noteBullets(task.notes);
  if (bullets.length < 2) return group;

  const shared = (task.notes ?? "")
    .split(/\r?\n/)
    .filter((l) => !BULLET_RE.test(l))
    .join("\n")
    .trim();
  const context = [task.title, shared].filter(Boolean).join(" — ");
  const children: BulkTask[] = bullets.map((b) => ({
    ...task,
    title: b.slice(0, 200),
    notes: context || null,
  }));
  return {
    ...group,
    tasks: [...group.tasks.slice(0, taskIndex), ...children, ...group.tasks.slice(taskIndex + 1)],
  };
}

/**
 * Collapse the tasks at `indices` (2+) into one task: first one's identity,
 * the rest folded into its notes as bullets. Earliest due date and highest
 * priority win, so merging never silently loses urgency.
 */
export function mergeTasks(group: BulkGroup, indices: number[]): BulkGroup {
  const sorted = [...new Set(indices)].filter((i) => group.tasks[i]).sort((a, b) => a - b);
  if (sorted.length < 2) return group;
  const picked = sorted.map((i) => group.tasks[i]);
  const [head, ...rest] = picked;

  const rank = { urgent: 0, high: 1, later: 2 } as const;
  const priorities = picked.map((t) => t.priority).filter((p): p is NonNullable<typeof p> => !!p);
  const dues = picked.map((t) => t.due_at).filter((d): d is string => !!d);

  const merged: BulkTask = {
    ...head,
    notes: [head.notes, ...rest.map((t) => `- ${t.title}${t.notes ? ` (${t.notes})` : ""}`)]
      .filter(Boolean)
      .join("\n")
      .slice(0, 2000) || null,
    due_at: dues.length > 0 ? dues.sort()[0] : null,
    priority:
      priorities.length > 0
        ? priorities.sort((a, b) => rank[a] - rank[b])[0]
        : null,
  };
  const keep = new Set(sorted.slice(1));
  const tasks = group.tasks
    .map((t, i) => (i === sorted[0] ? merged : t))
    .filter((_, i) => !keep.has(i));
  return { ...group, tasks };
}
