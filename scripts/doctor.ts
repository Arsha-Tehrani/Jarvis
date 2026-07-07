// Pre-flight doctor: a one-shot CLI version of the /status page, aimed at
// first-time setup. Run with `npm run doctor` (Node 24 runs TS natively).
//
// Exit code 0 unless something CONFIGURED is broken. "Not configured" is a
// normal state for every optional integration and never fails the run —
// only "configured but broken" does (usable as a CI / pre-flight gate).
import { execSync, spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { parseMissingPackages, parseRequirements, venvPythonPath } from "../lib/sidecars/core.ts";

const PROBE_TIMEOUT_MS = 3000;

// ---- .env.local (real environment wins over the file) ----------------------

function loadEnv(): Record<string, string> {
  const parsed: Record<string, string> = {};
  const file = path.join(process.cwd(), ".env.local");
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!match || line.trim().startsWith("#")) continue;
      parsed[match[1]] = match[2].replace(/^["']|["']$/g, "");
    }
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (value != null) parsed[key] = value;
  }
  return parsed;
}

const env = loadEnv();

// ---- report helpers ---------------------------------------------------------

let broken = 0;
const pass = (label: string, msg: string) => console.log(`  ✓ ${label} — ${msg}`);
const skip = (label: string, msg: string) => console.log(`  – ${label} — ${msg}`);
const fail = (label: string, msg: string) => {
  broken++;
  console.log(`  ✗ ${label} — ${msg}`);
};
const section = (title: string) => console.log(`\n${title}`);

async function probe(url: string): Promise<Response | null> {
  try {
    return await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  } catch {
    return null;
  }
}

// ---- Ollama + configured models ---------------------------------------------

// A configured model matches an installed tag exactly, or by name when the
// configured value has no explicit tag (llama3.1 matches llama3.1:latest).
function modelInstalled(configured: string, installed: string[]): boolean {
  return installed.some(
    (tag) => tag === configured || (!configured.includes(":") && tag.split(":")[0] === configured)
  );
}

async function checkLlm(): Promise<void> {
  section("LLM");
  if ((env.LLM_PROVIDER ?? "ollama") === "anthropic") {
    if (env.ANTHROPIC_API_KEY) pass("Anthropic", "LLM_PROVIDER=anthropic, API key present");
    else fail("Anthropic", "LLM_PROVIDER=anthropic but ANTHROPIC_API_KEY is not set");
    return;
  }

  const baseUrl = env.LLM_BASE_URL ?? "http://localhost:11434/v1";
  const ollamaRoot = baseUrl.replace(/\/v1\/?$/, "");
  const res = await probe(`${ollamaRoot}/api/tags`);
  if (!res || !res.ok) {
    // Distinguish "installed but not serving" from "not installed".
    let installed = false;
    try {
      execSync("ollama --version", { stdio: "ignore" });
      installed = true;
    } catch {
      /* not on PATH */
    }
    fail(
      "Ollama",
      installed
        ? `installed but not responding at ${ollamaRoot} — start it: ollama serve`
        : `not reachable at ${ollamaRoot} and no ollama CLI on PATH — install from https://ollama.com`
    );
    return;
  }
  pass("Ollama", `responding at ${ollamaRoot}`);

  const data = (await res.json()) as { models?: Array<{ name?: string }> };
  const tags = (data.models ?? []).map((m) => m.name ?? "").filter(Boolean);

  const chatModel = env.LLM_MODEL ?? "llama3.1:8b";
  if (modelInstalled(chatModel, tags)) pass("Chat model", `${chatModel} is pulled`);
  else fail("Chat model", `${chatModel} not pulled — run: ollama pull ${chatModel}`);

  const embedModel = env.EMBED_MODEL ?? "nomic-embed-text";
  if (modelInstalled(embedModel, tags)) pass("Embedding model", `${embedModel} is pulled`);
  else
    fail(
      "Embedding model",
      `${embedModel} not pulled (semantic search/RAG degrade to exact match) — run: ollama pull ${embedModel}`
    );

  const visionModel = env.MACRO_VISION_MODEL ?? "qwen2.5vl";
  if (modelInstalled(visionModel, tags)) pass("Vision model", `${visionModel} is pulled`);
  else
    skip(
      "Vision model",
      `${visionModel} not pulled — only needed for macro-sidecar food photos (ollama pull ${visionModel})`
    );
}

// ---- Sidecars (optional infra — a missing venv is never a failure) ----------

async function checkSidecars(): Promise<void> {
  section("Sidecars (optional)");
  const isWin = process.platform === "win32";
  const setup = (dir: string) =>
    isWin
      ? `cd sidecars/${dir} && py -3.13 -m venv .venv && .venv\\Scripts\\pip install -r requirements.txt`
      : `cd sidecars/${dir} && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt`;

  const sidecars: Array<{ dir: string; label: string; healthUrl?: string }> = [
    {
      dir: "textbook-rag",
      label: "Textbook RAG",
      healthUrl: `${env.TEXTBOOK_RAG_URL ?? "http://localhost:8016"}/health`,
    },
    {
      dir: "macro",
      label: "Macro (nutrition)",
      healthUrl: `${env.MACRO_SIDECAR_URL ?? "http://localhost:8017"}/health`,
    },
    { dir: "voice", label: "Voice" },
  ];

  for (const { dir, label, healthUrl } of sidecars) {
    const sidecarDir = path.join(process.cwd(), "sidecars", dir);
    const python = venvPythonPath(path.join(sidecarDir, ".venv"), process.platform);
    if (!fs.existsSync(python)) {
      skip(label, `venv not set up — ${setup(dir)} (or use Set up on /status)`);
      continue;
    }
    // Same readiness rule as /status: venv-exists is not venv-ready — ask
    // the venv's own pip whether the requirements actually resolve.
    const missing = missingRequirements(python, sidecarDir);
    if (missing === null) {
      fail(label, "venv exists but pip is broken in it — re-run setup from /status (or recreate .venv)");
      continue;
    }
    if (missing.length > 0) {
      fail(label, `venv incomplete — missing: ${missing.join(", ")} (use Set up on /status, or .venv pip install -r requirements.txt)`);
      continue;
    }
    const res = healthUrl ? await probe(healthUrl) : null;
    if (res?.ok) pass(label, "venv ready, server responding");
    else pass(label, "venv ready (server not currently running — that's fine)");
  }
}

// [] = all good; names = missing; null = pip itself unusable.
function missingRequirements(python: string, sidecarDir: string): string[] | null {
  let requirements: string[];
  try {
    requirements = parseRequirements(fs.readFileSync(path.join(sidecarDir, "requirements.txt"), "utf8"));
  } catch {
    return []; // no requirements file — nothing to verify
  }
  if (requirements.length === 0) return [];
  // spawnSync (not execFileSync): pip can exit 0 while still warning
  // "Package(s) not found" on stderr — the text is the truth, so capture
  // both streams regardless of exit code.
  const result = spawnSync(python, ["-m", "pip", "show", "--quiet", ...requirements], {
    timeout: 15_000,
    encoding: "utf8",
  });
  if (result.error) return null; // couldn't run the venv's python at all
  const missing = parseMissingPackages(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  if (missing.length > 0) return missing;
  return result.status === 0 ? [] : null;
}

// ---- Paths, keys, and connections --------------------------------------------

function checkVault(): void {
  section("Obsidian vault");
  const vault = env.OBSIDIAN_VAULT_PATH;
  if (!vault) skip("Vault", "OBSIDIAN_VAULT_PATH not set (notes + weekly digest disabled)");
  else if (fs.existsSync(vault) && fs.statSync(vault).isDirectory()) pass("Vault", vault);
  else fail("Vault", `OBSIDIAN_VAULT_PATH is set but the folder doesn't exist: ${vault}`);
}

function checkGoogle(): void {
  section("Google (Calendar / Gmail / Drive)");
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    skip("OAuth", "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set");
    return;
  }
  pass("OAuth", "client credentials present");

  const dbPath = path.join(process.cwd(), "jarvis.db");
  if (!fs.existsSync(dbPath)) {
    skip("Connections", "jarvis.db not created yet — run the app once, then connect from the UI");
    return;
  }
  const db = new Database(dbPath, { readonly: true });
  try {
    const google = db
      .prepare("SELECT refresh_token, expires_at FROM oauth_tokens WHERE provider = 'google'")
      .get() as { refresh_token: string | null; expires_at: string } | undefined;
    if (!google) {
      skip("Calendar/Drive", "not connected — connect from the Calendar tab");
    } else if (Date.parse(google.expires_at) < Date.now() && !google.refresh_token) {
      fail("Calendar/Drive", "token expired with no refresh token — reconnect from the Calendar tab");
    } else {
      pass("Calendar/Drive", "connected (token refresh is verified live on /status)");
    }

    const inboxes = db
      .prepare("SELECT COUNT(*) AS n FROM oauth_tokens WHERE provider LIKE 'gmail:%'")
      .get() as { n: number };
    if (inboxes.n === 0) skip("Gmail", "no inboxes linked — connect from the Mail tab");
    else pass("Gmail", `${inboxes.n} inbox(es) linked`);

    skip(
      "GoodNotes sync",
      `Drive folder "${env.GOODNOTES_DRIVE_FOLDER ?? "GoodNotes Backup"}" — reachability is checked by the hourly sync`
    );
  } catch {
    skip("Connections", "oauth_tokens table not created yet — run the app once");
  } finally {
    db.close();
  }
}

async function checkSlack(): Promise<void> {
  section("Slack");
  const token = env.SLACK_BOT_TOKEN;
  if (!token) {
    skip("Slack", "SLACK_BOT_TOKEN not set (check-in + morning brief disabled)");
    return;
  }
  try {
    const res = await fetch("https://slack.com/api/auth.test", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const data = (await res.json()) as { ok: boolean; team?: string; error?: string };
    if (data.ok) pass("Slack", `auth.test ok${data.team ? ` (${data.team})` : ""}`);
    else fail("Slack", `token set but auth.test failed: ${data.error ?? res.status}`);
  } catch {
    fail("Slack", "token set but slack.com is unreachable");
  }
  if (!env.SLACK_USER_ID) skip("Slack DM", "SLACK_USER_ID not set — the morning DM needs it");
}

async function checkMisc(): Promise<void> {
  section("Everything else");
  if (env.LEETCODE_USERNAME) pass("LeetCode", `daily pull configured for ${env.LEETCODE_USERNAME}`);
  else skip("LeetCode", "LEETCODE_USERNAME not set (manual entry still works)");

  if (env.FINNHUB_API_KEY) pass("Finnhub", "key present");
  else if (env.ALPHAVANTAGE_API_KEY) pass("Alpha Vantage", "key present (fallback provider)");
  else skip("Stocks", "no FINNHUB_API_KEY / ALPHAVANTAGE_API_KEY (quotes disabled)");

  const aw = await probe(`${env.AW_BASE_URL ?? "http://localhost:5600"}/api/0/info`);
  if (aw?.ok) pass("ActivityWatch", "responding");
  else skip("ActivityWatch", "not running (screen-time card shows a hint)");
}

// ---- run ----------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("Jarvis doctor — configured-but-broken fails; not-configured never does.");
  await checkLlm();
  await checkSidecars();
  checkVault();
  checkGoogle();
  await checkSlack();
  await checkMisc();

  console.log(
    broken === 0
      ? "\nAll configured integrations look healthy."
      : `\n${broken} configured integration(s) look broken — see ✗ above.`
  );
  process.exitCode = broken === 0 ? 0 : 1;
}

main();
