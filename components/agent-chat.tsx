"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type PendingCall = { name: string; args: unknown; description: string };

type Entry =
  | { kind: "user"; text: string }
  | { kind: "agent"; text: string }
  | { kind: "error"; text: string }
  | { kind: "pending"; originalText: string; calls: PendingCall[]; resolved?: string };

export function AgentChat() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setEntries((prev) => [...prev, { kind: "user", text }]);
    setBusy(true);
    try {
      const res = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const data = await res.json();
      if (!res.ok) {
        setEntries((prev) => [
          ...prev,
          { kind: "error", text: data.error ?? "Agent request failed" },
        ]);
        return;
      }
      setEntries((prev) => [...prev, { kind: "agent", text: data.reply }]);
      if (data.pending?.length) {
        setEntries((prev) => [
          ...prev,
          { kind: "pending", originalText: text, calls: data.pending },
        ]);
      }
      router.refresh();
    } catch {
      setEntries((prev) => [
        ...prev,
        { kind: "error", text: "Could not reach the agent API." },
      ]);
    } finally {
      setBusy(false);
    }
  }

  async function confirmPending(index: number, approve: boolean) {
    const entry = entries[index];
    if (entry.kind !== "pending" || entry.resolved) return;
    if (!approve) {
      setEntries((prev) =>
        prev.map((e, i) =>
          i === index && e.kind === "pending" ? { ...e, resolved: "Cancelled." } : e
        )
      );
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          originalText: entry.originalText,
          confirmedCalls: entry.calls.map((c) => ({ name: c.name, args: c.args })),
        }),
      });
      const data = await res.json();
      const resolved = res.ok ? data.reply : (data.error ?? "Confirmation failed");
      setEntries((prev) =>
        prev.map((e, i) =>
          i === index && e.kind === "pending" ? { ...e, resolved } : e
        )
      );
      router.refresh();
    } catch {
      setEntries((prev) =>
        prev.map((e, i) =>
          i === index && e.kind === "pending"
            ? { ...e, resolved: "Could not reach the agent API." }
            : e
        )
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Ask Jarvis</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {entries.length > 0 && (
          <div className="flex max-h-80 flex-col gap-2 overflow-y-auto text-sm">
            {entries.map((entry, i) => {
              if (entry.kind === "pending") {
                return (
                  <div key={i} className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3">
                    <p className="font-medium">Needs confirmation:</p>
                    <ul className="mt-1 list-disc pl-5">
                      {entry.calls.map((c, j) => (
                        <li key={j}>
                          <code>{c.name}</code>{" "}
                          <span className="text-muted-foreground">
                            {JSON.stringify(c.args)}
                          </span>
                        </li>
                      ))}
                    </ul>
                    {entry.resolved ? (
                      <p className="mt-2 whitespace-pre-wrap">{entry.resolved}</p>
                    ) : (
                      <div className="mt-2 flex gap-2">
                        <Button size="sm" onClick={() => confirmPending(i, true)} disabled={busy}>
                          Confirm
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => confirmPending(i, false)} disabled={busy}>
                          Cancel
                        </Button>
                      </div>
                    )}
                  </div>
                );
              }
              return (
                <p
                  key={i}
                  className={
                    entry.kind === "user"
                      ? "font-medium"
                      : entry.kind === "error"
                        ? "whitespace-pre-wrap text-destructive"
                        : "whitespace-pre-wrap text-muted-foreground"
                  }
                >
                  {entry.kind === "user" ? "You: " : entry.kind === "error" ? "Error: " : "Jarvis: "}
                  {entry.text}
                </p>
              );
            })}
          </div>
        )}
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder='Try: "add a task to review my budget Friday"'
            disabled={busy}
          />
          <Button type="submit" disabled={busy || !input.trim()}>
            {busy ? "…" : "Send"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
