import { getDb } from "@/lib/db";
import { undelete } from "@/lib/sync/tombstone";

export const READING_KINDS = ["book", "article", "course", "paper", "video"] as const;
export const READING_STATUSES = ["queued", "reading", "done", "abandoned"] as const;

export type ReadingItem = {
  id: number;
  kind: (typeof READING_KINDS)[number];
  title: string;
  author: string | null;
  status: (typeof READING_STATUSES)[number];
  link: string | null;
  notes: string | null;
  note_path: string | null;
  created_at: string;
};

export function listReading(): ReadingItem[] {
  return getDb()
    .prepare(
      `SELECT * FROM reading WHERE deleted_at IS NULL
       ORDER BY CASE status WHEN 'reading' THEN 0 WHEN 'queued' THEN 1 WHEN 'done' THEN 2 ELSE 3 END,
                created_at DESC`
    )
    .all() as ReadingItem[];
}

export function currentReads(): ReadingItem[] {
  return getDb()
    .prepare(
      "SELECT * FROM reading WHERE status = 'reading' AND deleted_at IS NULL ORDER BY created_at DESC"
    )
    .all() as ReadingItem[];
}

export function addReadingItem(fields: {
  title: string;
  kind?: (typeof READING_KINDS)[number];
  author?: string;
  link?: string;
  notes?: string;
  status?: (typeof READING_STATUSES)[number];
}): void {
  const db = getDb();
  const kind = fields.kind ?? "book";
  // Re-adding a tombstoned title+kind (the sync natural key) revives that
  // row instead of inserting a duplicate that would collide when it syncs.
  const tombstoned = db
    .prepare(
      `SELECT id FROM reading
       WHERE LOWER(TRIM(title)) = LOWER(TRIM(?)) AND kind = ? AND deleted_at IS NOT NULL`
    )
    .get(fields.title, kind) as { id: number } | undefined;
  if (tombstoned) {
    undelete(db, "reading", "id = ?", [tombstoned.id]);
    db.prepare(
      `UPDATE reading SET kind = ?, title = ?, author = ?, status = ?, link = ?, notes = ?
       WHERE id = ?`
    ).run(
      kind,
      fields.title,
      fields.author ?? null,
      fields.status ?? "queued",
      fields.link ?? null,
      fields.notes ?? null,
      tombstoned.id
    );
    return;
  }
  db.prepare(
    "INSERT INTO reading (kind, title, author, status, link, notes) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(
    kind,
    fields.title,
    fields.author ?? null,
    fields.status ?? "queued",
    fields.link ?? null,
    fields.notes ?? null
  );
}
