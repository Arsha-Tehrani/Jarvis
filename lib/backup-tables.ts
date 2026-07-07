// The single list of tables that backup exports and restore loads.
// oauth_tokens is deliberately ABSENT — backups must be storable without
// leaking live Google credentials, and restore must never clobber them.
// Pure constant (no imports) so the standalone scripts/ can share it.

export const BACKUP_TABLES = [
  "tasks",
  "agent_log",
  "reverted_actions",
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
] as const;
