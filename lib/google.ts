import { getDb } from "@/lib/db";
import { resolveGoogleEventTimes } from "@/lib/calendar-grid";
import { loggedFetch } from "@/lib/network-log";

// Google Calendar via OAuth (Testing mode: refresh tokens expire ~weekly —
// on refresh failure we surface "reconnect" rather than crashing).
// Non-negotiables: tokens live in oauth_tokens (server-side only); Google is
// the single source of truth — we poll and read back into calendar_cache,
// never reconcile two mutable calendars. Poll on open + hourly; no webhooks.

const SCOPES = [
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/calendar.events",
  // Read-only Drive access for the GoodNotes backup sync (lib/goodnotes.ts).
  // Tokens granted before this scope was added get a 403 there — reconnect
  // from the Calendar tab to re-consent.
  "https://www.googleapis.com/auth/drive.readonly",
].join(" ");

export const GOOGLE_REDIRECT_URI = "http://localhost:3000/api/google/callback";

export class GoogleNotConfiguredError extends Error {
  constructor() {
    super("Google OAuth is not configured — set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env.local");
  }
}

export class GoogleNotConnectedError extends Error {
  constructor(message = "Google Calendar is not connected — connect it from the Calendar tab") {
    super(message);
  }
}

function clientCredentials(): { clientId: string; clientSecret: string } {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new GoogleNotConfiguredError();
  return { clientId, clientSecret };
}

export function isGoogleConfigured(): boolean {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

export function isGoogleConnected(): boolean {
  return !!getDb()
    .prepare("SELECT 1 FROM oauth_tokens WHERE provider = 'google'")
    .get();
}

export function buildAuthUrl(state: string): string {
  const { clientId } = clientCredentials();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: GOOGLE_REDIRECT_URI,
    response_type: "code",
    scope: SCOPES,
    access_type: "offline",
    prompt: "consent",
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

export async function exchangeCodeForTokens(code: string): Promise<void> {
  const { clientId, clientSecret } = clientCredentials();
  const res = await loggedFetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: GOOGLE_REDIRECT_URI,
      grant_type: "authorization_code",
    }),
  }, { feature: "google-oauth", purpose: "exchange authorization code" });
  const data = (await res.json()) as TokenResponse;
  if (!res.ok || !data.access_token) {
    throw new Error(`Token exchange failed: ${data.error_description ?? data.error ?? res.status}`);
  }
  storeTokens(data.access_token, data.refresh_token ?? null, data.expires_in ?? 3600);
}

function storeTokens(accessToken: string, refreshToken: string | null, expiresIn: number): void {
  const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
  getDb()
    .prepare(
      `INSERT INTO oauth_tokens (provider, access_token, refresh_token, expires_at)
       VALUES ('google', ?, ?, ?)
       ON CONFLICT(provider) DO UPDATE SET
         access_token = excluded.access_token,
         refresh_token = COALESCE(excluded.refresh_token, oauth_tokens.refresh_token),
         expires_at = excluded.expires_at`
    )
    .run(accessToken, refreshToken, expiresAt);
}

export function disconnectGoogle(): void {
  const db = getDb();
  db.prepare("DELETE FROM oauth_tokens WHERE provider = 'google'").run();
  db.prepare("DELETE FROM calendar_cache").run();
}

// Exported for other Google APIs on the same consent (Drive in goodnotes.ts).
export async function getGoogleAccessToken(): Promise<string> {
  const row = getDb()
    .prepare(
      "SELECT access_token, refresh_token, expires_at FROM oauth_tokens WHERE provider = 'google'"
    )
    .get() as
    | { access_token: string; refresh_token: string | null; expires_at: string }
    | undefined;
  if (!row) throw new GoogleNotConnectedError();

  const stillValid = Date.parse(row.expires_at) - Date.now() > 60_000;
  if (stillValid) return row.access_token;

  if (!row.refresh_token) {
    throw new GoogleNotConnectedError("Google access expired and no refresh token — reconnect from the Calendar tab");
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
  }, { feature: "google-oauth", purpose: "refresh access token" });
  const data = (await res.json()) as TokenResponse;
  if (!res.ok || !data.access_token) {
    // Testing-mode refresh tokens die after ~7 days — expected, not fatal.
    throw new GoogleNotConnectedError(
      `Google token refresh failed (${data.error ?? res.status}) — testing-mode tokens expire ~weekly, reconnect from the Calendar tab`
    );
  }
  storeTokens(data.access_token, null, data.expires_in ?? 3600);
  return data.access_token;
}

type GoogleEvent = {
  id: string;
  summary?: string;
  status?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
};

// Poll: fetch upcoming events and replace the cache (read-back only).
export async function pollCalendar(): Promise<number> {
  const token = await getGoogleAccessToken();
  const params = new URLSearchParams({
    timeMin: new Date().toISOString(),
    maxResults: "50",
    singleEvents: "true",
    orderBy: "startTime",
  });
  const res = await loggedFetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`,
    { headers: { Authorization: `Bearer ${token}` } },
    { feature: "calendar-poll", purpose: "list upcoming events" }
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Calendar list failed (${res.status}): ${detail.slice(0, 300)}`);
  }
  const data = (await res.json()) as { items?: GoogleEvent[] };
  const events = (data.items ?? []).filter((e) => e.status !== "cancelled" && e.id);

  const db = getDb();
  const replace = db.transaction(() => {
    db.prepare("DELETE FROM calendar_cache").run();
    const insert = db.prepare(
      `INSERT INTO calendar_cache (google_event_id, title, start, end)
       VALUES (?, ?, ?, ?)`
    );
    for (const e of events) {
      insert.run(
        e.id,
        e.summary ?? "(untitled)",
        e.start?.dateTime ?? e.start?.date ?? "",
        e.end?.dateTime ?? e.end?.date ?? ""
      );
    }
  });
  replace();
  return events.length;
}

export async function createCalendarEvent({
  title,
  start,
  end,
  notes,
}: {
  title: string;
  start: string;
  end?: string;
  notes?: string;
}): Promise<string> {
  const token = await getGoogleAccessToken();
  // Pure: throws a clear error on an unparseable start/end (never silently
  // misdates), and picks all-day ({date}) vs timed ({dateTime}) the same way
  // the rest of the calendar code detects all-day (a plain YYYY-MM-DD).
  const times = resolveGoogleEventTimes(start, end);

  const res = await loggedFetch(
    "https://www.googleapis.com/calendar/v3/calendars/primary/events",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        summary: title,
        description: notes,
        ...times,
        reminders: { useDefault: true },
      }),
    },
    { feature: "calendar-write", purpose: "create event" }
  );
  const data = (await res.json().catch(() => ({}))) as { id?: string; error?: { message?: string } };
  if (!res.ok || !data.id) {
    throw new Error(`Event creation failed (${res.status}): ${data.error?.message ?? "unknown"}`);
  }
  // Google is the source of truth: read back rather than writing the cache.
  await pollCalendar().catch((err) => console.error("[google] read-back poll failed:", err));
  return data.id;
}

// Cron job: hourly poll (+ catch-up at launch). Not connected → skip quietly.
export async function pollCalendarJob(): Promise<void> {
  if (!isGoogleConfigured() || !isGoogleConnected()) {
    console.log("[google] calendar poll skipped (not configured/connected)");
    return;
  }
  try {
    const n = await pollCalendar();
    console.log(`[google] calendar poll ok — ${n} upcoming events cached`);
  } catch (err) {
    console.error("[google] calendar poll failed:", err);
  }
}
