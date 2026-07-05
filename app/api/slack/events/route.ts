import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { handleCheckinReply, sendDm } from "@/lib/slack";

// Slack Events API receiver (INBOUND half of the check-in).
// Needs a public URL — deferred behind the tunnel step in HANDOFF.md.
// Every request is verified against SLACK_SIGNING_SECRET before parsing;
// without the secret set this endpoint refuses everything.

const MAX_SKEW_SECONDS = 300;

function verifySlackSignature(req: NextRequest, rawBody: string): boolean {
  const secret = process.env.SLACK_SIGNING_SECRET;
  if (!secret) return false;
  const timestamp = req.headers.get("x-slack-request-timestamp");
  const signature = req.headers.get("x-slack-signature");
  if (!timestamp || !signature) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > MAX_SKEW_SECONDS) return false;

  const expected = `v0=${crypto
    .createHmac("sha256", secret)
    .update(`v0:${timestamp}:${rawBody}`)
    .digest("hex")}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

type SlackEvent = {
  type?: string;
  challenge?: string;
  event?: {
    type?: string;
    channel_type?: string;
    user?: string;
    bot_id?: string;
    text?: string;
  };
};

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  if (!verifySlackSignature(req, rawBody)) {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  let payload: SlackEvent;
  try {
    payload = JSON.parse(rawBody) as SlackEvent;
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  // Slack's one-time endpoint handshake.
  if (payload.type === "url_verification" && payload.challenge) {
    return NextResponse.json({ challenge: payload.challenge });
  }

  if (payload.type === "event_callback") {
    const event = payload.event;
    const isOwnDm =
      event?.type === "message" &&
      event.channel_type === "im" &&
      !event.bot_id &&
      event.user === process.env.SLACK_USER_ID &&
      typeof event.text === "string";

    if (isOwnDm) {
      // Ack fast; process asynchronously (Slack retries after 3s timeouts).
      void handleCheckinReply(event.text as string)
        .then((reply) => sendDm(reply))
        .catch((err) => console.error("[slack] reply handling failed:", err));
    }
  }

  return NextResponse.json({ ok: true });
}
