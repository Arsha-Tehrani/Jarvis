// Standalone restore: node scripts/restore.ts [backup.json] [--yes]
// (Node 24 runs TS natively — same convention as scripts/backup.ts.)
//
// Loads a JSON export produced by `npm run backup` back into jarvis.db:
// truncates each known table present in the backup (NEVER oauth_tokens —
// live credentials are not part of backups) and bulk-inserts its rows,
// all inside ONE transaction: the whole restore lands or none of it does.
//
// Destructive, so it shows exactly what it will do and asks for the word
// "restore" unless --yes is passed.

import fs from "fs";
import path from "path";
import readline from "readline";
import Database from "better-sqlite3";
import { BACKUP_TABLES } from "../lib/backup-tables.ts";

const KNOWN_TABLES = new Set<string>(BACKUP_TABLES);

function fail(message: string): never {
  console.error(`restore: ${message}`);
  process.exit(1);
}

// --- resolve arguments -----------------------------------------------------

const args = process.argv.slice(2).filter((a) => a !== "--yes");
const skipPrompt = process.argv.includes("--yes");

let backupFile = args[0];
if (!backupFile) {
  const dir = path.join(process.cwd(), "backups");
  const candidates = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort()
    : [];
  if (candidates.length === 0) {
    fail("no backup file given and /backups is empty. Run `npm run backup` first.");
  }
  backupFile = path.join(dir, candidates[candidates.length - 1]);
  console.log(`No file given — using newest backup: ${backupFile}`);
}
if (!fs.existsSync(backupFile)) fail(`backup file not found: ${backupFile}`);

const dbPath = path.join(process.cwd(), "jarvis.db");
if (!fs.existsSync(dbPath)) fail("jarvis.db not found — run the app once first.");

// --- validate the backup shape before touching the database -----------------

let parsed: unknown;
try {
  parsed = JSON.parse(fs.readFileSync(backupFile, "utf8"));
} catch {
  fail(`${backupFile} is not valid JSON.`);
}
const tables = (parsed as { tables?: unknown })?.tables;
if (tables == null || typeof tables !== "object" || Array.isArray(tables)) {
  fail(`${backupFile} has no "tables" object — is this a jarvis backup?`);
}

type Row = Record<string, unknown>;
const plan: Array<{ table: string; rows: Row[] }> = [];
const skipped: string[] = [];

for (const [table, rows] of Object.entries(tables as Record<string, unknown>)) {
  if (table === "oauth_tokens") {
    skipped.push(`${table} (never restored — live credentials)`);
    continue;
  }
  if (!KNOWN_TABLES.has(table)) {
    skipped.push(`${table} (not a known jarvis table)`);
    continue;
  }
  if (!Array.isArray(rows)) {
    skipped.push(`${table} (malformed: not an array)`);
    continue;
  }
  plan.push({ table, rows: rows as Row[] });
}
if (plan.length === 0) fail("nothing restorable found in the backup.");

// --- show the plan and confirm ----------------------------------------------

const db = new Database(dbPath);
// Restore replaces whole tables from a consistent snapshot; enforcing FK
// order across truncate+insert would only fight that.
db.pragma("foreign_keys = OFF");

const tableExists = db.prepare(
  "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?"
);
const restorable = plan.filter(({ table }) => {
  if (tableExists.get(table)) return true;
  skipped.push(`${table} (table doesn't exist in this jarvis.db yet)`);
  return false;
});

console.log(`\nRestoring from ${backupFile} into ${dbPath}:`);
for (const { table, rows } of restorable) {
  const current = (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  console.log(`  ${table}: replace ${current} current row(s) with ${rows.length} from backup`);
}
for (const s of skipped) console.log(`  skipping ${s}`);

async function confirm(): Promise<void> {
  if (skipPrompt) return;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) =>
    rl.question('\nThis overwrites the tables above. Type "restore" to continue: ', resolve)
  );
  rl.close();
  if (answer.trim() !== "restore") fail("aborted — nothing was changed.");
}

// --- run --------------------------------------------------------------------

await confirm();

const run = db.transaction(() => {
  for (const { table, rows } of restorable) {
    db.prepare(`DELETE FROM ${table}`).run();
    if (rows.length === 0) continue;

    const tableCols = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
      .map((c) => c.name);
    const backupCols = Object.keys(rows[0]);
    const cols = tableCols.filter((c) => backupCols.includes(c));
    if (cols.length === 0) {
      throw new Error(`${table}: backup columns don't match the current schema at all`);
    }
    const insert = db.prepare(
      `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`
    );
    for (const row of rows) {
      insert.run(...cols.map((c) => normalize(row[c])));
    }
  }
});

function normalize(value: unknown): string | number | null {
  if (value == null) return null;
  if (typeof value === "string" || typeof value === "number") return value;
  return JSON.stringify(value); // shouldn't happen in our exports; be safe
}

try {
  run();
} catch (err) {
  fail(`failed, nothing was changed (transaction rolled back): ${err instanceof Error ? err.message : err}`);
}

for (const { table, rows } of restorable) {
  console.log(`  ✓ ${table}: ${rows.length} row(s)`);
}
console.log("Restore complete.");
