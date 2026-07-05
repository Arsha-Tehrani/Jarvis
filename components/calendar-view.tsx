"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type CalEvent = {
  google_event_id: string;
  title: string;
  start: string;
  end: string;
  updated_at: string;
};

const CALLBACK_MESSAGES: Record<string, string> = {
  connected: "Google Calendar connected.",
  denied: "Google sign-in was cancelled.",
  state_mismatch: "Sign-in state didn't match (try connecting again).",
  exchange_failed: "Token exchange failed — check the OAuth client credentials.",
};

function fmt(when: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(when)) return `${when} (all day)`;
  const d = new Date(when);
  if (Number.isNaN(d.getTime())) return when;
  return d.toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function CalendarView() {
  const params = useSearchParams();
  const flag = params.get("google");
  const [configured, setConfigured] = useState(true);
  const [connected, setConnected] = useState(false);
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/google");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load calendar");
      setConfigured(data.configured);
      setConnected(data.connected);
      setEvents(data.events);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load calendar");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(action: "connect" | "poll" | "disconnect") {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/google", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? `${action} failed`);
        return;
      }
      if (action === "connect" && data.authUrl) {
        window.location.href = data.authUrl;
        return;
      }
      await load();
    } catch {
      setError("Could not reach the API.");
    } finally {
      setBusy(false);
    }
  }

  const lastPolled = events[0]?.updated_at;

  return (
    <div className="flex flex-col gap-6">
      {flag && (
        <p className="text-sm text-muted-foreground">
          {CALLBACK_MESSAGES[flag] ?? flag}
        </p>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}

      {!configured ? (
        <Card>
          <CardContent className="pt-6 text-sm text-muted-foreground">
            Google OAuth is not configured. Set GOOGLE_CLIENT_ID and
            GOOGLE_CLIENT_SECRET in .env.local (OAuth client redirect:{" "}
            <code className="rounded bg-muted px-1">
              http://localhost:3000/api/google/callback
            </code>
            ), then connect here.
          </CardContent>
        </Card>
      ) : !connected ? (
        <Card>
          <CardContent className="flex flex-col gap-3 pt-6 text-sm">
            <p className="text-muted-foreground">
              Not connected. Google Calendar is the source of truth — Jarvis reads it
              back on open and hourly. Testing-mode tokens expire about weekly;
              reconnect here when that happens.
            </p>
            <div>
              <Button onClick={() => act("connect")} disabled={busy}>
                Connect Google Calendar
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between">
              Upcoming events
              <span className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => act("poll")} disabled={busy}>
                  Refresh
                </Button>
                <Button variant="ghost" size="sm" onClick={() => act("disconnect")} disabled={busy}>
                  Disconnect
                </Button>
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {events.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No upcoming events cached. Hit Refresh to poll Google.
              </p>
            ) : (
              <ul className="flex flex-col divide-y">
                {events.map((e) => (
                  <li key={e.google_event_id} className="flex items-baseline gap-3 py-2 text-sm">
                    <span className="w-48 shrink-0 text-muted-foreground">{fmt(e.start)}</span>
                    <span className="font-medium">{e.title}</span>
                  </li>
                ))}
              </ul>
            )}
            {lastPolled && (
              <p className="mt-3 text-xs text-muted-foreground">
                Last polled {fmt(lastPolled)} — polls on app open and hourly.
              </p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
