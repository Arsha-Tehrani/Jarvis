import type { ChatMeta } from "@/lib/llm";

// The single agent_log write point. Everything the route does — success,
// validation failure, execution failure, total LLM failure, or a pending
// confirmation — funnels through logAgentTurn so that exactly one row is
// written per turn and no branch can silently skip logging (a calmly-degraded
// response with nothing logged is invisible later). Never throws: a failed log
// write is reported to the console, never bubbled into the user's turn.

export type AgentTurnStatus =
  | "ok"
  | "validation_error"
  | "execution_error"
  | "llm_error"
  | "pending_confirmation";

// How the turn arrived. voice_ptt is reserved for a future push-to-talk path;
// today's UI emits only "typed" and "voice_mic".
export type AgentInputSource = "typed" | "voice_mic" | "voice_ptt";

export type AgentTurnLog = {
  userText: string;
  inputSource: AgentInputSource;
  status: AgentTurnStatus;
  errorMessage?: string | null;
  // Raw tool calls the model returned, BEFORE zod validation (null when the
  // model returned none, or the LLM call itself failed).
  requestedCalls?: unknown;
  // Calls that actually ran, with validated args + result. This is the
  // canonical undo source (lib/revert.ts).
  executedCalls?: unknown;
  result: string;
  meta?: ChatMeta | null;
};

// Structural db type so this stays testable against in-memory sqlite.
type DbLike = {
  prepare(sql: string): {
    run(...args: unknown[]): unknown;
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
  };
};

export function logAgentTurn(db: DbLike, entry: AgentTurnLog): void {
  const meta = entry.meta ?? null;
  try {
    db.prepare(
      `INSERT INTO agent_log
         (user_text, result, status, error_message, input_source,
          requested_calls, executed_calls,
          provider, model, latency_ms, input_tokens, output_tokens, cost_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      entry.userText,
      entry.result,
      entry.status,
      entry.errorMessage ?? null,
      entry.inputSource,
      entry.requestedCalls == null ? null : JSON.stringify(entry.requestedCalls),
      entry.executedCalls == null ? null : JSON.stringify(entry.executedCalls),
      meta?.provider ?? null,
      meta?.model ?? null,
      meta?.latencyMs ?? null,
      meta?.inputTokens ?? null,
      meta?.outputTokens ?? null,
      meta?.costUsd ?? null
    );
  } catch (err) {
    // The legacy tool_calls column is intentionally not written anymore
    // (executed_calls is canonical); it stays NULL for new rows. A write
    // failure must never break the user's turn.
    console.error("agent_log write failed:", err);
  }
}

// ---- read side (used by the /api/agent-log routes; pure + db-injected) ------

export type AgentLogFilters = {
  status?: AgentTurnStatus;
  since?: string; // YYYY-MM-DD
  q?: string; // substring over user_text + error_message
  limit: number;
  offset: number;
};

export type AgentLogRow = {
  id: number;
  created_at: string;
  input_source: string | null;
  user_text: string;
  requested_calls: string | null;
  executed_calls: string | null;
  status: string | null;
  error_message: string | null;
  provider: string | null;
  model: string | null;
  latency_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
};

function buildWhere(f: AgentLogFilters): { sql: string; args: (string | number)[] } {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (f.status) {
    where.push("status = ?");
    args.push(f.status);
  }
  if (f.since) {
    where.push("substr(created_at, 1, 10) >= ?");
    args.push(f.since);
  }
  if (f.q) {
    where.push("(user_text LIKE ? OR error_message LIKE ?)");
    args.push(`%${f.q}%`, `%${f.q}%`);
  }
  return { sql: where.length ? `WHERE ${where.join(" AND ")}` : "", args };
}

export function queryAgentLog(
  db: DbLike,
  filters: AgentLogFilters
): { rows: AgentLogRow[]; total: number } {
  const { sql: whereSql, args } = buildWhere(filters);
  const rows = db
    .prepare(
      `SELECT id, created_at, input_source, user_text, requested_calls, executed_calls,
              status, error_message, provider, model, latency_ms,
              input_tokens, output_tokens, cost_usd
       FROM agent_log
       ${whereSql}
       ORDER BY id DESC
       LIMIT ? OFFSET ?`
    )
    .all(...args, filters.limit, filters.offset) as AgentLogRow[];
  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM agent_log ${whereSql}`).get(...args) as { n: number }
  ).n;
  return { rows, total };
}

// Count of error turns since an ISO instant (for the Log button's 24h badge).
export function countRecentAgentErrors(db: DbLike, sinceIso: string): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM agent_log
         WHERE created_at >= ?
           AND status IN ('validation_error', 'execution_error', 'llm_error')`
      )
      .get(sinceIso) as { n: number }
  ).n;
}
