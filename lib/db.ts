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
  // Phase 8 — Gmail triage (read-only + on-demand drafts)
  `CREATE TABLE IF NOT EXISTS mail_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    connected_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE TABLE IF NOT EXISTS mail_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account TEXT NOT NULL,
    gmail_id TEXT NOT NULL,
    sender TEXT NOT NULL,
    subject TEXT NOT NULL,
    snippet TEXT,
    received_at TEXT,
    importance TEXT CHECK (importance IN ('important','can_wait','noise')),
    importance_reason TEXT,
    category TEXT,
    is_read INTEGER NOT NULL DEFAULT 0,
    UNIQUE(account, gmail_id)
  )`,
  // Phase 6g — tiny key/value store (digest markers, Slack config, …)
  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  // Phase 6f — net worth rollup
  `CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL DEFAULT 'cash'
      CHECK (kind IN ('cash','savings','investment','debt','other')),
    balance REAL NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE TABLE IF NOT EXISTS networth_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL UNIQUE,
    accounts_total REAL NOT NULL,
    holdings_value REAL NOT NULL,
    total REAL NOT NULL
  )`,
  // Phase 6e — people / keep-in-touch
  `CREATE TABLE IF NOT EXISTS people (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    cadence_days INTEGER,
    last_contacted TEXT,
    birthday TEXT,
    gift_ideas TEXT,
    notes TEXT
  )`,
  // Phase 6d — reading & learning
  `CREATE TABLE IF NOT EXISTS reading (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL DEFAULT 'book'
      CHECK (kind IN ('book','article','course','paper','video')),
    title TEXT NOT NULL,
    author TEXT,
    status TEXT NOT NULL DEFAULT 'queued'
      CHECK (status IN ('queued','reading','done','abandoned')),
    link TEXT,
    notes TEXT,
    note_path TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  // Phase 17 — nutrition / macros (entries come from the macro sidecar or
  // the log_meal agent tool; both are schema-validated before insert)
  `CREATE TABLE IF NOT EXISTS nutrition_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    item TEXT NOT NULL,
    calories INTEGER NOT NULL,
    protein INTEGER NOT NULL,
    carbs INTEGER NOT NULL,
    fat INTEGER NOT NULL,
    source TEXT NOT NULL DEFAULT 'text' CHECK (source IN ('photo','text')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  // Phase 19 — GoodNotes → RAG sync: one row per Drive file already
  // ingested; a file is re-downloaded only when its modifiedTime moves.
  `CREATE TABLE IF NOT EXISTS goodnotes_sync_state (
    file_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    modified_time TEXT NOT NULL,
    ingested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  // Phase 21 — semantic search index: one embedding per indexed row
  // (task title / note path / mail subject). text is what was embedded —
  // the refresh job compares it to decide whether to re-embed, and search
  // renders it. embedding is a little-endian float32 BLOB.
  `CREATE TABLE IF NOT EXISTS search_embeddings (
    source TEXT NOT NULL CHECK (source IN ('task','note','mail')),
    ref_id TEXT NOT NULL,
    text TEXT NOT NULL,
    embedding BLOB NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (source, ref_id)
  )`,
  // Phase 21 — per-category monthly spending budgets. category values are
  // validated against the fixed CATEGORIES list (lib/finance/categorize.ts)
  // at the API/tool layer; SQLite just stores them.
  `CREATE TABLE IF NOT EXISTS category_budgets (
    category TEXT PRIMARY KEY,
    monthly_limit REAL NOT NULL CHECK (monthly_limit > 0)
  )`,
  // Phase 21 — undo: which executed agent_log calls were already reverted,
  // so the same action can never be undone twice. call_index is the position
  // of the executed call inside the log row's tool_calls JSON.
  `CREATE TABLE IF NOT EXISTS reverted_actions (
    log_id INTEGER NOT NULL,
    call_index INTEGER NOT NULL,
    tool TEXT NOT NULL,
    reverted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (log_id, call_index)
  )`,
  // Phase 6c — career / job hunt
  `CREATE TABLE IF NOT EXISTS applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company TEXT NOT NULL,
    role TEXT NOT NULL,
    stage TEXT NOT NULL DEFAULT 'applied'
      CHECK (stage IN ('wishlist','applied','screening','interview','offer','rejected','accepted')),
    next_action TEXT,
    next_action_at TEXT,
    contact TEXT,
    link TEXT,
    notes TEXT,
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
