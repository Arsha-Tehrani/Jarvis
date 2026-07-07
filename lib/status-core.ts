// Pure pieces of the system-status page: the check runner and the summary
// math. No db/network imports so `node --test` exercises them directly —
// the real probes (which do hit the network) live in lib/status.ts.

export type HealthStatus = "ok" | "degraded" | "down" | "unconfigured";

export type HealthCheck = {
  id: string;
  label: string;
  status: HealthStatus;
  message: string;
  latencyMs?: number;
  lastChecked: string; // ISO timestamp
};

export type ProbeResult = { status: HealthStatus; message: string };

export type Probe = {
  id: string;
  label: string;
  run: () => ProbeResult | Promise<ProbeResult>;
};

// Run every probe in parallel, each independently caught — one integration
// blowing up must never hide the state of the others. A thrown error is
// reported as "down" with the error text as the message.
export async function runProbes(probes: Probe[]): Promise<HealthCheck[]> {
  return Promise.all(
    probes.map(async (probe): Promise<HealthCheck> => {
      const started = Date.now();
      let result: ProbeResult;
      try {
        result = await probe.run();
      } catch (err) {
        result = {
          status: "down",
          message: err instanceof Error ? err.message : "probe failed",
        };
      }
      return {
        id: probe.id,
        label: probe.label,
        status: result.status,
        message: result.message,
        latencyMs: Date.now() - started,
        lastChecked: new Date().toISOString(),
      };
    })
  );
}

export type HealthSummary = {
  healthy: number; // checks reporting ok
  configured: number; // checks that are configured at all (not "unconfigured")
  total: number;
  problems: string[]; // labels of degraded/down checks, worst first
};

// "10/12 healthy" — unconfigured integrations are a normal state and don't
// count against health; only configured-but-broken ones are problems.
export function summarizeChecks(checks: HealthCheck[]): HealthSummary {
  const configured = checks.filter((c) => c.status !== "unconfigured");
  const rank: Record<HealthStatus, number> = { down: 0, degraded: 1, ok: 2, unconfigured: 3 };
  const problems = configured
    .filter((c) => c.status === "down" || c.status === "degraded")
    .sort((a, b) => rank[a.status] - rank[b.status])
    .map((c) => c.label);
  return {
    healthy: configured.filter((c) => c.status === "ok").length,
    configured: configured.length,
    total: checks.length,
    problems,
  };
}
