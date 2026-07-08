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
  getMessageBody,
  isGmailConfigured,
  listMailAccounts,
  loadOlderMessages,
  makeTaskFromMessage,
  pollAccount,
  triagePending,
} from "@/lib/mail";
import { mailTaskTitle } from "@/lib/mail-core";

const postSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("connect") }),
  z.object({ action: z.literal("poll") }),
  z.object({ action: z.literal("load_older") }),
  z.object({
    action: z.literal("body"),
    account: z.string().min(1),
    gmail_id: z.string().min(1),
  }),
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

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

type MessageRow = {
  account: string;
  gmail_id: string;
  sender: string;
  subject: string;
  snippet: string | null;
  received_at: string | null;
  importance: string | null;
  importance_reason: string | null;
  category: string | null;
  is_read: number;
};

export async function GET(req: NextRequest) {
  const parsed = listQuerySchema.safeParse({
    limit: req.nextUrl.searchParams.get("limit") ?? undefined,
    offset: req.nextUrl.searchParams.get("offset") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: z.prettifyError(parsed.error) }, { status: 400 });
  }
  const { limit, offset } = parsed.data;

  const db = getDb();
  const total = (db.prepare("SELECT COUNT(*) AS n FROM mail_messages").get() as { n: number }).n;
  const messages = db
    .prepare(
      `SELECT account, gmail_id, sender, subject, snippet, received_at,
              importance, importance_reason, category, is_read
       FROM mail_messages ORDER BY received_at DESC LIMIT ? OFFSET ?`
    )
    .all(limit, offset) as MessageRow[];

  // "Make task" state: a mail-sourced task whose title matches this
  // message's derived title means the button already fired.
  const mailTaskTitles = new Set(
    (
      db.prepare("SELECT title FROM tasks WHERE source = 'mail'").all() as {
        title: string;
      }[]
    ).map((t) => t.title)
  );

  return NextResponse.json({
    configured: isGmailConfigured(),
    accounts: listMailAccounts(),
    messages: messages.map((m) => ({
      ...m,
      task_created: mailTaskTitles.has(mailTaskTitle(m.sender, m.subject)),
    })),
    total,
    limit,
    offset,
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
      case "load_older": {
        const results: Record<string, number | string> = {};
        let anyMore = false;
        for (const account of listMailAccounts()) {
          try {
            const { inserted, more } = await loadOlderMessages(account.email);
            results[account.email] = inserted;
            anyMore = anyMore || more;
          } catch (err) {
            results[account.email] = err instanceof Error ? err.message : "failed";
          }
        }
        return NextResponse.json({ results, more: anyMore });
      }
      case "body": {
        const { body: text, bodySource } = await getMessageBody(body.account, body.gmail_id);
        return NextResponse.json({ ok: true, body: text, bodySource });
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
