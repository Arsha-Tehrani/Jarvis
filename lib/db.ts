import Database from "better-sqlite3";
import path from "path";
import { syncColumnMigrations, syncTriggerSql } from "@/lib/sync/tables";
import { seedSyncConfig } from "@/lib/sync/config";
import { migrateGoalsToTrackers } from "@/lib/trackers-migrate";
import { MAGNITUDE_SOURCES } from "@/lib/slack/checkin-core";
import { CASH_EQUIVALENT_TABLE } from "@/lib/stocks/cash-equivalents";

// One connection per process. Next.js dev hot-reload re-evaluates modules,
// so stash the handle on globalThis to avoid leaking connections.
const globalForDb = globalThis as unknown as {
  __jarvisDb?: Database.Database;
  __jarvisMigrationCount?: number;
};

// Schema definitions are centralized here. Tables are created per phase:
// each entry is idempotent (CREATE TABLE IF NOT EXISTS), run on startup.
const MIGRATIONS: string[] = [
  // Phase 1 (priority values canonicalized to urgent/high/later by the
  // task-board redesign — existing DBs with the old low/medium/high CHECK
  // are rebuilt by migrateTaskPriorities below)
  `CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    due_at TEXT,
    priority TEXT NOT NULL DEFAULT 'high' CHECK (priority IN ('urgent','high','later')),
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
  // Retroactive check-in — an EXPLICIT miss ("asked, and the answer was no"),
  // which is a different thing from "no data" (never asked / tracker didn't
  // exist yet) and is the only state that turns a heatmap cell red and breaks
  // a daily streak. A "yes" answer needs no row here: it writes to whatever
  // table that tracker already logs to, so completion truth stays in exactly
  // one place per tracker. `date` is the day being marked, never today.
  `CREATE TABLE IF NOT EXISTS tracker_misses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    habit_id INTEGER NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
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
  // Sync Control Center — per-device selection of which registry categories
  // this machine sends/receives (the /sync page). table_id is a CATEGORY id
  // from lib/sync/tables.ts (NOT a raw table name). Local-only and itself
  // hard-excluded from sync (each device owns its own config, like
  // device_meta). Seeded from the registry defaults by seedSyncConfig() after
  // migrations: today's allowlist enabled, everything new off.
  `CREATE TABLE IF NOT EXISTS sync_config (
    table_id TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  )`,
  // Part D6 (reworked for multi-timeframe charts) — click-to-chart price
  // history, cached per (ticker, interval). `series` is the whole fetched
  // series as one JSON blob, replaced wholesale — no partial-range SQL
  // access is needed; the per-timeframe slicing is pure logic in
  // lib/stocks/history-core.ts. Freshness is decided there too: EOD
  // intervals (1d/1wk/1mo) are fresh for the fetch's calendar day, intraday
  // (5m/15m/30m) for 15 minutes. See docs/stock-history-feasibility.md.
  `CREATE TABLE IF NOT EXISTS stock_chart_cache (
    ticker TEXT NOT NULL,
    interval TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    series TEXT NOT NULL,
    PRIMARY KEY (ticker, interval)
  )`,
  // Task-board redesign Phase 4 — Slack task digests, one row per (date,
  // slot) actually sent. task_ids is the JSON array of task ids in displayed
  // order, so "done 2" indexes into what the user actually saw. The UNIQUE
  // constraint is the idempotency guard that makes launch catch-up safe.
  // Deliberately NOT in the sync allowlist: digests are per-device-process
  // (only the machine with Slack configured sends).
  `CREATE TABLE IF NOT EXISTS slack_task_digests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    slot TEXT NOT NULL CHECK (slot IN ('morning','midday','evening')),
    task_ids TEXT NOT NULL,
    sent_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE(date, slot)
  )`,
  // Bulk task-list import (spec: parse, group, reason, log). One row per
  // paste: the raw text, the validated pre-edit model output, what the user
  // actually confirmed, and the created task ids (the bulk-undo target).
  // PRIVACY: raw_input_text/proposed_json routinely carry sensitive personal
  // content (the same category Notes/Finance/Mail keep local-only), so this
  // table is deliberately NOT in the sync allowlist (lib/sync/tables.ts) and
  // NOT in BACKUP_TABLES (lib/backup-tables.ts) — like oauth_tokens.
  `CREATE TABLE IF NOT EXISTS bulk_imports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    raw_input_text TEXT NOT NULL,
    source_mode TEXT NOT NULL CHECK (source_mode IN ('structured','unstructured')),
    model_used TEXT,
    proposed_json TEXT NOT NULL,
    final_json TEXT,
    status TEXT NOT NULL DEFAULT 'proposed'
      CHECK (status IN ('proposed','committed','discarded','reverted')),
    created_task_ids TEXT
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
// `seed` runs exactly once — inside the same `if column doesn't exist yet`
// branch as the ALTER TABLE that adds it (see applyMigrations below) — so a
// later user correction to the column is never clobbered on a future boot.
const COLUMN_MIGRATIONS: Array<{
  table: string;
  column: string;
  ddl: string;
  seed?: (db: Database.Database) => void;
}> = [
  // Phase 22 — agent cost/latency per turn (filled by /api/agent from
  // lib/llm.ts chat() meta; cost_usd is 0 for local Ollama, null when the
  // pricing table has no entry for the model).
  { table: "agent_log", column: "provider", ddl: "provider TEXT" },
  { table: "agent_log", column: "model", ddl: "model TEXT" },
  { table: "agent_log", column: "latency_ms", ddl: "latency_ms INTEGER" },
  { table: "agent_log", column: "input_tokens", ddl: "input_tokens INTEGER" },
  { table: "agent_log", column: "output_tokens", ddl: "output_tokens INTEGER" },
  { table: "agent_log", column: "cost_usd", ddl: "cost_usd REAL" },
  // Agent Log viewer — every turn now records a terminal status + debug detail
  // so a bad run (Ollama down, invalid model output, a tool that threw) is
  // readable after the fact instead of vanishing into a thrown error. Nullable:
  // rows logged before this migration keep NULL (status unknown, rendered as
  // "legacy" in the viewer — not retroactively claimed to be 'ok').
  //   status         'ok' | 'validation_error' | 'execution_error' | 'llm_error' | 'pending_confirmation'
  //   error_message  human-readable detail when status != 'ok'
  //   input_source   'typed' | 'voice_mic' | 'voice_ptt' (how the turn arrived)
  //   requested_calls raw tool calls the model returned, BEFORE zod validation
  //   executed_calls  the calls that actually ran, with validated args + result
  //                   (canonical undo source — see lib/revert.ts; the legacy
  //                    tool_calls column is read as a fallback for old rows)
  { table: "agent_log", column: "status", ddl: "status TEXT" },
  { table: "agent_log", column: "error_message", ddl: "error_message TEXT" },
  { table: "agent_log", column: "input_source", ddl: "input_source TEXT" },
  { table: "agent_log", column: "requested_calls", ddl: "requested_calls TEXT" },
  { table: "agent_log", column: "executed_calls", ddl: "executed_calls TEXT" },
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
  // Retroactive check-in — per-tracker opt-in for the morning "did you do
  // this yesterday?" nag. Column default is 1 (a brand-new daily manual habit
  // is the common case); the seed immediately corrects the rows the default
  // is wrong for, per defaultCheckinEnabled(): magnitude-based sources answer
  // a number, not yes/no, and a weekly tracker isn't framed by "yesterday".
  // MUST stay after the `source` migration above — the seed reads that column.
  {
    table: "habits",
    column: "checkin_enabled",
    ddl: "checkin_enabled INTEGER NOT NULL DEFAULT 1",
    seed: seedCheckinEnabled,
  },
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
  // Task-board redesign Phase 1 — task detail + calendar link + completion
  // timestamp + ranking fields. llm_rank holds the deterministic rank as the
  // fallback content of the same field (llm_rank_source says which writer:
  // 'deterministic' | 'llm'). llm_suggested_priority/llm_rationale are only
  // set while the model's suggestion differs from the stored priority —
  // applying or dismissing the suggestion clears them. Never auto-applied.
  { table: "tasks", column: "description", ddl: "description TEXT" },
  { table: "tasks", column: "gcal_event_id", ddl: "gcal_event_id TEXT" },
  { table: "tasks", column: "completed_at", ddl: "completed_at TEXT" },
  { table: "tasks", column: "llm_rank", ddl: "llm_rank INTEGER" },
  { table: "tasks", column: "llm_rank_source", ddl: "llm_rank_source TEXT" },
  { table: "tasks", column: "llm_suggested_priority", ddl: "llm_suggested_priority TEXT" },
  { table: "tasks", column: "llm_rationale", ddl: "llm_rationale TEXT" },
  // Phase 23 — sync bookkeeping columns on every allowlisted table,
  // generated from the allowlist itself (lib/sync/tables.ts).
  ...syncColumnMigrations(),
  // Round 2 — scope the Stocks-page chart to the investment account only:
  // split a holding's value into "stocks" (real ticker price) vs
  // "cash-equivalent" (money-market/sweep, e.g. SPAXX). is_cash_equivalent
  // is a real, user-overridable column, seeded ONCE from the known-ticker
  // table (lib/stocks/cash-equivalents.ts) — never re-derived from that
  // table on render, so a manual correction in the Stocks page UI sticks.
  {
    table: "holdings",
    column: "is_cash_equivalent",
    ddl: "is_cash_equivalent INTEGER NOT NULL DEFAULT 0",
    seed: seedCashEquivalentHoldings,
  },
  // The daily snapshot already writes `holdings_value`; these two sum to it
  // and let the Stocks chart plot equity vs. cash-equivalent within the
  // investment account, separate from the Net Worth page's blended total.
  // Nullable: rows written before this split has no seed value, correctly
  // null rather than fabricated (same rule as holdings_value/cash_value in
  // Round 1) — the chart renders a gap for that period, never a fake $0.
  // Sync spec §4 — one UUID per brokerage import, stamped on every row that
  // import touched (upserts AND tombstones). Debugging aid; see
  // lib/sync/tables.ts holdings entry.
  { table: "holdings", column: "import_batch_id", ddl: "import_batch_id TEXT" },
  { table: "networth_snapshots", column: "stocks_value", ddl: "stocks_value REAL" },
  {
    table: "networth_snapshots",
    column: "cash_equivalent_value",
    ddl: "cash_equivalent_value REAL",
  },
];

// Backfill checkin_enabled for trackers that existed before the column did.
// Same rule as defaultCheckinEnabled() (lib/slack/checkin-core.ts), expressed
// in SQL: everything daily and non-magnitude keeps the column default of 1;
// magnitude sources and every weekly tracker are turned off.
function seedCheckinEnabled(db: Database.Database): void {
  const placeholders = MAGNITUDE_SOURCES.map(() => "?").join(",");
  const info = db
    .prepare(
      `UPDATE habits SET checkin_enabled = 0
       WHERE cadence != 'daily' OR source IN (${placeholders})`
    )
    .run(...MAGNITUDE_SOURCES);
  if (info.changes > 0) {
    console.log(`[db] checkin_enabled defaulted off for ${info.changes} tracker(s)`);
  }
}

function seedCashEquivalentHoldings(db: Database.Database): void {
  const tickers = CASH_EQUIVALENT_TABLE.map((r) => r.ticker);
  if (tickers.length === 0) return;
  const placeholders = tickers.map(() => "?").join(",");
  const info = db
    .prepare(`UPDATE holdings SET is_cash_equivalent = 1 WHERE upper(ticker) IN (${placeholders})`)
    .run(...tickers);
  if (info.changes > 0) {
    console.log(`[db] seeded is_cash_equivalent for ${info.changes} existing holding(s)`);
  }
}

// Runs AFTER the column adds (indexes/triggers reference sync columns).
const POST_MIGRATIONS: string[] = [
  ...syncTriggerSql(),
  // The pre-multi-timeframe chart cache (PRIMARY KEY ticker only, daily-EOD
  // series). Superseded by stock_chart_cache above; it held nothing but
  // regenerable cached Yahoo responses, so dropping is safe and keeps the
  // DB tidy. Idempotent: IF EXISTS, and nothing recreates it.
  `DROP TABLE IF EXISTS stock_history_cache`,
];

const MIGRATION_COUNT =
  MIGRATIONS.length + COLUMN_MIGRATIONS.length + POST_MIGRATIONS.length;

// Task-board redesign Phase 1 — normalize tasks.priority to the canonical
// 'urgent' | 'high' | 'later'. The legacy CHECK (low/medium/high) is baked
// into the original CREATE TABLE and SQLite can't alter a CHECK, so existing
// DBs get the classic rebuild: create the new-shape table, copy rows with
// priorities mapped, drop the old, rename, recreate the sync index/triggers
// that dropped with the old table. Idempotent — runs only while
// sqlite_master still shows the legacy CHECK.
//
// Value audit before this migration was written (2026-07-12, live jarvis.db):
//   SELECT priority, COUNT(*) FROM tasks GROUP BY priority
//   → [{ priority: 'medium', n: 2 }]
// Only legacy 'medium' existed; no value outside the canonical mapping table
// was observed, so no extra closest-match entries were needed. The CASE
// below still carries the full spec mapping (urgent/critical/p0/p1 → urgent,
// high/medium/normal/p2 → high, low/later/someday/p3/p4/NULL/'' → later,
// numeric 1 → urgent, 2–3 → high, ≥4 → later) plus an ELSE 'high' fallback —
// per the closest-match rule, an unforeseen value most resembles
// "default/unspecified".
//
// Sync note: rows are copied with their sync bookkeeping (sync_id,
// updated_at, sync_dirty) byte-for-byte — the rename itself marks nothing
// dirty. Every device runs this same deterministic migration on its own
// copy, so remapped priorities converge without needing a sync push.
function migrateTaskPriorities(db: Database.Database): void {
  const schema = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tasks'`)
    .get() as { sql: string } | undefined;
  if (!schema || !schema.sql.includes("'low','medium','high'")) return;

  const found = db
    .prepare(`SELECT priority, COUNT(*) AS n FROM tasks GROUP BY priority`)
    .all() as Array<{ priority: string | null; n: number }>;
  console.log(
    `[db] migrating tasks.priority to urgent/high/later; distinct legacy values: ${JSON.stringify(found)}`
  );

  const priorityCase = `CASE
      WHEN lower(trim(coalesce(priority, ''))) IN ('urgent','critical','p0','p1') THEN 'urgent'
      WHEN lower(trim(coalesce(priority, ''))) IN ('high','medium','normal','p2') THEN 'high'
      WHEN priority IS NULL OR trim(priority) = ''
        OR lower(trim(priority)) IN ('low','later','someday','p3','p4') THEN 'later'
      WHEN trim(priority) GLOB '[0-9]*' AND CAST(priority AS INTEGER) = 1 THEN 'urgent'
      WHEN trim(priority) GLOB '[0-9]*' AND CAST(priority AS INTEGER) BETWEEN 2 AND 3 THEN 'high'
      WHEN trim(priority) GLOB '[0-9]*' AND CAST(priority AS INTEGER) >= 4 THEN 'later'
      ELSE 'high'
    END`;

  db.transaction(() => {
    db.exec(`CREATE TABLE tasks_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      due_at TEXT,
      priority TEXT NOT NULL DEFAULT 'high' CHECK (priority IN ('urgent','high','later')),
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done')),
      source TEXT NOT NULL DEFAULT 'manual',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      description TEXT,
      gcal_event_id TEXT,
      completed_at TEXT,
      llm_rank INTEGER,
      llm_rank_source TEXT,
      llm_suggested_priority TEXT,
      llm_rationale TEXT,
      sync_id TEXT,
      updated_at TEXT,
      origin_device_id TEXT,
      sync_dirty INTEGER NOT NULL DEFAULT 1,
      deleted_at TEXT
    )`);
    // Only copy columns that exist on the source table — an old DB that
    // never ran the column migrations above still rebuilds cleanly.
    const srcCols = new Set(
      (db.prepare(`PRAGMA table_info(tasks)`).all() as { name: string }[]).map((c) => c.name)
    );
    const copyCols = [
      "id", "title", "due_at", "status", "source", "created_at",
      "description", "gcal_event_id", "completed_at",
      "llm_rank", "llm_rank_source", "llm_suggested_priority", "llm_rationale",
      "sync_id", "updated_at", "origin_device_id", "sync_dirty", "deleted_at",
    ].filter((c) => srcCols.has(c));
    db.exec(
      `INSERT INTO tasks_new (${copyCols.join(", ")}, priority)
       SELECT ${copyCols.join(", ")}, ${priorityCase} FROM tasks`
    );
    db.exec(`DROP TABLE tasks`);
    db.exec(`ALTER TABLE tasks_new RENAME TO tasks`);
    // The DROP took the sync index + triggers with it; recreate (IF NOT
    // EXISTS makes the non-tasks entries no-ops).
    for (const sql of syncTriggerSql()) db.exec(sql);
  })();
}

function applyMigrations(db: Database.Database): void {
  for (const sql of MIGRATIONS) db.exec(sql);
  for (const m of COLUMN_MIGRATIONS) {
    const cols = db.prepare(`PRAGMA table_info(${m.table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === m.column)) {
      db.exec(`ALTER TABLE ${m.table} ADD COLUMN ${m.ddl}`);
      m.seed?.(db);
    }
  }
  for (const sql of POST_MIGRATIONS) db.exec(sql);
  // Data migrations (not DDL) — each idempotent, safe to run on every connect.
  migrateTaskPriorities(db);
  migrateGoalsToTrackers(db);
  // Seed the sync control-center config from the registry defaults (idempotent:
  // INSERT OR IGNORE, so a user's later toggle is never clobbered on reboot).
  seedSyncConfig(db);
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
