import fs from "fs";
import path from "path";
import { NextResponse } from "next/server";
import { exportAllData } from "@/lib/backup";

// GET → downloads the full JSON dump and writes a copy to /backups.
export async function GET() {
  const data = exportAllData();
  const json = JSON.stringify(data, null, 2);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filename = `jarvis-backup-${stamp}.json`;

  try {
    const dir = path.join(process.cwd(), "backups");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, filename), json, "utf8");
  } catch (err) {
    console.error("[backup] could not write local copy:", err);
  }

  return new NextResponse(json, {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
