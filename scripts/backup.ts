// Standalone backup: node scripts/backup.ts (Node 24 runs TS natively).
// Same export as the in-app button, written to /backups.
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { BACKUP_TABLES } from "../lib/backup-tables.ts";

const dbPath = path.join(process.cwd(), "jarvis.db");
if (!fs.existsSync(dbPath)) {
  console.error("jarvis.db not found — run the app once first.");
  process.exit(1);
}
const db = new Database(dbPath, { readonly: true });

const tables: Record<string, unknown[]> = {};
for (const table of BACKUP_TABLES) {
  try {
    tables[table] = db.prepare(`SELECT * FROM ${table}`).all();
  } catch {
    tables[table] = []; // table not created yet (earlier-phase DB)
  }
}

const dir = path.join(process.cwd(), "backups");
fs.mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const file = path.join(dir, `jarvis-backup-${stamp}.json`);
fs.writeFileSync(
  file,
  JSON.stringify(
    {
      exported_at: new Date().toISOString(),
      note: "oauth_tokens excluded on purpose (live credentials)",
      tables,
    },
    null,
    2
  ),
  "utf8"
);
console.log(`Backup written: ${file}`);
