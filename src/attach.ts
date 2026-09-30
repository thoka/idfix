/** `oc-sub attach CODE`: attach the opencode TUI to a known run. */
import type { Env } from "./config";
import { loadAllRunRecords, type RunRecord } from "./runs";
import { resolveCommandUrl } from "./sandbox";

/** The parts of attach that the tests replace: the records and the child process. */
export type AttachDeps = {
  loadRecords: (cwd: string, env: Env) => Promise<RunRecord[]>;
  spawn: (cmd: string[]) => Promise<number>;
  cwd: string;
};

async function defaultSpawn(cmd: string[]): Promise<number> {
  const proc = Bun.spawn(cmd, { stdio: ["inherit", "inherit", "inherit"] });
  return await proc.exited;
}

const defaultDeps: AttachDeps = {
  loadRecords: loadAllRunRecords,
  spawn: defaultSpawn,
  cwd: process.cwd(),
};

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
  const records = await deps.loadRecords(deps.cwd, env);
  const matches = matchingRuns(records, args.code);
  if (matches.length === 0) {
    console.error(`error: no run matches "${args.code}"`);
    return 1;
  }
  if (matches.length > 1) {
    console.error(`error: "${args.code}" matches ${matches.length} runs:`);
    console.error(matchLines(matches));
    console.error("Give a longer part of the session ID.");
    return 1;
  }
  const record = matches[0];
  if (record === undefined) return 1;
  const url = resolveCommandUrl(args.url, env, record.directory);
  return await deps.spawn([
    "opencode",
    "attach",
    url,
    "--dir",
    record.directory,
    "--session",
    record.sessionId,
  ]);
}
