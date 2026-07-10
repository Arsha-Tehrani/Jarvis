"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const STAGES = [
  "wishlist",
  "applied",
  "screening",
  "interview",
  "offer",
  "rejected",
  "accepted",
] as const;

type Application = {
  id: number;
  company: string;
  role: string;
  stage: (typeof STAGES)[number];
  next_action: string | null;
  next_action_at: string | null;
  contact: string | null;
  link: string | null;
  notes: string | null;
  date_applied: string | null;
  created_at: string;
};

// Same "today" convention the due-badge comparison below already uses.
const todayIso = () => new Date().toISOString().slice(0, 10);

const STAGE_ORDER: Record<string, number> = Object.fromEntries(
  STAGES.map((s, i) => [s, i])
);

export function CareerView() {
  const [apps, setApps] = useState<Application[]>([]);
  const [due, setDue] = useState<Application[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [company, setCompany] = useState("");
  const [role, setRole] = useState("");
  const [nextAction, setNextAction] = useState("");
  const [nextActionAt, setNextActionAt] = useState("");
  const [dateApplied, setDateApplied] = useState(todayIso);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/career");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load applications");
      setApps(data.applications);
      setDue(data.followUpsDue);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load applications");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!company.trim() || !role.trim()) return;
    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        company: company.trim(),
        role: role.trim(),
      };
      if (nextAction.trim()) body.next_action = nextAction.trim();
      if (nextActionAt) body.next_action_at = nextActionAt;
      if (dateApplied) body.date_applied = dateApplied;
      const res = await fetch("/api/career", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "Failed to add");
      } else {
        setCompany("");
        setRole("");
        setNextAction("");
        setNextActionAt("");
        setDateApplied(todayIso());
        setError(null);
      }
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function setStage(app: Application, stage: string) {
    await fetch("/api/career", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: app.id, stage }),
    });
    await load();
  }

  async function remove(app: Application) {
    if (!window.confirm(`Delete ${app.company} — ${app.role}?`)) return;
    await fetch(`/api/career?id=${app.id}`, { method: "DELETE" });
    await load();
  }

  const grouped = STAGES.map((stage) => ({
    stage,
    items: apps
      .filter((a) => a.stage === stage)
      .sort((a, b) => (a.next_action_at ?? "9").localeCompare(b.next_action_at ?? "9")),
  })).filter((g) => g.items.length > 0);

  return (
    <div className="flex flex-col gap-6">
      {error && <p className="text-sm text-destructive">{error}</p>}

      {due.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Follow-ups due ({due.length})</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col gap-2 text-sm">
              {due.map((a) => (
                <li key={a.id} className="flex flex-wrap items-baseline gap-2">
                  <span className="font-medium">
                    {a.company} — {a.role}
                  </span>
                  <span className="text-muted-foreground">
                    {a.next_action ?? "follow up"} · due{" "}
                    {a.next_action_at?.slice(0, 10)}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Add application</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={create} className="flex flex-wrap items-end gap-2">
            <div className="flex flex-col gap-1">
              <Label htmlFor="ca-company" className="text-xs">
                Company
              </Label>
              <Input
                id="ca-company"
                value={company}
                onChange={(e) => setCompany(e.target.value)}
                className="w-44"
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="ca-role" className="text-xs">
                Role
              </Label>
              <Input
                id="ca-role"
                value={role}
                onChange={(e) => setRole(e.target.value)}
                className="w-52"
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="ca-next" className="text-xs">
                Next action
              </Label>
              <Input
                id="ca-next"
                value={nextAction}
                onChange={(e) => setNextAction(e.target.value)}
                placeholder="Follow up with recruiter"
                className="w-56"
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="ca-when" className="text-xs">
                Due
              </Label>
              <Input
                id="ca-when"
                type="date"
                value={nextActionAt}
                onChange={(e) => setNextActionAt(e.target.value)}
                className="w-40"
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="ca-applied" className="text-xs">
                Applied
              </Label>
              <Input
                id="ca-applied"
                type="date"
                value={dateApplied}
                onChange={(e) => setDateApplied(e.target.value)}
                className="w-40"
              />
            </div>
            <Button type="submit" disabled={busy || !company.trim() || !role.trim()}>
              Add
            </Button>
          </form>
        </CardContent>
      </Card>

      {apps.length === 0 ? (
        <p className="text-sm text-muted-foreground">No applications tracked yet.</p>
      ) : (
        grouped
          .sort((a, b) => STAGE_ORDER[a.stage] - STAGE_ORDER[b.stage])
          .map((group) => (
            <Card key={group.stage}>
              <CardHeader>
                <CardTitle className="capitalize">
                  {group.stage}{" "}
                  <span className="text-sm font-normal text-muted-foreground">
                    ({group.items.length})
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="flex flex-col divide-y">
                  {group.items.map((a) => (
                    <li key={a.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                      <div className="min-w-40 flex-1">
                        <p className="font-medium">
                          {a.link ? (
                            <a
                              href={a.link}
                              target="_blank"
                              rel="noreferrer"
                              className="hover:underline"
                            >
                              {a.company}
                            </a>
                          ) : (
                            a.company
                          )}{" "}
                          — {a.role}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          <>applied {a.date_applied ?? "—"}</>
                          {a.next_action && (
                            <>
                              {" · "}
                              {a.next_action}
                              {a.next_action_at && ` · due ${a.next_action_at.slice(0, 10)}`}
                            </>
                          )}
                          {a.contact && <> · {a.contact}</>}
                        </p>
                      </div>
                      {a.next_action_at &&
                        a.next_action_at.slice(0, 10) <=
                          new Date().toISOString().slice(0, 10) &&
                        !["rejected", "accepted"].includes(a.stage) && (
                          <Badge variant="destructive">due</Badge>
                        )}
                      <Select value={a.stage} onValueChange={(v) => setStage(a, v)}>
                        <SelectTrigger className="h-8 w-32 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {STAGES.map((s) => (
                            <SelectItem key={s} value={s} className="capitalize">
                              {s}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button variant="ghost" size="sm" onClick={() => remove(a)}>
                        ✕
                      </Button>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ))
      )}
    </div>
  );
}
