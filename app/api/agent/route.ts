import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { runAgentConfirm, runAgentTurn, type TurnDeps } from "@/lib/agent/core";
import { logAgentTurn } from "@/lib/agent/log";
import { recentTranscript } from "@/lib/agent-memory";
import { getDb } from "@/lib/db";
import { chat } from "@/lib/llm";
import { queueSyncPush } from "@/lib/sync/client";
import { getTool, toolDefsForLlm } from "@/lib/tools";

// POST { text, source? } — one agent turn: the LLM decides tool calls, each is
// validated against its zod schema before executing, and the whole turn is
// logged to agent_log with a terminal status (ok / validation_error /
// execution_error / llm_error / pending_confirmation) — no branch skips it.
// POST { confirmedCalls, originalText, source? } — second leg of the confirm
// flow: args are re-validated and executed.
//
// This route is a thin wrapper: all orchestration + the single log call live
// in lib/agent/core.ts, so the guarantee "exactly one row per turn" is
// structural, not something each branch here has to remember.

const sourceSchema = z.enum(["typed", "voice_mic", "voice_ptt"]).default("typed");

const turnSchema = z.object({
  text: z.string().min(1).max(4000),
  source: sourceSchema,
});

const confirmSchema = z.object({
  originalText: z.string().min(1).max(4000),
  confirmedCalls: z.array(z.object({ name: z.string(), args: z.unknown() })).min(1),
  source: sourceSchema,
});

function makeDeps(): TurnDeps {
  return {
    chat,
    toolDefsForLlm,
    getTool,
    recentTranscript,
    log: (entry) => logAgentTurn(getDb(), entry),
    onExecuted: queueSyncPush,
  };
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);

  const confirm = confirmSchema.safeParse(body);
  if (confirm.success) {
    const { reply } = await runAgentConfirm(
      confirm.data.originalText,
      confirm.data.confirmedCalls,
      confirm.data.source,
      makeDeps()
    );
    return NextResponse.json({ reply });
  }

  const turn = turnSchema.safeParse(body);
  if (!turn.success) {
    return NextResponse.json({ error: z.prettifyError(turn.error) }, { status: 400 });
  }

  const result = await runAgentTurn(turn.data.text, turn.data.source, makeDeps());
  // The LLM-call failure keeps its historical 502 + {error} shape (the chat
  // card renders it as an error line); everything else is a normal 200.
  if (result.status === "llm_error") {
    return NextResponse.json({ error: result.reply }, { status: 502 });
  }
  return NextResponse.json({
    reply: result.reply,
    pending: result.pending,
  });
}
