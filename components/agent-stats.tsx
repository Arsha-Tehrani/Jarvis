import { Bot } from "lucide-react";
import { getDb } from "@/lib/db";
import { Card } from "@/components/ui/card";

// Agent cost/latency panel (server-rendered on /status): how slow and how
// expensive the agent actually is, from the telemetry columns on agent_log.
// With local Ollama the answer to "expensive" is a plain $0 — the cost
// numbers only appear once LLM_PROVIDER points at a hosted model.

function isoDaysAgo(n: number): string {
  return new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);
}

export function AgentStats() {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);
  const provider = process.env.LLM_PROVIDER ?? "ollama";

  const turnsToday = (
    db
      .prepare("SELECT COUNT(*) AS n FROM agent_log WHERE substr(created_at, 1, 10) = ?")
      .get(today) as { n: number }
  ).n;
  const turnsWeek = (
    db
      .prepare("SELECT COUNT(*) AS n FROM agent_log WHERE substr(created_at, 1, 10) > ?")
      .get(isoDaysAgo(7)) as { n: number }
  ).n;
  const avgLatency = (
    db
      .prepare(
        `SELECT ROUND(AVG(latency_ms)) AS ms FROM agent_log
         WHERE latency_ms IS NOT NULL AND substr(created_at, 1, 10) > ?`
      )
      .get(isoDaysAgo(7)) as { ms: number | null }
  ).ms;

  const month = today.slice(0, 7);
  const monthly = db
    .prepare(
      `SELECT
         COALESCE(SUM(input_tokens), 0) AS input,
         COALESCE(SUM(output_tokens), 0) AS output,
         SUM(cost_usd) AS cost,
         SUM(CASE WHEN provider = 'anthropic' AND cost_usd IS NULL THEN 1 ELSE 0 END) AS unpriced
       FROM agent_log WHERE substr(created_at, 1, 7) = ?`
    )
    .get(month) as { input: number; output: number; cost: number | null; unpriced: number };

  return (
    <Card className="gap-2 px-(--card-spacing)">
      <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <span className="text-primary [&>svg]:size-3.5">
          <Bot />
        </span>
        Agent
      </span>
      <div className="flex flex-wrap gap-x-8 gap-y-2">
        <Stat label="turns today" value={String(turnsToday)} />
        <Stat label="turns this week" value={String(turnsWeek)} />
        <Stat
          label="avg latency (7d)"
          value={avgLatency != null ? `${(avgLatency / 1000).toFixed(1)}s` : "—"}
        />
        {provider === "ollama" ? (
          <Stat label="cost" value="$0" sub="local model" />
        ) : (
          <>
            <Stat
              label="tokens this month"
              value={
                monthly.input + monthly.output > 0
                  ? `${(monthly.input + monthly.output).toLocaleString("en-US")}`
                  : "—"
              }
              sub={monthly.input > 0 ? `${monthly.input.toLocaleString("en-US")} in / ${monthly.output.toLocaleString("en-US")} out` : undefined}
            />
            <Stat
              label="cost this month"
              value={monthly.cost != null ? `$${monthly.cost.toFixed(2)}` : "—"}
              sub={
                monthly.unpriced > 0
                  ? `${monthly.unpriced} turn(s) unpriced — fill lib/pricing.ts`
                  : undefined
              }
            />
          </>
        )}
      </div>
    </Card>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <p className="text-2xl leading-none font-semibold tracking-tight">{value}</p>
      <p className="mt-1 text-xs text-muted-foreground">
        {label}
        {sub && <span className="text-muted-foreground/70"> · {sub}</span>}
      </p>
    </div>
  );
}
