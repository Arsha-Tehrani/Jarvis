// Pure orchestration of the one-repair-then-reject gate: no db/network
// imports, chat is injected — so `node --test` exercises the repair path with
// a scripted fake. lib/bulk-import/parse.ts is the thin production glue.

import {
  buildParseMessages,
  parseBulkImportResponse,
  type BulkGroup,
  type SourceMode,
} from "./schema.ts";

export type ChatLike = (req: {
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  jsonMode?: boolean;
}) => Promise<{ text?: string; meta?: { model: string } }>;

// One corrective retry showing the model its own output + the validation
// error; a second malformed response hard-rejects with a clear message.
// Never returns partial data.
export async function parseChunkWithRepair(
  chunk: string,
  mode: SourceMode,
  todayIso: string,
  chatFn: ChatLike
): Promise<{ groups: BulkGroup[]; model: string | null }> {
  const messages = buildParseMessages(chunk, mode, todayIso);
  // Strict JSON mode (enforced provider-side where supported) — the zod gate
  // below still validates the shape either way.
  const first = await chatFn({ messages, jsonMode: true });
  try {
    return {
      groups: parseBulkImportResponse(first.text ?? "").groups,
      model: first.meta?.model ?? null,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : "invalid response";
    const repair = await chatFn({
      jsonMode: true,
      messages: [
        ...messages,
        { role: "assistant", content: first.text ?? "" },
        {
          role: "user",
          content: `That response was rejected: ${reason}. Reply again with ONLY the corrected JSON in the exact schema. No prose.`,
        },
      ],
    });
    try {
      return {
        groups: parseBulkImportResponse(repair.text ?? "").groups,
        model: repair.meta?.model ?? null,
      };
    } catch (err2) {
      const reason2 = err2 instanceof Error ? err2.message : "invalid response";
      throw new Error(
        `Bulk-import parse failed after one repair attempt: ${reason2}. Nothing was created — try again or trim the pasted text.`
      );
    }
  }
}
