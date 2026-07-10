import Database from "better-sqlite3";
import path from "path";
import { syncColumnMigrations, syncTriggerSql } from "@/lib/sync/tables";
import { migrateGoalsToTrackers } from "@/lib/trackers-migrate";

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
  // Part D3 — dividend events. Finnhub's dividend endpoint is premium and
  // Alpha Vantage dropped free dividend data, so these are entered by hand
  // (the "manual entry always works" path). Payout is shares-on-ex-date ×
  // amount/share; without per-date holdings history we use the current share
  // count, clearly labeled as an approximation in the UI.
  `CREATE TABLE IF NOT EXISTS dividend_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker TEXT NOT NULL,
    ex_date TEXT NOT NULL,
    amount_per_share REAL NOT NULL,
    shares_at_date REAL,
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE(ticker, ex_date)
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
  // Part B4 — user category corrections keyed by merchant. Consulted on every
  // import (highest priority, above the LLM/keywords) so a manual re-categorize
  // sticks for future statements with the same merchant.
  `CREATE TABLE IF NOT EXISTS category_overrides (
    merchant TEXT PRIMARY KEY,
    category TEXT NOT NULL
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
  // Phase 22 — privacy audit: one row per OUTBOUND network call (metadata
  // only — host + feature + outcome, never bodies/params/headers, which
  // could contain tokens or PII). Written by lib/network-log.ts loggedFetch;
  // localhost calls (Ollama, sidecars) are deliberately not logged.
  `CREATE TABLE IF NOT EXISTS network_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    feature TEXT NOT NULL,
    host TEXT NOT NULL,
    purpose TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('ok','error')),
    status_code INTEGER,
    latency_ms INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_network_log_timestamp ON network_log(timestamp)`,
  // Phase 23 — selective sync: per-table pull cursors + push/pull marks.
  // Machine-specific but harmless to back up (restore lands on the same
  // machine in the normal case).
  `CREATE TABLE IF NOT EXISTS sync_state (
    table_name TEXT PRIMARY KEY,
    pull_cursor TEXT,
    last_pull_at TEXT,
    last_push_at TEXT
  )`,
  // Phase 23 — stable per-machine identity (DEVICE_ID env overrides).
  // Deliberately NOT in BACKUP_TABLES: restoring a backup onto a second
  // machine must not clone the first machine's device identity.
  `CREATE TABLE IF NOT EXISTS device_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  // Part D6 — click-to-chart daily price history, cached at most once per
  // ticker per day (Alpha Vantage free tier is 25 req/day; see
  // docs/stock-history-feasibility.md). `series` is the whole daily-close
  // array as one JSON blob, replaced wholesale on each fetch rather than
  // queried by date range, since the whole point is "serve today's cached
  // copy or fetch once" — no partial-range SQL access is needed.
  `CREATE TABLE IF NOT EXISTS stock_history_cache (
    ticker TEXT PRIMARY KEY,
    fetched_date TEXT NOT NULL,
    series TEXT NOT NULL
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

// Column adds on existing tables. SQLite has no ADD COLUMN IF NOT EXISTS,
// so idempotency comes from checking pragma table_info first.
const COLUMN_MIGRATIONS: Array<{ table: string; column: string; ddl: string }> = [
  // Phase 22 — agent cost/latency per turn (filled by /api/agent from
  // lib/llm.ts chat() meta; cost_usd is 0 for local Ollama, null when the
  // pricing table has no entry for the model).
  { table: "agent_log", column: "provider", ddl: "provider TEXT" },
  { table: "agent_log", column: "model", ddl: "model TEXT" },
  { table: "agent_log", column: "latency_ms", ddl: "latency_ms INTEGER" },
  { table: "agent_log", column: "input_tokens", ddl: "input_tokens INTEGER" },
  { table: "agent_log", column: "output_tokens", ddl: "output_tokens INTEGER" },
  { table: "agent_log", column: "cost_usd", ddl: "cost_usd REAL" },
  // Part A — retain the redacted extracted text/table of each imported file
  // so a downstream number that looks off can be traced back to what was
  // actually parsed (the "logs" pattern), not just a pass/fail flag.
  { table: "statements", column: "raw_text", ddl: "raw_text TEXT" },
  { table: "statements", column: "kind", ddl: "kind TEXT" },
  // Part B5 — captured summary balance, surfaced as a confirm-gated net-worth
  // account suggestion (never auto-applied).
  { table: "statements", column: "ending_balance", ddl: "ending_balance REAL" },
  { table: "statements", column: "balance_kind", ddl: "balance_kind TEXT" },
  { table: "statements", column: "balance_label", ddl: "balance_label TEXT" },
  // Part A follow-up — which account a transaction statement is FOR
  // ('checking' | 'savings' | 'credit_card' | null when undetermined), from
  // lib/finance/classify.ts's content-based sub-type detection. Lets the UI
  // badge statements/transactions and lets the transfer matcher tell "the
  // credit-card side" from "the checking side" of the same real payment.
  { table: "statements", column: "account_type", ddl: "account_type TEXT" },
  { table: "transactions", column: "account_type", ddl: "account_type TEXT" },
  // Part E — generalize `habits` into the unified Tracker model: `source` links
  // a tracker to a built-in feed (null = manual habit), `target` is the numeric
  // goal folded in from the legacy `goals` table.
  { table: "habits", column: "source", ddl: "source TEXT" },
  { table: "habits", column: "target", ddl: "target REAL" },
  // fix-plan-3 Phase 6 — automated dividend detection (docs/dividend-automation.md).
  // status: 'pending' (ex-date passed, cash not landed) | 'confirmed' (counts
  // toward the running total). Existing manual rows default to 'confirmed' —
  // a human typed them in after the fact. payment_date nullable (manual rows
  // may not have one). Dedupe rides the table's original UNIQUE(ticker, ex_date).
  { table: "dividend_log", column: "status", ddl: "status TEXT NOT NULL DEFAULT 'confirmed'" },
  { table: "dividend_log", column: "payment_date", ddl: "payment_date TEXT" },
  { table: "dividend_log", column: "source", ddl: "source TEXT NOT NULL DEFAULT 'manual'" },
  // fix-plan-3 Phase 1 — the date a job application was submitted (ISO date,
  // set once at creation; distinct from created_at, which is when the row was
  // tracked). Pre-existing rows keep NULL — no guessed backfill.
  { table: "applications", column: "date_applied", ddl: "date_applied TEXT" },
  // Phase 23 — sync bookkeeping columns on every allowlisted table,
  // generated from the allowlist itself (lib/sync/tables.ts).
  ...syncColumnMigrations(),
];

// Runs AFTER the column adds (indexes/triggers reference sync columns).
const POST_MIGRATIONS: string[] = [...syncTriggerSql()];

const MIGRATION_COUNT =
  MIGRATIONS.length + COLUMN_MIGRATIONS.length + POST_MIGRATIONS.length;

function applyMigrations(db: Database.Database): void {
  for (const sql of MIGRATIONS) db.exec(sql);
  for (const m of COLUMN_MIGRATIONS) {
    const cols = db.prepare(`PRAGMA table_info(${m.table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === m.column)) {
      db.exec(`ALTER TABLE ${m.table} ADD COLUMN ${m.ddl}`);
    }
  }
  for (const sql of POST_MIGRATIONS) db.exec(sql);
  // Data migration (not DDL): fold legacy goals into the unified Trackers.
  // Idempotent, so it's safe to run on every connect.
  migrateGoalsToTrackers(db);
}

function connect(): Database.Database {
  const db = new Database(path.join(process.cwd(), "jarvis.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  applyMigrations(db);
  return db;
}

export function getDb(): Database.Database {
  if (!globalForDb.__jarvisDb) {
    globalForDb.__jarvisDb = connect();
    globalForDb.__jarvisMigrationCount = MIGRATION_COUNT;
  } else if (globalForDb.__jarvisMigrationCount !== MIGRATION_COUNT) {
    // Dev hot-reload added migrations since this connection opened —
    // re-run the (idempotent) list so new tables exist without a restart.
    applyMigrations(globalForDb.__jarvisDb);
    globalForDb.__jarvisMigrationCount = MIGRATION_COUNT;
  }
  return globalForDb.__jarvisDb;
}

export function nowIso(): string {
  return new Date().toISOString();
}
