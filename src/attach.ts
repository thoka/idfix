/** `oc-sub attach CODE`: attach the opencode TUI to a known run. */
import type { Env } from "./config";
import { makeClient, probeServer } from "./client";
import { loadAllRunRecords, type RunRecord } from "./runs";
import { resolveCommandUrl } from "./sandbox";

/** The handle of the spawned TUI child process. */
export type SpawnHandle = {
  exited: Promise<number>;
  kill: () => void;
};

/** The parts of attach that the tests replace: the records, the child process, and the session check. */
export type AttachDeps = {
  loadRecords: (cwd: string, env: Env) => Promise<RunRecord[]>;
  spawn: (cmd: string[]) => SpawnHandle;
  checkSession: (url: string, directory: string, sessionId: string, env: Env) => Promise<"present" | "deleted" | "unreachable">;
  pollMs: number;
  sleep: (ms: number) => Promise<void>;
  cwd: string;
};

function defaultSpawn(cmd: string[]): SpawnHandle {
  const proc = Bun.spawn(cmd, { stdio: ["inherit", "inherit", "inherit"] });
  return { exited: proc.exited, kill: () => proc.kill("SIGTERM") };
}

async function defaultCheckSession(
  url: string,
  directory: string,
  sessionId: string,
  env: Env,
): Promise<"present" | "deleted" | "unreachable"> {
  const probe = await probeServer(url, env);
  if (probe.state !== "up") return "unreachable";
  try {
    const client = makeClient(url, env);
    const result = await client.session.get({ path: { id: sessionId }, query: { directory } });
    if (result.response?.status === 404) return "deleted";
    return "present";
  } catch {
    // An unclear answer must not kill the TUI.
    return "present";
  }
}

const defaultDeps: AttachDeps = {
  loadRecords: loadAllRunRecords,
  spawn: defaultSpawn,
  checkSession: defaultCheckSession,
  pollMs: 2000,
  sleep: Bun.sleep,
  cwd: process.cwd(),
};

/** How many misses in a row (server unreachable) end the attach. */
export const GONE_AFTER_MISSES = 3;

/**
 * The decision rule of the attach poll. Pure. A deleted session ends at once.
 * A miss (server down or unclear) counts; GONE_AFTER_MISSES misses in a row
 * end the attach. "present" resets the count.
 */
export function nextWatchState(
  misses: number,
  check: "present" | "deleted" | "unreachable",
): { misses: number; end?: "deleted" | "gone" } {
  if (check === "deleted") return { misses: 0, end: "deleted" };
  if (check === "present") return { misses: 0 };
  const next = misses + 1;
  if (next >= GONE_AFTER_MISSES) return { misses: next, end: "gone" };
  return { misses: next };
}

/**
 * Keep only the characters [A-Za-z0-9_] of CODE. The user may paste the CODE
 * from `oc-sub top` with its agent icon, for example "🔧3NcXxn". Pure.
 */
export function normalizeCode(code: string): string {
  return (code.match(/[A-Za-z0-9_]/g) ?? []).join("");
}

/** The runs whose session ID contains CODE, case-sensitive substring. Pure. */
export function matchingRuns(records: readonly RunRecord[], code: string): RunRecord[] {
  return records.filter((record) => record.sessionId.includes(code));
}

function matchLines(matches: readonly RunRecord[]): string {
  return matches.map((m) => `  ${m.sessionId}  title: ${m.title ?? "(none)"}  dir: ${m.directory}`).join("\n");
}

export async function attach(
  args: { url?: string; code: string },
  env: Env = process.env,
  deps: AttachDeps = defaultDeps,
): Promise<number> {
  const code = normalizeCode(args.code);
  if (code === "") {
    console.error(`error: "${args.code}" holds no usable part of a session ID`);
    return 1;
  }
  const records = await deps.loadRecords(deps.cwd, env);
  const matches = matchingRuns(records, code);
  if (matches.length === 0) {
    console.error(`error: no run matches "${args.code}"`);
    return 1;
  }
  if (matches.length > 1) {
    console.error(`error: "${code}" matches ${matches.length} runs:`);
    console.error(matchLines(matches));
    console.error("Give a longer part of the session ID.");
    return 1;
  }
  const record = matches[0];
  if (record === undefined) return 1;
  const url = resolveCommandUrl(args.url, env, record.directory);
  const child = deps.spawn([
    "opencode",
    "attach",
    url,
    "--dir",
    record.directory,
    "--session",
    record.sessionId,
  ]);
  let misses = 0;
  while (true) {
    const exited = await Promise.race([child.exited.then((code) => ({ code })), deps.sleep(deps.pollMs).then(() => null)]);
    if (exited !== null) return exited.code;
    const check = await deps.checkSession(url, record.directory, record.sessionId, env);
    const state = nextWatchState(misses, check);
    misses = state.misses;
    if (state.end === "deleted") {
      child.kill();
      await child.exited;
      console.error(`attach ended: session ${record.sessionId} was deleted`);
      return 0;
    }
    if (state.end === "gone") {
      child.kill();
      await child.exited;
      console.error(`attach ended: the server on ${url} does not answer`);
      return 0;
    }
  }
}
