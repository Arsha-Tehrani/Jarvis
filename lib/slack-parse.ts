// Deterministic parsers for Slack check-in replies. Pure functions with
// unit coverage (tests/slack-parse.test.ts) — the LLM fallback only runs
// when these return null, so the common case never needs a live model.

export type SleepAnswer =
  | { kind: "bedtime"; value: number } // decimal hour of day, 23.5 = 11:30pm
  | { kind: "sleep_hours"; value: number };

// "11:30", "11.30pm", "23:15", "11pm", "midnight", "1am", "around 12"
// → bedtime. "7h", "7 hours", "slept 7.5" → sleep_hours.
export function parseSleepAnswer(raw: string): SleepAnswer | null {
  const text = raw.trim().toLowerCase();
  if (!text) return null;

  if (/\bmidnight\b/.test(text)) return { kind: "bedtime", value: 0 };
  if (/\bnoon\b/.test(text)) return { kind: "bedtime", value: 12 };

  // Explicit duration: "7h", "7 hours", "7.5 hrs", "slept 7"
  const duration = /(?:^|\s)(\d{1,2}(?:[.,]\d+)?)\s*(?:h|hr|hrs|hour|hours)\b/.exec(text);
  if (duration) {
    const value = Number(duration[1].replace(",", "."));
    return value >= 0 && value <= 16 ? { kind: "sleep_hours", value } : null;
  }
  const slept = /^slept\s+(\d{1,2}(?:[.,]\d+)?)$/.exec(text);
  if (slept) {
    const value = Number(slept[1].replace(",", "."));
    return value >= 0 && value <= 16 ? { kind: "sleep_hours", value } : null;
  }

  // Clock time: "11:30", "11:30pm", "23:15", "11pm", "11 pm", "at 12"
  const clock = /(?:^|\s|@|at\s)(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/.exec(text);
  if (clock) {
    let hour = Number(clock[1]);
    const minute = clock[2] ? Number(clock[2]) : 0;
    const meridiem = clock[3];
    if (hour > 24 || minute > 59) return null;
    if (meridiem === "pm" && hour < 12) hour += 12;
    if (meridiem === "am" && hour === 12) hour = 0;
    if (!meridiem) {
      // Bare "11" or "12" at night is almost always pm/midnight-adjacent;
      // bare 1–5 reads as am. 13–24 are unambiguous.
      if (hour >= 6 && hour <= 12) hour = hour === 12 ? 0 : hour + 12;
      if (hour === 24) hour = 0;
    }
    if (hour > 23) return null;
    return { kind: "bedtime", value: hour + minute / 60 };
  }

  return null;
}

// yes/no with common variants; null when unclear.
export function parseYesNo(raw: string): boolean | null {
  const text = raw
    .trim()
    .toLowerCase()
    .replace(/[!.,]+$/, "");
  if (!text) return null;
  if (/^(y|yes|yeah|yep|yup|ya|did|done|sure|✅|👍|of course|i did)$/.test(text)) return true;
  if (/^(n|no|nope|nah|didn't|didnt|did not|skip|skipped|missed( it)?|❌|👎)$/.test(text)) {
    return false;
  }
  if (/^yes\b/.test(text)) return true;
  if (/^no\b/.test(text)) return false;
  return null;
}

// "3", "solved 2", "did 1" → count of problems; yes/no also accepted.
export function parseLeetCodeAnswer(raw: string): { did: boolean; count: number } | null {
  const yn = parseYesNo(raw);
  if (yn !== null) return { did: yn, count: yn ? 1 : 0 };
  const count = /^(?:solved|did)?\s*(\d{1,3})(?:\s*(?:problems?|qs?|questions?))?$/.exec(
    raw.trim().toLowerCase()
  );
  if (count) {
    const n = Number(count[1]);
    return { did: n > 0, count: n };
  }
  return null;
}
