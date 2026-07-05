import { NextRequest, NextResponse } from "next/server";
import { exchangeGmailCode, pollAccount } from "@/lib/mail";

// Gmail OAuth redirect target: http://localhost:3000/api/mail/callback
// (add it to the OAuth client alongside the calendar callback). Verifies
// the CSRF state cookie, exchanges the code, registers the inbox, does an
// initial poll, and bounces back to the Mail tab.

export async function GET(req: NextRequest) {
  const url = req.nextUrl;
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");
  const expectedState = req.cookies.get("gmail_oauth_state")?.value;

  const redirect = (flag: string) => {
    const res = NextResponse.redirect(new URL(`/mail?gmail=${flag}`, url.origin));
    res.cookies.delete("gmail_oauth_state");
    return res;
  };

  if (oauthError) return redirect("denied");
  if (!code || !state || !expectedState || state !== expectedState) {
    return redirect("state_mismatch");
  }

  let email: string;
  try {
    email = await exchangeGmailCode(code);
  } catch (err) {
    console.error("[mail] token exchange failed:", err);
    return redirect("exchange_failed");
  }

  await pollAccount(email).catch((err) =>
    console.error("[mail] initial poll failed:", err)
  );
  return redirect("connected");
}
