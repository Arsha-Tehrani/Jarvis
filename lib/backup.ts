import { getDb } from "@/lib/db";
import { BACKUP_TABLES } from "@/lib/backup-tables";

// Local backup export: every table to one JSON object. Never locked in.
// oauth_tokens is deliberately EXCLUDED — backups should be shareable/
// storable without leaking live Google credentials.

export function exportAllData(): Record<string, unknown> {
  const db = getDb();
  const tables: Record<string, unknown[]> = {};
  for (const table of BACKUP_TABLES) {
    tables[table] = db.prepare(`SELECT * FROM ${table}`).all();
  }
  return {
    exported_at: new Date().toISOString(),
    note: "oauth_tokens excluded on purpose (live credentials)",
    tables,
  };
}
