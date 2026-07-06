import { NextRequest, NextResponse } from "next/server";
import { globalSearch } from "@/lib/search";

export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get("q") ?? "").trim();
  if (q.length < 2) {
    return NextResponse.json({ groups: [], error: "Type at least 2 characters" });
  }
  if (q.length > 200) {
    return NextResponse.json({ error: "Query too long" }, { status: 400 });
  }
  return NextResponse.json({ groups: globalSearch(q) });
}
