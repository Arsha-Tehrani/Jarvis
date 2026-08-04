// Pure formatting for the system clock — no DB/network imports so
// node --test exercises it directly.

// offsetMinutes is minutes EAST of UTC (i.e. -new Date().getTimezoneOffset()):
// New York in summer (EDT) is -240 → "UTC-4"; Kathmandu is +345 → "UTC+5:45".
export function utcOffsetLabel(offsetMinutes: number): string {
  if (offsetMinutes === 0) return "UTC";
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `UTC${sign}${h}${m ? `:${String(m).padStart(2, "0")}` : ""}`;
}

// Short zone name ("EDT") for a display date in an IANA zone, falling back to
// the numeric UTC offset when Intl can't resolve the zone.
export function zoneAbbreviation(date: Date, timeZone: string, offsetMinutes: number): string {
  try {
    const part = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" })
      .formatToParts(date)
      .find((p) => p.type === "timeZoneName");
    if (part?.value) return part.value;
  } catch {
    // unknown zone name — fall through to the numeric label
  }
  return utcOffsetLabel(offsetMinutes);
}
