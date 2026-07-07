import { getDb } from "@/lib/db";

// Rolling-window conversation memory for /api/agent. Every turn is already
// logged to agent_log; this reads the last few turns back and formats them
// as a compact transcript for the system prompt. The tool_calls JSON column
// is deliberately NOT included — it's large and the reply text already says
// what happened. Failure here must never block a turn (memory is garnish).

const WINDOW_TURNS = 8;
const MAX_FIELD_CHARS = 300;

type TurnRow = { user_text: string; result: string | null };

function clip(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > MAX_FIELD_CHARS
    ? `${oneLine.slice(0, MAX_FIELD_CHARS - 1)}…`
    : oneLine;
}

export function recentTranscript(limit = WINDOW_TURNS): string {
  let rows: TurnRow[];
  try {
    rows = getDb()
      .prepare(
        "SELECT user_text, result FROM agent_log ORDER BY id DESC LIMIT ?"
      )
      .all(limit) as TurnRow[];
  } catch (err) {
    console.error("[agent] memory read failed (continuing without):", err);
    return "";
  }
  if (rows.length === 0) return "";

  const lines: string[] = [];
  for (const row of rows.reverse()) {
    lines.push(`User: ${clip(row.user_text)}`);
    if (row.result) lines.push(`Jarvis: ${clip(row.result)}`);
  }
  return [
    "Recent conversation (oldest first) — use it to resolve references like 'that task' or 'undo that':",
    ...lines,
  ].join("\n");
}
