import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { chat } from "@/lib/llm";
import { getTool, toolDefsForLlm } from "@/lib/tools";

// POST { text } — one agent turn: LLM decides tool calls, we validate each
// against its zod schema before executing. Tools with requiresConfirm are
// returned as pending instead of executed.
// POST { confirmedCalls, originalText } — second leg of the confirm flow:
// args are re-validated and executed.

const turnSchema = z.object({ text: z.string().min(1).max(4000) });

const confirmSchema = z.object({
  originalText: z.string().min(1).max(4000),
  confirmedCalls: z
    .array(z.object({ name: z.string(), args: z.unknown() }))
    .min(1),
});

type ExecutedCall = { name: string; args: unknown; result: string };
type PendingCall = { name: string; args: unknown; description: string };

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);

  const confirm = confirmSchema.safeParse(body);
  if (confirm.success) return handleConfirm(confirm.data);

  const turn = turnSchema.safeParse(body);
  if (!turn.success) {
    return NextResponse.json({ error: z.prettifyError(turn.error) }, { status: 400 });
  }
  return handleTurn(turn.data.text);
}

async function handleTurn(text: string) {
  const today = new Date();
  const systemPrompt = [
    "You are Jarvis, the user's personal dashboard assistant.",
    `Today is ${today.toISOString().slice(0, 10)} (${today.toLocaleDateString("en-US", { weekday: "long" })}).`,
    "When the user asks you to do something a tool covers, call the tool. Resolve relative dates ('Friday', 'tomorrow') to concrete ISO dates yourself.",
    "If no tool applies, answer briefly in plain text.",
  ].join(" ");

  let llmResult;
  try {
    llmResult = await chat({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: text },
      ],
      tools: toolDefsForLlm(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "LLM call failed";
    logTurn(text, null, `ERROR: ${message}`);
    return NextResponse.json({ error: message }, { status: 502 });
  }

  const executed: ExecutedCall[] = [];
  const pending: PendingCall[] = [];
  const rejected: string[] = [];

  for (const call of llmResult.toolCalls ?? []) {
    const tool = getTool(call.name);
    if (!tool) {
      rejected.push(`Unknown tool "${call.name}" — refused.`);
      continue;
    }
    // Non-negotiable #1: never execute an unvalidated call.
    const parsed = tool.schema.safeParse(call.args);
    if (!parsed.success) {
      rejected.push(
        `Invalid arguments for ${tool.name}: ${z.prettifyError(parsed.error)}`
      );
      continue;
    }
    if (tool.requiresConfirm) {
      pending.push({
        name: tool.name,
        args: parsed.data,
        description: tool.description,
      });
      continue;
    }
    try {
      const result = await tool.handler(parsed.data);
      executed.push({ name: tool.name, args: parsed.data, result });
    } catch (err) {
      rejected.push(
        `${tool.name} failed: ${err instanceof Error ? err.message : "unknown error"}`
      );
    }
  }

  const replyParts: string[] = [];
  if (llmResult.text) replyParts.push(llmResult.text);
  replyParts.push(...executed.map((e) => e.result));
  replyParts.push(...rejected);
  if (pending.length > 0) {
    replyParts.push(
      `${pending.length} action(s) need your confirmation before they run.`
    );
  }
  const reply = replyParts.join("\n") || "I didn't find anything to do.";

  logTurn(
    text,
    { toolCalls: llmResult.toolCalls ?? [], executed, pending, rejected },
    reply
  );

  return NextResponse.json({
    reply,
    pending: pending.length > 0 ? pending : undefined,
  });
}

async function handleConfirm(data: z.infer<typeof confirmSchema>) {
  const executed: ExecutedCall[] = [];
  const rejected: string[] = [];

  for (const call of data.confirmedCalls) {
    const tool = getTool(call.name);
    if (!tool) {
      rejected.push(`Unknown tool "${call.name}" — refused.`);
      continue;
    }
    // Re-validate on the confirm leg too; never trust round-tripped args.
    const parsed = tool.schema.safeParse(call.args);
    if (!parsed.success) {
      rejected.push(
        `Invalid arguments for ${tool.name}: ${z.prettifyError(parsed.error)}`
      );
      continue;
    }
    try {
      const result = await tool.handler(parsed.data);
      executed.push({ name: tool.name, args: parsed.data, result });
    } catch (err) {
      rejected.push(
        `${tool.name} failed: ${err instanceof Error ? err.message : "unknown error"}`
      );
    }
  }

  const reply =
    [...executed.map((e) => e.result), ...rejected].join("\n") ||
    "Nothing was executed.";

  logTurn(
    `[CONFIRMED] ${data.originalText}`,
    { executed, rejected },
    reply
  );

  return NextResponse.json({ reply });
}

function logTurn(userText: string, toolCalls: unknown, result: string) {
  try {
    getDb()
      .prepare(
        "INSERT INTO agent_log (user_text, tool_calls, result) VALUES (?, ?, ?)"
      )
      .run(userText, toolCalls == null ? null : JSON.stringify(toolCalls), result);
  } catch (err) {
    console.error("agent_log write failed:", err);
  }
}
