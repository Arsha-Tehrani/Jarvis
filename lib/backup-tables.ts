// The single list of tables that backup exports and restore loads.
// oauth_tokens is deliberately ABSENT — backups must be storable without
// leaking live Google credentials, and restore must never clobber them.
// device_meta is also ABSENT: it holds this machine's sync identity, and
// restoring a backup onto a second machine must not clone it. (SYNC_AUTH_TOKEN
// lives only in .env.local, like all secrets — never in any table.)
// bulk_imports is also deliberately ABSENT: its raw_input_text/proposed_json
// hold pasted personal content verbatim (health/legal/financial detail — the
// category Notes/Finance/Mail keep local-only), and a restore-target machine
// seeing that is a real exposure surface a plain task list isn't. The tasks
// it created ARE backed up (they're in `tasks`).
// Pure constant (no imports) so the standalone scripts/ can share it.

export const BACKUP_TABLES = [
  "tasks",
  "agent_log",
  "reverted_actions",
  "network_log",
  "gym_logs",
  "leetcode_stats",
  "transactions",
  "statements",
  "goals",
  "category_budgets",
  "holdings",
  "watchlist",
  "calendar_cache",
  "health_logs",
  "habits",
  "habit_logs",
  "mail_accounts",
  "mail_messages",
  "settings",
  "accounts",
  "networth_snapshots",
  "people",
  "reading",
  "nutrition_logs",
  "goodnotes_sync_state",
  "applications",
  "sync_state",
  // Device-local digest markers (never synced) — backed up so a same-machine
  // restore doesn't re-send today's digests.
  "slack_task_digests",
] as const;
