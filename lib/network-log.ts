import { getDb } from "@/lib/db";
import {
  insertNetworkLog,
  loggedFetchWith,
  pruneNetworkLog,
  type NetworkLogMeta,
} from "@/lib/network-log-core";

// loggedFetch: drop-in fetch for OUTBOUND-TO-THE-INTERNET calls, recording
// host + feature + outcome (metadata only, never contents) to network_log.
//
// What counts as outbound: quote APIs, Google OAuth/Calendar/Gmail/Drive,
// Slack, the unofficial LeetCode API, and the Anthropic API when
// LLM_PROVIDER=anthropic. Do NOT wrap calls to localhost — Ollama, the
// sidecars (:8016/:8017/:8018), and ActivityWatch never leave the machine
// and are not a privacy concern; logging them would bury the calls that
// matter and miscategorize local inference as "data leaving the laptop".

const PRUNE_PROBABILITY = 0.02; // amortized cleanup, ~1 in 50 writes

export async function loggedFetch(
  url: string,
  opts: RequestInit | undefined,
  meta: NetworkLogMeta
): Promise<Response> {
  return loggedFetchWith(
    {
      fetchImpl: fetch,
      record: (entry) => {
        const db = getDb();
        insertNetworkLog(db, entry);
        if (Math.random() < PRUNE_PROBABILITY) pruneNetworkLog(db);
      },
    },
    url,
    opts,
    meta
  );
}
