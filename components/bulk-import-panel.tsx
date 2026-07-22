"use client";

import { useCallback, useEffect, useState } from "react";
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
import type { BulkGroup, BulkProposal, SourceMode } from "@/lib/bulk-import/schema";
import { canSplit, mergeTasks, splitTask } from "@/lib/bulk-import/preview-edit";

// Bulk task-list import panel (Tasks page). Paste → Analyze → PREVIEW (groups
// with the model's reasoning, per-task edit/exclude/split/merge, reminder
// toggles) → Confirm. Only the confirm POST writes tasks — the same
// preview-then-confirm discipline as Finance's Re-Analyze flow. A proposal
// the agent's bulk_import_tasks tool created shows up here too (GET returns
// the pending proposal), so chat and UI share one review surface.

type Priority = "urgent" | "high" | "later";

type EditTask = {
  title: string;
  notes: string | null;
  due_at: string | null;
  priority: Priority | null;
  dependsOnNote: string | null;
  suggestAsReminder: boolean;
  include: boolean;
  createAsReminder: boolean;
};

type EditGroup = { name: string; reasoning: string; tasks: EditTask[] };

type Preview = { importId: number; sourceMode: SourceMode; groups: EditGroup[] };

type PastImport = {
  id: number;
  created_at: string;
  source_mode: SourceMode;
  status: string;
  task_count: number | null;
  proposal?: BulkProposal;
};

function toEditGroups(proposal: BulkProposal): EditGroup[] {
  return proposal.groups.map((g) => ({
    name: g.name,
    reasoning: g.reasoning,
    tasks: g.tasks.map((t) => ({
      ...t,
      include: true,
      createAsReminder: t.suggestAsReminder,
    })),
  }));
}

export function BulkImportPanel({ onCommitted }: { onCommitted: () => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [history, setHistory] = useState<PastImport[]>([]);

  const loadHistory = useCallback(async () => {
    try {
      const res = await fetch("/api/tasks/bulk-import");
      if (!res.ok) return;
      const data = (await res.json()) as { imports: PastImport[] };
      setHistory(data.imports);
      // An agent-initiated analyze leaves a pending proposal — surface it.
      const pending = data.imports.find((i) => i.status === "proposed" && i.proposal);
      if (pending?.proposal) {
        setPreview((cur) =>
          cur ?? {
            importId: pending.id,
            sourceMode: pending.source_mode,
            groups: toEditGroups(pending.proposal!),
          }
        );
      }
    } catch {
      // history is a convenience — the paste box still works without it
    }
  }, []);

  useEffect(() => {
    if (open) void loadHistory();
  }, [open, loadHistory]);

  async function analyze() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/tasks/bulk-import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "analyze", text }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Analyze failed");
        return;
      }
      setPreview({
        importId: data.importId,
        sourceMode: data.sourceMode,
        groups: toEditGroups(data.proposal),
      });
      setText("");
    } catch {
      setError("Could not reach the API.");
    } finally {
      setBusy(false);
    }
  }

  function patchTask(gi: number, ti: number, patch: Partial<EditTask>) {
    setPreview((p) => {
      if (!p) return p;
      const groups = p.groups.map((g, i) =>
        i === gi
          ? { ...g, tasks: g.tasks.map((t, j) => (j === ti ? { ...t, ...patch } : t)) }
          : g
      );
      return { ...p, groups };
    });
  }

  // Split/merge run through the pure, tested helpers; the include/reminder
  // flags ride along on the task objects through the spread.
  function doSplit(gi: number, ti: number) {
    setPreview((p) => {
      if (!p) return p;
      const groups = [...p.groups];
      groups[gi] = splitTask(groups[gi] as unknown as BulkGroup, ti) as unknown as EditGroup;
      return { ...p, groups };
    });
  }

  function doMergeUp(gi: number, ti: number) {
    setPreview((p) => {
      if (!p) return p;
      const groups = [...p.groups];
      groups[gi] = mergeTasks(groups[gi] as unknown as BulkGroup, [ti - 1, ti]) as unknown as EditGroup;
      return { ...p, groups };
    });
  }

  async function commit() {
    if (!preview) return;
    const groups = preview.groups
      .map((g) => ({
        name: g.name,
        reasoning: g.reasoning,
        tasks: g.tasks
          .filter((t) => t.include)
          .map(({ include: _include, ...t }) => t),
      }))
      .filter((g) => g.tasks.length > 0);
    if (groups.length === 0) {
      setError("Nothing selected to import.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/tasks/bulk-import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "commit",
          import_id: preview.importId,
          selection: { groups },
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Commit failed");
        return;
      }
      const failed = (data.reminders as Array<{ ok: boolean; title: string; error?: string }>)
        .filter((r) => !r.ok)
        .map((r) => `"${r.title}" (${r.error})`);
      setNotice(
        `Created ${data.created} task(s).` +
          (failed.length > 0 ? ` Reminder(s) not created: ${failed.join("; ")}` : "")
      );
      setPreview(null);
      await loadHistory();
      onCommitted();
    } catch {
      setError("Could not reach the API.");
    } finally {
      setBusy(false);
    }
  }

  async function discard() {
    if (!preview) return;
    setBusy(true);
    try {
      await fetch("/api/tasks/bulk-import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "discard", import_id: preview.importId }),
      });
      setPreview(null);
      await loadHistory();
    } finally {
      setBusy(false);
    }
  }

  async function undo(imp: PastImport) {
    // Bulk delete of real tasks → confirm-gated like every other revert.
    if (
      !window.confirm(
        `Undo import #${imp.id}? This deletes the ${imp.task_count ?? "?"} task(s) it created.`
      )
    )
      return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/tasks/bulk-import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "undo", import_id: imp.id }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Undo failed");
        return;
      }
      setNotice(`Removed ${data.removed} task(s) from import #${imp.id}.`);
      await loadHistory();
      onCommitted();
    } catch {
      setError("Could not reach the API.");
    } finally {
      setBusy(false);
    }
  }

  const selectedCount =
    preview?.groups.reduce((n, g) => n + g.tasks.filter((t) => t.include).length, 0) ?? 0;

  return (
    <section className="rounded-lg border border-line">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-sm text-muted-foreground hover:text-foreground"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {open ? "▾" : "▸"} Bulk import
        <span className="text-xs">— paste a checklist or notes dump, review, then confirm</span>
      </button>

      {open && (
        <div className="flex flex-col gap-3 border-t border-line p-3">
          {!preview && (
            <div className="flex flex-col gap-2">
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Paste your list here…"
                rows={6}
                className="w-full rounded-[var(--radius)] border border-line bg-transparent p-2 text-xs outline-none focus-visible:border-ring"
              />
              <div>
                <Button onClick={analyze} disabled={busy || !text.trim()}>
                  {busy ? "Analyzing…" : "Analyze"}
                </Button>
              </div>
            </div>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}
          {notice && <p className="text-sm text-muted-foreground">{notice}</p>}

          {preview && (
            <div className="flex flex-col gap-4">
              <p className="text-xs text-muted-foreground">
                Proposal from a {preview.sourceMode} paste — nothing is created until you
                confirm. Uncheck to exclude; Split expands noted sub-bullets into their own
                tasks; ↑ merges a task into the one above it.
              </p>
              {preview.groups.map((g, gi) => (
                <div key={gi} className="flex flex-col gap-2">
                  <header className="border-b border-line pb-1">
                    <h3 className="text-sm font-medium">{g.name}</h3>
                    <p className="text-xs italic text-muted-foreground">{g.reasoning}</p>
                  </header>
                  {g.tasks.map((t, ti) => (
                    <div
                      key={ti}
                      className={`flex flex-col gap-1.5 rounded-md border border-line p-2 ${t.include ? "" : "opacity-50"}`}
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <Checkbox
                          checked={t.include}
                          onCheckedChange={(v) => patchTask(gi, ti, { include: v === true })}
                          aria-label={`Include "${t.title}"`}
                        />
                        <Input
                          value={t.title}
                          onChange={(e) => patchTask(gi, ti, { title: e.target.value })}
                          className="h-7 min-w-48 flex-1 text-xs"
                          aria-label="Task title"
                        />
                        <Input
                          type="date"
                          value={t.due_at ?? ""}
                          onChange={(e) => patchTask(gi, ti, { due_at: e.target.value || null })}
                          className="h-7 w-36 text-xs"
                          aria-label="Due date"
                        />
                        <Select
                          value={t.priority ?? "high"}
                          onValueChange={(v) => patchTask(gi, ti, { priority: v as Priority })}
                        >
                          <SelectTrigger className="h-7 w-24 text-xs" aria-label="Priority">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="urgent">Urgent</SelectItem>
                            <SelectItem value="high">High</SelectItem>
                            <SelectItem value="later">Later</SelectItem>
                          </SelectContent>
                        </Select>
                        {canSplit(t) && (
                          <Button variant="outline" size="xs" onClick={() => doSplit(gi, ti)}>
                            Split
                          </Button>
                        )}
                        {ti > 0 && (
                          <Button
                            variant="outline"
                            size="xs"
                            onClick={() => doMergeUp(gi, ti)}
                            title="Merge into the task above"
                          >
                            ↑
                          </Button>
                        )}
                      </div>
                      {t.notes && (
                        <p className="whitespace-pre-wrap pl-6 text-xs text-muted-foreground">
                          {t.notes}
                        </p>
                      )}
                      <div className="flex flex-wrap items-center gap-3 pl-6">
                        {t.dependsOnNote && (
                          <span className="rounded-[var(--radius)] bg-warn-bg px-1.5 py-0.5 text-xs text-warn">
                            depends: {t.dependsOnNote}
                          </span>
                        )}
                        {(t.suggestAsReminder || t.createAsReminder) && (
                          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                            <Checkbox
                              checked={t.createAsReminder}
                              onCheckedChange={(v) =>
                                patchTask(gi, ti, { createAsReminder: v === true })
                              }
                            />
                            create as calendar reminder instead
                            {t.suggestAsReminder && " (suggested)"}
                          </label>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ))}
              <div className="flex items-center gap-2">
                <Button onClick={commit} disabled={busy || selectedCount === 0}>
                  Create {selectedCount} task(s)
                </Button>
                <Button variant="ghost" onClick={discard} disabled={busy}>
                  Discard
                </Button>
              </div>
            </div>
          )}

          {history.some((i) => i.status === "committed") && (
            <div className="border-t border-line pt-2">
              <p className="mb-1 text-xs font-medium text-muted-foreground">Recent imports</p>
              <ul className="flex flex-col gap-1">
                {history
                  .filter((i) => i.status === "committed")
                  .map((i) => (
                    <li key={i.id} className="flex items-center gap-2 text-xs">
                      <span className="text-muted-foreground">
                        #{i.id} · {i.created_at.slice(0, 10)} · {i.task_count ?? "?"} task(s)
                      </span>
                      <Button variant="ghost" size="xs" onClick={() => undo(i)} disabled={busy}>
                        Undo
                      </Button>
                    </li>
                  ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
