import assert from "node:assert/strict";
import { test } from "node:test";
import {
  runProbes,
  summarizeChecks,
  type HealthCheck,
  type Probe,
} from "../lib/status-core.ts";

const probe = (id: string, run: Probe["run"]): Probe => ({ id, label: id, run });

const check = (
  id: string,
  status: HealthCheck["status"]
): HealthCheck => ({
  id,
  label: id,
  status,
  message: "",
  lastChecked: "2026-07-07T00:00:00Z",
});

test("runProbes isolates failures — one throwing probe never hides the others", async () => {
  const results = await runProbes([
    probe("good", () => ({ status: "ok", message: "fine" })),
    probe("bad", () => {
      throw new Error("boom");
    }),
    probe("slow-bad", async () => {
      throw new Error("async boom");
    }),
  ]);
  assert.equal(results.length, 3);
  const byId = new Map(results.map((r) => [r.id, r]));
  assert.equal(byId.get("good")?.status, "ok");
  assert.equal(byId.get("bad")?.status, "down");
  assert.equal(byId.get("bad")?.message, "boom");
  assert.equal(byId.get("slow-bad")?.status, "down");
  assert.equal(byId.get("slow-bad")?.message, "async boom");
});

test("runProbes stamps latency and lastChecked on every check", async () => {
  const [result] = await runProbes([
    probe("timed", async () => ({ status: "ok", message: "fine" })),
  ]);
  assert.ok(typeof result.latencyMs === "number" && result.latencyMs >= 0);
  assert.ok(!Number.isNaN(Date.parse(result.lastChecked)));
});

test("summary counts only configured checks and surfaces failures", () => {
  const summary = summarizeChecks([
    check("a", "ok"),
    check("b", "ok"),
    check("c", "down"),
    check("d", "degraded"),
    check("e", "unconfigured"),
    check("f", "unconfigured"),
  ]);
  assert.equal(summary.healthy, 2);
  assert.equal(summary.configured, 4);
  assert.equal(summary.total, 6);
  // down sorts before degraded — worst problem first.
  assert.deepEqual(summary.problems, ["c", "d"]);
});

test("summary of all-unconfigured is calm: zero of zero, no problems", () => {
  const summary = summarizeChecks([check("a", "unconfigured")]);
  assert.deepEqual(summary, { healthy: 0, configured: 0, total: 1, problems: [] });
});
