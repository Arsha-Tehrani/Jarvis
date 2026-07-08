// Pure mail helpers — no database, no network, no Gmail client. Body
// extraction and the mail→task title live here so both are unit-testable
// and the title derivation has exactly one definition (creation in
// lib/mail.ts and the "already created" check in /api/mail must agree).

export type GmailPart = {
  mimeType?: string;
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: GmailPart[];
};

/** Gmail transports part bodies as base64url. */
export function decodeBase64Url(data: string): string {
  const normalized = data.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64").toString("utf8");
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

/**
 * Reduce an HTML email to readable plain text. This is the sanitizer for
 * html-only messages: the output is rendered as TEXT in the UI (never
 * dangerouslySetInnerHTML), so stripping is about readability, not security —
 * markup can't execute either way.
 */
export function htmlToText(html: string): string {
  let text = html
    // Drop the invisible machinery wholesale, content included.
    .replace(/<(script|style|head)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    // Block-level boundaries become line breaks before tags are stripped.
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|table|blockquote)\s*>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "• ")
    // Everything else that looks like a tag goes away.
    .replace(/<[^>]+>/g, "");
  for (const [entity, ch] of Object.entries(ENTITIES)) {
    text = text.split(entity).join(ch);
  }
  text = text.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
  // Collapse the whitespace soup HTML emails leave behind.
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Depth-first hunt for the first part of a MIME type that carries data. */
function findPart(part: GmailPart | undefined, mimeType: string): GmailPart | null {
  if (!part) return null;
  if (part.mimeType?.toLowerCase().startsWith(mimeType) && part.body?.data) return part;
  for (const child of part.parts ?? []) {
    const hit = findPart(child, mimeType);
    if (hit) return hit;
  }
  return null;
}

export type ExtractedBody = { text: string; source: "plain" | "html" | "none" };

/**
 * Pull readable text out of a Gmail `format=full` payload: prefer the
 * text/plain alternative, fall back to stripped text/html, degrade to
 * nothing (caller shows the snippet) rather than throwing.
 */
export function extractBody(payload: GmailPart | undefined): ExtractedBody {
  const plain = findPart(payload, "text/plain");
  if (plain?.body?.data) {
    const text = decodeBase64Url(plain.body.data).trim();
    if (text) return { text, source: "plain" };
  }
  const html = findPart(payload, "text/html");
  if (html?.body?.data) {
    const text = htmlToText(decodeBase64Url(html.body.data));
    if (text) return { text, source: "html" };
  }
  return { text: "", source: "none" };
}

/**
 * The task title "Make task" derives from a message. Creation and the
 * created-already check both call this — drift here would break the
 * button state, so it has one home.
 */
export function mailTaskTitle(sender: string, subject: string): string {
  const senderName = sender.replace(/<[^>]*>/g, "").trim() || sender;
  return `Reply: ${subject} — ${senderName}`.slice(0, 500);
}
