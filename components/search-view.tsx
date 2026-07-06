"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

type Hit = { title: string; sub: string; href: string };
type Group = { source: string; hits: Hit[] };

export function SearchView() {
  const [query, setQuery] = useState("");
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [busy, setBusy] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    const q = query.trim();
    if (q.length < 2) {
      setGroups(null);
      return;
    }
    debounce.current = setTimeout(async () => {
      setBusy(true);
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
        const data = await res.json();
        if (res.ok) setGroups(data.groups);
      } finally {
        setBusy(false);
      }
    }, 250);
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, [query]);

  return (
    <div className="flex flex-col gap-6">
      <Input
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search tasks, notes, transactions, mail, people, reading…"
        className="h-11 text-base"
        aria-label="Global search"
      />

      {groups === null ? (
        <p className="text-sm text-muted-foreground">
          Type at least two characters — results come from every local source at once.
        </p>
      ) : groups.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No matches{busy ? "…" : ` for “${query.trim()}”.`}
        </p>
      ) : (
        groups.map((group) => (
          <Card key={group.source}>
            <CardHeader>
              <CardTitle>
                {group.source}{" "}
                <span className="text-sm font-normal text-muted-foreground">
                  ({group.hits.length})
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="flex flex-col divide-y">
                {group.hits.map((hit, i) => (
                  <li key={i} className="py-2 text-sm">
                    <Link href={hit.href} className="font-medium hover:underline">
                      {hit.title}
                    </Link>
                    <p className="text-xs text-muted-foreground">{hit.sub}</p>
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
