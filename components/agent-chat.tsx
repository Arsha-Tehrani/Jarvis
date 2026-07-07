"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Mic, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type PendingCall = { name: string; args: unknown; description: string };

type Entry =
  | { kind: "user"; text: string }
  | { kind: "agent"; text: string }
  | { kind: "error"; text: string }
  | { kind: "pending"; originalText: string; calls: PendingCall[]; resolved?: string };

type MicState = "idle" | "recording" | "transcribing";

export function AgentChat() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [mic, setMic] = useState<MicState>("idle");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const router = useRouter();

  // If the card unmounts mid-recording, release the mic.
  useEffect(() => {
    return () => {
      recorderRef.current?.stream.getTracks().forEach((t) => t.stop());
    };
  }, []);

  function pushError(text: string) {
    setEntries((prev) => [...prev, { kind: "error", text }]);
  }

  // Record → /api/transcribe (voice sidecar) → the transcript goes through
  // send(), i.e. the exact same agent path as typing. Mic/sidecar problems
  // surface as chat errors, never crashes.
  async function toggleRecording() {
    if (mic === "recording") {
      recorderRef.current?.stop(); // onstop handles the rest
      return;
    }
    if (mic !== "idle" || busy) return;

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      pushError("Microphone unavailable — check the browser's mic permission for this site.");
      return;
    }
    const mimeType = ["audio/webm", "audio/mp4", ""].find(
      (t) => t === "" || MediaRecorder.isTypeSupported(t)
    );
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    recorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      recorderRef.current = null;
      void transcribe(new Blob(chunks, { type: recorder.mimeType || "audio/webm" }));
    };
    recorderRef.current = recorder;
    recorder.start();
    setMic("recording");
  }

  async function transcribe(blob: Blob) {
    setMic("transcribing");
    try {
      const form = new FormData();
      form.append("audio", blob, "clip.webm");
      const res = await fetch("/api/transcribe", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) {
        pushError(data.error ?? "Transcription failed");
        return;
      }
      if (!data.text) {
        pushError("Didn't catch that — the recording came back empty.");
        return;
      }
      // Same routing as typing: the agent tool-calls it into the right section.
      await send(data.text);
    } catch {
      pushError("Could not reach the transcription API.");
    } finally {
      setMic("idle");
    }
  }

  async function send(spoken?: string) {
    const text = (spoken ?? input).trim();
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
            placeholder={
              mic === "recording"
                ? "Listening… click ■ when done"
                : 'Try: "add a task to review my budget Friday"'
            }
            disabled={busy || mic !== "idle"}
          />
          <Button
            type="button"
            variant={mic === "recording" ? "destructive" : "outline"}
            size="icon"
            onClick={() => void toggleRecording()}
            disabled={busy || mic === "transcribing"}
            aria-label={mic === "recording" ? "Stop recording" : "Record a voice message"}
            className={mic === "recording" ? "animate-pulse" : undefined}
          >
            {mic === "recording" ? <Square className="size-4" /> : <Mic className="size-4" />}
          </Button>
          <Button type="submit" disabled={busy || mic !== "idle" || !input.trim()}>
            {busy || mic === "transcribing" ? "…" : "Send"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
