import fs from "fs";
import path from "path";
import { getDb } from "@/lib/db";
import { loggedFetch } from "@/lib/network-log";
import {
  GoogleNotConnectedError,
  getGoogleAccessToken,
  isGoogleConfigured,
  isGoogleConnected,
} from "@/lib/google";

// GoodNotes auto-backs-up handwritten notes as PDFs to a Google Drive
// folder. Hourly (+ launch catch-up) we poll that folder, download files
// whose modifiedTime moved past what goodnotes_sync_state recorded, park
// them in /temp_notes (gitignored), and hand each path to the textbook-rag
// sidecar's POST /ingest so the notes become searchable via ask_textbook.
// Sync state is written only after a successful ingest, so a failed file
// (sidecar down, Ollama down) retries on the next run instead of being
// silently marked done. Needs the drive.readonly scope — tokens granted
// before it was added to lib/google.ts SCOPES must reconnect once.

const RAG_BASE_URL = process.env.TEXTBOOK_RAG_URL ?? "http://localhost:8016";
const TEMP_DIR = path.join(process.cwd(), "temp_notes");
// Marker PDF→Markdown conversion can take minutes per file on CPU.
const INGEST_TIMEOUT_MS = 15 * 60 * 1000;

export function goodnotesFolderName(): string {
  return process.env.GOODNOTES_DRIVE_FOLDER ?? "GoodNotes Backup";
}

type DriveFile = { id: string; name: string; modifiedTime: string };

export type GoodNotesSyncResult = {
  scanned: number;
  ingested: number;
  skipped: number;
  failed: Array<{ name: string; error: string }>;
};

async function driveGet(url: string, purpose: string): Promise<Response> {
  const token = await getGoogleAccessToken();
  const res = await loggedFetch(
    url,
    { headers: { Authorization: `Bearer ${token}` } },
    { feature: "goodnotes-sync", purpose }
  );
  if (res.status === 403) {
    // The stored consent predates the drive.readonly scope.
    throw new GoogleNotConnectedError(
      "Google Drive returned 403 — reconnect Google from the Calendar tab to grant the Drive (read-only) scope"
    );
  }
  return res;
}

async function findFolderId(): Promise<string | null> {
  const name = goodnotesFolderName().replace(/'/g, "\\'");
  const params = new URLSearchParams({
    q: `name = '${name}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: "files(id)",
    pageSize: "1",
  });
  const res = await driveGet(
    `https://www.googleapis.com/drive/v3/files?${params}`,
    "find backup folder"
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Drive folder lookup failed (${res.status}): ${detail.slice(0, 300)}`);
  }
  const data = (await res.json()) as { files?: { id: string }[] };
  return data.files?.[0]?.id ?? null;
}

async function listFolderPdfs(folderId: string): Promise<DriveFile[]> {
  const files: DriveFile[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and mimeType = 'application/pdf' and trashed = false`,
      fields: "nextPageToken, files(id, name, modifiedTime)",
      pageSize: "100",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const res = await driveGet(
      `https://www.googleapis.com/drive/v3/files?${params}`,
      "list notebook PDFs"
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Drive file list failed (${res.status}): ${detail.slice(0, 300)}`);
    }
    const data = (await res.json()) as { nextPageToken?: string; files?: DriveFile[] };
    files.push(...(data.files ?? []).filter((f) => f.id && f.name));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return files;
}

// Keep the Drive name (the RAG source label is the file stem) but strip
// path separators and other characters that break filesystems.
function safeFileName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, "-").trim();
  return cleaned.toLowerCase().endsWith(".pdf") ? cleaned : `${cleaned}.pdf`;
}

async function downloadPdf(file: DriveFile): Promise<string> {
  const res = await driveGet(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}?alt=media`,
    "download notebook PDF"
  );
  if (!res.ok) throw new Error(`Drive download failed (${res.status}) for "${file.name}"`);
  fs.mkdirSync(TEMP_DIR, { recursive: true });
  const filePath = path.join(TEMP_DIR, safeFileName(file.name));
  fs.writeFileSync(filePath, Buffer.from(await res.arrayBuffer()));
  return filePath;
}

async function ingestIntoRag(filePath: string): Promise<{ chunks: number; engine: string }> {
  let res: Response;
  try {
    res = await fetch(`${RAG_BASE_URL}/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: filePath }),
      signal: AbortSignal.timeout(INGEST_TIMEOUT_MS),
    });
  } catch {
    throw new Error(
      `RAG sidecar unreachable at ${RAG_BASE_URL} — start it with: python -m rag.server`
    );
  }
  const data = (await res.json().catch(() => ({}))) as {
    chunks?: number;
    engine?: string;
    detail?: string;
  };
  if (!res.ok) {
    throw new Error(`RAG ingest failed (${res.status}): ${data.detail ?? "unknown"}`);
  }
  return { chunks: data.chunks ?? 0, engine: data.engine ?? "unknown" };
}

export async function syncGoodNotes(): Promise<GoodNotesSyncResult> {
  const folderId = await findFolderId();
  if (!folderId) {
    throw new Error(
      `Drive folder "${goodnotesFolderName()}" not found — check the GoodNotes backup destination or set GOODNOTES_DRIVE_FOLDER`
    );
  }

  const db = getDb();
  const seen = db.prepare(
    "SELECT modified_time FROM goodnotes_sync_state WHERE file_id = ?"
  );
  const markDone = db.prepare(
    `INSERT INTO goodnotes_sync_state (file_id, name, modified_time, ingested_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(file_id) DO UPDATE SET
       name = excluded.name,
       modified_time = excluded.modified_time,
       ingested_at = excluded.ingested_at`
  );

  const result: GoodNotesSyncResult = { scanned: 0, ingested: 0, skipped: 0, failed: [] };
  for (const file of await listFolderPdfs(folderId)) {
    result.scanned++;
    const row = seen.get(file.id) as { modified_time: string } | undefined;
    if (row && row.modified_time === file.modifiedTime) {
      result.skipped++;
      continue;
    }
    try {
      const filePath = await downloadPdf(file);
      const { chunks, engine } = await ingestIntoRag(filePath);
      markDone.run(file.id, file.name, file.modifiedTime, new Date().toISOString());
      result.ingested++;
      console.log(`[goodnotes] ingested "${file.name}" via ${engine} (${chunks} chunks)`);
    } catch (err) {
      // Leave sync state untouched so this file retries next run.
      result.failed.push({
        name: file.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}

// Cron job: hourly poll (+ catch-up at launch). Not connected → skip quietly.
export async function syncGoodNotesJob(): Promise<void> {
  if (!isGoogleConfigured() || !isGoogleConnected()) {
    console.log("[goodnotes] sync skipped (Google not configured/connected)");
    return;
  }
  try {
    const r = await syncGoodNotes();
    console.log(
      `[goodnotes] sync ok — ${r.scanned} scanned, ${r.ingested} ingested, ${r.skipped} unchanged` +
        (r.failed.length > 0
          ? `, ${r.failed.length} failed: ${r.failed.map((f) => f.name).join(", ")}`
          : "")
    );
    for (const f of r.failed) console.error(`[goodnotes] "${f.name}": ${f.error}`);
  } catch (err) {
    console.error("[goodnotes] sync failed:", err);
  }
}
