import { NextRequest, NextResponse } from "next/server";

// Optional bearer-token gate for serving Jarvis beyond localhost (Tailscale
// funnel / LAN). With JARVIS_AUTH_TOKEN unset this is a no-op and local use
// is unchanged. With it set, every page and API request must present the
// token, one of:
//   - Authorization: Bearer <token>          (API clients, sidecars)
//   - ?token=<token> once in a browser        (sets a cookie, then redirects
//                                              to strip the token from the URL)
//   - the cookie that grants
// This is a single-user gate, not internet-grade multi-user auth. The token
// stays server-side (non-negotiable #3) — never rendered into a page.

const COOKIE_NAME = "jarvis_auth";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

// Constant-time-ish comparison; middleware may run on the edge runtime,
// where node's crypto.timingSafeEqual isn't available.
function tokenMatches(candidate: string | null | undefined, expected: string): boolean {
  if (!candidate || candidate.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= candidate.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

// Note: Slack needs no exemption here. Inbound Slack traffic arrives over the
// Socket Mode WebSocket this process opens outbound (lib/slack/socket.ts),
// never as an inbound HTTP request, so it never passes through middleware.
export function middleware(req: NextRequest) {
  const expected = process.env.JARVIS_AUTH_TOKEN;
  if (!expected) return NextResponse.next();

  // 1. API-style header.
  const header = req.headers.get("authorization");
  if (header?.startsWith("Bearer ") && tokenMatches(header.slice(7), expected)) {
    return NextResponse.next();
  }

  // 2. Browser session cookie.
  if (tokenMatches(req.cookies.get(COOKIE_NAME)?.value, expected)) {
    return NextResponse.next();
  }

  // 3. One-time ?token= in the URL: set the cookie and redirect without it.
  const queryToken = req.nextUrl.searchParams.get("token");
  if (tokenMatches(queryToken, expected)) {
    const clean = req.nextUrl.clone();
    clean.searchParams.delete("token");
    const res = NextResponse.redirect(clean);
    res.cookies.set(COOKIE_NAME, queryToken as string, {
      httpOnly: true,
      sameSite: "lax",
      secure: req.nextUrl.protocol === "https:",
      maxAge: COOKIE_MAX_AGE,
      path: "/",
    });
    return res;
  }

  if (req.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json(
      { error: "Unauthorized — send Authorization: Bearer <JARVIS_AUTH_TOKEN>" },
      { status: 401 }
    );
  }
  return new NextResponse(
    "401 — Jarvis is token-protected. Open /?token=<your JARVIS_AUTH_TOKEN> once to sign in.",
    { status: 401, headers: { "Content-Type": "text/plain" } }
  );
}

export const config = {
  // Everything except static assets and what the PWA needs before auth:
  // the manifest, icons, and the service worker must load unauthenticated
  // or "Add to Home Screen" breaks.
  matcher: [
    "/((?!_next/static|_next/image|favicon\\.ico|icons/|sw\\.js|manifest\\.webmanifest).*)",
  ],
};
