import { getDb } from "@/lib/db";
import { resolveDateApplied } from "@/lib/career-dates";
import { undelete } from "@/lib/sync/tombstone";

export const STAGES = [
  "wishlist",
  "applied",
  "screening",
  "interview",
  "offer",
  "rejected",
  "accepted",
] as const;

export type Stage = (typeof STAGES)[number];

export type Application = {
  id: number;
  company: string;
  role: string;
  stage: Stage;
  next_action: string | null;
  next_action_at: string | null;
  contact: string | null;
  link: string | null;
  notes: string | null;
  date_applied: string | null;
  created_at: string;
};

const ACTIVE_STAGES = ["wishlist", "applied", "screening", "interview", "offer"];

export function listApplications(): Application[] {
  return getDb()
    .prepare(
      `SELECT * FROM applications WHERE deleted_at IS NULL
       ORDER BY next_action_at IS NULL, next_action_at ASC, created_at DESC`
    )
    .all() as Application[];
}

// Follow-ups due: an active application whose next_action_at has passed
// (or is today). The nudge list on the hub and the career page.
export function followUpsDue(): Application[] {
  const now = new Date().toISOString();
  return getDb()
    .prepare(
      `SELECT * FROM applications
       WHERE deleted_at IS NULL
         AND stage IN (${ACTIVE_STAGES.map(() => "?").join(",")})
         AND next_action_at IS NOT NULL
         AND substr(next_action_at, 1, 10) <= substr(?, 1, 10)
       ORDER BY next_action_at ASC`
    )
    .all(...ACTIVE_STAGES, now) as Application[];
}

export function addApplication(fields: {
  company: string;
  role: string;
  stage?: Stage;
  next_action?: string;
  next_action_at?: string;
  contact?: string;
  link?: string;
  notes?: string;
  date_applied?: string;
}): number {
  const db = getDb();
  // Re-adding a tombstoned company+role (the sync natural key) revives that
  // row with the new fields instead of inserting a duplicate that would
  // collide when it syncs.
  const tombstoned = db
    .prepare(
      `SELECT id FROM applications
       WHERE LOWER(TRIM(company)) = LOWER(TRIM(?)) AND LOWER(TRIM(role)) = LOWER(TRIM(?))
         AND deleted_at IS NOT NULL`
    )
    .get(fields.company, fields.role) as { id: number } | undefined;
  if (tombstoned) {
    undelete(db, "applications", "id = ?", [tombstoned.id]);
    db.prepare(
      `UPDATE applications SET company = ?, role = ?, stage = ?, next_action = ?,
         next_action_at = ?, contact = ?, link = ?, notes = ?, date_applied = ?
       WHERE id = ?`
    ).run(
      fields.company,
      fields.role,
      fields.stage ?? "applied",
      fields.next_action ?? null,
      fields.next_action_at ?? null,
      fields.contact ?? null,
      fields.link ?? null,
      fields.notes ?? null,
      resolveDateApplied(fields.date_applied),
      tombstoned.id
    );
    return tombstoned.id;
  }
  const info = db
    .prepare(
      `INSERT INTO applications (company, role, stage, next_action, next_action_at, contact, link, notes, date_applied)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      fields.company,
      fields.role,
      fields.stage ?? "applied",
      fields.next_action ?? null,
      fields.next_action_at ?? null,
      fields.contact ?? null,
      fields.link ?? null,
      fields.notes ?? null,
      resolveDateApplied(fields.date_applied)
    );
  return info.lastInsertRowid as number;
}

// Advance by company name (case-insensitive, most recent active first) —
// the shape the agent naturally has.
export function advanceApplicationByCompany(
  company: string,
  stage: Stage,
  next_action?: string,
  next_action_at?: string
): string {
  const db = getDb();
  const app = db
    .prepare(
      `SELECT id, company, role FROM applications
       WHERE LOWER(company) = LOWER(?) AND deleted_at IS NULL
       ORDER BY (stage IN ('rejected','accepted')), created_at DESC LIMIT 1`
    )
    .get(company.trim()) as { id: number; company: string; role: string } | undefined;
  if (!app) {
    throw new Error(`No application found for company "${company}".`);
  }
  db.prepare(
    `UPDATE applications SET stage = ?,
       next_action = COALESCE(?, next_action),
       next_action_at = COALESCE(?, next_action_at)
     WHERE id = ?`
  ).run(stage, next_action ?? null, next_action_at ?? null, app.id);
  return `${app.company} — ${app.role} moved to ${stage}.`;
}
