// Pure state-derivation for the Ask Jarvis mic button's status indicator
// (Phase 5). Reuses the same /api/sidecars data the /status page's voice
// card already shows — no second probe, no new polling mechanism.

export type VoiceIndicatorState = "ready" | "starting" | "down" | "needs-setup";

export type VoiceSidecarStatusLike = {
  state: "stopped" | "starting" | "running" | "crashed" | "not-installed";
  readiness?: "not-set-up" | "incomplete" | "ready";
};

// undefined covers both "haven't fetched /api/sidecars yet" and "the voice
// sidecar isn't in the response at all" -- both read as needing setup rather
// than a false "ready", since we can't tell it's safe to record.
export function deriveVoiceIndicator(status: VoiceSidecarStatusLike | undefined): VoiceIndicatorState {
  if (!status) return "needs-setup";
  if (status.state === "not-installed") return "needs-setup";
  if (status.readiness && status.readiness !== "ready") return "needs-setup";
  if (status.state === "running") return "ready";
  if (status.state === "starting") return "starting";
  // "stopped" or "crashed" with a ready venv: safe to auto-start on mic click.
  return "down";
}
