import { NextResponse } from "next/server";
import { assembleBriefFacts, renderPlainBrief } from "@/lib/brief";

// Preview of the morning brief (deterministic rendering — what the Slack
// DM falls back to when no model is running).
export async function GET() {
  const facts = assembleBriefFacts();
  return NextResponse.json({ facts, text: renderPlainBrief(facts) });
}
