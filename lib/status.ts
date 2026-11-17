import fs from "fs";
import { probeActivityWatch } from "@/lib/activitywatch";
import {
  getGoogleAccessToken,
  isGoogleConfigured,
  isGoogleConnected,
} from "@/lib/google";
import { latestLeetCodeRow } from "@/lib/leetcode";
import { getGmailAccessToken, listMailAccounts } from "@/lib/mail";
import { loggedFetch } from "@/lib/network-log";
import { SIDECARS, type SidecarDef } from "@/lib/sidecars/registry";
import { slackSocketState } from "@/lib/slack/socket";
import {
  runProbes,
  type HealthCheck,
  type Probe,
  type ProbeResult,
} from "@/lib/status-core";

// The thirteen status-page probes. Every optional integration reports one of
// ok / degraded / down / unconfigured — unconfigured is a normal state, not
// an error. Probes are cheap by design: presence checks where a live call
// would burn a rate limit, one small request where liveness matters. The
// result is cached ~20s so the auto-polling status page can't hammer
// sidecars or Google.

const PROBE_TIMEOUT_MS = 3000;
const CACHE_TTL_MS = 20_000;

function ok(message: string): ProbeResult {
  return { status: "ok", message };
}
function down(message: string): ProbeResult {
  return { status: "down", message };
}
function degraded(message: string): ProbeResult {
  return { status: "degraded", message };
}
function unconfigured(message: string): ProbeResult {
  return { status: "unconfigured", message };
}

async function probeUrl(url: string): Promise<Response> {
  return fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
}

const ollamaProbe: Probe = {
  id: "ollama",
  label: "LLM (Ollama)",
  run: async () => {
    if ((process.env.LLM_PROVIDER ?? "ollama") === "anthropic") {
      return process.env.ANTHROPIC_API_KEY
        ? ok("using Anthropic (API key present)")
        : unconfigured("LLM_PROVIDER=anthropic but ANTHROPIC_API_KEY not set");
    }
    const baseUrl = process.env.LLM_BASE_URL ?? "http://localhost:11434/v1";
    try {
      const res = await probeUrl(`${baseUrl}/models`);
      if (!res.ok) return down(`responded ${res.status}`);
      return ok(`reachable — model: ${process.env.LLM_MODEL ?? "llama3.1:8b"}`);
    } catch {
      return down(`unreachable at ${baseUrl} — is Ollama running? (ollama serve)`);
    }
  },
};

// Sidecars are optional infra with no config flag — unreachable reads as
// "down" with a note that it can be started right here. Health URLs come
// from the sidecar registry (one source of truth with the start/stop API).
function sidecarProbe(def: SidecarDef): Probe {
  return {
    id: def.id,
    label: def.label,
    run: async () => {
      try {
        const res = await probeUrl(def.healthUrl());
        if (!res.ok) return down(`health endpoint responded ${res.status}`);
        return ok("responding");
      } catch {
        return down("not running (optional — use the Start button, or python -m " + def.module + ")");
      }
    },
  };
}

const activityWatchProbe: Probe = {
  id: "activitywatch",
  label: "ActivityWatch",
  run: async () =>
    (await probeActivityWatch())
      ? ok("responding")
      : down("not running (optional — use the Start button if installed)"),
};

const obsidianProbe: Probe = {
  id: "obsidian",
  label: "Obsidian vault",
  run: () => {
    const p = process.env.OBSIDIAN_VAULT_PATH;
    if (!p) return unconfigured("OBSIDIAN_VAULT_PATH not set");
    if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) {
      return down("OBSIDIAN_VAULT_PATH is set but the folder doesn't exist");
    }
    return ok("vault folder exists");
  },
};

// Calendar and Drive share one oauth_tokens row ('google'); getting a token
// exercises the same refresh-failure detection that produces the
// "reconnect" prompt, and only hits Google when the token is expired.
const calendarProbe: Probe = {
  id: "google-calendar",
  label: "Google Calendar",
  run: async () => {
    if (!isGoogleConfigured()) return unconfigured("GOOGLE_CLIENT_ID/SECRET not set");
    if (!isGoogleConnected()) return unconfigured("not connected — connect from the Calendar tab");
    try {
      await getGoogleAccessToken();
      return ok("connected, token valid");
    } catch (err) {
      return down(err instanceof Error ? err.message : "token refresh failed");
    }
  },
};

// Drive uses the same token but a later-added scope — tokens granted before
// the scope existed 403 here and need a one-time reconnect.
const driveProbe: Probe = {
  id: "google-drive",
  label: "Google Drive",
  run: async () => {
    if (!isGoogleConfigured()) return unconfigured("GOOGLE_CLIENT_ID/SECRET not set");
    if (!isGoogleConnected()) return unconfigured("not connected — connect from the Calendar tab");
    let token: string;
    try {
      token = await getGoogleAccessToken();
    } catch (err) {
      return down(err instanceof Error ? err.message : "token refresh failed");
    }
    try {
      const res = await loggedFetch("https://www.googleapis.com/drive/v3/about?fields=user", {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      }, { feature: "status-check", purpose: "verify Drive scope" });
      if (res.status === 403) {
        return down("Drive scope not granted — reconnect from the Calendar tab");
      }
      if (!res.ok) return down(`Drive API responded ${res.status}`);
      return ok("Drive scope granted");
    } catch {
      return down("Drive API unreachable");
    }
  },
};

const gmailProbe: Probe = {
  id: "google-gmail",
  label: "Gmail",
  run: async () => {
    if (!isGoogleConfigured()) return unconfigured("GOOGLE_CLIENT_ID/SECRET not set");
    const accounts = listMailAccounts();
    if (accounts.length === 0) return unconfigured("no inboxes linked — connect from the Mail tab");
    const failures: string[] = [];
    for (const account of accounts) {
      try {
        await getGmailAccessToken(account.email);
      } catch (err) {
        failures.push(err instanceof Error ? err.message : account.email);
      }
    }
    if (failures.length === 0) {
      return ok(`${accounts.length} inbox(es) linked, tokens valid`);
    }
    const message = failures.join("; ");
    return failures.length === accounts.length ? down(message) : degraded(message);
  },
};

const slackProbe: Probe = {
  id: "slack",
  label: "Slack",
  run: async () => {
    const token = process.env.SLACK_BOT_TOKEN;
    if (!token) return unconfigured("SLACK_BOT_TOKEN not set");
    try {
      const res = await loggedFetch("https://slack.com/api/auth.test", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      }, { feature: "status-check", purpose: "slack auth.test" });
      const data = (await res.json()) as { ok: boolean; team?: string; error?: string };
      if (!data.ok) return down(`auth.test failed: ${data.error ?? res.status}`);
      const authed = `authed${data.team ? ` to ${data.team}` : ""}`;
      // Outbound works with just a bot token; INBOUND (check-in buttons, DM
      // replies) needs the Socket Mode connection to be live, so the probe
      // reports both. Read from the client directly — there's no URL to ping
      // now that nothing inbound arrives over HTTP.
      const socket = slackSocketState();
      if (socket === "unconfigured") {
        return ok(`${authed} · inbound off (SLACK_APP_TOKEN not set)`);
      }
      if (socket === "connected") return ok(`${authed} · socket connected`);
      return degraded(`${authed} · socket ${socket} — buttons and DM replies won't work`);
    } catch {
      return down("slack.com unreachable");
    }
  },
};

// The pull is a daily cron — report the last stored result instead of
// making a live call against the unofficial API.
const leetcodeProbe: Probe = {
  id: "leetcode",
  label: "LeetCode",
  run: () => {
    if (!process.env.LEETCODE_USERNAME) {
      return unconfigured("LEETCODE_USERNAME not set (manual entry still works)");
    }
    const row = latestLeetCodeRow();
    if (!row) return degraded("no stats stored yet — daily pull runs at 08:00 and at launch");
    const ageDays = (Date.now() - Date.parse(row.date)) / 86400_000;
    if (ageDays > 2) {
      return degraded(`last stored stats are from ${row.date} — the daily pull may be failing`);
    }
    return ok(`last pull ${row.date} (total ${row.total_solved})`);
  },
};

// Presence check only — a live quote would burn a rate-limited call just
// for a health check; real failures already surface in the Stocks UI.
function marketKeyProbe(id: string, label: string, envVar: string): Probe {
  return {
    id,
    label,
    run: () =>
      process.env[envVar]
        ? ok("key present (live failures surface in the Stocks UI)")
        : unconfigured(`${envVar} not set`),
  };
}

function buildProbes(): Probe[] {
  return [
    ollamaProbe,
    ...SIDECARS.map(sidecarProbe),
    activityWatchProbe,
    obsidianProbe,
    calendarProbe,
    gmailProbe,
    driveProbe,
    slackProbe,
    leetcodeProbe,
    marketKeyProbe("finnhub", "Finnhub", "FINNHUB_API_KEY"),
    marketKeyProbe("alphavantage", "Alpha Vantage", "ALPHAVANTAGE_API_KEY"),
  ];
}

const globalForStatus = globalThis as unknown as {
  __jarvisStatusCache?: { at: number; checks: HealthCheck[] };
};

export async function getHealthChecks(fresh = false): Promise<HealthCheck[]> {
  const cached = globalForStatus.__jarvisStatusCache;
  if (!fresh && cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.checks;
  }
  const checks = await runProbes(buildProbes());
  globalForStatus.__jarvisStatusCache = { at: Date.now(), checks };
  return checks;
}
