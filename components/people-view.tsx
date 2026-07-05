"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Person = {
  id: number;
  name: string;
  cadence_days: number | null;
  last_contacted: string | null;
  birthday: string | null;
  gift_ideas: string | null;
  notes: string | null;
  overdueDays: number | null;
  birthdayInDays: number | null;
};

export function PeopleView() {
  const [people, setPeople] = useState<Person[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [cadence, setCadence] = useState("");
  const [birthday, setBirthday] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/people");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load people");
      setPeople(data.people);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load people");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      const body: Record<string, unknown> = { name: name.trim() };
      if (cadence) body.cadence_days = Number(cadence);
      if (birthday.trim()) body.birthday = birthday.trim();
      const res = await fetch("/api/people", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "Failed to add");
      } else {
        setName("");
        setCadence("");
        setBirthday("");
        setError(null);
      }
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function contactedToday(p: Person) {
    setBusy(true);
    try {
      await fetch("/api/people", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "log_contact", name: p.name }),
      });
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function remove(p: Person) {
    if (!window.confirm(`Remove ${p.name}?`)) return;
    await fetch(`/api/people?id=${p.id}`, { method: "DELETE" });
    await load();
  }

  const overdue = people.filter((p) => p.overdueDays != null);
  const birthdays = people.filter((p) => p.birthdayInDays != null && p.birthdayInDays <= 7);

  return (
    <div className="flex flex-col gap-6">
      {error && <p className="text-sm text-destructive">{error}</p>}

      {(overdue.length > 0 || birthdays.length > 0) && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {overdue.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Overdue ({overdue.length})</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="flex flex-col gap-2 text-sm">
                  {overdue.map((p) => (
                    <li key={p.id} className="flex items-center gap-2">
                      <span className="font-medium">{p.name}</span>
                      <span className="text-muted-foreground">
                        {p.last_contacted
                          ? `last contact ${p.last_contacted}`
                          : "never contacted"}
                      </span>
                      <Button
                        size="sm"
                        variant="outline"
                        className="ml-auto"
                        onClick={() => contactedToday(p)}
                        disabled={busy}
                      >
                        Contacted today
                      </Button>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
          {birthdays.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Birthdays this week</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="flex flex-col gap-2 text-sm">
                  {birthdays.map((p) => (
                    <li key={p.id} className="flex items-baseline gap-2">
                      <span className="font-medium">{p.name}</span>
                      <span className="text-muted-foreground">
                        {p.birthdayInDays === 0
                          ? "today 🎂"
                          : `in ${p.birthdayInDays} day${p.birthdayInDays === 1 ? "" : "s"}`}
                      </span>
                      {p.gift_ideas && (
                        <span className="text-xs text-muted-foreground">
                          gifts: {p.gift_ideas}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-xs text-muted-foreground">
                  Tip: ask Jarvis to “set a reminder” to get a calendar ping.
                </p>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Add person</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={create} className="flex flex-wrap items-end gap-2">
            <div className="flex flex-col gap-1">
              <Label htmlFor="pp-name" className="text-xs">
                Name
              </Label>
              <Input
                id="pp-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-48"
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="pp-cadence" className="text-xs">
                Keep in touch every … days
              </Label>
              <Input
                id="pp-cadence"
                type="number"
                min={1}
                value={cadence}
                onChange={(e) => setCadence(e.target.value)}
                className="w-40"
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="pp-bday" className="text-xs">
                Birthday (MM-DD)
              </Label>
              <Input
                id="pp-bday"
                value={birthday}
                onChange={(e) => setBirthday(e.target.value)}
                placeholder="03-14"
                className="w-32"
              />
            </div>
            <Button type="submit" disabled={busy || !name.trim()}>
              Add
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Everyone ({people.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {people.length === 0 ? (
            <p className="text-sm text-muted-foreground">No people yet.</p>
          ) : (
            <ul className="flex flex-col divide-y">
              {people.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                  <span className="font-medium">{p.name}</span>
                  {p.overdueDays != null && <Badge variant="destructive">overdue</Badge>}
                  {p.birthdayInDays != null && p.birthdayInDays <= 7 && (
                    <Badge variant="secondary">🎂 soon</Badge>
                  )}
                  <span className="text-xs text-muted-foreground">
                    {p.cadence_days ? `every ${p.cadence_days}d` : "no cadence"}
                    {p.last_contacted && ` · last ${p.last_contacted}`}
                    {p.birthday && ` · bday ${p.birthday}`}
                  </span>
                  <span className="ml-auto flex gap-1">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => contactedToday(p)}
                      disabled={busy}
                    >
                      Contacted today
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => remove(p)}>
                      ✕
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
