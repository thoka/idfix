/** The real-cost line that `watch` and `log` print after the cost line. */
import type { OpencodeClient } from "@opencode-ai/sdk";
import type { Env } from "./config";
import { errorMessage } from "./client";
import { fetchKeyUsage, resolveDirectoryKey, type KeyFetch } from "./keys";
import { loadAllRunRecords, loadRunRecord, otherRunIds, realCostLine } from "./runs";

/** The parts that the tests replace: fetch and the working directory. */
export type RealCostDeps = {
  fetch: KeyFetch;
  cwd: string;
};

const defaultDeps: RealCostDeps = { fetch, cwd: process.cwd() };

/**
 * The real-cost line for a finished run: the growth of the key usage at
 * OpenRouter since the start of the run. Returns null without a run record
 * with a fingerprint, because then there is nothing to ask OpenRouter about.
 */
export async function realCostOutput(
  client: OpencodeClient,
  sessionId: string,
  env: Env,
  deps: RealCostDeps = defaultDeps,
): Promise<string | null> {
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
