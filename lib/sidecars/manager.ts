import { execFile, spawn } from "child_process";
import fs from "fs";
import path from "path";
import { promisify } from "util";
import { getSetting, setSetting } from "@/lib/settings";
import {
  RingBuffer,
  SidecarProcess,
  checkReadinessWith,
  crashHint,
  deriveState,
  venvPythonPath,
  type CrashHint,
  type Readiness,
  type SidecarState,
} from "@/lib/sidecars/core";
import {
  awLogs,
  awStatus,
  startActivityWatch,
  stopActivityWatch,
  type AwStatus,
} from "@/lib/sidecars/aw-control";
import { SIDECARS, getSidecarDef, type SidecarDef } from "@/lib/sidecars/registry";

// Glue between the pure process/readiness logic (lib/sidecars/core.ts) and
// the real world: child_process, the on-disk venv + pip state, PID
// persistence across server restarts, the Set up runner, and the shutdown
// hook that keeps `npm run dev` from leaving orphaned python processes.
//
// In-memory handles live on globalThis — the same "one always-running
// process" assumption lib/cron.ts already makes (dev hot-reload re-evaluates
// modules, so a plain module-level Map would leak processes).

const execFileAsync = promisify(execFile);

const PIDS_KEY = "sidecar_pids"; // settings JSON: { [id]: { pid, startedAt } }
const HEALTH_TIMEOUT_MS = 1500;
const PIP_SHOW_TIMEOUT_MS = 15_000;
const READINESS_TTL_MS = 120_000;

const globalForSidecars = globalThis as unknown as {
  __jarvisSidecarProcs?: Map<string, SidecarProcess>;
  __jarvisSidecarLogs?: Map<string, RingBuffer>;
  __jarvisSidecarSetup?: Set<string>; // ids with a setup run in flight
  __jarvisSidecarReadiness?: Map<string, { at: number; readiness: Readiness; missing: string[] }>;
  __jarvisSidecarShutdownHooked?: boolean;
  __jarvisSidecarReconciled?: boolean;
};

function procs(): Map<string, SidecarProcess> {
  if (!globalForSidecars.__jarvisSidecarProcs) {
    globalForSidecars.__jarvisSidecarProcs = new Map();
  }
  return globalForSidecars.__jarvisSidecarProcs;
}

// One log buffer per sidecar, OUTLIVING individual processes: setup runs and
// server runs write to the same stream so the "logs" panel tells one story.
function logsFor(id: string): RingBuffer {
  if (!globalForSidecars.__jarvisSidecarLogs) {
    globalForSidecars.__jarvisSidecarLogs = new Map();
  }
  let buf = globalForSidecars.__jarvisSidecarLogs.get(id);
  if (!buf) {
    buf = new RingBuffer(200);
    globalForSidecars.__jarvisSidecarLogs.set(id, buf);
  }
  return buf;
}

function setupsInFlight(): Set<string> {
  if (!globalForSidecars.__jarvisSidecarSetup) {
    globalForSidecars.__jarvisSidecarSetup = new Set();
  }
  return globalForSidecars.__jarvisSidecarSetup;
}

function newProc(id: string): SidecarProcess {
  return new SidecarProcess({
    spawnImpl: (cmd, args, opts) =>
      // No shell: the venv's python binary is invoked directly.
      spawn(cmd, args, { cwd: opts.cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] }),
    killPid: (pid, signal) => process.kill(pid, signal),
    logs: logsFor(id),
  });
}

export function venvPython(def: SidecarDef): string {
  const venvDir = path.join(process.cwd(), def.dir, def.venvDir);
  return venvPythonPath(venvDir, process.platform);
}

// ---- readiness (not-set-up / incomplete / ready) ------------------------------

function readinessCache() {
  if (!globalForSidecars.__jarvisSidecarReadiness) {
    globalForSidecars.__jarvisSidecarReadiness = new Map();
  }
  return globalForSidecars.__jarvisSidecarReadiness;
}

export function invalidateReadiness(id: string): void {
  readinessCache().delete(id);
}

// Asks the venv's own pip which requirements are missing. Cached ~2 min
// (spawning python on every 30s status poll would be wasteful); setup
// completion and missing-dep crashes invalidate the cache.
export async function checkReadiness(
  def: SidecarDef,
  fresh = false
): Promise<{ readiness: Readiness; missing: string[] }> {
  const cached = readinessCache().get(def.id);
  if (!fresh && cached && Date.now() - cached.at < READINESS_TTL_MS) return cached;

  const python = venvPython(def);
  const reqPath = path.join(process.cwd(), def.dir, "requirements.txt");
  let requirementsText: string | null = null;
  try {
    requirementsText = fs.readFileSync(reqPath, "utf8");
  } catch {
    requirementsText = null;
  }
  const result = await checkReadinessWith({
    venvPythonExists: fs.existsSync(python),
    requirementsText,
    runPipShow: async (packages) => {
      try {
        const { stdout, stderr } = await execFileAsync(
          python,
          ["-m", "pip", "show", "--quiet", ...packages],
          { timeout: PIP_SHOW_TIMEOUT_MS }
        );
        return { ok: true, output: `${stdout}\n${stderr}` };
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string; message?: string };
        return { ok: false, output: `${e.stdout ?? ""}\n${e.stderr ?? ""}\n${e.message ?? ""}` };
      }
    },
  });
  const entry = { at: Date.now(), ...result };
  readinessCache().set(def.id, entry);
  return entry;
}

// ---- Set up (venv create + pip install), streaming to the log panel -----------
// Scope revision from the original "no auto-setup" decision, on purpose:
// the operation is confined to sidecars/<name>/.venv, idempotent (pip
// no-ops satisfied packages), and its output streams to the same log panel
// as Start/Stop — so a failure is visible, not silent. We still never touch
// system Python beyond invoking it to create the venv.

function systemPythonCandidates(): string[] {
  return process.platform === "win32" ? ["py", "python"] : ["python3", "python"];
}

function pythonInstallHint(): string {
  switch (process.platform) {
    case "darwin":
      return "Install Python 3: brew install python3 (or https://python.org/downloads)";
    case "win32":
      return "Install Python 3: winget install Python.Python.3.13 (or https://python.org/downloads)";
    default:
      return "Install Python 3: sudo apt install python3 python3-venv (or your distro's equivalent)";
  }
}

async function resolveSystemPython(): Promise<string | null> {
  for (const cmd of systemPythonCandidates()) {
    try {
      await execFileAsync(cmd, ["--version"], { timeout: 5000 });
      return cmd;
    } catch {
      /* try next */
    }
  }
  return null;
}

// Run one setup step, streaming stdout/stderr into the sidecar's log buffer.
function runStep(cmd: string, args: string[], cwd: string, logs: RingBuffer): Promise<number | null> {
  return new Promise((resolve) => {
    logs.push(`[setup] $ ${cmd} ${args.join(" ")}`);
    let child;
    try {
      child = spawn(cmd, args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      logs.push(`[setup] failed to launch: ${err instanceof Error ? err.message : "unknown"}`);
      resolve(null);
      return;
    }
    child.stdout?.on("data", (c) => logs.pushChunk(c.toString()));
    child.stderr?.on("data", (c) => logs.pushChunk(c.toString()));
    child.once("error", (err) => {
      logs.push(`[setup] error: ${err.message}`);
      resolve(null);
    });
    child.once("exit", (code) => resolve(code));
  });
}

// Fire-and-forget from the route's perspective: the UI polls /api/sidecars
// (state "setting-up") and the logs panel while this runs.
export function setupSidecar(id: string): { ok: boolean; error?: string } {
  const def = getSidecarDef(id);
  if (!def) return { ok: false, error: `unknown sidecar "${id}"` };
  if (setupsInFlight().has(id)) return { ok: false, error: "setup already running" };
  const proc = procs().get(id);
  if (proc?.isAlive()) return { ok: false, error: "stop it before running setup" };

  setupsInFlight().add(id);
  void runSetup(def).finally(() => setupsInFlight().delete(id));
  return { ok: true };
}

async function runSetup(def: SidecarDef): Promise<void> {
  const logs = logsFor(def.id);
  const cwd = path.join(process.cwd(), def.dir);
  try {
    const before = await checkReadiness(def, true);
    if (before.readiness === "ready") {
      logs.push("[setup] already ready — nothing to do");
      return;
    }
    if (before.readiness === "not-set-up") {
      const python = await resolveSystemPython();
      if (!python) {
        logs.push("[setup] no system Python found (tried: " + systemPythonCandidates().join(", ") + ")");
        logs.push(`[setup] ${pythonInstallHint()}`);
        return;
      }
      const code = await runStep(python, ["-m", "venv", def.venvDir], cwd, logs);
      if (code !== 0) {
        logs.push(`[setup] venv creation failed (exit ${code ?? "?"}) — see output above`);
        return;
      }
    } else {
      logs.push("[setup] venv exists — reinstalling missing requirements");
    }
    // Idempotent: pip skips already-satisfied packages and fills the gaps.
    const pipCode = await runStep(
      venvPython(def),
      ["-m", "pip", "install", "--no-input", "-r", "requirements.txt"],
      cwd,
      logs
    );
    if (pipCode !== 0) {
      logs.push(`[setup] pip install failed (exit ${pipCode ?? "?"}) — see output above`);
      return;
    }
    invalidateReadiness(def.id);
    const after = await checkReadiness(def, true);
    logs.push(
      after.readiness === "ready"
        ? "[setup] done — ready to start"
        : `[setup] finished but still missing: ${after.missing.join(", ") || "unknown"} — see output above`
    );
  } catch (err) {
    logs.push(`[setup] failed: ${err instanceof Error ? err.message : "unknown error"}`);
  } finally {
    invalidateReadiness(def.id);
  }
}

// ---- PID persistence (restart resilience, best-effort) ----------------------

type PersistedPids = Record<string, { pid: number; startedAt: string }>;

function readPids(): PersistedPids {
  try {
    return JSON.parse(getSetting(PIDS_KEY) ?? "{}") as PersistedPids;
  } catch {
    return {};
  }
}

function writePids(pids: PersistedPids): void {
  setSetting(PIDS_KEY, JSON.stringify(pids));
}

function persistPid(id: string, pid: number, startedAt: string): void {
  const pids = readPids();
  pids[id] = { pid, startedAt };
  writePids(pids);
}

function clearPid(id: string): void {
  const pids = readPids();
  delete pids[id];
  writePids(pids);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// On the first touch after a server (re)start: for each persisted PID with
// no in-memory handle, re-attach if the process is still alive, otherwise
// forget it — never assume "server restarted" means "sidecar stopped".
function reconcileOnce(): void {
  if (globalForSidecars.__jarvisSidecarReconciled) return;
  globalForSidecars.__jarvisSidecarReconciled = true;
  const pids = readPids();
  for (const def of SIDECARS) {
    const saved = pids[def.id];
    if (!saved || procs().has(def.id)) continue;
    if (pidAlive(saved.pid)) {
      const proc = newProc(def.id);
      proc.adopt(saved.pid, saved.startedAt);
      procs().set(def.id, proc);
      console.log(`[sidecars] re-attached ${def.id} (pid ${saved.pid}) from previous run`);
    } else {
      clearPid(def.id);
    }
  }
}

// ---- shutdown: don't orphan children when the Next process dies -------------

function hookShutdownOnce(): void {
  if (globalForSidecars.__jarvisSidecarShutdownHooked) return;
  globalForSidecars.__jarvisSidecarShutdownHooked = true;
  const killAll = () => {
    // Bundled sidecars only — ActivityWatch is detached third-party and
    // deliberately survives us.
    for (const proc of procs().values()) proc.killNowSync();
  };
  // 'exit' fires on any normal termination; the signal listeners cover
  // Ctrl-C / kill without suppressing Next's own handlers (which do the
  // actual exiting). Default behavior today: sidecars die with the server —
  // a per-sidecar "keep running independently" toggle is a future option.
  process.once("exit", killAll);
  process.on("SIGINT", killAll);
  process.on("SIGTERM", killAll);
}

// ---- public API used by the /api/sidecars routes -----------------------------

export function startSidecar(id: string): { ok: boolean; error?: string } {
  reconcileOnce();
  hookShutdownOnce();
  const def = getSidecarDef(id);
  if (!def) return { ok: false, error: `unknown sidecar "${id}"` };
  if (setupsInFlight().has(id)) return { ok: false, error: "setup is running — wait for it to finish" };
  if (!fs.existsSync(venvPython(def))) {
    return { ok: false, error: "not set up yet — use Set up first" };
  }
  let proc = procs().get(id);
  if (proc?.isAlive()) return { ok: false, error: "already running" };
  proc = newProc(id);
  const result = proc.start(venvPython(def), ["-m", def.module], path.join(process.cwd(), def.dir));
  if (!result.ok) return result;
  procs().set(id, proc);
  const snap = proc.snapshot();
  if (snap.pid != null) persistPid(id, snap.pid, snap.startedAt ?? new Date().toISOString());
  return { ok: true };
}

export async function stopSidecar(id: string): Promise<{ ok: boolean; error?: string }> {
  reconcileOnce();
  const def = getSidecarDef(id);
  if (!def) return { ok: false, error: `unknown sidecar "${id}"` };
  const proc = procs().get(id);
  if (!proc || !proc.isAlive()) return { ok: false, error: "not running (or not started from here)" };
  await proc.stop();
  clearPid(id);
  return { ok: true };
}

export function sidecarLogs(id: string): string[] | null {
  reconcileOnce();
  if (id === "activitywatch") return awLogs().toArray();
  return logsFor(id).toArray();
}

export type SidecarStatus = {
  id: string;
  label: string;
  kind: "bundled" | "third-party";
  port?: number;
  state: SidecarState | "not-installed";
  readiness?: Readiness;
  missingPackages?: string[];
  settingUp?: boolean;
  hint?: string; // plain-language crash hint (raw logs stay in the panel)
  hintKind?: CrashHint["kind"];
  installUrl?: string;
  pid?: number;
  uptimeSec?: number;
  exitCode?: number | null;
};

function hintText(hint: CrashHint, port: number): string {
  return hint.kind === "missing-dep"
    ? `Missing dependency: ${hint.pkg}. Try Set up again.`
    : `Port ${port} is already taken — something else may already be running here.`;
}

export async function sidecarStatuses(): Promise<SidecarStatus[]> {
  reconcileOnce();
  const bundled = await Promise.all(
    SIDECARS.map(async (def): Promise<SidecarStatus> => {
      const { readiness, missing } = await checkReadiness(def);
      const proc = procs().get(def.id);
      const snap = proc?.snapshot();
      let healthOk: boolean | null = null;
      if (readiness !== "not-set-up") {
        try {
          const res = await fetch(def.healthUrl(), {
            signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
          });
          healthOk = res.ok;
        } catch {
          healthOk = false;
        }
      }
      const state = deriveState(snap, proc?.wasStopRequested() ?? false, healthOk);
      let hint: CrashHint | null = null;
      if (state === "crashed") {
        hint = crashHint(logsFor(def.id).toArray());
        // A missing-dep crash means the readiness cache is stale — recheck
        // next poll so the card flips to "Set up".
        if (hint?.kind === "missing-dep") invalidateReadiness(def.id);
      }
      return {
        id: def.id,
        label: def.label,
        kind: "bundled",
        port: def.port,
        state,
        readiness,
        missingPackages: missing.length > 0 ? missing : undefined,
        settingUp: setupsInFlight().has(def.id) || undefined,
        hint: hint ? hintText(hint, def.port) : undefined,
        hintKind: hint?.kind,
        pid: snap?.phase === "running" ? snap.pid : undefined,
        uptimeSec:
          snap?.phase === "running" && snap.startedAt
            ? Math.max(0, Math.round((Date.now() - Date.parse(snap.startedAt)) / 1000))
            : undefined,
        exitCode: snap?.phase === "exited" ? snap.exitCode : undefined,
      };
    })
  );
  const aw: AwStatus = await awStatus();
  return [...bundled, aw];
}

export async function startById(id: string): Promise<{ ok: boolean; error?: string }> {
  if (id === "activitywatch") return startActivityWatch();
  return startSidecar(id);
}

export async function stopById(id: string): Promise<{ ok: boolean; error?: string }> {
  if (id === "activitywatch") return stopActivityWatch();
  return stopSidecar(id);
}
