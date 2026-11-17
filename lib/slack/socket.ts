import { SocketModeClient } from "@slack/socket-mode";
import { slackApi } from "@/lib/slack";
import { handleCheckinReply, sendDm } from "@/lib/slack";
import { handleTaskReply } from "@/lib/slack/task-digest";
import {
  NO_ACTION,
  YES_ACTION,
  applyAnswerToBlocks,
  parseActionValue,
  type SlackBlock,
} from "@/lib/slack/checkin-core";
import { applyCheckinAnswer } from "@/lib/slack/tracker-checkin";

// Slack Socket Mode — the ONLY inbound path. Slack holds a WebSocket open to
// this process and pushes events down it, so there is no public Request URL,
// no tunnel, and nothing for SLACK_SIGNING_SECRET to verify (that secret
// authenticated inbound HTTP, which no longer exists here).
//
// This module does exactly two things: keep the connection up, and decode
// payloads into calls on already-tested functions. All the decision logic
// lives elsewhere — handleTrackerResponse (lib/slack/tracker-response.ts) for
// button presses, handleTaskReply / handleCheckinReply for DMs — which is what
// keeps the socket wiring itself thin enough not to need its own tests.
//
// OUTBOUND still goes through lib/slack.ts's slackApi, deliberately: it routes
// every Slack call through loggedFetch, so posts and updates stay visible in
// /network-log. Adding @slack/web-api here would mean a second Slack client
// with its own untracked HTTP stack.

// Socket Mode is only alive while this process is. Same requirement the cron
// scheduler already has — see the "Running continuously" note in the README.
const globalForSocket = globalThis as unknown as {
  __jarvisSlackSocketStarted?: boolean;
  __jarvisSlackSocketState?: SocketState;
};

export type SocketState =
  | "unconfigured"
  | "disconnected"
  | "connecting"
  | "reconnecting"
  | "connected";

export function isSlackSocketConfigured(): boolean {
  return !!(process.env.SLACK_APP_TOKEN && process.env.SLACK_BOT_TOKEN);
}

// Connection state for the /status probe — read from the client's own
// lifecycle events rather than by pinging a URL (there is no URL now). The
// client has no public "are you connected" getter, but it emits these state
// names, so we track the last one seen. Stored on globalThis so a dev hot
// reload of this module doesn't reset the reading for a socket that's still up.
export function slackSocketState(): SocketState {
  if (!isSlackSocketConfigured()) return "unconfigured";
  return globalForSocket.__jarvisSlackSocketState ?? "disconnected";
}

type InteractivePayload = {
  actions?: Array<{ action_id?: string; value?: string }>;
  channel?: { id?: string };
  message?: { ts?: string; blocks?: SlackBlock[] };
  user?: { id?: string };
};

type MessageEvent = {
  channel_type?: string;
  bot_id?: string;
  user?: string;
  text?: string;
};

async function onInteractive(body: InteractivePayload): Promise<void> {
  const action = body.actions?.[0];
  if (!action) return;
  if (action.action_id !== YES_ACTION && action.action_id !== NO_ACTION) return;
  // The socket proves the message came from Slack; this proves it came from
  // the owner of this Jarvis and not another member of a shared channel.
  if (body.user?.id !== process.env.SLACK_USER_ID) return;

  const parsed = action.value ? parseActionValue(action.value) : null;
  if (!parsed) {
    console.error("[slack-socket] unparseable action value");
    return;
  }

  const answer = action.action_id === YES_ACTION ? "yes" : "no";
  const { habit } = await applyCheckinAnswer(parsed.habitId, parsed.date, answer);

  const channel = body.channel?.id;
  const ts = body.message?.ts;
  if (!channel || !ts) return;
  // Replace just this tracker's button row with a static result: visible
  // confirmation, nothing left to double-tap, other trackers still answerable.
  await slackApi("chat.update", {
    channel,
    ts,
    blocks: applyAnswerToBlocks(body.message?.blocks ?? [], parsed.habitId, habit.name, answer),
  });
}

async function onMessage(event: MessageEvent): Promise<void> {
  // Only the user's own DMs; never the bot's own messages (which would loop).
  if (event.channel_type !== "im" || event.bot_id) return;
  if (event.user !== process.env.SLACK_USER_ID || typeof event.text !== "string") return;
  const text = event.text;
  // Unchanged routing: task-completion parsing first ("done 2"), then the
  // check-in pipeline (the sleep question), deterministic parsers before any
  // LLM fallback.
  const reply = (await handleTaskReply(text)) ?? (await handleCheckinReply(text));
  await sendDm(reply);
}

// Start the connection exactly once per process. Next.js re-executes
// module-level code on every dev hot reload, and a second start() would mean
// two live sockets — i.e. every button press handled twice. The globalThis
// flag survives hot reloads within the same process, same guard the cron
// scheduler uses.
export async function startSlackSocket(): Promise<void> {
  if (globalForSocket.__jarvisSlackSocketStarted) return;
  if (!isSlackSocketConfigured()) {
    console.log("[slack-socket] SLACK_APP_TOKEN / SLACK_BOT_TOKEN not set — not connecting");
    return;
  }
  globalForSocket.__jarvisSlackSocketStarted = true;

  const client = new SocketModeClient({ appToken: process.env.SLACK_APP_TOKEN as string });

  // Lifecycle → the state the /status probe reports.
  for (const state of ["connecting", "reconnecting", "connected", "disconnected"] as const) {
    client.on(state, () => {
      globalForSocket.__jarvisSlackSocketState = state;
      console.log(`[slack-socket] ${state}`);
    });
  }

  type AckArgs = { ack: (response?: unknown) => Promise<void> };

  client.on("interactive", async ({ body, ack }: AckArgs & { body: InteractivePayload }) => {
    await ack(); // ~3s deadline, same as the old HTTP webhook had
    try {
      await onInteractive(body);
    } catch (err) {
      console.error("[slack-socket] interactive handling failed:", err);
    }
  });

  client.on("message", async ({ event, ack }: AckArgs & { event: MessageEvent }) => {
    await ack();
    try {
      await onMessage(event);
    } catch (err) {
      console.error("[slack-socket] message handling failed:", err);
    }
  });

  try {
    await client.start();
  } catch (err) {
    // A bad/expired app token must not take the server down with it — every
    // other integration here degrades to "not working" rather than fatal.
    globalForSocket.__jarvisSlackSocketStarted = false;
    globalForSocket.__jarvisSlackSocketState = "disconnected";
    console.error("[slack-socket] failed to connect:", err);
  }
}
