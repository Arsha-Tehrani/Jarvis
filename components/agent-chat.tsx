"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Mic, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { deriveVoiceIndicator, type VoiceIndicatorState } from "@/lib/sidecars/voice-indicator";

type PendingCall = { name: string; args: unknown; description: string };

type Entry =
  | { kind: "user"; text: string }
  | { kind: "agent"; text: string }
  // linkHref/linkLabel: e.g. pointing at /status's Set-up flow when the
  // voice sidecar needs setup — never just the raw terminal-command message.
  | { kind: "error"; text: string; linkHref?: string; linkLabel?: string }
  | { kind: "pending"; originalText: string; calls: PendingCall[]; resolved?: string };

type MicState = "idle" | "starting-sidecar" | "recording" | "transcribing";

const VOICE_POLL_MS = 10_000;
const VOICE_START_TIMEOUT_MS = 20_000;

export function AgentChat() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [mic, setMic] = useState<MicState>("idle");
  const [voiceState, setVoiceState] = useState<VoiceIndicatorState>("needs-setup");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const router = useRouter();

  // If the card unmounts mid-recording, release the mic.
  useEffect(() => {
    return () => {
      recorderRef.current?.stream.getTracks().forEach((t) => t.stop());
    };
  }, []);

  // Reuses the exact same /api/sidecars data the /status page's voice card
  // already shows — no second probe, no bespoke polling mechanism.
  async function refreshVoiceState(): Promise<VoiceIndicatorState> {
    try {
      const res = await fetch("/api/sidecars");
      const data = await res.json();
      const voice = (data.sidecars as Array<{ id: string }> | undefined)?.find(
        (s) => s.id === "voice-sidecar"
      );
      const next = deriveVoiceIndicator(voice as Parameters<typeof deriveVoiceIndicator>[0]);
      setVoiceState(next);
      return next;
    } catch {
      setVoiceState("needs-setup");
      return "needs-setup";
    }
  }

  useEffect(() => {
    void refreshVoiceState();
    const id = setInterval(() => void refreshVoiceState(), VOICE_POLL_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function pushError(text: string, link?: { href: string; label: string }) {
    setEntries((prev) => [
      ...prev,
      { kind: "error", text, linkHref: link?.href, linkLabel: link?.label },
    ]);
  }

  async function waitForVoiceReady(timeoutMs: number): Promise<VoiceIndicatorState> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const state = await refreshVoiceState();
      if (state !== "starting" && state !== "down") return state;
      if (Date.now() >= deadline) return state;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  // Record → /api/transcribe (voice sidecar) → the transcript goes through
  // send(), i.e. the exact same agent path as typing. Mic/sidecar problems
  // surface as chat errors, never crashes. If the sidecar is down but its
  // venv is ready, this auto-starts it (same action the /status card's
  // Start button uses) and proceeds once ready, rather than making the user
  // leave the chat to click Start themselves.
  async function toggleRecording() {
    if (mic === "recording") {
      recorderRef.current?.stop(); // onstop handles the rest
      return;
    }
    if (mic !== "idle" || busy) return;

    if (voiceState === "needs-setup") {
      pushError(
        "Voice sidecar isn't set up yet — Set up creates the venv and installs requirements right from the browser.",
        { href: "/status", label: "Go to Status → Set up" }
      );
      return;
    }

    if (voiceState === "down") {
      setMic("starting-sidecar");
      const startRes = await fetch("/api/sidecars/voice-sidecar/start", { method: "POST" }).catch(
        () => null
      );
      if (!startRes || !startRes.ok) {
        const body = await startRes?.json().catch(() => ({}));
        pushError(
          (body as { error?: string })?.error ??
            "Could not start the voice sidecar — check /status for details."
        );
        setMic("idle");
        return;
      }
      const finalState = await waitForVoiceReady(VOICE_START_TIMEOUT_MS);
      if (finalState !== "ready") {
        pushError(
          finalState === "needs-setup"
            ? "Voice sidecar needs setup."
            : "Voice sidecar didn't become ready in time — check its log panel for the reason.",
          { href: "/status", label: "Go to Status" }
        );
        setMic("idle");
        return;
      }
    }

    await startRecording();
  }

  async function startRecording() {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      pushError("Microphone unavailable — check the browser's mic permission for this site.");
      setMic("idle");
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
                  {entry.kind === "error" && entry.linkHref && (
                    <>
                      {" "}
                      <Link href={entry.linkHref} className="underline">
                        {entry.linkLabel ?? entry.linkHref}
                      </Link>
                    </>
                  )}
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
                : mic === "starting-sidecar"
                  ? "Starting voice service…"
                  : 'Try: "add a task to review my budget Friday"'
            }
            disabled={busy || mic !== "idle"}
          />
          <div className="flex flex-col items-center gap-0.5">
            <Button
              type="button"
              variant={mic === "recording" ? "destructive" : "outline"}
              size="icon"
              onClick={() => void toggleRecording()}
              disabled={busy || mic === "transcribing" || mic === "starting-sidecar"}
              aria-label={mic === "recording" ? "Stop recording" : "Record a voice message"}
              className={mic === "recording" ? "mic-btn animate-pulse" : "mic-btn"}
            >
              {mic === "recording" ? <Square className="size-4" /> : <Mic className="size-4" />}
            </Button>
            <VoiceIndicatorDot mic={mic} voiceState={voiceState} />
          </div>
          <Button type="submit" disabled={busy || mic !== "idle" || !input.trim()}>
            {busy || mic === "transcribing" ? "…" : "Send"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

// Small Ready/Starting/Down/Needs setup indicator next to the mic button,
// reflecting the voice sidecar's real state (Phase 5) — reuses
// deriveVoiceIndicator's four states rather than a separate UI-only enum.
function VoiceIndicatorDot({ mic, voiceState }: { mic: MicState; voiceState: VoiceIndicatorState }) {
  const effective = mic === "starting-sidecar" ? "starting" : voiceState;
  const config: Record<VoiceIndicatorState, { color: string; label: string }> = {
    ready: { color: "bg-emerald-500", label: "Ready" },
    starting: { color: "bg-amber-500 animate-pulse", label: "Starting…" },
    down: { color: "bg-muted-foreground", label: "Down" },
    "needs-setup": { color: "bg-destructive", label: "Needs setup" },
  };
  const { color, label } = config[effective];
  return (
    <span
      className="flex items-center gap-1 text-[10px] text-muted-foreground"
      title={`Voice sidecar: ${label}`}
    >
      <span className={`inline-block size-1.5 rounded-full ${color}`} />
      {label}
    </span>
  );
}
