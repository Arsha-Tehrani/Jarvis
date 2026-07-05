import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { listPeople, logContactByName } from "@/lib/people";

const BIRTHDAY_RE = /^(?:\d{4}-)?\d{2}-\d{2}$/;

const createSchema = z.object({
  name: z.string().trim().min(1).max(200),
  cadence_days: z.number().int().min(1).max(3650).optional(),
  birthday: z.string().regex(BIRTHDAY_RE, "birthday must be MM-DD or YYYY-MM-DD").optional(),
  gift_ideas: z.string().max(5000).optional(),
  notes: z.string().max(5000).optional(),
});

const updateSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().trim().min(1).max(200).optional(),
  cadence_days: z.number().int().min(1).max(3650).nullable().optional(),
  last_contacted: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD")
    .nullable()
    .optional(),
  birthday: z.string().regex(BIRTHDAY_RE).nullable().optional(),
  gift_ideas: z.string().max(5000).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
});

const contactSchema = z.object({
  action: z.literal("log_contact"),
  name: z.string().trim().min(1).max(200),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  notes: z.string().max(2000).optional(),
});

export async function GET() {
  return NextResponse.json({ people: listPeople() });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);

  const contact = contactSchema.safeParse(body);
  if (contact.success) {
    try {
      const message = logContactByName(
        contact.data.name,
        contact.data.date,
        contact.data.notes
      );
      return NextResponse.json({ ok: true, message });
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Failed" },
        { status: 404 }
      );
    }
  }

  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: z.prettifyError(parsed.error) }, { status: 400 });
  }
  try {
    getDb()
      .prepare(
        "INSERT INTO people (name, cadence_days, birthday, gift_ideas, notes) VALUES (?, ?, ?, ?, ?)"
      )
      .run(
        parsed.data.name,
        parsed.data.cadence_days ?? null,
        parsed.data.birthday ?? null,
        parsed.data.gift_ideas ?? null,
        parsed.data.notes ?? null
      );
  } catch {
    return NextResponse.json(
      { error: `"${parsed.data.name}" already exists` },
      { status: 409 }
    );
  }
  return NextResponse.json({ people: listPeople() }, { status: 201 });
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
    .prepare(`UPDATE people SET ${setClause} WHERE id = ?`)
    .run(...entries.map(([, v]) => v), id);
  if (info.changes === 0) {
    return NextResponse.json({ error: "Person not found" }, { status: 404 });
  }
  return NextResponse.json({ people: listPeople() });
}

export async function DELETE(req: NextRequest) {
  const id = Number(req.nextUrl.searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }
  const info = getDb().prepare("DELETE FROM people WHERE id = ?").run(id);
  if (info.changes === 0) {
    return NextResponse.json({ error: "Person not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
