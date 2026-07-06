import assert from "node:assert/strict";
import { test } from "node:test";
import {
  appOf,
  domainOf,
  sumActiveSeconds,
  topByDuration,
  type AwEvent,
} from "../lib/activitywatch.ts";

const ev = (duration: number, data: Record<string, unknown>): AwEvent => ({
  timestamp: "2026-07-06T09:00:00Z",
  duration,
  data,
});

test("active time counts only not-afk spans and rounds", () => {
  const events = [
    ev(600, { status: "not-afk" }),
    ev(1200, { status: "afk" }),
    ev(30.6, { status: "not-afk" }),
  ];
  assert.equal(sumActiveSeconds(events), 631);
  assert.equal(sumActiveSeconds([]), 0);
});

test("top apps aggregate durations, drop junk, rank and cap at n", () => {
  const events = [
    ev(300, { app: "Code" }),
    ev(500, { app: "Chrome" }),
    ev(400, { app: "Code" }),
    ev(-5, { app: "Ghost" }), // corrupt duration → ignored
    ev(100, { title: "no app key" }),
    ev(50, { app: "   " }), // blank app name → ignored
    ev(10, { app: "Terminal" }),
  ];
  assert.deepEqual(topByDuration(events, appOf, 2), [
    { name: "Code", seconds: 700 },
    { name: "Chrome", seconds: 500 },
  ]);
});

test("domainOf strips www and survives junk urls", () => {
  assert.equal(domainOf(ev(1, { url: "https://www.github.com/foo/bar" })), "github.com");
  assert.equal(domainOf(ev(1, { url: "https://news.ycombinator.com/item?id=1" })), "news.ycombinator.com");
  assert.equal(domainOf(ev(1, { url: "not a url" })), null);
  assert.equal(domainOf(ev(1, {})), null);
});
