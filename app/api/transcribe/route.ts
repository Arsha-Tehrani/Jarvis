import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

// Browser mic audio → voice sidecar → transcript. The browser can't talk to
// the sidecar directly (and shouldn't need to know it exists), so this route
// forwards the multipart upload and normalizes errors. The sidecar being
// down is a normal state with a clear message, never a crash.

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

const sidecarResponseSchema = z.object({ text: z.string() });

export async function POST(req: NextRequest) {
  const form = await req.formData().catch(() => null);
  const audio = form?.get("audio");
  if (!(audio instanceof File) || audio.size === 0) {
    return NextResponse.json(
      { error: "Send the recording as a multipart 'audio' file field" },
      { status: 400 }
    );
  }
  if (audio.size > MAX_AUDIO_BYTES) {
    return NextResponse.json({ error: "Recording too large (max 25 MB)" }, { status: 413 });
  }

  const base = process.env.VOICE_SIDECAR_URL ?? "http://localhost:8018";
  const forward = new FormData();
  forward.append("audio", audio, audio.name || "clip.webm");

  let res: Response;
  try {
    res = await fetch(`${base}/transcribe`, { method: "POST", body: forward });
  } catch {
    return NextResponse.json(
      {
        error: `Voice sidecar not running at ${base}. Start it: sidecars/voice/.venv/bin/python -m voice.server`,
      },
      { status: 502 }
    );
  }

  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = (data as { detail?: unknown })?.detail;
    return NextResponse.json(
      { error: typeof detail === "string" ? detail : `Transcription failed (${res.status})` },
      { status: 502 }
    );
  }
  const parsed = sidecarResponseSchema.safeParse(data);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Voice sidecar returned an unexpected response shape" },
      { status: 502 }
    );
  }
  return NextResponse.json({ text: parsed.data.text.trim() });
}
