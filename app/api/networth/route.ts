import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import {
  ACCOUNT_KINDS,
  computeNetWorth,
  listAccounts,
  snapshots,
  takeSnapshot,
  weeklyDelta,
} from "@/lib/networth";

const createSchema = z.object({
  name: z.string().trim().min(1).max(200),
  kind: z.enum(ACCOUNT_KINDS).optional(),
  balance: z.number().min(0).max(1e12),
});

const updateSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().trim().min(1).max(200).optional(),
  kind: z.enum(ACCOUNT_KINDS).optional(),
  balance: z.number().min(0).max(1e12).optional(),
});

export async function GET() {
  return NextResponse.json({
    accounts: listAccounts(),
    now: computeNetWorth(),
    snapshots: snapshots(),
    weeklyDelta: weeklyDelta(),
  });
}

export async function POST(req: NextRequest) {
  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: z.prettifyError(parsed.error) }, { status: 400 });
  }
  try {
    getDb()
      .prepare("INSERT INTO accounts (name, kind, balance) VALUES (?, ?, ?)")
      .run(parsed.data.name, parsed.data.kind ?? "cash", parsed.data.balance);
  } catch {
    return NextResponse.json(
      { error: `An account named "${parsed.data.name}" already exists` },
      { status: 409 }
    );
  }
  takeSnapshot();
  return NextResponse.json({ accounts: listAccounts() }, { status: 201 });
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
    .prepare(
      `UPDATE accounts SET ${setClause}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
    )
    .run(...entries.map(([, v]) => v), id);
  if (info.changes === 0) {
    return NextResponse.json({ error: "Account not found" }, { status: 404 });
  }
  takeSnapshot();
  return NextResponse.json({ accounts: listAccounts() });
}

export async function DELETE(req: NextRequest) {
  const id = Number(req.nextUrl.searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }
  const info = getDb().prepare("DELETE FROM accounts WHERE id = ?").run(id);
  if (info.changes === 0) {
    return NextResponse.json({ error: "Account not found" }, { status: 404 });
  }
  takeSnapshot();
  return NextResponse.json({ ok: true });
}
