/** Run records: one JSON file per started run under .opencode/runs/. */
import { mkdir } from "node:fs/promises";
import path from "node:path";

export type RunRecord = {
  sessionId: string;
  directory: string;
  agent: string;
  title: string | null;
  startedAt: string;
};

export function makeRunRecord(input: {
  sessionId: string;
  directory: string;
  agent: string;
  title?: string;
  startedAt?: Date;
}): RunRecord {
  return {
    sessionId: input.sessionId,
    directory: input.directory,
    agent: input.agent,
    title: input.title ?? null,
    startedAt: (input.startedAt ?? new Date()).toISOString(),
  };
}

export function runRecordPath(cwd: string, sessionId: string): string {
  return path.join(cwd, ".opencode", "runs", `${sessionId}.json`);
}

/** Write the record and return its path. */
export async function writeRunRecord(cwd: string, record: RunRecord): Promise<string> {
  const file = runRecordPath(cwd, record.sessionId);
  await mkdir(path.dirname(file), { recursive: true });
  await Bun.write(file, `${JSON.stringify(record, null, 2)}\n`);
  return file;
}
