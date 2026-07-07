// The two in-repo Python sidecars Jarvis can start/stop from /status.
//
// Deliberately NOT here: ActivityWatch. It's a third-party tray app the
// user installs and runs themselves — Jarvis detects it (status page) but
// never spawns or kills it. Also deliberately narrow: this registry is for
// starting an ALREADY-SET-UP sidecar; venv creation stays a one-time
// manual command (npm run doctor prints it when the venv is missing).

export type SidecarDef = {
  id: "textbook-rag" | "macro-sidecar"; // same ids as the status checks
  label: string;
  dir: string; // working directory, relative to the repo root
  venvDir: string; // relative to dir
  module: string; // python -m <module>
  port: number;
  healthUrl: () => string; // the same URL the status probe uses
};

export const SIDECARS: SidecarDef[] = [
  {
    id: "textbook-rag",
    label: "Textbook RAG sidecar",
    dir: "sidecars/textbook-rag",
    venvDir: ".venv",
    module: "rag.server",
    port: 8016,
    healthUrl: () => `${process.env.TEXTBOOK_RAG_URL ?? "http://localhost:8016"}/health`,
  },
  {
    id: "macro-sidecar",
    label: "Macro sidecar",
    dir: "sidecars/macro",
    venvDir: ".venv",
    module: "macro.server",
    port: 8017,
    healthUrl: () => `${process.env.MACRO_SIDECAR_URL ?? "http://localhost:8017"}/health`,
  },
];

export const SIDECAR_IDS = SIDECARS.map((s) => s.id) as [string, ...string[]];

export function getSidecarDef(id: string): SidecarDef | undefined {
  return SIDECARS.find((s) => s.id === id);
}
