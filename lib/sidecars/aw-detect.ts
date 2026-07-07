// Pure per-OS detection + launch/quit command selection for ActivityWatch.
// No fs/child_process imports — the environment is injected so `node --test`
// covers every OS branch on one machine.
//
// ActivityWatch is a THIRD-PARTY app the user installs themselves (tray
// app), unlike the bundled sidecars. Jarvis can best-effort launch and quit
// it, but never installs it and never treats a failed quit as a hard error.

export type AwDetectDeps = {
  exists: (absolutePath: string) => boolean;
  homeDir: string;
  localAppData?: string; // win32 %LOCALAPPDATA%
  onPath: (binary: string) => boolean;
};

export type AwDetection =
  | { installed: false }
  | { installed: true; start: { cmd: string; args: string[] } };

export const AW_INSTALL_URL = "https://activitywatch.net/downloads/";

export function detectActivityWatch(
  platform: NodeJS.Platform,
  deps: AwDetectDeps
): AwDetection {
  if (platform === "darwin") {
    const bundles = [
      "/Applications/ActivityWatch.app",
      `${deps.homeDir}/Applications/ActivityWatch.app`,
    ];
    if (bundles.some((p) => deps.exists(p))) {
      return { installed: true, start: { cmd: "open", args: ["-a", "ActivityWatch"] } };
    }
    return { installed: false };
  }
  if (platform === "win32") {
    const candidates = [
      deps.localAppData ? `${deps.localAppData}\\Programs\\ActivityWatch\\aw-qt.exe` : null,
      "C:\\Program Files\\ActivityWatch\\aw-qt.exe",
      "C:\\Program Files (x86)\\ActivityWatch\\aw-qt.exe",
    ].filter((p): p is string => p != null);
    const found = candidates.find((p) => deps.exists(p));
    if (found) return { installed: true, start: { cmd: found, args: [] } };
    if (deps.onPath("aw-qt.exe")) {
      return { installed: true, start: { cmd: "aw-qt.exe", args: [] } };
    }
    return { installed: false };
  }
  // linux and everything else: the aw-qt binary on PATH.
  if (deps.onPath("aw-qt")) {
    return { installed: true, start: { cmd: "aw-qt", args: [] } };
  }
  return { installed: false };
}

// Graceful-quit attempts, in order; the caller runs them until the health
// probe confirms it's gone. Best-effort by design.
export function awStopCommands(platform: NodeJS.Platform): Array<{ cmd: string; args: string[] }> {
  if (platform === "darwin") {
    return [
      { cmd: "osascript", args: ["-e", 'quit app "ActivityWatch"'] },
      { cmd: "pkill", args: ["-x", "aw-qt"] },
    ];
  }
  if (platform === "win32") {
    return [
      { cmd: "taskkill", args: ["/IM", "aw-qt.exe"] },
      { cmd: "taskkill", args: ["/F", "/IM", "aw-qt.exe"] },
    ];
  }
  return [{ cmd: "pkill", args: ["-f", "aw-qt"] }];
}
