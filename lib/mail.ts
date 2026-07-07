import { z } from "zod";
import { getDb } from "@/lib/db";
import { chat } from "@/lib/llm";
import { loggedFetch } from "@/lib/network-log";
import { preFilterCategory } from "@/lib/mail-prefilter";

// Gmail triage — read-only + on-demand drafts. Mirrors the Calendar OAuth
// pattern: CSRF state cookie, tokens in oauth_tokens (server-side only),
// auto-refresh, clear reconnect error on testing-mode expiry. Multi-account:
// one oauth_tokens row per inbox (provider = "gmail:<email>") plus a
// mail_accounts registry; every message is tagged with its inbox.
// Scopes: gmail.readonly to read, gmail.compose ONLY to create drafts.
// Nothing here can send mail; drafts are created only on explicit click.

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
].join(" ");

export const GMAIL_REDIRECT_URI = "http://localhost:3000/api/mail/callback";

export class GmailNotConfiguredError extends Error {
  constructor() {
    super("Google OAuth is not configured — set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env.local");
  }
}

export class GmailNotConnectedError extends Error {
  constructor(message = "This Gmail account needs reconnecting from the Mail tab") {
    super(message);
  }
}

function clientCredentials(): { clientId: string; clientSecret: string } {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new GmailNotConfiguredError();
  return { clientId, clientSecret };
}

export function isGmailConfigured(): boolean {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

export type MailAccount = { id: number; email: string; connected_at: string };

export function listMailAccounts(): MailAccount[] {
  return getDb()
    .prepare("SELECT * FROM mail_accounts ORDER BY email")
    .all() as MailAccount[];
}

export function buildGmailAuthUrl(state: string): string {
  const { clientId } = clientCredentials();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: GMAIL_REDIRECT_URI,
    response_type: "code",
    scope: SCOPES,
    access_type: "offline",
    prompt: "consent", // always get a refresh token, even for re-links
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

function storeTokens(
  email: string,
  accessToken: string,
  refreshToken: string | null,
  expiresIn: number
): void {
  const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
  getDb()
    .prepare(
      `INSERT INTO oauth_tokens (provider, access_token, refresh_token, expires_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(provider) DO UPDATE SET
         access_token = excluded.access_token,
         refresh_token = COALESCE(excluded.refresh_token, oauth_tokens.refresh_token),
         expires_at = excluded.expires_at`
    )
    .run(`gmail:${email}`, accessToken, refreshToken, expiresAt);
}

// Exchange the OAuth code, discover which inbox it belongs to, register it.
export async function exchangeGmailCode(code: string): Promise<string> {
  const { clientId, clientSecret } = clientCredentials();
  const res = await loggedFetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: GMAIL_REDIRECT_URI,
      grant_type: "authorization_code",
    }),
  }, { feature: "gmail-oauth", purpose: "exchange authorization code" });
  const data = (await res.json()) as TokenResponse;
  if (!res.ok || !data.access_token) {
    throw new Error(`Token exchange failed: ${data.error_description ?? data.error ?? res.status}`);
  }

  const profileRes = await loggedFetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/profile",
    { headers: { Authorization: `Bearer ${data.access_token}` } },
    { feature: "gmail-oauth", purpose: "read linked inbox address" }
  );
  const profile = (await profileRes.json()) as { emailAddress?: string };
  if (!profileRes.ok || !profile.emailAddress) {
    throw new Error("Could not read the Gmail profile for the linked account");
  }
  const email = profile.emailAddress;

  storeTokens(email, data.access_token, data.refresh_token ?? null, data.expires_in ?? 3600);
  getDb()
    .prepare("INSERT OR IGNORE INTO mail_accounts (email) VALUES (?)")
    .run(email);
  return email;
}

export function disconnectGmailAccount(email: string): void {
  const db = getDb();
  db.prepare("DELETE FROM oauth_tokens WHERE provider = ?").run(`gmail:${email}`);
  db.prepare("DELETE FROM mail_accounts WHERE email = ?").run(email);
  db.prepare("DELETE FROM mail_messages WHERE account = ?").run(email);
}

// Exported for the status page: getting a token exercises the same
// refresh-failure detection that produces the "reconnect" prompt.
export async function getGmailAccessToken(email: string): Promise<string> {
  const row = getDb()
    .prepare(
      "SELECT access_token, refresh_token, expires_at FROM oauth_tokens WHERE provider = ?"
    )
    .get(`gmail:${email}`) as
    | { access_token: string; refresh_token: string | null; expires_at: string }
    | undefined;
  if (!row) throw new GmailNotConnectedError(`${email} is not linked — connect it from the Mail tab`);

  if (Date.parse(row.expires_at) - Date.now() > 60_000) return row.access_token;

  if (!row.refresh_token) {
    throw new GmailNotConnectedError(`${email}: access expired and no refresh token — reconnect from the Mail tab`);
  }
  const { clientId, clientSecret } = clientCredentials();
  const res = await loggedFetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: row.refresh_token,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
    }),
  }, { feature: "gmail-oauth", purpose: "refresh access token" });
  const data = (await res.json()) as TokenResponse;
  if (!res.ok || !data.access_token) {
    throw new GmailNotConnectedError(
      `${email}: token refresh failed (${data.error ?? res.status}) — testing-mode tokens expire ~weekly, reconnect from the Mail tab`
    );
  }
  storeTokens(email, data.access_token, null, data.expires_in ?? 3600);
  return data.access_token;
}

// ---- Polling (no push/webhooks — that's the deferred tunnel path) ----

type GmailHeader = { name: string; value: string };

type GmailMessageMeta = {
  id: string;
  threadId?: string;
  snippet?: string;
  internalDate?: string;
  labelIds?: string[];
  payload?: { headers?: GmailHeader[] };
};

function header(meta: GmailMessageMeta, name: string): string {
  return (
    meta.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())
      ?.value ?? ""
  );
}

// Fetch recent messages for one inbox; only new gmail_ids are processed
// (INSERT OR IGNORE dedupe) so repeated polls stay inside rate limits.
export async function pollAccount(email: string, maxResults = 25): Promise<number> {
  const token = await getGmailAccessToken(email);
  const listRes = await loggedFetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${maxResults}&labelIds=INBOX`,
    { headers: { Authorization: `Bearer ${token}` } },
    { feature: "mail-poll", purpose: "list inbox messages" }
  );
  if (!listRes.ok) {
    const detail = await listRes.text().catch(() => "");
    throw new Error(`Gmail list failed for ${email} (${listRes.status}): ${detail.slice(0, 200)}`);
  }
  const list = (await listRes.json()) as { messages?: Array<{ id: string }> };
  const ids = (list.messages ?? []).map((m) => m.id);
  if (ids.length === 0) return 0;

  const db = getDb();
  const known = new Set(
    (
      db
        .prepare(
          `SELECT gmail_id FROM mail_messages WHERE account = ? AND gmail_id IN (${ids.map(() => "?").join(",")})`
        )
        .all(email, ...ids) as { gmail_id: string }[]
    ).map((r) => r.gmail_id)
  );
  const newIds = ids.filter((id) => !known.has(id));

  let inserted = 0;
  for (const id of newIds) {
    const msgRes = await loggedFetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=List-Unsubscribe`,
      { headers: { Authorization: `Bearer ${token}` } },
      { feature: "mail-poll", purpose: "fetch message headers" }
    );
    if (!msgRes.ok) continue;
    const meta = (await msgRes.json()) as GmailMessageMeta;
    const sender = header(meta, "From");
    const category = preFilterCategory(sender, header(meta, "List-Unsubscribe"));
    const info = db
      .prepare(
        `INSERT OR IGNORE INTO mail_messages
           (account, gmail_id, sender, subject, snippet, received_at, importance, importance_reason, category, is_read)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        email,
        meta.id,
        sender || "(unknown sender)",
        header(meta, "Subject") || "(no subject)",
        meta.snippet ?? null,
        meta.internalDate ? new Date(Number(meta.internalDate)).toISOString() : null,
        category ? "noise" : null,
        category ? "newsletter pre-filter" : null,
        category,
        meta.labelIds?.includes("UNREAD") ? 0 : 1
      );
    inserted += info.changes;
  }
  return inserted;
}

// ---- Triage via lib/llm.chat: sender+subject+snippet only, never bodies ----

const IMPORTANCE = ["important", "can_wait", "noise"] as const;

const triageResponseSchema = z.array(
  z.object({
    id: z.number().int(),
    importance: z.enum(IMPORTANCE),
    reason: z.string().max(300),
  })
);

export async function triagePending(batchSize = 20): Promise<number> {
  const db = getDb();
  const pending = db
    .prepare(
      `SELECT id, sender, subject, snippet FROM mail_messages
       WHERE importance IS NULL ORDER BY received_at DESC LIMIT ?`
    )
    .all(batchSize) as { id: number; sender: string; subject: string; snippet: string | null }[];
  if (pending.length === 0) return 0;

  const listing = pending
    .map((m) => `${m.id}\t${m.sender}\t${m.subject}\t${(m.snippet ?? "").slice(0, 150)}`)
    .join("\n");
  const result = await chat({
    messages: [
      {
        role: "system",
        content: [
          "You triage the user's inbox. Input lines: id<TAB>sender<TAB>subject<TAB>snippet.",
          "Classify each as: important (needs the user's attention/reply), can_wait (legitimate but not urgent), or noise (newsletters, promos, automated notifications).",
          'Respond with ONLY a JSON array like [{"id":1,"importance":"important","reason":"one short line"}] covering every id. No prose.',
        ].join(" "),
      },
      { role: "user", content: listing },
    ],
  });
  const match = (result.text ?? "").match(/\[[\s\S]*\]/);
  if (!match) throw new Error("Triage LLM response contained no JSON array");
  const parsed = triageResponseSchema.safeParse(JSON.parse(match[0]));
  if (!parsed.success) {
    throw new Error(`Triage response failed validation: ${z.prettifyError(parsed.error)}`);
  }

  const validIds = new Set(pending.map((m) => m.id));
  const update = db.prepare(
    "UPDATE mail_messages SET importance = ?, importance_reason = ? WHERE id = ?"
  );
  let updated = 0;
  const apply = db.transaction(() => {
    for (const row of parsed.data) {
      if (!validIds.has(row.id)) continue;
      update.run(row.importance, row.reason, row.id);
      updated++;
    }
  });
  apply();
  return updated;
}

// Cron job: poll every linked inbox, then triage what's new. Each half
// fails independently and quietly (no accounts / no model → skip + log).
export async function pollMailJob(): Promise<void> {
  if (!isGmailConfigured()) {
    console.log("[mail] Google OAuth not configured — skipping mail poll");
    return;
  }
  const accounts = listMailAccounts();
  if (accounts.length === 0) {
    console.log("[mail] no Gmail accounts linked — skipping mail poll");
    return;
  }
  for (const account of accounts) {
    try {
      const n = await pollAccount(account.email);
      console.log(`[mail] ${account.email}: ${n} new message(s)`);
    } catch (err) {
      console.error(`[mail] poll failed for ${account.email}:`, err);
    }
  }
  try {
    const n = await triagePending();
    if (n > 0) console.log(`[mail] triaged ${n} message(s)`);
  } catch (err) {
    console.error("[mail] triage failed (messages stay untriaged until the LLM is up):", err);
  }
}

// ---- Flag → one-click task (writes ONLY to the local tasks table) ----

// "Make task" from a triaged message. Reuses the add_task tool handler so
// task creation has exactly one code path; the only Gmail involvement is
// reading the cached metadata — nothing is sent or modified. The LLM may
// suggest a due date; with no model running the task simply has none.
export async function makeTaskFromMessage(
  account: string,
  gmailId: string
): Promise<string> {
  const db = getDb();
  const message = db
    .prepare(
      "SELECT sender, subject, snippet FROM mail_messages WHERE account = ? AND gmail_id = ?"
    )
    .get(account, gmailId) as
    | { sender: string; subject: string; snippet: string | null }
    | undefined;
  if (!message) throw new Error("Message not found — poll first");

  const senderName = message.sender.replace(/<[^>]*>/g, "").trim() || message.sender;
  const title = `Reply: ${message.subject} — ${senderName}`.slice(0, 500);

  const existing = db
    .prepare("SELECT 1 FROM tasks WHERE title = ? AND status = 'open'")
    .get(title);
  if (existing) return `A task for this message is already open: "${title}"`;

  const due = await suggestDueDate(message.sender, message.subject, message.snippet);

  const { getTool } = await import("@/lib/tools"); // lazy: avoids an import cycle
  const tool = getTool("add_task");
  if (!tool) throw new Error("add_task tool not registered");
  const args = due ? { title, due } : { title };
  const parsed = tool.schema.safeParse(args);
  if (!parsed.success) {
    throw new Error(`Invalid task args: ${z.prettifyError(parsed.error)}`);
  }
  const result = await tool.handler(parsed.data);

  // Mark provenance: this task came from mail, not an agent turn.
  db.prepare(
    "UPDATE tasks SET source = 'mail' WHERE id = (SELECT MAX(id) FROM tasks WHERE title = ?)"
  ).run(title);

  return result;
}

// Optional nicety, never a dependency: with no model running this quietly
// returns undefined and the task gets no due date.
async function suggestDueDate(
  sender: string,
  subject: string,
  snippet: string | null
): Promise<string | undefined> {
  try {
    const result = await chat({
      messages: [
        {
          role: "system",
          content: `Today is ${new Date().toISOString().slice(0, 10)}. Given an email, suggest a reasonable due date for a "reply to this" task. Respond with ONLY a date as YYYY-MM-DD, or the word "none" if no deadline is implied.`,
        },
        { role: "user", content: `From: ${sender}\nSubject: ${subject}\n${snippet ?? ""}` },
      ],
    });
    const match = result.text?.match(/\d{4}-\d{2}-\d{2}/);
    if (!match) return undefined;
    const due = match[0];
    // Sanity: within the next year, not in the past.
    const ms = Date.parse(due);
    const now = Date.now();
    if (Number.isNaN(ms) || ms < now - 86400_000 || ms > now + 366 * 86400_000) {
      return undefined;
    }
    return due;
  } catch {
    return undefined;
  }
}

// ---- On-demand draft (gmail.compose; NEVER send, never automatic) ----

export async function createDraftReply(account: string, gmailId: string): Promise<string> {
  const db = getDb();
  const message = db
    .prepare(
      "SELECT sender, subject, snippet FROM mail_messages WHERE account = ? AND gmail_id = ?"
    )
    .get(account, gmailId) as
    | { sender: string; subject: string; snippet: string | null }
    | undefined;
  if (!message) throw new Error("Message not found — poll first");

  const token = await getGmailAccessToken(account);

  // Thread + reply headers from the original message.
  const metaRes = await loggedFetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${gmailId}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=Reply-To&metadataHeaders=From`,
    { headers: { Authorization: `Bearer ${token}` } },
    { feature: "mail-draft", purpose: "load original message headers" }
  );
  if (!metaRes.ok) throw new Error(`Could not load the original message (${metaRes.status})`);
  const meta = (await metaRes.json()) as GmailMessageMeta;
  const messageIdHeader = header(meta, "Message-ID");
  const replyTo = header(meta, "Reply-To") || header(meta, "From") || message.sender;

  const result = await chat({
    messages: [
      {
        role: "system",
        content:
          "Draft a short, polite reply email body for the user to finish. Plain text only, no subject line, no signature placeholder, under 120 words. It is a DRAFT — leave specifics the user must decide as [brackets].",
      },
      {
        role: "user",
        content: `From: ${message.sender}\nSubject: ${message.subject}\nSnippet: ${message.snippet ?? ""}`,
      },
    ],
  });
  if (!result.text) throw new Error("The LLM returned no draft text");

  const subject = message.subject.startsWith("Re:")
    ? message.subject
    : `Re: ${message.subject}`;
  const mime = [
    `To: ${replyTo}`,
    `Subject: ${subject}`,
    messageIdHeader ? `In-Reply-To: ${messageIdHeader}` : "",
    messageIdHeader ? `References: ${messageIdHeader}` : "",
    'Content-Type: text/plain; charset="UTF-8"',
    "",
    result.text.trim(),
  ]
    .filter((line, i) => line !== "" || i >= 5)
    .join("\r\n");

  const raw = Buffer.from(mime, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const draftRes = await loggedFetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/drafts",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message: { raw, threadId: meta.threadId } }),
    },
    { feature: "mail-draft", purpose: "create draft" }
  );
  const draft = (await draftRes.json().catch(() => ({}))) as {
    id?: string;
    error?: { message?: string };
  };
  if (!draftRes.ok || !draft.id) {
    throw new Error(`Draft creation failed (${draftRes.status}): ${draft.error?.message ?? "unknown"}`);
  }
  return `Draft created in ${account} — finish and send it from Gmail.`;
}
