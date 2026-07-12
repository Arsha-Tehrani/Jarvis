import { randomUUID } from "crypto";
import { getDb } from "@/lib/db";
import {
  getGoogleAccessToken,
  isGoogleConfigured,
  isGoogleConnected,
} from "@/lib/google";
import { loggedFetch } from "@/lib/network-log";
import {
  buildEventBody,
  findMarkedEvent,
  handleGoogleStatus,
  planTaskEvent,
  shouldReconcile,
  taskMarker,
  type TaskWriteIntent,
} from "@/lib/tasks/calendar-plan";

// Network-touching half of task↔calendar sync. Every decision lives in the
// pure, unit-tested lib/tasks/calendar-plan.ts; this file is the thin glue:
// Google Calendar REST calls (through the same OAuth client module that
// create_calendar_event uses — one flow, one token store) plus the
// gcal_event_id bookkeeping. Calendar failures never fail a task write —
// callers get { synced: false, reason } and the reconciler retries hourly.

const CAL_BASE = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

export type TaskRow = {
  id: number;
  title: string;
  description: string | null;
  due_at: string | null;
  status: string;
  gcal_event_id: string | null;
  sync_id: string | null;
  created_at: string;
};

export type SyncResult = { synced: boolean; reason?: string; eventId?: string };

function connected(): boolean {
  return isGoogleConfigured() && isGoogleConnected();
}

// The calendar marker keys off sync_id (the cross-device identity), which is
// normally backfilled lazily at first sync push. Ensure it exists now — the
// same field sync would backfill, so there's no conflict.
function ensureSyncId(task: TaskRow): string {
  if (task.sync_id) return task.sync_id;
  const syncId = randomUUID();
  getDb().prepare("UPDATE tasks SET sync_id = ? WHERE id = ?").run(syncId, task.id);
  return syncId;
}

function storeEventId(taskId: number, eventId: string | null): void {
  getDb().prepare("UPDATE tasks SET gcal_event_id = ? WHERE id = ?").run(eventId, taskId);
}

async function googleJson(
  method: "POST" | "PATCH" | "DELETE" | "GET",
  url: string,
  body: unknown,
  purpose: string
): Promise<{ status: number; data: { id?: string; items?: Array<{ id: string; description?: string }> } }> {
  const token = await getGoogleAccessToken();
  const res = await loggedFetch(
    url,
    {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
    { feature: "task-calendar", purpose }
  );
  const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
  return { status: res.status, data };
}

export async function createTaskEvent(task: TaskRow): Promise<SyncResult> {
  const plan = planTaskEvent("create", task, connected());
  if (plan.kind !== "create") return { synced: false, reason: reasonOf(plan) };
  const syncId = ensureSyncId(task);
  const { status, data } = await googleJson(
    "POST",
    CAL_BASE,
    buildEventBody({ ...task, due_at: task.due_at! }, syncId),
    "create task event"
  );
  if (handleGoogleStatus(status) !== "ok" || !data.id) {
    return { synced: false, reason: `Google returned ${status}` };
  }
  storeEventId(task.id, data.id);
  return { synced: true, eventId: data.id };
}

export async function updateTaskEvent(task: TaskRow): Promise<SyncResult> {
  const plan = planTaskEvent("update", task, connected());
  if (plan.kind === "skip") return { synced: false, reason: plan.reason };
  if (plan.kind === "create") return createTaskEvent(task);
  if (plan.kind === "close") return closeTaskEvent(task, "deleted");
  const syncId = ensureSyncId(task);
  const { status } = await googleJson(
    "PATCH",
    `${CAL_BASE}/${encodeURIComponent(task.gcal_event_id!)}`,
    buildEventBody({ ...task, due_at: task.due_at! }, syncId),
    "update task event"
  );
  const outcome = handleGoogleStatus(status);
  if (outcome === "forget-link") {
    // User deleted the event by hand — normal, forget the link.
    storeEventId(task.id, null);
    return { synced: false, reason: "event deleted on Google" };
  }
  if (outcome === "error") return { synced: false, reason: `Google returned ${status}` };
  return { synced: true, eventId: task.gcal_event_id! };
}

// 'completed' renames the event to "✓ {title}" (the day's record stays on
// the calendar); 'deleted' removes it. 404 is not an error either way.
export async function closeTaskEvent(
  task: TaskRow,
  mode: "completed" | "deleted"
): Promise<SyncResult> {
  const plan = planTaskEvent(mode === "completed" ? "complete" : "delete", task, connected());
  if (plan.kind !== "close") return { synced: false, reason: reasonOf(plan) };
  const url = `${CAL_BASE}/${encodeURIComponent(task.gcal_event_id!)}`;
  const { status } =
    mode === "completed"
      ? await googleJson("PATCH", url, { summary: `✓ ${task.title}` }, "mark task event done")
      : await googleJson("DELETE", url, null, "delete task event");
  const outcome = handleGoogleStatus(status);
  if (outcome === "forget-link") {
    storeEventId(task.id, null);
    return { synced: false, reason: "event already gone on Google" };
  }
  if (outcome === "error") return { synced: false, reason: `Google returned ${status}` };
  if (mode === "deleted") storeEventId(task.id, null);
  return { synced: true };
}

// Reopen (undo of a completion): rename the event back to "Task: {title}".
export async function reopenTaskEvent(task: TaskRow): Promise<SyncResult> {
  if (!connected()) return { synced: false, reason: "Google not connected" };
  if (!task.gcal_event_id) return { synced: false, reason: "no linked event" };
  const { status } = await googleJson(
    "PATCH",
    `${CAL_BASE}/${encodeURIComponent(task.gcal_event_id)}`,
    { summary: `Task: ${task.title}` },
    "reopen task event"
  );
  if (handleGoogleStatus(status) === "forget-link") {
    storeEventId(task.id, null);
    return { synced: false, reason: "event deleted on Google" };
  }
  return status >= 200 && status < 300
    ? { synced: true }
    : { synced: false, reason: `Google returned ${status}` };
}

// Convenience for the API route: run the right calendar call for a task
// write, never letting a calendar failure surface as a task-write failure.
export async function syncTaskWrite(intent: TaskWriteIntent, task: TaskRow): Promise<void> {
  try {
    const result =
      intent === "create"
        ? await createTaskEvent(task)
        : intent === "update"
          ? await updateTaskEvent(task)
          : intent === "complete"
            ? await closeTaskEvent(task, "completed")
            : await closeTaskEvent(task, "deleted");
    if (!result.synced && result.reason && connected()) {
      console.log(`[task-calendar] ${intent} task ${task.id}: ${result.reason}`);
    }
  } catch (err) {
    // Outcome already recorded by loggedFetch; keep the task write alive.
    console.error(`[task-calendar] ${intent} task ${task.id} failed:`, err);
  }
}

function reasonOf(plan: { kind: string; reason?: string }): string {
  return plan.reason ?? `unexpected plan: ${plan.kind}`;
}

// ---- reconciler cron ---------------------------------------------------------

// Hourly (:45, plus launch catch-up): create events for open, due-dated
// tasks with no gcal_event_id — typically rows that synced in from a device
// without Google. Grace period + marker adoption prevent duplicates; only
// the device with Google connected does anything.
export async function taskCalendarReconcileJob(): Promise<void> {
  if (!connected()) {
    console.log("[task-calendar] reconcile skipped (Google not configured/connected)");
    return;
  }
  const now = new Date();
  const candidates = (
    getDb()
      .prepare(
        `SELECT id, title, description, due_at, status, gcal_event_id, sync_id, created_at
         FROM tasks WHERE status = 'open' AND due_at IS NOT NULL AND gcal_event_id IS NULL`
      )
      .all() as TaskRow[]
  ).filter((t) => shouldReconcile(t, now, true));

  for (const task of candidates) {
    try {
      const syncId = ensureSyncId(task);
      // Adopt an existing event carrying this task's marker before creating —
      // another device (or an earlier crashed run) may have made it already.
      const { status, data } = await googleJson(
        "GET",
        `${CAL_BASE}?${new URLSearchParams({
          q: taskMarker(syncId),
          timeMin: new Date(now.getTime() - 24 * 3600 * 1000).toISOString(),
          maxResults: "10",
          singleEvents: "true",
        })}`,
        null,
        "search for task event marker"
      );
      const existing =
        status === 200 ? findMarkedEvent(data.items ?? [], syncId) : null;
      if (existing) {
        storeEventId(task.id, existing);
        console.log(`[task-calendar] reconcile adopted event for task ${task.id} ("${task.title}")`);
        continue;
      }
      const result = await createTaskEvent({ ...task, sync_id: syncId });
      console.log(
        result.synced
          ? `[task-calendar] reconcile created event for task ${task.id} ("${task.title}")`
          : `[task-calendar] reconcile task ${task.id}: ${result.reason}`
      );
    } catch (err) {
      console.error(`[task-calendar] reconcile task ${task.id} failed:`, err);
    }
  }
}
