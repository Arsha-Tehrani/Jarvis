import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import {
  GmailNotConfiguredError,
  GmailNotConnectedError,
  buildGmailAuthUrl,
  createDraftReply,
  disconnectGmailAccount,
  isGmailConfigured,
  listMailAccounts,
  makeTaskFromMessage,
  pollAccount,
  triagePending,
} from "@/lib/mail";

const postSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("connect") }),
  z.object({ action: z.literal("poll") }),
  z.object({
    action: z.literal("draft"),
    account: z.string().min(1),
    gmail_id: z.string().min(1),
  }),
  z.object({
    action: z.literal("make_task"),
    account: z.string().min(1),
    gmail_id: z.string().min(1),
  }),
  z.object({ action: z.literal("disconnect"), email: z.string().min(1) }),
]);

export async function GET() {
  const messages = getDb()
    .prepare(
      `SELECT account, gmail_id, sender, subject, snippet, received_at,
              importance, importance_reason, category, is_read
       FROM mail_messages ORDER BY received_at DESC LIMIT 200`
    )
    .all();
  return NextResponse.json({
    configured: isGmailConfigured(),
    accounts: listMailAccounts(),
    messages,
  });
}

export async function POST(req: NextRequest) {
  const parsed = postSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: z.prettifyError(parsed.error) }, { status: 400 });
  }
  const body = parsed.data;

  try {
    switch (body.action) {
      case "connect": {
        const state = crypto.randomBytes(16).toString("hex");
        const res = NextResponse.json({ authUrl: buildGmailAuthUrl(state) });
        res.cookies.set("gmail_oauth_state", state, {
          httpOnly: true,
          sameSite: "lax",
          maxAge: 600,
          path: "/",
        });
        return res;
      }
      case "poll": {
        const results: Record<string, number | string> = {};
        for (const account of listMailAccounts()) {
          try {
            results[account.email] = await pollAccount(account.email);
          } catch (err) {
            results[account.email] = err instanceof Error ? err.message : "failed";
          }
        }
        let triaged = 0;
        let triageError: string | undefined;
        try {
          triaged = await triagePending();
        } catch (err) {
          triageError = err instanceof Error ? err.message : "triage failed";
        }
        return NextResponse.json({ results, triaged, triageError });
      }
      case "draft": {
        const message = await createDraftReply(body.account, body.gmail_id);
        return NextResponse.json({ ok: true, message });
      }
      case "make_task": {
        const message = await makeTaskFromMessage(body.account, body.gmail_id);
        return NextResponse.json({ ok: true, message });
      }
      case "disconnect": {
        disconnectGmailAccount(body.email);
        return NextResponse.json({ ok: true });
      }
    }
  } catch (err) {
    const status =
      err instanceof GmailNotConfiguredError || err instanceof GmailNotConnectedError
        ? 409
        : 502;
    const message = err instanceof Error ? err.message : "Mail request failed";
    console.error("[mail] action failed:", err);
    return NextResponse.json({ error: message }, { status });
  }
}
