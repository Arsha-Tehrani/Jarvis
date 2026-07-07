// Pure pieces of sidecar process management: python-path resolution, the
// bounded log buffer, and the process state machine. No child_process /
// fs / db imports — spawn and kill are injected so `node --test` drives
// the whole lifecycle with fakes (never a real python in CI). The glue
// that binds real spawn/fs lives in lib/sidecars/manager.ts.

// The venv's python binary is called directly with args — never through an
// activation script (shell-dependent, fragile). Layout differs per OS:
//   win32               <venv>\Scripts\python.exe
//   darwin/linux/...    <venv>/bin/python
// `platform` is a parameter (not process.platform) purely for testability;
// the caller passes the real value, checked server-side at request time.
export function venvPythonPath(venvDir: string, platform: NodeJS.Platform): string {
  return platform === "win32"
    ? `${venvDir}\\Scripts\\python.exe`
    : `${venvDir}/bin/python`;
}

// Last-N-lines log buffer per sidecar (the "read the terminal" replacement).
export class RingBuffer {
  private lines: string[] = [];
  private readonly cap: number;

  // (No TS parameter properties anywhere in lib — node's strip-only TS
  // loader, which runs the tests, doesn't support them.)
  constructor(cap = 200) {
    this.cap = cap;
  }

  push(line: string): void {
    this.lines.push(line);
    if (this.lines.length > this.cap) this.lines.splice(0, this.lines.length - this.cap);
  }

  pushChunk(chunk: string): void {
    for (const line of chunk.split(/\r?\n/)) {
      if (line.trim() !== "") this.push(line);
    }
  }

  toArray(): string[] {
    return [...this.lines];
  }
}

// ---- readiness: not-set-up / incomplete / ready ------------------------------
// "venv folder exists" is not "ready" — a venv with no packages installed
// crashes on import. Readiness is decided by asking the venv's own pip
// which top-level requirements are missing.

export type Readiness = "not-set-up" | "incomplete" | "ready";

// Top-level distribution names from a requirements.txt: strip comments,
// blank lines, option lines (-r/--foo), extras ([standard]) and version
// specifiers. pip-show works on distribution names, so no import-name
// guessing is needed.
export function parseRequirements(text: string): string[] {
  const names: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith("-")) continue;
    const match = line.match(/^[A-Za-z0-9][A-Za-z0-9._-]*/);
    if (match) names.push(match[0]);
  }
  return names;
}

// `pip show a b c` prints "WARNING: Package(s) not found: b, c" (stderr) and
// exits 1 when anything is missing — parse the names back out. pip colors
// its warnings, so ANSI escape sequences are stripped first (they were
// observed leaking into parsed names: "fastapi\u001b[0m").
export function parseMissingPackages(pipOutput: string): string[] {
  // eslint-disable-next-line no-control-regex
  const clean = pipOutput.replace(/\u001b?\[[0-9;]*m/g, "");
  const match = clean.match(/Package\(s\) not found:\s*(.+)/);
  if (!match) return [];
  return match[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Readiness decision with the environment injected (fs and pip execution
// live in the manager / doctor; tests pass fakes).
export async function checkReadinessWith(deps: {
  venvPythonExists: boolean;
  requirementsText: string | null;
  // Runs `<venv python> -m pip show --quiet <packages>`; ok = exit code 0.
  runPipShow: (packages: string[]) => Promise<{ ok: boolean; output: string }>;
}): Promise<{ readiness: Readiness; missing: string[] }> {
  if (!deps.venvPythonExists) return { readiness: "not-set-up", missing: [] };
  const packages = deps.requirementsText ? parseRequirements(deps.requirementsText) : [];
  if (packages.length === 0) return { readiness: "ready", missing: [] };
  const result = await deps.runPipShow(packages);
  // Don't trust pip's exit code: some pip versions exit 0 while still
  // printing "Package(s) not found: …" to stderr. The warning text is the
  // truth; the exit code only matters when pip itself is broken.
  const missing = parseMissingPackages(result.output);
  if (missing.length > 0) return { readiness: "incomplete", missing };
  if (!result.ok) return { readiness: "incomplete", missing: [] }; // pip unusable → not safe to Start
  return { readiness: "ready", missing: [] };
}

// ---- crash hints ---------------------------------------------------------------
// A couple of KNOWN-common failure patterns get a one-line plain-language
// hint above the raw log. Anything else: no synthetic hint — the raw log
// stays the source of truth. Deliberately not clever beyond these two.

export type CrashHint =
  | { kind: "missing-dep"; pkg: string }
  | { kind: "port-in-use" };

export function crashHint(logLines: string[]): CrashHint | null {
  // Scan newest-first: the last error is the one that killed it.
  for (let i = logLines.length - 1; i >= 0; i--) {
    const line = logLines[i];
    const missing = line.match(/ModuleNotFoundError: No module named '([^']+)'/);
    if (missing) return { kind: "missing-dep", pkg: missing[1] };
    if (/address already in use|EADDRINUSE|error while attempting to bind|WinError 10048/i.test(line)) {
      return { kind: "port-in-use" };
    }
  }
  return null;
}

// The externally-visible process state reported by GET /api/sidecars.
// (Setup readiness is reported separately — a sidecar can be "crashed" AND
// "incomplete" at once, e.g. after a missing-dependency crash.)
export type SidecarState = "stopped" | "starting" | "running" | "crashed";

export type ProcSnapshot = {
  phase: "idle" | "running" | "exited";
  pid?: number;
  startedAt?: string; // ISO
  exitCode?: number | null;
  adopted: boolean; // re-attached by PID after a server restart (no logs)
};

// Minimal structural slice of node's ChildProcess.
export type ChildLike = {
  pid?: number;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "exit", cb: (code: number | null, signal: string | null) => void): unknown;
  stdout?: { on(event: "data", cb: (chunk: { toString(): string }) => void): unknown } | null;
  stderr?: { on(event: "data", cb: (chunk: { toString(): string }) => void): unknown } | null;
};

export type SpawnImpl = (cmd: string, args: string[], opts: { cwd: string }) => ChildLike;

// One managed process. Lifecycle: idle → running → exited; a stop() request
// is remembered so a SIGTERM'd exit reads as "stopped", not "crashed".
export type SidecarProcessDeps = {
  spawnImpl: SpawnImpl;
  killPid: (pid: number, signal: NodeJS.Signals) => void;
  killTimeoutMs?: number; // SIGTERM → this long → SIGKILL
  now?: () => Date;
  // Shared per-sidecar buffer: setup runs and server runs write to the same
  // log stream, so "logs" shows one continuous story. Defaults to its own.
  logs?: RingBuffer;
};

export class SidecarProcess {
  readonly logs: RingBuffer;
  private child?: ChildLike;
  private adoptedPid?: number;
  private startedAt?: string;
  private exited = false;
  private exitCode: number | null = null;
  private stopRequested = false;
  private readonly deps: SidecarProcessDeps;

  constructor(deps: SidecarProcessDeps) {
    this.deps = deps;
    this.logs = deps.logs ?? new RingBuffer(200);
  }

  private nowIso(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }

  start(cmd: string, args: string[], cwd: string): { ok: true } | { ok: false; error: string } {
    if (this.isAlive()) return { ok: false, error: "already running" };
    let child: ChildLike;
    try {
      child = this.deps.spawnImpl(cmd, args, { cwd });
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "spawn failed" };
    }
    if (child.pid == null) return { ok: false, error: "spawn returned no pid" };
    this.child = child;
    this.adoptedPid = undefined;
    this.startedAt = this.nowIso();
    this.exited = false;
    this.exitCode = null;
    this.stopRequested = false;
    this.logs.push(`[jarvis] started ${cmd} ${args.join(" ")} (pid ${child.pid})`);
    child.stdout?.on("data", (c) => this.logs.pushChunk(c.toString()));
    child.stderr?.on("data", (c) => this.logs.pushChunk(c.toString()));
    child.once("exit", (code, signal) => {
      this.exited = true;
      this.exitCode = code;
      this.logs.push(`[jarvis] exited (code ${code ?? "null"}${signal ? `, signal ${signal}` : ""})`);
    });
    return { ok: true };
  }

  // Re-attach to a PID a previous server instance started (best-effort: we
  // can stop it, but its output isn't captured — the handle died with the
  // old process).
  adopt(pid: number, startedAt: string): void {
    this.adoptedPid = pid;
    this.startedAt = startedAt;
    this.exited = false;
    this.exitCode = null;
    this.stopRequested = false;
    this.logs.push(`[jarvis] re-attached to pid ${pid} from a previous server run — logs unavailable`);
  }

  isAlive(): boolean {
    if (this.child) return !this.exited;
    if (this.adoptedPid != null && !this.exited) {
      try {
        this.deps.killPid(this.adoptedPid, 0 as unknown as NodeJS.Signals); // liveness probe
        return true;
      } catch {
        this.exited = true;
        return false;
      }
    }
    return false;
  }

  // SIGTERM, wait briefly, SIGKILL if it hasn't exited.
  async stop(): Promise<void> {
    if (!this.isAlive()) return;
    this.stopRequested = true;
    const timeout = this.deps.killTimeoutMs ?? 3000;
    if (this.child) {
      const child = this.child;
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          if (!this.exited) child.kill("SIGKILL");
          resolve();
        }, timeout);
        timer.unref?.();
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    } else if (this.adoptedPid != null) {
      try {
        this.deps.killPid(this.adoptedPid, "SIGTERM");
        await new Promise((r) => setTimeout(r, timeout).unref?.());
        if (this.isAlive()) this.deps.killPid(this.adoptedPid, "SIGKILL");
      } catch {
        /* already gone */
      }
      this.exited = true;
    }
  }

  killNowSync(): void {
    // Shutdown-handler path: no waiting allowed on 'exit'.
    try {
      if (this.child && !this.exited) this.child.kill("SIGTERM");
      else if (this.adoptedPid != null && !this.exited) this.deps.killPid(this.adoptedPid, "SIGTERM");
    } catch {
      /* best effort */
    }
  }

  snapshot(): ProcSnapshot {
    const started = this.child != null || this.adoptedPid != null;
    return {
      phase: !started ? "idle" : this.isAlive() ? "running" : "exited",
      pid: this.child?.pid ?? this.adoptedPid,
      startedAt: this.startedAt,
      exitCode: this.exitCode,
      adopted: this.adoptedPid != null,
    };
  }

  wasStopRequested(): boolean {
    return this.stopRequested;
  }
}

// Map (process phase, health probe) → the reported state. Readiness is a
// separate axis (see checkReadinessWith) so a crash can carry its exit info
// even while the fix is "Set up", not "Start".
export function deriveState(
  snap: ProcSnapshot | undefined,
  stopRequested: boolean,
  healthOk: boolean | null
): SidecarState {
  if (!snap || snap.phase === "idle") {
    // Not started by us — but it may be running externally (user's terminal).
    return healthOk ? "running" : "stopped";
  }
  if (snap.phase === "running") return healthOk ? "running" : "starting";
  // exited
  if (stopRequested || snap.exitCode === 0) return "stopped";
  return "crashed";
}
