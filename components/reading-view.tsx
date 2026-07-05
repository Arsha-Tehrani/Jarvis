"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
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

const KINDS = ["book", "article", "course", "paper", "video"] as const;
const STATUSES = ["queued", "reading", "done", "abandoned"] as const;

type Item = {
  id: number;
  kind: (typeof KINDS)[number];
  title: string;
  author: string | null;
  status: (typeof STATUSES)[number];
  link: string | null;
  notes: string | null;
  note_path: string | null;
  created_at: string;
};

export function ReadingView() {
  const [items, setItems] = useState<Item[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState("");
  const [author, setAuthor] = useState("");
  const [kind, setKind] = useState<(typeof KINDS)[number]>("book");
  const [notePath, setNotePath] = useState<Record<number, string>>({});

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/reading");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load");
      setItems(data.items);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    try {
      const body: Record<string, unknown> = { title: title.trim(), kind };
      if (author.trim()) body.author = author.trim();
      const res = await fetch("/api/reading", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "Failed to add");
      } else {
        setTitle("");
        setAuthor("");
        setError(null);
      }
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function patch(id: number, fields: Record<string, unknown>) {
    await fetch("/api/reading", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, ...fields }),
    });
    await load();
  }

  async function remove(item: Item) {
    if (!window.confirm(`Remove "${item.title}"?`)) return;
    await fetch(`/api/reading?id=${item.id}`, { method: "DELETE" });
    await load();
  }

  const grouped = STATUSES.map((status) => ({
    status,
    items: items.filter((i) => i.status === status),
  })).filter((g) => g.items.length > 0);

  return (
    <div className="flex flex-col gap-6">
      {error && <p className="text-sm text-destructive">{error}</p>}

      <Card>
        <CardHeader>
          <CardTitle>Add to list</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={create} className="flex flex-wrap items-end gap-2">
            <div className="flex flex-col gap-1">
              <Label htmlFor="rd-title" className="text-xs">
                Title
              </Label>
              <Input
                id="rd-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="w-64"
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="rd-author" className="text-xs">
                Author (optional)
              </Label>
              <Input
                id="rd-author"
                value={author}
                onChange={(e) => setAuthor(e.target.value)}
                className="w-44"
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-xs">Kind</Label>
              <Select value={kind} onValueChange={(v) => setKind(v as typeof kind)}>
                <SelectTrigger className="w-28 capitalize">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {KINDS.map((k) => (
                    <SelectItem key={k} value={k} className="capitalize">
                      {k}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button type="submit" disabled={busy || !title.trim()}>
              Add
            </Button>
          </form>
        </CardContent>
      </Card>

      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing on the list yet.</p>
      ) : (
        grouped.map((group) => (
          <Card key={group.status}>
            <CardHeader>
              <CardTitle className="capitalize">
                {group.status}{" "}
                <span className="text-sm font-normal text-muted-foreground">
                  ({group.items.length})
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="flex flex-col divide-y">
                {group.items.map((item) => (
                  <li key={item.id} className="flex flex-col gap-2 py-3 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline" className="capitalize">
                        {item.kind}
                      </Badge>
                      <span className="font-medium">
                        {item.link ? (
                          <a
                            href={item.link}
                            target="_blank"
                            rel="noreferrer"
                            className="hover:underline"
                          >
                            {item.title}
                          </a>
                        ) : (
                          item.title
                        )}
                      </span>
                      {item.author && (
                        <span className="text-muted-foreground">{item.author}</span>
                      )}
                      <span className="ml-auto flex items-center gap-2">
                        <Select
                          value={item.status}
                          onValueChange={(v) => patch(item.id, { status: v })}
                        >
                          <SelectTrigger className="h-8 w-32 text-xs capitalize">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {STATUSES.map((s) => (
                              <SelectItem key={s} value={s} className="capitalize">
                                {s}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Button variant="ghost" size="sm" onClick={() => remove(item)}>
                          ✕
                        </Button>
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      {item.note_path ? (
                        <Link
                          href={`/notes?path=${encodeURIComponent(item.note_path)}`}
                          className="text-primary hover:underline"
                        >
                          notes: {item.note_path}
                        </Link>
                      ) : (
                        <form
                          className="flex items-center gap-1"
                          onSubmit={(e) => {
                            e.preventDefault();
                            const p = notePath[item.id]?.trim();
                            if (p) void patch(item.id, { note_path: p });
                          }}
                        >
                          <Input
                            value={notePath[item.id] ?? ""}
                            onChange={(e) =>
                              setNotePath((m) => ({ ...m, [item.id]: e.target.value }))
                            }
                            placeholder="Link Obsidian note path…"
                            className="h-7 w-56 text-xs"
                          />
                          <Button
                            type="submit"
                            variant="ghost"
                            size="sm"
                            disabled={!notePath[item.id]?.trim()}
                          >
                            Link
                          </Button>
                        </form>
                      )}
                    </div>
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
