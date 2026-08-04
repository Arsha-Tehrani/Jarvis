import { z } from "zod";

// ============================================================================
// THE SYNC REGISTRY — the one place that describes every data category Jarvis
// has and whether it *may* leave this machine.
//
// This used to be a flat "allowlist": a hardcoded set of tables, everything
// else rejected forever. It is now a user-configurable control center
// (the /sync page): each device decides, per category, what it sends and
// receives, persisted in the local `sync_config` table. Two lines of defense
// survive that change and are NON-NEGOTIABLE:
//
//   1. HARD-EXCLUDED categories (see `hardExcluded` below) can never sync,
//      even if a `sync_config` row somehow says enabled. They are filtered out
//      unconditionally by getEnabledSyncTables() and are not even present in
//      SYNC_TABLE_NAMES / the wire z.enum, so they are impossible to name
//      through the push/pull endpoints. These are the ones that would break
//      the app (credential rotation fights, device-identity collisions), not
//      merely leak data:
//        - oauth_tokens              (live, rotating credentials)
//        - device_meta               (this machine's distinct sync identity)
//        - sync_state, sync_config   (inherently per-device bookkeeping)
//
//   2. Only REGISTERED tables sync, and only via their registered column
//      whitelist — SQL is only ever built from these names, never from request
//      input.
//
// Everything else is now a toggle. Seeded off on first migration (so an
// upgrade changes nobody's behavior); flip it on from /sync.
//
// tests/sync-core.test.ts asserts the hard-excluded set is rejected even when
// explicitly requested.
// ============================================================================

// Per-table sync spec. `columns` is the exact payload column set (a column
// whitelist — SQL is only ever built from these registered names, never from
// request input). `naturalKey` is the logical identity used when two devices
// created the same thing independently (e.g. both logged gym for the same
// date): a natural-key match adopts the incoming sync_id instead of hitting
// the UNIQUE constraint. `fkToSyncId` handles a device-local autoincrement FK
// (habit_logs.habit_id, transactions.statement_id): the payload carries the
// referenced row's sync_id instead, resolved back to the local id on apply.
export type SyncTableSpec = {
  table: string;
  columns: string[];
  // Row-identity column. Defaults to "id" (every table has an integer id
  // except category_budgets / category_overrides, whose TEXT primary key is
  // their identity). The engine keys backfill/upsert/triggers off this.
  pk?: string;
  naturalKey?: string[];
  // Match the natural key case-insensitively and trimmed (text keys typed by
  // a human on two devices — "Acme " vs "acme"). Leave unset for exact keys
  // (dates, numeric FKs).
  naturalKeyNoCase?: boolean;
  fkToSyncId?: { localColumn: string; refTable: string; payloadKey: string };
};

export type SyncDomain = "life" | "money" | "knowledge" | "system";

// A user-facing sync category. One category can cover several underlying SQL
// tables (e.g. "trackers" = habits + habit_logs). `specs` carries the full
// per-table sync mechanics; hard-excluded / informational rows leave it empty.
export type SyncCategory = {
  id: string; // stable key, used in sync_config + the API — NOT a raw table name
  label: string;
  description: string;
  domain: SyncDomain;
  hardExcluded: boolean; // true = never a toggle, filtered out server-side always
  defaultEnabled: boolean; // seed value on first migration (Reset-to-Recommended)
  risk?: string; // optional inline warning shown next to the toggle
  lockedReason?: string; // shown on hard-excluded / informational rows
  specs: SyncTableSpec[]; // underlying sync mechanics (empty = nothing flows)
};

// ---------------------------------------------------------------------------
// The registry. Order is load-bearing for FK resolution on both the migration
// side and the runSyncPass loop: a referenced table must appear before the
// table that points at it (habits before habit_logs; statements before
// transactions).
// ---------------------------------------------------------------------------

const trackersSpecs: SyncTableSpec[] = [
  {
    // The unified Tracker model (Part E folded Goals in): `source` links a
    // tracker to a built-in feed (null = manual habit), `target` is the numeric
    // goal that used to live in the now-legacy `goals` table (no longer synced).
    table: "habits",
    columns: ["name", "cadence", "goal", "source", "target"],
    naturalKey: ["name"],
  },
  {
    table: "habit_logs",
    columns: ["habit_id", "date"],
    naturalKey: ["habit_id", "date"],
    fkToSyncId: { localColumn: "habit_id", refTable: "habits", payloadKey: "habit_sync_id" },
  },
];

const tasksSpec: SyncTableSpec = {
  // Full task row incl. the board-redesign columns. gcal_event_id syncs so
  // the reconciler on the Google-connected device sees (and other devices
  // learn about) the linked event exactly once. Ranking columns sync too:
  // the deterministic ranker produces identical output on every device,
  // and the LLM pass may differ between devices — that is acceptable
  // because sync's host-stamped last-write-wins already resolves it
  // deterministically (receipt order at the host).
  // slack_task_digests is deliberately NOT here: digests are per-device-
  // process by design — only the machine with Slack configured sends, and
  // the UNIQUE(date, slot) constraint dedupes locally.
  table: "tasks",
  columns: [
    "title",
    "description",
    "due_at",
    "priority",
    "status",
    "source",
    "created_at",
    "gcal_event_id",
    "completed_at",
    "llm_rank",
    "llm_rank_source",
    "llm_suggested_priority",
    "llm_rationale",
  ],
};

const gymSpec: SyncTableSpec = {
  table: "gym_logs",
  columns: ["date", "notes"],
  naturalKey: ["date"],
};

const leetcodeSpec: SyncTableSpec = {
  table: "leetcode_stats",
  columns: ["date", "total_solved", "streak", "recent"],
  naturalKey: ["date"],
};

const networthSpec: SyncTableSpec = {
  table: "networth_snapshots",
  columns: ["date", "accounts_total", "holdings_value", "total"],
  naturalKey: ["date"],
};

const careerSpec: SyncTableSpec = {
  // Career pipeline (user-confirmed sync 2026-07-18: curated by hand, not
  // raw imported data — traffic stays inside the Tailscale mesh like every
  // other table). Natural key company+role, case-insensitive/trimmed, so
  // the same application entered on two devices pre-sync merges instead
  // of duplicating.
  table: "applications",
  columns: [
    "company",
    "role",
    "stage",
    "next_action",
    "next_action_at",
    "contact",
    "link",
    "notes",
    "date_applied",
    "created_at",
  ],
  naturalKey: ["company", "role"],
  naturalKeyNoCase: true,
};

const readingSpec: SyncTableSpec = {
  // Reading list. Natural key title+kind (case-insensitive/trimmed) —
  // author is deliberately NOT part of the key, so the same title+kind
  // with different authors would merge; accepted as unlikely for a
  // personal list, cheap to add later if it ever bites.
  table: "reading",
  columns: ["kind", "title", "author", "status", "link", "notes", "note_path", "created_at"],
  naturalKey: ["title", "kind"],
  naturalKeyNoCase: true,
};

const watchlistSpec: SyncTableSpec = {
  table: "watchlist",
  columns: ["ticker"],
  naturalKey: ["ticker"],
  naturalKeyNoCase: true,
};

const holdingsSpec: SyncTableSpec = {
  // Live per-ticker positions (user-confirmed 2026-07-18). A brokerage
  // positions import is "tombstone the missing, upsert the named" in one
  // transaction (lib/finance/holdings-import-core.ts), so a sold position's
  // tombstone propagates instead of lingering on other devices.
  // import_batch_id groups every row one import wrote — debugging aid
  // ("why did this position disappear"), not part of conflict resolution.
  // KNOWN, ACCEPTED LIMITATION: if two devices import different brokerage
  // statements before syncing with each other, resolution is per-row
  // last-write-wins, so the merged holdings set may match neither
  // statement exactly. Rare in practice (one device is usually "the"
  // import machine); revisit with a versioned-snapshot design if it bites.
  table: "holdings",
  columns: ["ticker", "shares", "cost_basis", "is_cash_equivalent", "import_batch_id"],
  naturalKey: ["ticker"],
  naturalKeyNoCase: true,
};

// --- New toggle candidates (seeded OFF; see §4/§6 of the spec) --------------

const transactionsSpecs: SyncTableSpec[] = [
  {
    // Statement containers. Synced by sync_id only — NO natural key. file_path
    // is device-local (a path on this machine's disk) and month/account_type
    // can be null, so there is no reliable cross-device identity for a
    // statement row. ACCEPTED LIMITATION: two devices that independently
    // imported the same statement before syncing keep two statement rows on
    // both devices (cosmetic, mirrors the holdings limitation). raw_text is
    // deliberately left OUT of the payload — it is the bulky, most-sensitive
    // field and nothing cross-device needs it to view transactions.
    table: "statements",
    columns: [
      "month",
      "file_path",
      "kind",
      "ending_balance",
      "balance_kind",
      "balance_label",
      "account_type",
    ],
  },
  {
    // Raw bank / credit-card transactions. Content natural key
    // (date + amount + raw_description + account_type) gives two devices that
    // imported the same statement a way to collapse identical rows instead of
    // duplicating — the §6 data-integrity prerequisite. statement_id is a
    // device-local autoincrement, so it rides the fkToSyncId swap like
    // habit_logs.habit_id (statements sync first — order matters above).
    table: "transactions",
    columns: [
      "date",
      "amount",
      "merchant",
      "category",
      "raw_description",
      "is_recurring",
      "account_type",
    ],
    naturalKey: ["date", "amount", "raw_description", "account_type"],
    fkToSyncId: { localColumn: "statement_id", refTable: "statements", payloadKey: "statement_sync_id" },
  },
];

const categoryBudgetsSpec: SyncTableSpec = {
  // TEXT primary key (category), not an integer id — declared via `pk` so the
  // engine keys row identity off it. Natural key == pk here, which is exactly
  // what we want: the same category on two devices is the same budget row.
  table: "category_budgets",
  pk: "category",
  columns: ["category", "monthly_limit"],
  naturalKey: ["category"],
};

const categoryOverridesSpec: SyncTableSpec = {
  table: "category_overrides",
  pk: "merchant",
  columns: ["merchant", "category"],
  naturalKey: ["merchant"],
  naturalKeyNoCase: true,
};

const nutritionSpec: SyncTableSpec = {
  // Meal / macro logs. Natural key date+item+source (item case-insensitive/
  // trimmed) so the same meal logged on two devices merges rather than
  // duplicating — same duplicate-risk mitigation as transactions, lower stakes.
  table: "nutrition_logs",
  columns: ["date", "item", "calories", "protein", "carbs", "fat", "source", "created_at"],
  naturalKey: ["date", "item", "source"],
  naturalKeyNoCase: true,
};

const peopleSpec: SyncTableSpec = {
  // Keep-in-touch contacts. name is already the natural key used by the
  // log_contact matching path, and UNIQUE(name) means the natural-key
  // adopt-incoming-sync_id merge (like watchlist.ticker) avoids a duplicate.
  table: "people",
  columns: ["name", "cadence_days", "last_contacted", "birthday", "gift_ideas", "notes"],
  naturalKey: ["name"],
  naturalKeyNoCase: true,
};

const bulkImportsSpec: SyncTableSpec = {
  // Append-only bulk-import history. No natural key (each paste is unique) —
  // sync_id only. Was excluded for privacy (pasted dumps can contain
  // anything); the toggle removes that restriction on request. created_task_ids
  // holds this device's local task ids, so it is only meaningful as an
  // audit/debug record on other devices, not a working bulk-undo target there.
  table: "bulk_imports",
  columns: [
    "created_at",
    "raw_input_text",
    "source_mode",
    "model_used",
    "proposed_json",
    "final_json",
    "status",
    "created_task_ids",
  ],
};

export const SYNC_CATEGORIES: SyncCategory[] = [
  // ---- Life tracking ------------------------------------------------------
  { id: "tasks", label: "Tasks", description: "Your task list and board.", domain: "life", hardExcluded: false, defaultEnabled: true, specs: [tasksSpec] },
  { id: "gym", label: "Gym visits", description: "Logged gym / workout days.", domain: "life", hardExcluded: false, defaultEnabled: true, specs: [gymSpec] },
  { id: "trackers", label: "Trackers / habits", description: "Habits and their daily logs.", domain: "life", hardExcluded: false, defaultEnabled: true, specs: trackersSpecs },
  { id: "leetcode", label: "LeetCode stats", description: "Daily solved count and streak.", domain: "life", hardExcluded: false, defaultEnabled: true, specs: [leetcodeSpec] },
  { id: "career", label: "Career pipeline", description: "Job applications and their stages.", domain: "life", hardExcluded: false, defaultEnabled: true, specs: [careerSpec] },
  { id: "people", label: "Keep-in-touch contacts", description: "People, cadences, and last-contacted dates.", domain: "life", hardExcluded: false, defaultEnabled: false, specs: [peopleSpec] },
  {
    id: "nutrition",
    label: "Meal / macro logs",
    description: "Logged meals with calories and macros.",
    domain: "life",
    hardExcluded: false,
    defaultEnabled: false,
    risk: "Merges by date + item + source, so the same meal on two devices collapses instead of duplicating.",
    specs: [nutritionSpec],
  },

  // ---- Money --------------------------------------------------------------
  { id: "networth", label: "Net worth snapshots", description: "Daily net-worth rollup snapshots.", domain: "money", hardExcluded: false, defaultEnabled: true, specs: [networthSpec] },
  { id: "watchlist", label: "Stock watchlist", description: "Tickers you're watching.", domain: "money", hardExcluded: false, defaultEnabled: true, specs: [watchlistSpec] },
  { id: "holdings", label: "Brokerage holdings", description: "Live per-ticker positions.", domain: "money", hardExcluded: false, defaultEnabled: true, specs: [holdingsSpec] },
  {
    id: "transactions",
    label: "Bank & credit card transactions",
    description: "Imported statements and their transactions.",
    domain: "money",
    hardExcluded: false,
    defaultEnabled: false,
    risk: "Transactions merge on a content key (date + amount + description + account); the statement containers themselves may show as duplicates if both devices imported the same file before syncing.",
    specs: transactionsSpecs,
  },
  { id: "category-budgets", label: "Category budgets", description: "Per-category monthly spending limits.", domain: "money", hardExcluded: false, defaultEnabled: false, specs: [categoryBudgetsSpec] },
  { id: "category-overrides", label: "Merchant categorization overrides", description: "Your manual merchant → category corrections.", domain: "money", hardExcluded: false, defaultEnabled: false, specs: [categoryOverridesSpec] },

  // ---- Knowledge ----------------------------------------------------------
  { id: "reading", label: "Reading list", description: "Books, articles, and their status.", domain: "knowledge", hardExcluded: false, defaultEnabled: true, specs: [readingSpec] },
  {
    id: "bulk-imports",
    label: "Bulk-import history",
    description: "History of pasted bulk task imports.",
    domain: "knowledge",
    hardExcluded: false,
    defaultEnabled: false,
    risk: "Pasted dumps can contain anything; this was local-only for privacy until you turn it on here.",
    specs: [bulkImportsSpec],
  },
  {
    id: "notes",
    label: "Notes / Obsidian vault",
    description: "Notes are files, not database rows — this feature can't sync them.",
    domain: "knowledge",
    hardExcluded: true,
    defaultEnabled: false,
    lockedReason:
      "Notes are files on disk (OBSIDIAN_VAULT_PATH), not rows, and the path can differ per machine. Use Obsidian Sync, Syncthing, or a synced Drive/iCloud folder for the vault itself.",
    specs: [],
  },

  // ---- System (hard-excluded, always locked) ------------------------------
  {
    id: "oauth-tokens",
    label: "OAuth credentials",
    description: "Google / mail access and refresh tokens.",
    domain: "system",
    hardExcluded: true,
    defaultEnabled: false,
    lockedReason:
      "Live, rotating credentials. Syncing a refresh token to a second device makes both copies fight over rotation and breaks the OAuth session — an actual bug generator, not a privacy tradeoff.",
    specs: [],
  },
  {
    id: "device-identity",
    label: "Device identity",
    description: "This machine's distinct sync identity.",
    domain: "system",
    hardExcluded: true,
    defaultEnabled: false,
    lockedReason:
      "This is the thing that gives each machine a distinct sync identity. Syncing it lets two devices collide identities and corrupts conflict resolution.",
    specs: [],
  },
  {
    id: "sync-bookkeeping",
    label: "Sync state & config",
    description: "Pull cursors and this page's own settings.",
    domain: "system",
    hardExcluded: true,
    defaultEnabled: false,
    lockedReason: "Pull cursors and this feature's own config are inherently per-device.",
    specs: [],
  },
];

// ---------------------------------------------------------------------------
// Derived views. SYNC_TABLES is every SYNCABLE table's spec (all
// non-hard-excluded categories, flattened in FK-safe order). It drives the
// schema migration, the triggers, the wire z.enum, and the runSyncPass loop —
// exactly as the old static array did. Whether a table actually flows on any
// given tick is a *runtime* decision (getEnabledSyncTables, in ./config.ts);
// this list is only "what CAN sync, ever".
// ---------------------------------------------------------------------------

export const SYNC_TABLES: SyncTableSpec[] = SYNC_CATEGORIES.filter((c) => !c.hardExcluded).flatMap(
  (c) => c.specs
);

// Delete propagation: every synced table carries a `deleted_at` tombstone
// column, and it syncs like any other field — a delete is just "the newest
// write happened to be a delete", stamped and conflict-resolved by the same
// host-clock `updated_at` as ordinary edits. Appended here (not per-entry)
// so a future registry addition can't forget it. Tombstoned rows are kept
// forever: purging one before every device has pulled it would let a stale
// device resurrect the row. The ONE exception to tombstoning is the
// manual-habit cascade delete (lib/tracker-delete.ts) — documented,
// intentionally irreversible, stays a hard delete.
for (const spec of SYNC_TABLES) spec.columns.push("deleted_at");

export const SYNC_TABLE_NAMES = SYNC_TABLES.map((t) => t.table) as [string, ...string[]];

// The truly-permanent exclusions, by raw table name. getEnabledSyncTables()
// subtracts these unconditionally; they are never in SYNC_TABLE_NAMES either,
// so they cannot even be named on the wire. Kept as an explicit constant so
// the test asserting "rejected even if requested" reads off one source.
export const HARD_EXCLUDED_TABLES = ["oauth_tokens", "device_meta", "sync_state", "sync_config"] as const;

export function getSyncSpec(table: string): SyncTableSpec | undefined {
  return SYNC_TABLES.find((t) => t.table === table);
}

// The full static category list, for rendering the /sync page.
export function getSyncRegistry(): SyncCategory[] {
  return SYNC_CATEGORIES;
}

// Category ids that are real toggles (everything the UI can flip + the API
// will accept in PATCH). Hard-excluded ids are deliberately absent.
export const TOGGLEABLE_CATEGORY_IDS = SYNC_CATEGORIES.filter((c) => !c.hardExcluded).map(
  (c) => c.id
) as [string, ...string[]];

export function getCategory(id: string): SyncCategory | undefined {
  return SYNC_CATEGORIES.find((c) => c.id === id);
}

// ---- wire schemas (zod at the boundary; both endpoints use these) ----------

const rowDataSchema = z.record(z.string(), z.union([z.string(), z.number(), z.null()]));

export const pushRowSchema = z.object({
  sync_id: z.uuid(),
  origin_device_id: z.string().min(1).max(100),
  data: rowDataSchema,
});

export const pushBodySchema = z.object({
  // z.enum over the registry: a table that isn't a syncable one fails
  // validation — it is impossible to even name a hard-excluded table here.
  table: z.enum(SYNC_TABLE_NAMES),
  rows: z.array(pushRowSchema).min(1).max(1000),
});

export const pullQuerySchema = z.object({
  table: z.enum(SYNC_TABLE_NAMES),
  since: z.string().max(40).optional(), // ISO cursor; absent = everything
});

export const pullRowSchema = pushRowSchema.extend({ updated_at: z.string() });

export type PushRow = z.infer<typeof pushRowSchema>;
export type PullRow = z.infer<typeof pullRowSchema>;

// ---- schema DDL, generated from the registry --------------------------------
// (Consumed by lib/db.ts so the registry literally drives the migration:
// adding a syncable table is what gives it sync columns + triggers. Note this
// covers every *syncable* table whether or not it is currently enabled — the
// bookkeeping columns must exist before a runtime toggle can turn it on.)

// Sync bookkeeping columns added to every syncable table:
//   sync_id          cross-device row identity (UUID; local id stays internal)
//   updated_at       ordering timestamp — HOST-assigned once synced; local
//                    clock only until first push (devices drift, so conflict
//                    resolution keys off host stamps exclusively)
//   origin_device_id which device created the row
//   sync_dirty       1 = has local changes the host hasn't confirmed
//   deleted_at       tombstone: non-null = deleted (propagates like an edit);
//                    NULL backfill means nothing is retroactively deleted
export function syncColumnMigrations(): Array<{ table: string; column: string; ddl: string }> {
  return SYNC_TABLES.flatMap(({ table }) => [
    { table, column: "sync_id", ddl: "sync_id TEXT" },
    { table, column: "updated_at", ddl: "updated_at TEXT" },
    { table, column: "origin_device_id", ddl: "origin_device_id TEXT" },
    { table, column: "sync_dirty", ddl: "sync_dirty INTEGER NOT NULL DEFAULT 1" },
    { table, column: "deleted_at", ddl: "deleted_at TEXT" },
  ]);
}

// Triggers keep sync bookkeeping correct WITHOUT touching any existing write
// path (sync is additive):
//   - AFTER INSERT stamps updated_at with the local clock when the writer
//     didn't provide one (app inserts). Sync-applied inserts provide it.
//   - AFTER UPDATE marks the row dirty + bumps updated_at, but ONLY when the
//     update changed neither updated_at nor sync_dirty — i.e. it was a normal
//     app write. Sync operations always set one of those two columns, so they
//     never re-mark rows dirty. (SQLite recursive_triggers is off by default,
//     so the trigger's own UPDATE can't re-fire it.)
export function syncTriggerSql(): string[] {
  const now = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`;
  return SYNC_TABLES.flatMap((spec) => {
    const { table } = spec;
    const pk = spec.pk ?? "id";
    return [
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_${table}_sync_id ON ${table}(sync_id)`,
      `CREATE TRIGGER IF NOT EXISTS trg_${table}_sync_insert
     AFTER INSERT ON ${table}
     WHEN NEW.updated_at IS NULL
     BEGIN
       UPDATE ${table} SET updated_at = ${now} WHERE ${pk} = NEW.${pk};
     END`,
      `CREATE TRIGGER IF NOT EXISTS trg_${table}_sync_update
     AFTER UPDATE ON ${table}
     WHEN NEW.updated_at IS OLD.updated_at AND NEW.sync_dirty = OLD.sync_dirty
     BEGIN
       UPDATE ${table} SET sync_dirty = 1, updated_at = ${now} WHERE ${pk} = NEW.${pk};
     END`,
    ];
  });
}
