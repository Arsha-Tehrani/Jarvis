import { NextResponse } from "next/server";
import { GoodNotesFolderNotFoundError, syncGoodNotes } from "@/lib/goodnotes";

// Manual "Sync now" trigger for the hourly GoodNotes->Drive->RAG poll
// (lib/goodnotes.ts's syncGoodNotesJob runs this same core function on a
// cron). No confirm gate: sync only reads Drive and ingests into the local
// RAG index, it never deletes or overwrites anything.

export async function POST() {
  try {
    const result = await syncGoodNotes();
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof GoodNotesFolderNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "GoodNotes sync failed" },
      { status: 502 }
    );
  }
}
