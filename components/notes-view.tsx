"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

type NoteSummary = { path: string; modified: string };
type NoteContent = { path: string; content: string };
type SearchHit = { path: string; snippet: string };

// Folder tree built from slash-separated note paths, rendered with native
// <details> elements — the browser keeps the open/closed state for us.
type TreeNode = {
  folders: Map<string, TreeNode>;
  files: NoteSummary[];
};

function buildTree(notes: NoteSummary[]): TreeNode {
  const root: TreeNode = { folders: new Map(), files: [] };
  for (const note of notes) {
    const segments = note.path.split("/");
    let node = root;
    for (const segment of segments.slice(0, -1)) {
      let child = node.folders.get(segment);
      if (!child) {
        child = { folders: new Map(), files: [] };
        node.folders.set(segment, child);
      }
      node = child;
    }
    node.files.push(note);
  }
  return root;
}

function TreeFolder({
  name,
  node,
  onOpen,
}: {
  name: string;
  node: TreeNode;
  onOpen: (path: string) => void;
}) {
  return (
    <details className="ml-0">
      <summary className="cursor-pointer select-none rounded px-1 py-0.5 text-sm font-medium hover:bg-accent/50">
        📁 {name}
      </summary>
      <div className="ml-4 border-l pl-2">
        <TreeChildren node={node} onOpen={onOpen} />
      </div>
    </details>
  );
}

function TreeChildren({
  node,
  onOpen,
}: {
  node: TreeNode;
  onOpen: (path: string) => void;
}) {
  return (
    <>
      {[...node.folders.entries()].map(([name, child]) => (
        <TreeFolder key={name} name={name} node={child} onOpen={onOpen} />
      ))}
      {node.files.map((f) => (
        <button
          key={f.path}
          className="block w-full truncate rounded px-1 py-0.5 text-left text-sm hover:bg-accent/50 hover:underline"
          onClick={() => onOpen(f.path)}
          title={f.path}
        >
          {f.path.split("/").pop()?.replace(/\.md$/i, "")}
        </button>
      ))}
    </>
  );
}

export function NotesView() {
  const [configured, setConfigured] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dailyNote, setDailyNote] = useState<NoteContent | null>(null);
  const [recent, setRecent] = useState<NoteSummary[]>([]);
  const [all, setAll] = useState<NoteSummary[]>([]);
  const [filter, setFilter] = useState("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchHit[] | null>(null);
  const [openNote, setOpenNote] = useState<NoteContent | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/notes");
      const data = await res.json();
      if (res.status === 409) {
        setConfigured(false);
        setError(data.error);
        return;
      }
      if (!res.ok) throw new Error(data.error ?? "Failed to read vault");
      setConfigured(true);
      setError(null);
      setDailyNote(data.dailyNote);
      setRecent(data.recent);
      setAll(data.all ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to read vault");
    }
  }, []);

  const requestedPath = useSearchParams().get("path");

  useEffect(() => {
    void load();
  }, [load]);

  // Deep link: /notes?path=… opens that note (used by the reading list).
  useEffect(() => {
    if (requestedPath) void open(requestedPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedPath]);

  async function search(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim()) {
      setResults(null);
      return;
    }
    const res = await fetch(`/api/notes?q=${encodeURIComponent(query.trim())}`);
    const data = await res.json();
    if (res.ok) setResults(data.results);
    else setError(data.error ?? "Search failed");
  }

  async function open(path: string) {
    const res = await fetch(`/api/notes?path=${encodeURIComponent(path)}`);
    const data = await res.json();
    if (res.ok) setOpenNote(data.note);
    else setError(data.error ?? "Could not open note");
  }

  if (!configured) {
    return (
      <Card>
        <CardContent className="pt-6 text-sm text-muted-foreground">
          {error ?? "Vault not configured."} The Notes tab lights up once
          OBSIDIAN_VAULT_PATH points at your vault.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {error && <p className="text-sm text-destructive">{error}</p>}

      <form onSubmit={search} className="flex gap-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search notes…"
        />
        <Button type="submit" variant="secondary">
          Search
        </Button>
      </form>

      {results && (
        <Card>
          <CardHeader>
            <CardTitle>Results ({results.length})</CardTitle>
          </CardHeader>
          <CardContent>
            {results.length === 0 ? (
              <p className="text-sm text-muted-foreground">No matches.</p>
            ) : (
              <ul className="flex flex-col gap-2 text-sm">
                {results.map((r) => (
                  <li key={r.path}>
                    <button
                      className="font-medium hover:underline"
                      onClick={() => open(r.path)}
                    >
                      {r.path}
                    </button>
                    <p className="text-muted-foreground">{r.snippet}</p>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}

      {openNote && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between">
              {openNote.path}
              <Button variant="ghost" size="sm" onClick={() => setOpenNote(null)}>
                ✕
              </Button>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap text-sm">
              {openNote.content}
            </pre>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-baseline justify-between">
            Vault explorer
            <span className="text-sm font-normal text-muted-foreground">
              {all.length} notes
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by name or folder…"
          />
          <div className="max-h-[28rem] overflow-y-auto rounded-md border p-2">
            {all.length === 0 ? (
              <p className="p-2 text-sm text-muted-foreground">
                No markdown files found in the vault.
              </p>
            ) : filter.trim() ? (
              // Filtering flattens the tree — matches shown with full paths.
              <ul className="flex flex-col">
                {all
                  .filter((n) => n.path.toLowerCase().includes(filter.trim().toLowerCase()))
                  .slice(0, 200)
                  .map((n) => (
                    <li key={n.path}>
                      <button
                        className="block w-full truncate rounded px-1 py-0.5 text-left text-sm hover:bg-accent/50 hover:underline"
                        onClick={() => open(n.path)}
                        title={n.path}
                      >
                        {n.path}
                      </button>
                    </li>
                  ))}
              </ul>
            ) : (
              <TreeChildren node={buildTree(all)} onOpen={(p) => void open(p)} />
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Today&apos;s daily note</CardTitle>
        </CardHeader>
        <CardContent>
          {dailyNote ? (
            <>
              <p className="mb-2 text-xs text-muted-foreground">{dailyNote.path}</p>
              <pre className="max-h-96 overflow-auto whitespace-pre-wrap text-sm">
                {dailyNote.content}
              </pre>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              No daily note for today yet (looked for {new Date().toISOString().slice(0, 10)}
              .md). Ask Jarvis to note something down and it will be created.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recently edited</CardTitle>
        </CardHeader>
        <CardContent>
          {recent.length === 0 ? (
            <p className="text-sm text-muted-foreground">No markdown files found.</p>
          ) : (
            <ul className="flex flex-col gap-1 text-sm">
              {recent.map((n) => (
                <li key={n.path} className="flex items-baseline gap-2">
                  <button className="hover:underline" onClick={() => open(n.path)}>
                    {n.path}
                  </button>
                  <span className="text-xs text-muted-foreground">
                    {n.modified.slice(0, 10)}
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
