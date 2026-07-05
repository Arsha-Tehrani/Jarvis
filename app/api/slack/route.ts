import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  QUESTION_IDS,
  enabledQuestions,
  isSlackConfigured,
  sendMorningCheckin,
  setEnabledQuestions,
} from "@/lib/slack";

const postSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("set_questions"),
    questions: z.object({
      sleep: z.boolean(),
      gym: z.boolean(),
      leetcode: z.boolean(),
    }),
  }),
  z.object({ action: z.literal("send_now") }),
]);

export async function GET() {
  return NextResponse.json({
    configured: isSlackConfigured(),
    questions: enabledQuestions(),
    questionIds: QUESTION_IDS,
  });
}

export async function POST(req: NextRequest) {
  const parsed = postSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: z.prettifyError(parsed.error) }, { status: 400 });
  }
  if (parsed.data.action === "set_questions") {
    setEnabledQuestions(parsed.data.questions);
    return NextResponse.json({ questions: enabledQuestions() });
  }
  if (!isSlackConfigured()) {
    return NextResponse.json(
      { error: "Set SLACK_BOT_TOKEN and SLACK_USER_ID in .env.local first" },
      { status: 409 }
    );
  }
  try {
    const result = await sendMorningCheckin(true);
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Slack send failed";
    console.error("[slack] send_now failed:", err);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
