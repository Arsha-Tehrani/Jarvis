import { z } from "zod";
import { loggedFetch } from "@/lib/network-log";
import { computeCostUsd } from "@/lib/pricing";

// Provider abstraction. Callers never know which provider ran.
// Routed by LLM_PROVIDER: "ollama" (default, OpenAI-compatible) or "anthropic".

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

// Tool definition as the LLM layer sees it. The zod schema is converted to
// JSON Schema for the wire format; validation of returned args stays with
// the caller (the tool registry), not here.
export type LlmToolDef = {
  name: string;
  description: string;
  schema: z.ZodType;
};

export type ToolCall = {
  id: string;
  name: string;
  // Parsed JSON, NOT validated. Callers must validate against the tool's
  // zod schema before executing (non-negotiable rule #1).
  args: unknown;
};

// Per-call telemetry, recorded into agent_log by the agent route. Token
// counts come from the API response when present and stay null otherwise —
// never estimated. costUsd is 0 for local Ollama (that's the point of it),
// a real dollar amount for hosted models with a filled-in pricing table,
// and null when the table has no entry for the model (see lib/pricing.ts).
export type ChatMeta = {
  provider: "ollama" | "anthropic";
  model: string;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
};

export type ChatResult = {
  text?: string;
  toolCalls?: ToolCall[];
  meta?: ChatMeta;
};

export async function chat({
  messages,
  tools,
}: {
  messages: ChatMessage[];
  tools?: LlmToolDef[];
}): Promise<ChatResult> {
  const provider = process.env.LLM_PROVIDER ?? "ollama";
  const started = Date.now();
  let result: ChatResult;
  let model: string;
  let usage: { inputTokens: number | null; outputTokens: number | null };
  if (provider === "anthropic") {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error("LLM_PROVIDER=anthropic but ANTHROPIC_API_KEY is not set");
    }
    model = process.env.LLM_MODEL ?? "claude-sonnet-5";
    ({ result, usage } = await chatAnthropic(messages, tools));
  } else {
    model = process.env.LLM_MODEL ?? "llama3.1:8b";
    ({ result, usage } = await chatOllama(messages, tools));
  }
  result.meta = {
    provider: provider === "anthropic" ? "anthropic" : "ollama",
    model,
    latencyMs: Date.now() - started,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    costUsd:
      provider === "anthropic"
        ? computeCostUsd(model, usage.inputTokens, usage.outputTokens)
        : 0,
  };
  return result;
}

// Embeddings for the semantic search index. Always the local Ollama
// OpenAI-compatible endpoint regardless of LLM_PROVIDER — Anthropic has no
// embeddings API, and embeddings of personal data should stay local anyway.
// Callers treat failure as normal (search degrades to its exact tier).
export async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const baseUrl = process.env.LLM_BASE_URL ?? "http://localhost:11434/v1";
  const model = process.env.EMBED_MODEL ?? "nomic-embed-text";

  let res: Response;
  try {
    res = await fetch(`${baseUrl}/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, input: texts }),
    });
  } catch {
    throw new Error(
      `Could not reach the embedding endpoint at ${baseUrl}. Is Ollama running? (ollama serve)`
    );
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Embedding request failed (${res.status}): ${detail.slice(0, 300)}`);
  }

  const data = (await res.json()) as {
    data?: Array<{ index?: number; embedding?: number[] }>;
  };
  const rows = data.data ?? [];
  if (rows.length !== texts.length) {
    throw new Error(
      `Embedding response mismatch: sent ${texts.length} texts, got ${rows.length} vectors`
    );
  }
  // OpenAI-compatible responses carry an index; honor it rather than assume order.
  const out: number[][] = new Array(texts.length);
  rows.forEach((row, i) => {
    if (!Array.isArray(row.embedding)) {
      throw new Error("Embedding response missing a vector");
    }
    out[row.index ?? i] = row.embedding;
  });
  return out;
}

function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema) as Record<string, unknown>;
}

type ProviderUsage = { inputTokens: number | null; outputTokens: number | null };

async function chatOllama(
  messages: ChatMessage[],
  tools?: LlmToolDef[]
): Promise<{ result: ChatResult; usage: ProviderUsage }> {
  const baseUrl = process.env.LLM_BASE_URL ?? "http://localhost:11434/v1";
  const model = process.env.LLM_MODEL ?? "llama3.1:8b";

  const body: Record<string, unknown> = { model, messages, stream: false };
  if (tools && tools.length > 0) {
    body.tools = tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: toJsonSchema(t.schema),
      },
    }));
  }

  let res: Response;
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error(
      `Could not reach the LLM at ${baseUrl}. Is Ollama running? (ollama serve)`
    );
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`LLM request failed (${res.status}): ${detail.slice(0, 500)}`);
  }

  const data = (await res.json()) as {
    choices?: Array<{
      message?: {
        content?: string | null;
        tool_calls?: Array<{
          id?: string;
          function?: { name?: string; arguments?: string };
        }>;
      };
    }>;
    // Ollama's OpenAI-compatible endpoint usually reports usage; when it
    // doesn't, the counts stay null rather than being estimated.
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };

  const message = data.choices?.[0]?.message;
  const result: ChatResult = {};
  if (message?.content) result.text = message.content;
  if (message?.tool_calls?.length) {
    result.toolCalls = message.tool_calls.map((tc, i) => ({
      id: tc.id ?? `call_${i}`,
      name: tc.function?.name ?? "",
      args: safeJsonParse(tc.function?.arguments),
    }));
  }
  return {
    result,
    usage: {
      inputTokens: data.usage?.prompt_tokens ?? null,
      outputTokens: data.usage?.completion_tokens ?? null,
    },
  };
}

async function chatAnthropic(
  messages: ChatMessage[],
  tools?: LlmToolDef[]
): Promise<{ result: ChatResult; usage: ProviderUsage }> {
  const model = process.env.LLM_MODEL ?? "claude-sonnet-5";
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  const conversation = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role, content: m.content }));

  const body: Record<string, unknown> = {
    model,
    max_tokens: 1024,
    messages: conversation,
  };
  if (system) body.system = system;
  if (tools && tools.length > 0) {
    body.tools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: toJsonSchema(t.schema),
    }));
  }

  // The one hosted-LLM call in the app — audit-logged. The Ollama path above
  // is localhost and deliberately NOT logged (see lib/network-log.ts).
  const res = await loggedFetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY as string,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  }, { feature: "agent-anthropic-call", purpose: "chat completion" });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Anthropic request failed (${res.status}): ${detail.slice(0, 500)}`);
  }

  const data = (await res.json()) as {
    content?: Array<
      | { type: "text"; text: string }
      | { type: "tool_use"; id: string; name: string; input: unknown }
    >;
    usage?: { input_tokens?: number; output_tokens?: number };
  };

  const result: ChatResult = {};
  const textParts: string[] = [];
  const toolCalls: ToolCall[] = [];
  for (const block of data.content ?? []) {
    if (block.type === "text") textParts.push(block.text);
    else if (block.type === "tool_use") {
      toolCalls.push({ id: block.id, name: block.name, args: block.input });
    }
  }
  if (textParts.length) result.text = textParts.join("\n");
  if (toolCalls.length) result.toolCalls = toolCalls;
  return {
    result,
    usage: {
      inputTokens: data.usage?.input_tokens ?? null,
      outputTokens: data.usage?.output_tokens ?? null,
    },
  };
}

function safeJsonParse(raw: string | undefined): unknown {
  if (raw == null) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    // Return the raw string; zod validation downstream will reject it
    // with a clear error instead of executing a garbled call.
    return raw;
  }
}
