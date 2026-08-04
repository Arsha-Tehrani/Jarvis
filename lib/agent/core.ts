import { z } from "zod";
import type { ChatMessage, ChatResult, LlmToolDef } from "@/lib/llm";
import type { Tool } from "@/lib/tools";
import type { AgentInputSource, AgentTurnLog, AgentTurnStatus } from "./log";

// The agent turn, extracted from the route so every exit path funnels through
// ONE log call (deps.log) and the outcomes are unit-testable without Ollama or
// NextRequest. The route (app/api/agent/route.ts) is a thin wrapper that
// supplies real deps; tests supply fakes.

export type ExecutedCall = { name: string; args: unknown; result: string };
export type PendingCall = { name: string; args: unknown; description: string };
// Every validated call we tried to run, logged as executed_calls: success
// carries `result`, a handler that threw carries `error` instead. Undo
// (lib/revert.ts) only ever acts on entries that have a `result`, so a failed
// attempt is visible in the log without being a revert target.
export type AttemptedCall = { name: string; args: unknown; result?: string; error?: string };

export type TurnDeps = {
  chat: (a: { messages: ChatMessage[]; tools?: LlmToolDef[] }) => Promise<ChatResult>;
  toolDefsForLlm: () => LlmToolDef[];
  getTool: (name: string) => Tool | undefined;
  recentTranscript: () => string;
  // The single write point — the route binds this to logAgentTurn(getDb(), …).
  log: (entry: AgentTurnLog) => void;
  // Debounced sync nudge, called only when something actually executed.
  onExecuted?: () => void;
  now?: () => Date;
};

export type TurnResult = {
  reply: string;
  pending?: PendingCall[];
  status: AgentTurnStatus;
};

export function buildSystemPrompt(today: Date, transcript: string): string {
  return [
    [
      "You are Jarvis, the user's personal dashboard assistant.",
      `Today is ${today.toISOString().slice(0, 10)} (${today.toLocaleDateString("en-US", { weekday: "long" })}).`,
      "When the user asks you to do something a tool covers, call the tool. Resolve relative dates ('Friday', 'tomorrow') to concrete ISO dates yourself.",
      "If the user asks to undo/revert something, call the revert_action tool.",
      "If no tool applies, answer briefly in plain text.",
    ].join(" "),
    transcript,
  ]
    .filter(Boolean)
    .join("\n\n");
}

// Single terminal status for the turn. Precedence surfaces the most severe
// problem first: an execution failure outranks a validation rejection, which
// outranks a benign pending-confirmation, which outranks a clean ok.
function resolveStatus(
  sawExecutionError: boolean,
  sawValidationError: boolean,
  hasPending: boolean
): AgentTurnStatus {
  if (sawExecutionError) return "execution_error";
  if (sawValidationError) return "validation_error";
  if (hasPending) return "pending_confirmation";
  return "ok";
}

export async function runAgentTurn(
  text: string,
  inputSource: AgentInputSource,
  deps: TurnDeps
): Promise<TurnResult> {
  const today = deps.now?.() ?? new Date();
  const systemPrompt = buildSystemPrompt(today, deps.recentTranscript());

  let llmResult: ChatResult;
  try {
    llmResult = await deps.chat({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: text },
      ],
      tools: deps.toolDefsForLlm(),
    });
  } catch (err) {
    // Ollama down / connection refused / timeout — the turn still logs, so a
    // degraded response isn't invisible later.
    const message = err instanceof Error ? err.message : "LLM call failed";
    deps.log({
      userText: text,
      inputSource,
      status: "llm_error",
      errorMessage: message,
      requestedCalls: null,
      executedCalls: null,
      result: message,
    });
    return { reply: message, status: "llm_error" };
  }

  const requestedCalls = llmResult.toolCalls ?? [];
  const attempted: AttemptedCall[] = [];
  const succeeded: ExecutedCall[] = [];
  const pending: PendingCall[] = [];
  const rejected: string[] = [];
  const errorDetails: string[] = [];
  let sawValidationError = false;
  let sawExecutionError = false;

  for (const call of requestedCalls) {
    const tool = deps.getTool(call.name);
    if (!tool) {
      const msg = `Unknown tool "${call.name}" — refused.`;
      rejected.push(msg);
      errorDetails.push(msg);
      sawValidationError = true;
      continue;
    }
    // Non-negotiable #1: never execute an unvalidated call.
    const parsed = tool.schema.safeParse(call.args);
    if (!parsed.success) {
      const msg = `Invalid arguments for ${tool.name}: ${z.prettifyError(parsed.error)}`;
      rejected.push(msg);
      errorDetails.push(msg);
      sawValidationError = true;
      continue;
    }
    if (tool.requiresConfirm) {
      pending.push({ name: tool.name, args: parsed.data, description: tool.description });
      continue;
    }
    try {
      const result = await tool.handler(parsed.data);
      attempted.push({ name: tool.name, args: parsed.data, result });
      succeeded.push({ name: tool.name, args: parsed.data, result });
    } catch (err) {
      const detail = err instanceof Error ? err.message : "unknown error";
      attempted.push({ name: tool.name, args: parsed.data, error: detail });
      rejected.push(`${tool.name} failed: ${detail}`);
      errorDetails.push(`${tool.name} failed: ${detail}`);
      sawExecutionError = true;
    }
  }

  const replyParts: string[] = [];
  if (llmResult.text) replyParts.push(llmResult.text);
  replyParts.push(...succeeded.map((e) => e.result));
  replyParts.push(...rejected);
  if (pending.length > 0) {
    replyParts.push(`${pending.length} action(s) need your confirmation before they run.`);
  }
  const reply = replyParts.join("\n") || "I didn't find anything to do.";

  const status = resolveStatus(sawExecutionError, sawValidationError, pending.length > 0);
  deps.log({
    userText: text,
    inputSource,
    status,
    errorMessage: errorDetails.length ? errorDetails.join("\n") : null,
    requestedCalls: requestedCalls.length ? requestedCalls : null,
    // Includes failed attempts (with `error`) for debugging; revert ignores
    // any entry without a `result`.
    executedCalls: attempted.length ? attempted : null,
    result: reply,
    meta: llmResult.meta ?? null,
  });
  if (succeeded.length > 0) deps.onExecuted?.();

  return { reply, pending: pending.length > 0 ? pending : undefined, status };
}

// Second leg of the confirm flow: re-validate and execute the confirmed calls.
// No LLM is involved, so meta stays null.
export async function runAgentConfirm(
  originalText: string,
  confirmedCalls: Array<{ name: string; args: unknown }>,
  inputSource: AgentInputSource,
  deps: TurnDeps
): Promise<{ reply: string; status: AgentTurnStatus }> {
  const attempted: AttemptedCall[] = [];
  const succeeded: ExecutedCall[] = [];
  const rejected: string[] = [];
  const errorDetails: string[] = [];
  let sawValidationError = false;
  let sawExecutionError = false;

  for (const call of confirmedCalls) {
    const tool = deps.getTool(call.name);
    if (!tool) {
      const msg = `Unknown tool "${call.name}" — refused.`;
      rejected.push(msg);
      errorDetails.push(msg);
      sawValidationError = true;
      continue;
    }
    // Re-validate on the confirm leg too; never trust round-tripped args.
    const parsed = tool.schema.safeParse(call.args);
    if (!parsed.success) {
      const msg = `Invalid arguments for ${tool.name}: ${z.prettifyError(parsed.error)}`;
      rejected.push(msg);
      errorDetails.push(msg);
      sawValidationError = true;
      continue;
    }
    try {
      const result = await tool.handler(parsed.data);
      attempted.push({ name: tool.name, args: parsed.data, result });
      succeeded.push({ name: tool.name, args: parsed.data, result });
    } catch (err) {
      const detail = err instanceof Error ? err.message : "unknown error";
      attempted.push({ name: tool.name, args: parsed.data, error: detail });
      rejected.push(`${tool.name} failed: ${detail}`);
      errorDetails.push(`${tool.name} failed: ${detail}`);
      sawExecutionError = true;
    }
  }

  const reply =
    [...succeeded.map((e) => e.result), ...rejected].join("\n") || "Nothing was executed.";
  const status = resolveStatus(sawExecutionError, sawValidationError, false);

  deps.log({
    userText: `[CONFIRMED] ${originalText}`,
    inputSource,
    status,
    errorMessage: errorDetails.length ? errorDetails.join("\n") : null,
    requestedCalls: confirmedCalls,
    executedCalls: attempted.length ? attempted : null,
    result: reply,
    meta: null,
  });
  if (succeeded.length > 0) deps.onExecuted?.();

  return { reply, status };
}
