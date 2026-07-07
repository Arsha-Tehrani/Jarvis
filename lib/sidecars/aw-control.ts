import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { probeActivityWatch } from "@/lib/activitywatch";
import { RingBuffer } from "@/lib/sidecars/core";
import {
  AW_INSTALL_URL,
  awStopCommands,
  detectActivityWatch,
  type AwDetection,
} from "@/lib/sidecars/aw-detect";

// Best-effort start/stop for ActivityWatch (third-party tray app). This is
// deliberately looser than the bundled-sidecar manager: we don't own the
// process (it detaches into its own tray lifecycle), can't capture its
// output, and can't guarantee a quit lands — a failed stop reports
// "couldn't confirm it stopped", never a hard error. The health probe
// (lib/activitywatch.ts, :5600) is the only truth about whether it's up.

export type AwState = "not-installed" | "stopped" | "starting" | "running";

export type AwStatus = {
  id: "activitywatch";
  label: "ActivityWatch";
  kind: "third-party";
  state: AwState;
  installUrl: string;
};

const STARTING_GRACE_MS = 20_000; // launched but health not up yet → "starting"

const globalForAw = globalThis as unknown as {
  __jarvisAwLaunchedAt?: number;
  __jarvisAwLogs?: RingBuffer;
};

export function awLogs(): RingBuffer {
  if (!globalForAw.__jarvisAwLogs) globalForAw.__jarvisAwLogs = new RingBuffer(200);
  return globalForAw.__jarvisAwLogs;
}

function onPath(binary: string): boolean {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  return dirs.some((dir) => {
    try {
      return fs.existsSync(path.join(dir, binary));
    } catch {
      return false;
    }
  });
}

export function detect(): AwDetection {
  return detectActivityWatch(process.platform, {
    exists: (p) => fs.existsSync(p),
    homeDir: os.homedir(),
    localAppData: process.env.LOCALAPPDATA,
    onPath,
  });
}

export async function awStatus(): Promise<AwStatus> {
  const detection = detect();
  const base = {
    id: "activitywatch" as const,
    label: "ActivityWatch" as const,
    kind: "third-party" as const,
    installUrl: AW_INSTALL_URL,
  };
  if (!detection.installed) return { ...base, state: "not-installed" };
  if (await probeActivityWatch()) return { ...base, state: "running" };
  const launchedAt = globalForAw.__jarvisAwLaunchedAt;
  if (launchedAt && Date.now() - launchedAt < STARTING_GRACE_MS) {
    return { ...base, state: "starting" };
  }
  return { ...base, state: "stopped" };
}

export async function startActivityWatch(): Promise<{ ok: boolean; error?: string }> {
  const detection = detect();
  if (!detection.installed) {
    return { ok: false, error: `ActivityWatch is not installed — get it from ${AW_INSTALL_URL}` };
  }
  if (await probeActivityWatch()) return { ok: false, error: "already running" };
  const { cmd, args } = detection.start;
  try {
    // Detached on purpose: it's a tray app with its own lifecycle, not a
    // child we manage — the server shutdown hook must NOT kill it.
    const child = spawn(cmd, args, { detached: true, stdio: "ignore", shell: false });
    child.unref();
    globalForAw.__jarvisAwLaunchedAt = Date.now();
    awLogs().push(`[jarvis] launched ActivityWatch: ${cmd} ${args.join(" ")}`.trim());
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : "launch failed";
    awLogs().push(`[jarvis] launch failed: ${message}`);
    return { ok: false, error: message };
  }
}

function runQuiet(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { stdio: "ignore", shell: false });
      child.once("error", () => resolve());
      child.once("exit", () => resolve());
    } catch {
      resolve();
    }
  });
}

export async function stopActivityWatch(): Promise<{ ok: boolean; error?: string }> {
  if (!(await probeActivityWatch())) return { ok: false, error: "not running" };
  for (const { cmd, args } of awStopCommands(process.platform)) {
    awLogs().push(`[jarvis] quit attempt: ${cmd} ${args.join(" ")}`);
    await runQuiet(cmd, args);
    // Give the tray app a moment to shut its server down, then verify.
    await new Promise((r) => setTimeout(r, 1500));
    if (!(await probeActivityWatch())) {
      globalForAw.__jarvisAwLaunchedAt = undefined;
      awLogs().push("[jarvis] confirmed stopped");
      return { ok: true };
    }
  }
  // Third-party lifecycle: report honestly instead of pretending.
  awLogs().push("[jarvis] still responding after quit attempts");
  return { ok: false, error: "couldn't confirm it stopped — it may still be running (quit it from the tray)" };
}
