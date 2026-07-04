import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";

const createSchema = z.object({
  title: z.string().min(1).max(500),
  due_at: z.string().nullable().optional(),
  priority: z.enum(["low", "medium", "high"]).optional(),
});

const updateSchema = z.object({
  id: z.number().int().positive(),
  title: z.string().min(1).max(500).optional(),
  due_at: z.string().nullable().optional(),
  priority: z.enum(["low", "medium", "high"]).optional(),
  status: z.enum(["open", "done"]).optional(),
});

export async function GET() {
  const rows = getDb()
    .prepare(
      `SELECT id, title, due_at, priority, status, source, created_at
       FROM tasks
       ORDER BY status ASC, due_at IS NULL, due_at ASC, created_at DESC`
    )
    .all();
  return NextResponse.json({ tasks: rows });
}

export async function POST(req: NextRequest) {
  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: z.prettifyError(parsed.error) }, { status: 400 });
  }
  const { title, due_at, priority } = parsed.data;
  const info = getDb()
    .prepare(
      "INSERT INTO tasks (title, due_at, priority, status, source) VALUES (?, ?, ?, 'open', 'manual')"
    )
    .run(title, due_at ?? null, priority ?? "medium");
  const task = getDb()
    .prepare("SELECT * FROM tasks WHERE id = ?")
    .get(info.lastInsertRowid);
  return NextResponse.json({ task }, { status: 201 });
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
    .prepare(`UPDATE tasks SET ${setClause} WHERE id = ?`)
    .run(...entries.map(([, v]) => v), id);
  if (info.changes === 0) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }
  const task = getDb().prepare("SELECT * FROM tasks WHERE id = ?").get(id);
  return NextResponse.json({ task });
}

export async function DELETE(req: NextRequest) {
  const id = Number(req.nextUrl.searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }
  const info = getDb().prepare("DELETE FROM tasks WHERE id = ?").run(id);
  if (info.changes === 0) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
