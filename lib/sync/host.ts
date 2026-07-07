import { NextRequest, NextResponse } from "next/server";
import { createStamper } from "@/lib/sync/core";

// Host-side gating for the /api/sync routes.
//
// ⚠ DEPLOYMENT ASSUMPTION: these endpoints are designed to sit behind
// Tailscale (or an equivalent private network) ONLY. The shared bearer
// token is the entire auth story — there is no rate limiting, no TLS
// management, no user model. Do NOT port-forward this to the open
// internet.

// Reject unless SYNC_ROLE=host AND the exact bearer token matches. A
// misconfigured client (or an unset token) must never serve sync traffic —
// we answer 404 for the disabled role so the routes are indistinguishable
// from absent, and 401 for a bad/missing token.
export function requireSyncHost(req: NextRequest): NextResponse | null {
  if (process.env.SYNC_ROLE !== "host") {
    return NextResponse.json({ error: "sync host is disabled on this machine" }, { status: 404 });
  }
  const expected = process.env.SYNC_AUTH_TOKEN;
  if (!expected) {
    return NextResponse.json(
      { error: "SYNC_ROLE=host but SYNC_AUTH_TOKEN is not set — refusing to serve sync" },
      { status: 503 }
    );
  }
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!tokenMatches(token, expected)) {
    return NextResponse.json({ error: "invalid sync token" }, { status: 401 });
  }
  return null;
}

// Constant-time-ish comparison, same shape as middleware.ts.
function tokenMatches(candidate: string, expected: string): boolean {
  if (candidate.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= candidate.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

// One monotonic stamper per server process: host stamps must be strictly
// increasing even across pushes landing in the same millisecond.
const globalForHost = globalThis as unknown as { __jarvisSyncStamper?: () => string };

export function hostStamp(): string {
  if (!globalForHost.__jarvisSyncStamper) {
    globalForHost.__jarvisSyncStamper = createStamper();
  }
  return globalForHost.__jarvisSyncStamper();
}
