// Pure decision half of task↔calendar sync (the network-touching wrapper is
// lib/tasks/calendar.ts) — same split as history-core.ts / history.ts. Unit
// tests exercise every branch here; the wrapper stays thin and untested.

export type TaskForCalendar = {
  title: string;
  description: string | null;
  due_at: string | null;
  gcal_event_id: string | null;
};

export type TaskWriteIntent = "create" | "update" | "complete" | "delete";

export type CalendarAction =
  | { kind: "skip"; reason: string }
  | { kind: "create" }
  | { kind: "update" }
  | { kind: "close"; mode: "completed" | "deleted" };

// What should happen on Google when a task write lands.
export function planTaskEvent(
  intent: TaskWriteIntent,
  task: TaskForCalendar,
  googleConnected: boolean
): CalendarAction {
  if (!googleConnected) return { kind: "skip", reason: "Google not connected" };

  switch (intent) {
    case "create":
      if (!task.due_at) return { kind: "skip", reason: "no due date" };
      if (task.gcal_event_id) return { kind: "skip", reason: "already has an event" };
      return { kind: "create" };
    case "update":
      if (!task.gcal_event_id) {
        // No linked event yet — e.g. a due date was just added, or creation
        // happened while Google was down. Create rather than patch nothing.
        return task.due_at
          ? { kind: "create" }
          : { kind: "skip", reason: "no due date" };
      }
      if (!task.due_at) {
        // Due date removed: a dateless task has no place on a calendar.
        return { kind: "close", mode: "deleted" };
      }
      return { kind: "update" };
    case "complete":
      if (!task.gcal_event_id) return { kind: "skip", reason: "no linked event" };
      return { kind: "close", mode: "completed" };
    case "delete":
      if (!task.gcal_event_id) return { kind: "skip", reason: "no linked event" };
      return { kind: "close", mode: "deleted" };
  }
}

// ---- reconciler eligibility --------------------------------------------------

export const RECONCILE_GRACE_MS = 10 * 60 * 1000;

// oauth_tokens never sync, so a task created on a Google-less device arrives
// here via sync with gcal_event_id NULL. The reconciler (hourly cron on
// whichever device IS connected) creates the missing events — but only for
// rows older than the grace period, so a fresher sync pull still has time to
// deliver an event id that was created elsewhere.
export function shouldReconcile(
  task: {
    status: string;
    due_at: string | null;
    gcal_event_id: string | null;
    created_at: string;
  },
  now: Date,
  googleConnected: boolean
): boolean {
  if (!googleConnected) return false;
  if (task.status !== "open") return false;
  if (!task.due_at) return false;
  if (task.gcal_event_id) return false;
  const createdMs = Date.parse(task.created_at);
  if (Number.isNaN(createdMs)) return true; // unparseable age — don't hold it forever
  return now.getTime() - createdMs >= RECONCILE_GRACE_MS;
}

// ---- marker + event body -----------------------------------------------------

export function taskMarker(syncId: string): string {
  return `jarvis-task:${syncId}`;
}

// Scan a list of events for the one carrying this task's marker line, so the
// reconciler adopts an existing event instead of duplicating it.
export function findMarkedEvent(
  events: Array<{ id: string; description?: string | null }>,
  syncId: string
): string | null {
  const marker = taskMarker(syncId);
  for (const e of events) {
    if (e.description?.includes(marker)) return e.id;
  }
  return null;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export type EventBody = {
  summary: string;
  description: string;
  start: { date: string } | { dateTime: string };
  end: { date: string } | { dateTime: string };
  reminders: { useDefault: false; overrides: Array<{ method: "popup"; minutes: number }> };
};

// A date-only due date becomes an all-day event; a datetime becomes a
// 30-minute event. Either way: popup reminder 60 minutes ahead, and the
// marker line rides the description for reconciler adoption.
export function buildEventBody(
  task: { title: string; description: string | null; due_at: string },
  syncId: string
): EventBody {
  const description = [task.description, taskMarker(syncId)]
    .filter((s): s is string => !!s)
    .join("\n\n");
  const base = {
    summary: `Task: ${task.title}`,
    description,
    reminders: {
      useDefault: false as const,
      overrides: [{ method: "popup" as const, minutes: 60 }],
    },
  };
  if (DATE_ONLY.test(task.due_at)) {
    const next = new Date(`${task.due_at}T12:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    return {
      ...base,
      start: { date: task.due_at },
      end: { date: next.toISOString().slice(0, 10) },
    };
  }
  const startMs = Date.parse(task.due_at);
  return {
    ...base,
    start: { dateTime: new Date(startMs).toISOString() },
    end: { dateTime: new Date(startMs + 30 * 60 * 1000).toISOString() },
  };
}

// 404 from Google on update/close means the user deleted the event by hand.
// That's a normal state, not an error: forget the link (so the reconciler can
// re-create if the task still qualifies) and move on.
export function handleGoogleStatus(
  status: number
): "ok" | "forget-link" | "error" {
  if (status >= 200 && status < 300) return "ok";
  if (status === 404 || status === 410) return "forget-link";
  return "error";
}
