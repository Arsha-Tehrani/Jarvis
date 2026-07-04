import Database from "better-sqlite3";
import path from "path";

// One connection per process. Next.js dev hot-reload re-evaluates modules,
// so stash the handle on globalThis to avoid leaking connections.
const globalForDb = globalThis as unknown as { __jarvisDb?: Database.Database };

// Schema definitions are centralized here. Tables are created per phase:
// each entry is idempotent (CREATE TABLE IF NOT EXISTS), run on startup.
const MIGRATIONS: string[] = [
  // Phase 1
  `CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    due_at TEXT,
    priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high')),
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done')),
    source TEXT NOT NULL DEFAULT 'manual',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE TABLE IF NOT EXISTS agent_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_text TEXT NOT NULL,
    tool_calls TEXT,
    result TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
];

function connect(): Database.Database {
  const db = new Database(path.join(process.cwd(), "jarvis.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  for (const sql of MIGRATIONS) db.exec(sql);
  return db;
}

export function getDb(): Database.Database {
  if (!globalForDb.__jarvisDb) {
    globalForDb.__jarvisDb = connect();
  }
  return globalForDb.__jarvisDb;
}

export function nowIso(): string {
  return new Date().toISOString();
}
