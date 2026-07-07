import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RingBuffer,
  SidecarProcess,
  checkReadinessWith,
  crashHint,
  deriveState,
  parseMissingPackages,
  parseRequirements,
  venvPythonPath,
  type ChildLike,
} from "../lib/sidecars/core.ts";
import { awStopCommands, detectActivityWatch } from "../lib/sidecars/aw-detect.ts";

// No real python is ever spawned: spawn/kill are injected fakes.

// ---- OS → python path ---------------------------------------------------------

test("venv python resolves per-OS: Scripts\\python.exe on win32, bin/python elsewhere", () => {
  assert.equal(venvPythonPath("C:\\repo\\sidecars\\macro\\.venv", "win32"), "C:\\repo\\sidecars\\macro\\.venv\\Scripts\\python.exe");
  assert.equal(venvPythonPath("/repo/sidecars/macro/.venv", "darwin"), "/repo/sidecars/macro/.venv/bin/python");
  assert.equal(venvPythonPath("/repo/sidecars/macro/.venv", "linux"), "/repo/sidecars/macro/.venv/bin/python");
});

// ---- ring buffer ---------------------------------------------------------------

test("ring buffer keeps only the last N lines and splits chunks", () => {
  const buf = new RingBuffer(3);
  buf.pushChunk("one\ntwo\n");
  buf.pushChunk("three\nfour");
  assert.deepEqual(buf.toArray(), ["two", "three", "four"]);
});

// ---- fake child -----------------------------------------------------------------

type ExitCb = (code: number | null, signal: string | null) => void;

class FakeChild implements ChildLike {
  pid = 4242;
  signals: string[] = [];
  private exitCbs: ExitCb[] = [];
  stdout = { on: (_: "data", cb: (c: { toString(): string }) => void) => (this.out = cb) };
  stderr = { on: () => undefined };
  private out?: (c: { toString(): string }) => void;

  kill(signal?: NodeJS.Signals): boolean {
    this.signals.push(signal ?? "SIGTERM");
    return true;
  }
  once(_event: "exit", cb: ExitCb): void {
    this.exitCbs.push(cb);
  }
  emitExit(code: number | null, signal: string | null = null): void {
    for (const cb of this.exitCbs.splice(0)) cb(code, signal);
  }
  emitStdout(text: string): void {
    this.out?.(text);
  }
}

function managed(child: FakeChild, killTimeoutMs = 25) {
  return new SidecarProcess({
    spawnImpl: () => child,
    killPid: () => undefined,
    killTimeoutMs,
  });
}

// ---- state machine: stopped → starting → running → stopped/crashed --------------

test("start → running snapshot; health probe decides starting vs running", () => {
  const child = new FakeChild();
  const proc = managed(child);
  assert.deepEqual(deriveState(undefined, false, false), "stopped");

  const started = proc.start("/venv/bin/python", ["-m", "macro.server"], "/repo/sidecars/macro");
  assert.deepEqual(started, { ok: true });
  const snap = proc.snapshot();
  assert.equal(snap.phase, "running");
  assert.equal(snap.pid, 4242);
  // Process alive but health endpoint not answering yet → "starting".
  assert.equal(deriveState(snap, false, false), "starting");
  // Health confirms → "running".
  assert.equal(deriveState(snap, false, true), "running");
});

test("nonzero exit without a stop request reads as crashed, with the exit code kept", () => {
  const child = new FakeChild();
  const proc = managed(child);
  proc.start("/py", [], "/cwd");
  child.emitExit(1);
  const snap = proc.snapshot();
  assert.equal(snap.phase, "exited");
  assert.equal(snap.exitCode, 1);
  assert.equal(deriveState(snap, proc.wasStopRequested(), false), "crashed");
});

test("clean exit (code 0) reads as stopped", () => {
  const child = new FakeChild();
  const proc = managed(child);
  proc.start("/py", [], "/cwd");
  child.emitExit(0);
  assert.equal(deriveState(proc.snapshot(), proc.wasStopRequested(), false), "stopped");
});

test("stop() SIGTERMs; a signal-killed exit after a stop request reads as stopped, not crashed", async () => {
  const child = new FakeChild();
  const proc = managed(child);
  proc.start("/py", [], "/cwd");
  const stopping = proc.stop();
  child.emitExit(null, "SIGTERM"); // python exits on the TERM
  await stopping;
  assert.deepEqual(child.signals, ["SIGTERM"]);
  assert.equal(deriveState(proc.snapshot(), proc.wasStopRequested(), false), "stopped");
});

test("stop() escalates to SIGKILL when the child ignores SIGTERM", async () => {
  const child = new FakeChild();
  const proc = managed(child, 20); // short timeout for the test
  proc.start("/py", [], "/cwd");
  await proc.stop(); // child never emits exit → timeout path
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
});

test("a sidecar started externally (user's terminal) still reads as running via health", () => {
  // No snapshot (we never spawned it) but the health endpoint answers.
  assert.equal(deriveState(undefined, false, true), "running");
  assert.equal(deriveState({ phase: "idle", adopted: false }, false, true), "running");
});

test("stdout chunks land in the log buffer; double-start is refused", () => {
  const child = new FakeChild();
  const proc = managed(child);
  proc.start("/py", [], "/cwd");
  child.emitStdout("INFO: server listening on :8017\n");
  assert.ok(proc.logs.toArray().some((l) => l.includes("listening on :8017")));
  const again = proc.start("/py", [], "/cwd");
  assert.deepEqual(again, { ok: false, error: "already running" });
});

// ---- readiness: not-set-up / incomplete / ready --------------------------------

test("requirements parsing: names only — comments, options, pins, extras stripped", () => {
  const text = [
    "# Pinned at install time",
    "chromadb==1.5.9",
    "fastapi==0.139.0",
    "markitdown[pdf]==0.1.6",
    "uvicorn[standard]==0.50.0",
    "-r requirements-extra.txt",
    "--find-links ./wheels",
    "",
    "python-multipart>=0.0.32",
  ].join("\n");
  assert.deepEqual(parseRequirements(text), [
    "chromadb",
    "fastapi",
    "markitdown",
    "uvicorn",
    "python-multipart",
  ]);
});

test("pip 'Package(s) not found' output parses into the missing names", () => {
  assert.deepEqual(
    parseMissingPackages("WARNING: Package(s) not found: fastapi, uvicorn\n"),
    ["fastapi", "uvicorn"]
  );
  assert.deepEqual(parseMissingPackages("Name: httpx\nVersion: 0.28.1"), []);
  // pip colors its warnings — ANSI escapes must not leak into names
  // (observed live: "fastapi\u001b[0m\u001b[33m").
  assert.deepEqual(
    parseMissingPackages("\u001b[33mWARNING: Package(s) not found: chromadb, fastapi\u001b[0m\u001b[33m\n"),
    ["chromadb", "fastapi"]
  );
});

test("readiness: no venv → not-set-up (pip never runs)", async () => {
  let pipRan = false;
  const result = await checkReadinessWith({
    venvPythonExists: false,
    requirementsText: "fastapi==1.0",
    runPipShow: async () => {
      pipRan = true;
      return { ok: true, output: "" };
    },
  });
  assert.deepEqual(result, { readiness: "not-set-up", missing: [] });
  assert.equal(pipRan, false);
});

test("readiness: venv exists but packages missing → incomplete with the specific names", async () => {
  const result = await checkReadinessWith({
    venvPythonExists: true,
    requirementsText: "fastapi==0.139.0\nuvicorn[standard]==0.50.0\nhttpx==0.28.1",
    runPipShow: async (packages) => {
      assert.deepEqual(packages, ["fastapi", "uvicorn", "httpx"]);
      return { ok: false, output: "WARNING: Package(s) not found: fastapi" };
    },
  });
  assert.deepEqual(result, { readiness: "incomplete", missing: ["fastapi"] });
});

test("readiness: venv exists and all requirements resolve → ready", async () => {
  const result = await checkReadinessWith({
    venvPythonExists: true,
    requirementsText: "fastapi==0.139.0",
    runPipShow: async () => ({ ok: true, output: "Name: fastapi" }),
  });
  assert.deepEqual(result, { readiness: "ready", missing: [] });
});

test("readiness regression: some pip versions exit 0 while warning — the text wins over the exit code", async () => {
  // Observed on this machine: `pip show a b` exited 0 with the missing
  // packages only mentioned on stderr. Exit-code trust made a broken venv
  // read as "ready".
  const result = await checkReadinessWith({
    venvPythonExists: true,
    requirementsText: "chromadb==1.5.9\nfastapi==0.139.0",
    runPipShow: async () => ({
      ok: true, // exit 0!
      output: "WARNING: Package(s) not found: chromadb, fastapi",
    }),
  });
  assert.deepEqual(result, { readiness: "incomplete", missing: ["chromadb", "fastapi"] });
});

test("readiness: pip itself broken (non-zero, no parseable warning) → incomplete, never ready", async () => {
  const result = await checkReadinessWith({
    venvPythonExists: true,
    requirementsText: "fastapi==0.139.0",
    runPipShow: async () => ({ ok: false, output: "No module named pip" }),
  });
  assert.deepEqual(result, { readiness: "incomplete", missing: [] });
});

// ---- crash hints ----------------------------------------------------------------

test("crash hints: missing module named, port in use, and no-hint fallthrough", () => {
  assert.deepEqual(
    crashHint([
      "Traceback (most recent call last):",
      '  File "server.py", line 21, in <module>',
      "ModuleNotFoundError: No module named 'fastapi'",
      "[jarvis] exited (code 1)",
    ]),
    { kind: "missing-dep", pkg: "fastapi" }
  );
  assert.deepEqual(
    crashHint(["OSError: [Errno 48] error while attempting to bind on address ('127.0.0.1', 8016): address already in use"]),
    { kind: "port-in-use" }
  );
  assert.deepEqual(crashHint(["[WinError 10048] Only one usage of each socket address"]), {
    kind: "port-in-use",
  });
  // The newest matching line wins (the last crash, not an old one).
  assert.deepEqual(
    crashHint([
      "ModuleNotFoundError: No module named 'fastapi'",
      "ModuleNotFoundError: No module named 'uvicorn'",
    ]),
    { kind: "missing-dep", pkg: "uvicorn" }
  );
  assert.equal(crashHint(["ValueError: bad config", "some stack frame"]), null);
  assert.equal(crashHint([]), null);
});

// ---- ActivityWatch detection ------------------------------------------------------

test("AW detection on macOS: app bundle in /Applications or ~/Applications", () => {
  const found = detectActivityWatch("darwin", {
    exists: (p) => p === "/Applications/ActivityWatch.app",
    homeDir: "/Users/arsha",
    onPath: () => false,
  });
  assert.deepEqual(found, {
    installed: true,
    start: { cmd: "open", args: ["-a", "ActivityWatch"] },
  });

  const home = detectActivityWatch("darwin", {
    exists: (p) => p === "/Users/arsha/Applications/ActivityWatch.app",
    homeDir: "/Users/arsha",
    onPath: () => false,
  });
  assert.equal(home.installed, true);

  const missing = detectActivityWatch("darwin", {
    exists: () => false,
    homeDir: "/Users/arsha",
    onPath: () => false,
  });
  assert.deepEqual(missing, { installed: false });
});

test("AW detection on Windows: known install paths, then PATH", () => {
  const local = detectActivityWatch("win32", {
    exists: (p) => p === "C:\\Users\\arsha\\AppData\\Local\\Programs\\ActivityWatch\\aw-qt.exe",
    homeDir: "C:\\Users\\arsha",
    localAppData: "C:\\Users\\arsha\\AppData\\Local",
    onPath: () => false,
  });
  assert.equal(local.installed, true);
  if (local.installed) {
    assert.equal(local.start.cmd, "C:\\Users\\arsha\\AppData\\Local\\Programs\\ActivityWatch\\aw-qt.exe");
  }
  const onPathOnly = detectActivityWatch("win32", {
    exists: () => false,
    homeDir: "C:\\Users\\arsha",
    onPath: (bin) => bin === "aw-qt.exe",
  });
  assert.equal(onPathOnly.installed, true);
});

test("AW detection on Linux: aw-qt on PATH or nothing", () => {
  const found = detectActivityWatch("linux", {
    exists: () => false,
    homeDir: "/home/arsha",
    onPath: (bin) => bin === "aw-qt",
  });
  assert.deepEqual(found, { installed: true, start: { cmd: "aw-qt", args: [] } });
  const missing = detectActivityWatch("linux", {
    exists: () => false,
    homeDir: "/home/arsha",
    onPath: () => false,
  });
  assert.deepEqual(missing, { installed: false });
});

test("AW stop commands: graceful first on every OS", () => {
  assert.equal(awStopCommands("darwin")[0].cmd, "osascript");
  assert.deepEqual(awStopCommands("win32")[0].args, ["/IM", "aw-qt.exe"]);
  assert.deepEqual(awStopCommands("win32")[1].args, ["/F", "/IM", "aw-qt.exe"]); // force only as fallback
  assert.equal(awStopCommands("linux")[0].cmd, "pkill");
});
