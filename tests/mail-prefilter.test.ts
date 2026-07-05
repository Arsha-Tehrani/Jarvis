import assert from "node:assert/strict";
import { test } from "node:test";
import { preFilterCategory } from "../lib/mail-prefilter.ts";

test("List-Unsubscribe header always marks newsletter", () => {
  assert.equal(preFilterCategory("Some Person <a@b.com>", "<mailto:u@x.com>"), "newsletter");
});

test("newsletter-ish senders are pre-filtered", () => {
  for (const sender of [
    "GitHub <noreply@github.com>",
    "no-reply@linkedin.com",
    "Substack <newsletter@substack.com>",
    "notifications@slack.com",
    "Deals <marketing@store.com>",
    "promo@airline.com",
  ]) {
    assert.equal(preFilterCategory(sender, ""), "newsletter", sender);
  }
});

test("personal senders reach the model", () => {
  assert.equal(preFilterCategory("Sam Chen <sam.chen@gmail.com>", ""), null);
  assert.equal(preFilterCategory("recruiter@company.com", ""), null);
});
