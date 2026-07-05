import Database from "better-sqlite3";
import path from "path";

// One connection per process. Next.js dev hot-reload re-evaluates modules,
// so stash the handle on globalThis to avoid leaking connections.
const globalForDb = globalThis as unknown as {
  __jarvisDb?: Database.Database;
  __jarvisMigrationCount?: number;
};

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
  // Phase 2
  `CREATE TABLE IF NOT EXISTS gym_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL UNIQUE,
    notes TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS leetcode_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    total_solved INTEGER NOT NULL,
    streak INTEGER NOT NULL DEFAULT 0,
    recent TEXT
  )`,
  // Phase 3
  `CREATE TABLE IF NOT EXISTS statements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    month TEXT,
    file_path TEXT NOT NULL UNIQUE,
    imported_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    amount REAL NOT NULL,
    merchant TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'Uncategorized',
    raw_description TEXT NOT NULL,
    statement_id INTEGER REFERENCES statements(id) ON DELETE CASCADE,
    is_recurring INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS goals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL UNIQUE,
    target REAL NOT NULL,
    period TEXT NOT NULL DEFAULT 'month'
  )`,
  // Phase 4
  `CREATE TABLE IF NOT EXISTS holdings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker TEXT NOT NULL UNIQUE,
    shares REAL NOT NULL,
    cost_basis REAL NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS watchlist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker TEXT NOT NULL UNIQUE
  )`,
  `CREATE TABLE IF NOT EXISTS calendar_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    google_event_id TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    start TEXT NOT NULL,
    end TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE TABLE IF NOT EXISTS oauth_tokens (
    provider TEXT PRIMARY KEY,
    access_token TEXT NOT NULL,
    refresh_token TEXT,
    expires_at TEXT NOT NULL
  )`,
  // Phase 6a — sleep + health metrics (one row per date+kind)
  `CREATE TABLE IF NOT EXISTS health_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('sleep_hours','bedtime','weight','mood')),
    value REAL NOT NULL,
    notes TEXT,
    UNIQUE(date, kind)
  )`,
  // Phase 6b — generic habits
  `CREATE TABLE IF NOT EXISTS habits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    cadence TEXT NOT NULL DEFAULT 'daily' CHECK (cadence IN ('daily','weekly')),
    goal INTEGER NOT NULL DEFAULT 1
  )`,
  `CREATE TABLE IF NOT EXISTS habit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    habit_id INTEGER NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    UNIQUE(habit_id, date)
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
    globalForDb.__jarvisMigrationCount = MIGRATIONS.length;
  } else if (globalForDb.__jarvisMigrationCount !== MIGRATIONS.length) {
    // Dev hot-reload added migrations since this connection opened —
    // re-run the (idempotent) list so new tables exist without a restart.
    for (const sql of MIGRATIONS) globalForDb.__jarvisDb.exec(sql);
    globalForDb.__jarvisMigrationCount = MIGRATIONS.length;
  }
  return globalForDb.__jarvisDb;
}

export function nowIso(): string {
  return new Date().toISOString();
}
