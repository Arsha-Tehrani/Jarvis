import { NextRequest, NextResponse } from "next/server";
import { exchangeCodeForTokens, pollCalendar } from "@/lib/google";

// OAuth redirect target: http://localhost:3000/api/google/callback
// Verifies the CSRF state cookie, exchanges the code, polls once, and
// bounces back to the Calendar tab with a status flag (never exposing
// tokens or error internals to the URL beyond a short code).

export async function GET(req: NextRequest) {
  const url = req.nextUrl;
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");
  const expectedState = req.cookies.get("google_oauth_state")?.value;

  const redirect = (flag: string) => {
    const res = NextResponse.redirect(new URL(`/calendar?google=${flag}`, url.origin));
    res.cookies.delete("google_oauth_state");
    return res;
  };

  if (oauthError) return redirect("denied");
  if (!code || !state || !expectedState || state !== expectedState) {
    return redirect("state_mismatch");
  }

  try {
    await exchangeCodeForTokens(code);
  } catch (err) {
    console.error("[google] token exchange failed:", err);
    return redirect("exchange_failed");
  }

  await pollCalendar().catch((err) =>
    console.error("[google] initial poll failed:", err)
  );
  return redirect("connected");
}
