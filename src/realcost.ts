/** The real-cost line that `watch` and `log` print after the cost line. */
import type { OpencodeClient } from "@opencode-ai/sdk";
import type { Env } from "./config";
import { errorMessage } from "./client";
import { fetchKeyUsage, resolveDirectoryKey, type KeyFetch } from "./keys";
import { readProxyTotals, formatProxyLine } from "./proxycost";
import { loadAllRunRecords, loadRunRecord, otherRunIds, realCostLine } from "./runs";
import { stateDir } from "./state";

/** The parts that the tests replace: fetch and the working directory. */
export type RealCostDeps = {
  fetch: KeyFetch;
  cwd: string;
};

const defaultDeps: RealCostDeps = { fetch, cwd: process.cwd() };

/**
 * The real-cost line for a finished run. It first sums the `end` lines of the
 * cost proxy (~/.local/state/idfx logs) for the session tree; when the proxy
 * log has none of the tree sessions, it falls back to the growth of the key
 * usage at OpenRouter since the start of the run. Returns null without a run
 * record with a fingerprint, because then there is nothing to ask OpenRouter
 * about.
 */
export async function realCostOutput(
  client: OpencodeClient,
  sessionId: string,
  env: Env,
  sessionIds: readonly string[],
  deps: RealCostDeps = defaultDeps,
): Promise<string | null> {
  const proxy = await readProxyTotals(stateDir(env), new Set(sessionIds));
  const proxyLine = formatProxyLine(proxy);
  if (proxyLine !== null) return proxyLine;
  try {
    const run = await loadRunRecord(sessionId, deps.cwd, env);
    if (run === null || run.keyFingerprint === undefined) {
      return realCostLine(run, null, []);
    }
    const others = otherRunIds(await loadAllRunRecords(deps.cwd, env), run);
    const key = await resolveDirectoryKey(client, run.directory, env);
    if (key === null || key.fingerprint !== run.keyFingerprint) {
      return realCostLine(run, null, others);
    }
    const usageNow = await fetchKeyUsage(key.key, deps.fetch);
    return realCostLine(run, usageNow, others);
  } catch (error) {
    return `real cost: unknown (${error instanceof Error ? error.message : errorMessage(error)})`;
  }
}
