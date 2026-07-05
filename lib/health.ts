import { z } from "zod";
import { getDb } from "@/lib/db";

// Health metrics: one value per date+kind (upsert). Units by kind:
// sleep_hours = hours (0–16), bedtime = decimal hour of day (0–24,
// e.g. 23.5 = 11:30pm), weight = user's unit as-is, mood = 1–5.

export const HEALTH_KINDS = ["sleep_hours", "bedtime", "weight", "mood"] as const;
export type HealthKind = (typeof HEALTH_KINDS)[number];

export const healthValueSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("sleep_hours"), value: z.number().min(0).max(16) }),
  z.object({ kind: z.literal("bedtime"), value: z.number().min(0).max(24) }),
  z.object({ kind: z.literal("weight"), value: z.number().positive().max(1000) }),
  z.object({ kind: z.literal("mood"), value: z.number().int().min(1).max(5) }),
]);

export function logMetric(
  kind: HealthKind,
  value: number,
  date?: string,
  notes?: string
): string {
  const parsed = healthValueSchema.safeParse({ kind, value });
  if (!parsed.success) {
    throw new Error(`Out-of-range value ${value} for ${kind}`);
  }
  const day = date ?? new Date().toISOString().slice(0, 10);
  getDb()
    .prepare(
      `INSERT INTO health_logs (date, kind, value, notes) VALUES (?, ?, ?, ?)
       ON CONFLICT(date, kind) DO UPDATE SET
         value = excluded.value, notes = COALESCE(excluded.notes, notes)`
    )
    .run(day, kind, value, notes ?? null);
  return day;
}

export type HealthRow = { date: string; kind: HealthKind; value: number; notes: string | null };

export function healthHistory(days = 30): HealthRow[] {
  const since = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
  return getDb()
    .prepare(
      "SELECT date, kind, value, notes FROM health_logs WHERE date >= ? ORDER BY date ASC"
    )
    .all(since) as HealthRow[];
}

export function latestMetric(kind: HealthKind): HealthRow | undefined {
  return getDb()
    .prepare(
      "SELECT date, kind, value, notes FROM health_logs WHERE kind = ? ORDER BY date DESC LIMIT 1"
    )
    .get(kind) as HealthRow | undefined;
}

export function formatBedtime(value: number): string {
  const h = Math.floor(value) % 24;
  const m = Math.round((value - Math.floor(value)) * 60);
  const ampm = h >= 12 ? "pm" : "am";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")}${ampm}`;
}
