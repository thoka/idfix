/**
 * Run records: one JSON file per started run under `.opencode/runs/` of the
 * start directory, and a copy under `<stateHome>/idfx/runs/` so that
 * `watch` and `log` find the record from any working directory.
 */
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Env } from "./config";
import { stateDir } from "./state";

export type RunRecord = {
  sessionId: string;
  directory: string;
  agent: string;
  title: string | null;
  startedAt: string;
  /** The key fingerprint of the run, from `keyFingerprint`. Missing on old records. */
  keyFingerprint?: string;
  /** The cumulative key usage in USD when the run started, or null when OpenRouter did not answer. */
  usageAtStart?: number | null;
};

export function makeRunRecord(input: {
  sessionId: string;
  directory: string;
  agent: string;
  title?: string;
  startedAt?: Date;
  keyFingerprint?: string;
  usageAtStart?: number | null;
}): RunRecord {
  return {
    sessionId: input.sessionId,
    directory: input.directory,
    agent: input.agent,
    title: input.title ?? null,
    startedAt: (input.startedAt ?? new Date()).toISOString(),
    ...(input.keyFingerprint === undefined ? {} : { keyFingerprint: input.keyFingerprint }),
    ...(input.usageAtStart === undefined ? {} : { usageAtStart: input.usageAtStart }),
  };
}

export function runRecordPath(cwd: string, sessionId: string): string {
  return path.join(cwd, ".opencode", "runs", `${sessionId}.json`);
}

/** The folder of the run records in the per-user state, `<stateHome>/idfx/runs/`. */
export function stateRunsDir(env: Env): string {
  return path.join(stateDir(env), "runs");
}

/** The path of a run record in the state folder. */
export function stateRunRecordPath(env: Env, sessionId: string): string {
  return path.join(stateRunsDir(env), `${sessionId}.json`);
}

/** Write the record and return its path. */
export async function writeRunRecord(cwd: string, record: RunRecord): Promise<string> {
  const file = runRecordPath(cwd, record.sessionId);
  await mkdir(path.dirname(file), { recursive: true });
  await Bun.write(file, `${JSON.stringify(record, null, 2)}\n`);
  return file;
}

/** Write the record into the state folder and return its path. */
export async function writeStateRunRecord(env: Env, record: RunRecord): Promise<string> {
  const file = stateRunRecordPath(env, record.sessionId);
  await mkdir(path.dirname(file), { recursive: true });
  await Bun.write(file, `${JSON.stringify(record, null, 2)}\n`);
  return file;
}

function parseRunRecord(text: string): RunRecord | null {
  try {
    const parsed = JSON.parse(text) as { sessionId?: unknown };
    return typeof parsed.sessionId === "string" ? (parsed as RunRecord) : null;
  } catch {
    return null;
  }
}

/**
 * The run record of a session: from the state folder first, then from the
 * `.opencode/runs/` folder of cwd. Null without a record.
 */
export async function loadRunRecord(sessionId: string, cwd: string, env: Env): Promise<RunRecord | null> {
  for (const file of [stateRunRecordPath(env, sessionId), runRecordPath(cwd, sessionId)]) {
    try {
      const record = parseRunRecord(await readFile(file, "utf8"));
      if (record !== null) return record;
    } catch {
      // Try the next location.
    }
  }
  return null;
}

/**
 * All run records in the state folder and in the `.opencode/runs/` folder of
 * cwd, each session ID once. A record usually exists in both folders, so the
 * first copy wins: the state folder is read first.
 */
export async function loadAllRunRecords(cwd: string, env: Env): Promise<RunRecord[]> {
  const records: RunRecord[] = [];
  const seen = new Set<string>();
  for (const dir of [stateRunsDir(env), path.join(cwd, ".opencode", "runs")]) {
    let names: string[];
    try {
      names = await Array.fromAsync(new Bun.Glob("*.json").scan({ cwd: dir }));
    } catch {
      continue;
    }
    for (const name of names) {
      try {
        const record = parseRunRecord(await readFile(path.join(dir, name), "utf8"));
        if (record !== null && !seen.has(record.sessionId)) {
          seen.add(record.sessionId);
          records.push(record);
        }
      } catch {
        // Skip an unreadable record.
      }
    }
  }
  return records;
}

/**
 * The session IDs of other runs that share the fingerprint of this run and
 * overlap with it in time. Records only store the start time, so a run
 * counts as overlapping when it started at or after the start of this run.
 * Pure function.
 */
export function otherRunIds(records: readonly RunRecord[], run: RunRecord): string[] {
  return records
    .filter(
      (other) =>
        other.sessionId !== run.sessionId &&
        other.keyFingerprint !== undefined &&
        other.keyFingerprint === run.keyFingerprint &&
        other.startedAt >= run.startedAt,
    )
    .map((other) => other.sessionId)
    // A record exists twice: in the state folder and in `.opencode/runs/`.
    .filter((id, index, ids) => ids.indexOf(id) === index)
    .sort();
}

/**
 * One real-cost line after the cost line of `watch` and `log`. Pure function.
 * The real cost is the growth of the key usage at OpenRouter during the run.
 * OpenRouter counts a request a minute or two late, so a later `log` can
 * show a slightly higher real cost.
 */
export function realCostLine(run: RunRecord | null, usageNow: number | null, others: readonly string[]): string {
  if (run === null || run.usageAtStart === undefined || run.usageAtStart === null) {
    return "real cost: unknown (no key usage at the start of the run)";
  }
  if (usageNow === null) {
    return "real cost: unknown (OpenRouter did not answer)";
  }
  const real = usageNow - run.usageAtStart;
  const base = `real cost $${real.toFixed(4)} at OpenRouter (key usage since the start of the run)`;
  return others.length === 0 ? base : `${base}, includes other runs: ${others.join(", ")}`;
}
