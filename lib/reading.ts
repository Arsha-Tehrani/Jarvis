import { getDb } from "@/lib/db";

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
      `SELECT * FROM reading
       ORDER BY CASE status WHEN 'reading' THEN 0 WHEN 'queued' THEN 1 WHEN 'done' THEN 2 ELSE 3 END,
                created_at DESC`
    )
    .all() as ReadingItem[];
}

export function currentReads(): ReadingItem[] {
  return getDb()
    .prepare("SELECT * FROM reading WHERE status = 'reading' ORDER BY created_at DESC")
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
  getDb()
    .prepare(
      "INSERT INTO reading (kind, title, author, status, link, notes) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .run(
      fields.kind ?? "book",
      fields.title,
      fields.author ?? null,
      fields.status ?? "queued",
      fields.link ?? null,
      fields.notes ?? null
    );
}
