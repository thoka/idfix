/**
 * The shared fixture of the Claude reader tests: a hand-written `~/.claude`
 * root in `test/fixtures/claude/root`, a fixed `NOW`, and a `ClaudeFs` that
 * reads the fixture files but fakes `/proc` and the modification times.
 * The fixture holds no real prompt, no real path, and no key.
 */
import path from "node:path";
import { nodeClaudeFs, type ClaudeFs } from "../src/claude/files";

export const FIXTURE_DIR = path.join(import.meta.dir, "fixtures", "claude");
export const FIXTURE_ROOT = path.join(FIXTURE_DIR, "root");
export const NOW = Date.parse("2026-10-06T11:00:00.000Z");
export const MINUTE = 60 * 1000;

export const S1 = "11111111-0000-4000-8000-000000000001";
export const S2 = "22222222-0000-4000-8000-000000000002";
export const S3 = "33333333-0000-4000-8000-000000000003";
export const S4 = "44444444-0000-4000-8000-000000000004";
export const S5 = "55555555-0000-4000-8000-000000000005";
export const S6 = "66666666-0000-4000-8000-000000000006";
export const S7 = "77777777-0000-4000-8000-000000000007";
export const S8 = "88888888-0000-4000-8000-000000000008";

/** A `/proc/<pid>/stat` line whose field 22 is `start`. The command name holds a space and a parenthesis, as a real one can. */
export function statLine(pid: number, start: string): string {
  const middle = Array.from({ length: 18 }, () => "0").join(" ");
  return `${pid} (claude (x)) S ${middle} ${start} 0 0 0\n`;
}

/** The default live processes: 1001 and 1002 match their files, 1004 is a reused pid, 1003 is dead. */
export const DEFAULT_PROC_STARTS: Record<number, string> = { 1001: "500", 1002: "600", 1004: "999" };

/** The default modification times of the transcripts, by file name. */
export const DEFAULT_MTIMES: Record<string, number> = {
  [`${S1}.jsonl`]: NOW - 1 * MINUTE,
  [`${S2}.jsonl`]: NOW - 10 * MINUTE,
  [`${S6}.jsonl`]: NOW - 180 * MINUTE,
  [`${S7}.jsonl`]: NOW - 10 * MINUTE,
  [`${S8}.jsonl`]: NOW - 120 * MINUTE,
};

/** A file system over the fixture, with fake processes and times. `opened` collects every file that the reader opens. */
export function fixtureFs(options: {
  procStarts?: Record<number, string>;
  mtimes?: Record<string, number>;
  opened?: string[];
  base?: ClaudeFs;
} = {}): ClaudeFs {
  const base = options.base ?? nodeClaudeFs;
  const procStarts = options.procStarts ?? DEFAULT_PROC_STARTS;
  const mtimes = { ...DEFAULT_MTIMES, ...options.mtimes };
  return {
    listDir: (dir) => base.listDir(dir),
    readText(file) {
      options.opened?.push(file);
      return base.readText(file);
    },
    readBytes(file, offset) {
      options.opened?.push(file);
      return base.readBytes(file, offset);
    },
    mtimeMs(file) {
      if (base.mtimeMs(file) === undefined) return undefined;
      return mtimes[path.basename(file)] ?? NOW - 24 * 60 * MINUTE;
    },
    procStat(pid) {
      const start = procStarts[pid];
      return start === undefined ? undefined : statLine(pid, start);
    },
  };
}
