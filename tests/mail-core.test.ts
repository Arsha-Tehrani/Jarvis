import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decodeBase64Url,
  extractBody,
  htmlToText,
  mailTaskTitle,
  type GmailPart,
} from "../lib/mail-core.ts";

const b64url = (s: string) =>
  Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

test("decodeBase64Url round-trips gmail's url-safe alphabet", () => {
  const original = "subjects can have ?? and ~~ and émojis 🎉";
  assert.equal(decodeBase64Url(b64url(original)), original);
});

test("extractBody: single-part text/plain message", () => {
  const payload: GmailPart = {
    mimeType: "text/plain",
    body: { data: b64url("Hi there,\nsee you Friday.") },
  };
  assert.deepEqual(extractBody(payload), {
    text: "Hi there,\nsee you Friday.",
    source: "plain",
  });
});

test("extractBody: multipart/alternative prefers text/plain over html", () => {
  const payload: GmailPart = {
    mimeType: "multipart/alternative",
    parts: [
      { mimeType: "text/plain", body: { data: b64url("plain wins") } },
      { mimeType: "text/html", body: { data: b64url("<b>html loses</b>") } },
    ],
  };
  assert.equal(extractBody(payload).text, "plain wins");
  assert.equal(extractBody(payload).source, "plain");
});

test("extractBody: nested multipart (mixed > alternative) still finds the text", () => {
  const payload: GmailPart = {
    mimeType: "multipart/mixed",
    parts: [
      {
        mimeType: "multipart/alternative",
        parts: [{ mimeType: "text/plain", body: { data: b64url("deep text") } }],
      },
      { mimeType: "application/pdf", body: { attachmentId: "abc", size: 12345 } },
    ],
  };
  assert.equal(extractBody(payload).text, "deep text");
});

test("extractBody: html-only message is stripped to readable text", () => {
  const html =
    "<html><head><style>.x{color:red}</style></head><body>" +
    "<script>alert('xss')</script>" +
    "<p>Hello &amp; welcome,</p><div>Your total is &quot;$5&quot;</div>" +
    "<ul><li>first</li><li>second</li></ul></body></html>";
  const out = extractBody({ mimeType: "text/html", body: { data: b64url(html) } });
  assert.equal(out.source, "html");
  assert.ok(out.text.includes("Hello & welcome,"));
  assert.ok(out.text.includes('Your total is "$5"'));
  assert.ok(out.text.includes("• first"));
  assert.ok(!out.text.includes("alert"), "script content must be dropped");
  assert.ok(!out.text.includes("color:red"), "style content must be dropped");
  assert.ok(!out.text.includes("<"), "no tags survive");
});

test("extractBody: attachment-only or empty payloads degrade to none", () => {
  assert.deepEqual(extractBody(undefined), { text: "", source: "none" });
  assert.deepEqual(
    extractBody({
      mimeType: "multipart/mixed",
      parts: [{ mimeType: "image/png", body: { attachmentId: "x" } }],
    }),
    { text: "", source: "none" }
  );
});

test("htmlToText collapses whitespace soup and numeric entities", () => {
  assert.equal(htmlToText("a   b\n\n\n\n<div>c&#8212;d</div>"), "a b\n\nc—d");
});

test("mailTaskTitle strips the email address, keeps the display name", () => {
  assert.equal(
    mailTaskTitle("Jane Doe <jane@example.com>", "Q3 numbers"),
    "Reply: Q3 numbers — Jane Doe"
  );
  // Address-only sender falls back to the raw value.
  assert.equal(
    mailTaskTitle("<noreply@example.com>", "Receipt"),
    "Reply: Receipt — <noreply@example.com>"
  );
});

test("mailTaskTitle caps runaway subjects at 500 chars", () => {
  const title = mailTaskTitle("A <a@b.c>", "x".repeat(600));
  assert.equal(title.length, 500);
});
