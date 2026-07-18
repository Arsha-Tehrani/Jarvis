import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import {
  READING_KINDS,
  READING_STATUSES,
  addReadingItem,
  listReading,
} from "@/lib/reading";
import { queueSyncPush } from "@/lib/sync/client";
import { tombstone } from "@/lib/sync/tombstone";

const createSchema = z.object({
  title: z.string().trim().min(1).max(300),
  kind: z.enum(READING_KINDS).optional(),
  author: z.string().max(200).optional(),
  status: z.enum(READING_STATUSES).optional(),
  link: z.string().max(1000).optional(),
  notes: z.string().max(5000).optional(),
});

const updateSchema = z.object({
  id: z.number().int().positive(),
  title: z.string().trim().min(1).max(300).optional(),
  kind: z.enum(READING_KINDS).optional(),
  author: z.string().max(200).nullable().optional(),
  status: z.enum(READING_STATUSES).optional(),
  link: z.string().max(1000).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
  note_path: z.string().max(500).nullable().optional(),
});

export async function GET() {
  return NextResponse.json({ items: listReading() });
}

export async function POST(req: NextRequest) {
  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: z.prettifyError(parsed.error) }, { status: 400 });
  }
  addReadingItem(parsed.data);
  queueSyncPush(); // debounced, non-blocking; no-op unless SYNC_ROLE=client
  return NextResponse.json({ items: listReading() }, { status: 201 });
}

export async function PATCH(req: NextRequest) {
  const parsed = updateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: z.prettifyError(parsed.error) }, { status: 400 });
  }
  const { id, ...fields } = parsed.data;
  const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
  if (entries.length === 0) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }
  const setClause = entries.map(([k]) => `${k} = ?`).join(", ");
  const info = getDb()
    .prepare(`UPDATE reading SET ${setClause} WHERE id = ? AND deleted_at IS NULL`)
    .run(...entries.map(([, v]) => v), id);
  if (info.changes === 0) {
    return NextResponse.json({ error: "Item not found" }, { status: 404 });
  }
  queueSyncPush();
  return NextResponse.json({ items: listReading() });
}

export async function DELETE(req: NextRequest) {
  const id = Number(req.nextUrl.searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }
  // Tombstone (lib/sync/tombstone.ts): the removal propagates through sync.
  const changes = tombstone(getDb(), "reading", "id = ?", [id]);
  if (changes === 0) {
    return NextResponse.json({ error: "Item not found" }, { status: 404 });
  }
  queueSyncPush();
  return NextResponse.json({ ok: true });
}
