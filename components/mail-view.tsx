"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type Account = { id: number; email: string; connected_at: string };

type Message = {
  account: string;
  gmail_id: string;
  sender: string;
  subject: string;
  snippet: string | null;
  received_at: string | null;
  importance: "important" | "can_wait" | "noise" | null;
  importance_reason: string | null;
  category: string | null;
  is_read: number;
  task_created: boolean;
};

type BodyState = { status: "loading" | "loaded" | "error"; text?: string; source?: string };

const PAGE_SIZE = 25;

const BUCKETS = [
  { key: "important", title: "Important" },
  { key: "can_wait", title: "Can wait" },
  { key: null, title: "Untriaged (needs the local model)" },
  { key: "noise", title: "Newsletter / noise" },
] as const;

const CALLBACK_MESSAGES: Record<string, string> = {
  connected: "Gmail account linked.",
  denied: "Google sign-in was cancelled.",
  state_mismatch: "Sign-in state didn't match (try connecting again).",
  exchange_failed: "Token exchange failed — check the OAuth client credentials.",
};

export function MailView() {
  const flag = useSearchParams().get("gmail");
  const [configured, setConfigured] = useState(true);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [bodies, setBodies] = useState<Record<string, BodyState>>({});

  const load = useCallback(async (at: number = 0) => {
    try {
      const res = await fetch(`/api/mail?limit=${PAGE_SIZE}&offset=${at}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load mail");
      setConfigured(data.configured);
      setAccounts(data.accounts);
      setMessages(data.messages);
      setTotal(data.total);
      setOffset(at);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load mail");
    }
  }, []);

  useEffect(() => {
    void load(0);
  }, [load]);

  async function act(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/mail", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Request failed");
        return;
      }
      if (body.action === "connect" && data.authUrl) {
        window.location.href = data.authUrl;
        return;
      }
      if (body.action === "draft" || body.action === "make_task") {
        setNotice(data.message);
      }
      if (body.action === "poll" && data.triageError) {
        setNotice(`Polled. Triage pending: ${data.triageError}`);
      }
      if (body.action === "load_older") {
        const pulled = Object.values(data.results ?? {})
          .filter((v): v is number => typeof v === "number")
          .reduce((a, b) => a + b, 0);
        setNotice(
          `Pulled ${pulled} older message(s) from Gmail${data.more ? " — more available" : " — inbox fully cached"}.`
        );
      }
      await load(offset);
    } catch {
      setError("Could not reach the API.");
    } finally {
      setBusy(false);
    }
  }

  // Expand a message: fetch its body once, cache it, render as plain text.
  async function toggleBody(m: Message) {
    const key = `${m.account}:${m.gmail_id}`;
    if (expanded === key) {
      setExpanded(null);
      return;
    }
    setExpanded(key);
    if (bodies[key]?.status === "loaded") return;
    setBodies((b) => ({ ...b, [key]: { status: "loading" } }));
    try {
      const res = await fetch("/api/mail", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "body", account: m.account, gmail_id: m.gmail_id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load body");
      setBodies((b) => ({
        ...b,
        [key]: { status: "loaded", text: data.body, source: data.bodySource },
      }));
    } catch (err) {
      setBodies((b) => ({
        ...b,
        [key]: {
          status: "error",
          text: err instanceof Error ? err.message : "Failed to load body",
        },
      }));
    }
  }

  const bucketed = BUCKETS.map((bucket) => ({
    ...bucket,
    items: messages.filter((m) => m.importance === bucket.key),
  }));

  const pageEnd = Math.min(offset + PAGE_SIZE, total);
  const onLastPage = offset + PAGE_SIZE >= total;

  return (
    <div className="flex flex-col gap-6">
      {flag && (
        <p className="text-sm text-muted-foreground">{CALLBACK_MESSAGES[flag] ?? flag}</p>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
      {notice && <p className="text-sm text-muted-foreground">{notice}</p>}

      <Card>
        <CardHeader>
          <CardTitle>Inboxes</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          {!configured && (
            <p className="text-muted-foreground">
              Google OAuth is not configured — set GOOGLE_CLIENT_ID and
              GOOGLE_CLIENT_SECRET in .env.local, and add{" "}
              <code className="rounded bg-muted px-1">
                http://localhost:3000/api/mail/callback
              </code>{" "}
              as a redirect URI. Note: gmail.readonly is a restricted scope (see
              HANDOFF.md).
            </p>
          )}
          {accounts.length > 0 && (
            <ul className="flex flex-col gap-1">
              {accounts.map((a) => (
                <li key={a.id} className="flex items-center gap-2">
                  <span className="font-medium">{a.email}</span>
                  <span className="text-xs text-muted-foreground">
                    linked {a.connected_at.slice(0, 10)}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="ml-auto"
                    onClick={() => {
                      if (window.confirm(`Unlink ${a.email} and drop its cached mail?`)) {
                        void act({ action: "disconnect", email: a.email });
                      }
                    }}
                  >
                    Unlink
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => act({ action: "connect" })} disabled={busy || !configured}>
              {accounts.length === 0 ? "Link a Gmail account" : "Link another account"}
            </Button>
            {accounts.length > 0 && (
              <Button variant="outline" onClick={() => act({ action: "poll" })} disabled={busy}>
                Poll now
              </Button>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            Read-only + drafts: Jarvis never sends, archives, or deletes mail. Polling
            runs on open and every 30 minutes.
          </p>
        </CardContent>
      </Card>

      {accounts.length > 0 &&
        bucketed.map(
          (bucket) =>
            bucket.items.length > 0 && (
              <Card key={bucket.title}>
                <CardHeader>
                  <CardTitle>
                    {bucket.title}{" "}
                    <span className="text-sm font-normal text-muted-foreground">
                      ({bucket.items.length})
                    </span>
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <ul className="flex flex-col divide-y">
                    {bucket.items.map((m) => {
                      const key = `${m.account}:${m.gmail_id}`;
                      const body = bodies[key];
                      const isOpen = expanded === key;
                      return (
                        <li key={key} className="flex flex-col gap-1 py-3 text-sm">
                          <div className="flex flex-wrap items-center gap-2">
                            {!m.is_read && (
                              <span
                                className="size-2 shrink-0 rounded-full bg-primary"
                                title="unread"
                              />
                            )}
                            <span className="font-medium">{m.sender}</span>
                            <Badge variant="outline">{m.account}</Badge>
                            {m.received_at && (
                              <span className="text-xs text-muted-foreground">
                                {m.received_at.slice(0, 10)}
                              </span>
                            )}
                            <span className="ml-auto flex gap-1">
                              {m.task_created ? (
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  disabled
                                  className="opacity-60"
                                  title="A task for this message already exists in Tasks"
                                >
                                  Task created ✓
                                </Button>
                              ) : (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() =>
                                    act({
                                      action: "make_task",
                                      account: m.account,
                                      gmail_id: m.gmail_id,
                                    })
                                  }
                                  disabled={busy}
                                  title="Create a local task from this message (writes only to Tasks)"
                                >
                                  Make task
                                </Button>
                              )}
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() =>
                                  act({ action: "draft", account: m.account, gmail_id: m.gmail_id })
                                }
                                disabled={busy}
                              >
                                Draft reply
                              </Button>
                            </span>
                          </div>
                          <button
                            type="button"
                            className="text-left hover:underline"
                            onClick={() => void toggleBody(m)}
                            aria-expanded={isOpen}
                          >
                            {m.subject}
                            <span className="ml-1 text-xs text-muted-foreground">
                              {isOpen ? "▲" : "▼"}
                            </span>
                          </button>
                          {m.importance_reason && (
                            <p className="text-xs text-muted-foreground">
                              {m.importance_reason}
                            </p>
                          )}
                          {isOpen && (
                            <div className="mt-1 rounded-md border bg-muted/30 p-3">
                              {!body || body.status === "loading" ? (
                                <p className="text-xs text-muted-foreground">Loading body…</p>
                              ) : body.status === "error" ? (
                                <p className="text-xs text-destructive">{body.text}</p>
                              ) : (
                                <>
                                  <pre className="max-h-96 overflow-auto whitespace-pre-wrap font-sans text-sm">
                                    {body.text}
                                  </pre>
                                  {body.source === "snippet" && (
                                    <p className="mt-2 text-xs text-muted-foreground">
                                      Only the snippet is available for this message.
                                    </p>
                                  )}
                                </>
                              )}
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </CardContent>
              </Card>
            )
        )}

      {accounts.length > 0 && total > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span>
            Showing {total === 0 ? 0 : offset + 1}–{pageEnd} of {total} cached
          </span>
          <span className="ml-auto flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => load(Math.max(0, offset - PAGE_SIZE))}
              disabled={busy || offset === 0}
            >
              ‹ Newer
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => load(offset + PAGE_SIZE)}
              disabled={busy || onLastPage}
            >
              Older ›
            </Button>
            {onLastPage && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => act({ action: "load_older" })}
                disabled={busy}
                title="Fetch the next batch of older messages from Gmail into the local cache"
              >
                Load older from Gmail
              </Button>
            )}
          </span>
        </div>
      )}
    </div>
  );
}
