import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import { z } from "zod";
import { runAgentConfirm, runAgentTurn, type TurnDeps } from "../lib/agent/core.ts";
import { logAgentTurn, queryAgentLog } from "../lib/agent/log.ts";
import type { ChatResult } from "../lib/llm.ts";
import type { Tool } from "../lib/tools.ts";

// The agent turn is exercised against in-memory sqlite with fake chat/tools —
// no Ollama, no NextRequest. The invariant under test: every exit path writes
// exactly one agent_log row with the right status.

function freshDb(): InstanceType<typeof Database> {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE agent_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_text TEXT NOT NULL,
    tool_calls TEXT,
    result TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    provider TEXT, model TEXT, latency_ms INTEGER,
    input_tokens INTEGER, output_tokens INTEGER, cost_usd REAL,
    status TEXT, error_message TEXT, input_source TEXT,
    requested_calls TEXT, executed_calls TEXT
  )`);
  return db;
}

function fakeTool(over: Partial<Tool> & Pick<Tool, "name">): Tool {
  return {
    description: "",
    schema: z.object({}),
    requiresConfirm: false,
    handler: () => "ok",
    ...over,
  } as Tool;
}

function makeDeps(
  db: InstanceType<typeof Database>,
  tools: Record<string, Tool>,
  chat: TurnDeps["chat"]
): TurnDeps {
  return {
    chat,
    toolDefsForLlm: () => [],
    getTool: (n) => tools[n],
    recentTranscript: () => "",
    log: (entry) => logAgentTurn(db, entry),
    onExecuted: () => {},
    now: () => new Date("2026-07-22T12:00:00.000Z"),
  };
}

function allRows(db: InstanceType<typeof Database>) {
  return queryAgentLog(db, { limit: 50, offset: 0 }).rows;
}

// ---- §7: every exit path logs exactly one row with the right status ---------

test("chat() throwing logs exactly one llm_error row with an error message", async () => {
  const db = freshDb();
  const deps = makeDeps(db, {}, async () => {
    throw new Error("Ollama unreachable: fetch failed");
  });
  const res = await runAgentTurn("what's up", "typed", deps);
  assert.equal(res.status, "llm_error");
  const rows = allRows(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "llm_error");
  assert.ok(rows[0].error_message?.includes("Ollama unreachable"));
  assert.equal(rows[0].executed_calls, null);
  assert.equal(rows[0].input_source, "typed");
});

test("a tool call failing zod validation logs validation_error with requested_calls, no executed_calls", async () => {
  const db = freshDb();
  const tool = fakeTool({ name: "add_task", schema: z.object({ title: z.string().min(1) }) });
  const chat: TurnDeps["chat"] = async () =>
    ({ toolCalls: [{ id: "1", name: "add_task", args: {} }] }) as ChatResult;
  await runAgentTurn("add a task", "typed", makeDeps(db, { add_task: tool }, chat));

  const rows = allRows(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "validation_error");
  assert.equal(rows[0].executed_calls, null);
  assert.ok(rows[0].requested_calls?.includes("add_task"), "requested_calls holds what the model asked");
  assert.ok(rows[0].error_message && rows[0].error_message.length > 0);
});

test("a validated tool call whose handler throws logs execution_error with the attempt", async () => {
  const db = freshDb();
  const tool = fakeTool({
    name: "add_task",
    schema: z.object({ title: z.string() }),
    handler: () => {
      throw new Error("SQLITE_CONSTRAINT: NOT NULL");
    },
  });
  const chat: TurnDeps["chat"] = async () =>
    ({ toolCalls: [{ id: "1", name: "add_task", args: { title: "x" } }] }) as ChatResult;
  await runAgentTurn("add a task", "typed", makeDeps(db, { add_task: tool }, chat));

  const rows = allRows(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "execution_error");
  assert.ok(rows[0].error_message?.includes("SQLITE_CONSTRAINT"));
  const executed = JSON.parse(rows[0].executed_calls ?? "null") as Array<{ error?: string; result?: string }>;
  assert.equal(executed.length, 1, "the attempted call is recorded");
  assert.ok(executed[0].error, "attempt carries error, not result");
  assert.equal(executed[0].result, undefined);
});

test("a clean turn logs status ok with executed_calls carrying the result", async () => {
  const db = freshDb();
  const tool = fakeTool({
    name: "add_task",
    schema: z.object({ title: z.string() }),
    handler: () => "Added task.",
  });
  const chat: TurnDeps["chat"] = async () =>
    ({
      toolCalls: [{ id: "1", name: "add_task", args: { title: "x" } }],
      meta: { provider: "ollama", model: "llama3.1:8b", latencyMs: 42, inputTokens: null, outputTokens: null, costUsd: 0 },
    }) as ChatResult;
  await runAgentTurn("add a task", "voice_mic", makeDeps(db, { add_task: tool }, chat));

  const rows = allRows(db);
  assert.equal(rows[0].status, "ok");
  assert.equal(rows[0].input_source, "voice_mic");
  assert.equal(rows[0].model, "llama3.1:8b");
  const executed = JSON.parse(rows[0].executed_calls ?? "null") as Array<{ result?: string }>;
  assert.equal(executed[0].result, "Added task.");
});

test("a requiresConfirm tool logs pending_confirmation and runs nothing", async () => {
  const db = freshDb();
  const tool = fakeTool({
    name: "set_goal",
    schema: z.object({ target: z.number() }),
    requiresConfirm: true,
    handler: () => "should not run",
  });
  const chat: TurnDeps["chat"] = async () =>
    ({ toolCalls: [{ id: "1", name: "set_goal", args: { target: 5 } }] }) as ChatResult;
  const res = await runAgentTurn("set my goal", "typed", makeDeps(db, { set_goal: tool }, chat));

  assert.ok(res.pending && res.pending.length === 1);
  const rows = allRows(db);
  assert.equal(rows[0].status, "pending_confirmation");
  assert.equal(rows[0].executed_calls, null);
});

test("the confirm leg executes and logs [CONFIRMED] with status ok", async () => {
  const db = freshDb();
  const tool = fakeTool({
    name: "set_goal",
    schema: z.object({ target: z.number() }),
    requiresConfirm: true,
    handler: () => "Goal set.",
  });
  await runAgentConfirm(
    "set my goal",
    [{ name: "set_goal", args: { target: 5 } }],
    "typed",
    makeDeps(db, { set_goal: tool }, async () => ({}) as ChatResult)
  );
  const rows = allRows(db);
  assert.equal(rows[0].status, "ok");
  assert.ok(rows[0].user_text.startsWith("[CONFIRMED]"));
});

// ---- §7: GET filtering by status returns only matching rows -----------------

test("queryAgentLog filters by status", async () => {
  const db = freshDb();
  logAgentTurn(db, { userText: "a", inputSource: "typed", status: "ok", result: "r" });
  logAgentTurn(db, { userText: "b", inputSource: "typed", status: "validation_error", errorMessage: "bad", result: "r" });
  logAgentTurn(db, { userText: "c", inputSource: "typed", status: "validation_error", errorMessage: "bad2", result: "r" });
  logAgentTurn(db, { userText: "d", inputSource: "typed", status: "execution_error", errorMessage: "boom", result: "r" });

  const { rows, total } = queryAgentLog(db, { status: "validation_error", limit: 50, offset: 0 });
  assert.equal(total, 2);
  assert.ok(rows.every((r) => r.status === "validation_error"));

  // Substring search hits user_text and error_message.
  const byText = queryAgentLog(db, { q: "boom", limit: 50, offset: 0 });
  assert.equal(byText.rows.length, 1);
  assert.equal(byText.rows[0].user_text, "d");
});
