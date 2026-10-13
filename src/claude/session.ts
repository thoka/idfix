/**
 * The session commands of the `claude` driver for a run of
 * `idfx run --driver claude`: `say` (a follow-up turn with `--resume`),
 * `abort` (stop the `claude` process in the sandbox), and `log` (the
 * transcript in the state folder). Each command reads the run record of the
 * session, which names the sandbox, the state folder, and the folder.
 *
 * All `sbx` calls go through a runner, so the tests replace it with a fake
 * and never call the real `sbx`. The state folder is writable by the agent
 * in the sandbox, so `log` reads it as untrusted data: no links, a size
 * limit.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import path from "node:path";
import type { Env } from "../config";
import { loadRunRecord, runRecordPath, writeRunRecord, writeStateRunRecord, type ClaudeRunInfo, type RunRecord } from "../runs";
import { listsMounts, listsName, printStderr, sbxBin } from "../sandbox";
import {
  claudeCostLine,
  claudeOutcome,
  defaultClaudeRunDeps,
  finalOutcome,
  parseClaudeResult,
  resumeIdOf,
  SAFE_SESSION,
  type ClaudeRunDeps,
} from "./run";
import { claudeExecArgs, hostClaudeDir } from "./sandbox-state";
import { summarizeTranscript, totalTokens } from "./transcript";

/** The parts of the session commands that the tests replace. */
export type ClaudeSessionDeps = Pick<ClaudeRunDeps, "runner" | "sync" | "findTranscript" | "cwd" | "now"> & {
  /** Loads the run record of a session. */
  load: (sessionId: string, cwd: string, env: Env) => Promise<RunRecord | null>;
  /** Reads a transcript from the state folder (`readStateFile`). */
  readTranscript: (stateDir: string, file: string, limit: number) => TranscriptRead;
};

export const defaultClaudeSessionDeps: ClaudeSessionDeps = {
  runner: defaultClaudeRunDeps.runner,
  sync: defaultClaudeRunDeps.sync,
  findTranscript: defaultClaudeRunDeps.findTranscript,
  get cwd() {
    return process.cwd();
  },
  now: () => new Date(),
  load: loadRunRecord,
  readTranscript: (stateDir, file, limit) => readStateFile(stateDir, file, limit),
};

function fail(message: string): number {
  console.error(`error: ${message}`);
  return 1;
}

/** The record and its Claude info, or an error message. */
async function claudeRecord(
  sessionId: string,
  env: Env,
  deps: Pick<ClaudeSessionDeps, "load" | "cwd">,
): Promise<{ record: RunRecord; info: ClaudeRunInfo } | string> {
  const record = await deps.load(sessionId, deps.cwd, env);
  if (record === null) return `no run record for the session ${sessionId}`;
  if (record.claude === undefined) return `the run record of ${sessionId} has no claude object`;
  return { record, info: record.claude };
}

/**
 * Writes the record into the state folder, and into `.opencode/runs/` of
 * cwd when a copy is there already. Returns the path of the state copy.
 */
async function saveRecord(record: RunRecord, env: Env, cwd: string): Promise<string> {
  if (lstatOrNull(runRecordPath(cwd, record.sessionId))?.isFile() === true) await writeRunRecord(cwd, record);
  return writeStateRunRecord(env, record);
}

function lstatOrNull(file: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(file);
  } catch {
    return null;
  }
}

/** The sum of two numbers where null means unknown. Pure. */
function addNullable(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return a + b;
}

/**
 * The usage of two turns: numbers add up, nested objects merge the same
 * way, other values come from the later turn. Pure.
 */
export function addUsage(
  a: Record<string, unknown> | null,
  b: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (a === null) return b;
  if (b === null) return a;
  const sum: Record<string, unknown> = { ...a };
  for (const [key, value] of Object.entries(b)) {
    const old = sum[key];
    if (typeof value === "number" && typeof old === "number") sum[key] = old + value;
    else if (isObject(value) && isObject(old)) sum[key] = addUsage(old, value);
    else sum[key] = value;
  }
  return sum;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The session ID for `--resume` and `pkill`: the resume ID, else the record ID. */
function liveSessionId(record: RunRecord, info: ClaudeRunInfo): string {
  return info.resumeId ?? record.sessionId;
}

/** `idfx say SESSION TEXT` for a Claude run: one blocking follow-up turn. Returns the exit code. */
export async function claudeSay(
  args: { session: string; text: string; model?: string; agent?: string },
  env: Env = process.env,
  deps: ClaudeSessionDeps = defaultClaudeSessionDeps,
): Promise<number> {
  const loaded = await claudeRecord(args.session, env, deps);
  if (typeof loaded === "string") return fail(loaded);
  const { record, info } = loaded;
  if (args.text.trim().length === 0) return fail("the message is empty");
  if (args.agent !== undefined) console.error("warning: --agent has no effect on a Claude run");
  if (info.status === "running") {
    return fail(`the session ${args.session} still runs a turn. Wait for its end, or stop it with: idfx abort ${args.session}`);
  }
  const resumeId = liveSessionId(record, info);
  if (!SAFE_SESSION.test(resumeId)) return fail(`the session ID ${resumeId} cannot be resumed`);

  const bin = sbxBin(env);
  const ls = deps.runner([bin, "ls"]);
  if (ls.exitCode !== 0) return fail(`sbx ls failed with code ${ls.exitCode}: ${(ls.stderr ?? "").trim()}`);
  if (!listsName(ls.stdout, info.sandbox) || !listsMounts(ls.stdout, info.sandbox, [info.stateDir])) {
    return fail(`the sandbox ${info.sandbox} of the session does not exist, or it does not mount the state folder ${info.stateDir}`);
  }

  const synced = deps.sync(hostClaudeDir(env), info.stateDir);
  const claudeArgs = [
    "-p",
    args.text,
    "--resume",
    resumeId,
    "--output-format",
    "json",
    ...(args.model === undefined ? [] : ["--model", args.model]),
  ];
  await saveRecord({ ...record, claude: { ...info, status: "running", error: null, endedAt: null } }, env, deps.cwd);

  console.error(`resuming the session ${resumeId} in the sandbox ${info.sandbox}, folder ${record.directory} (this blocks until the turn ends)`);
  const res = deps.runner(claudeExecArgs(bin, info.sandbox, info.stateDir, record.directory, synced.pluginDirs, claudeArgs));
  const result = parseClaudeResult(res.stdout);
  const outcome = await finalOutcome(record.sessionId, deps.cwd, env, claudeOutcome(res.exitCode, result, res.stderr ?? ""));

  const next: ClaudeRunInfo = {
    ...info,
    model: args.model ?? result?.model ?? info.model,
    status: outcome.status,
    error: outcome.status === "ok" ? null : outcome.error,
    exitCode: res.exitCode,
    isError: result?.isError ?? null,
    subtype: result?.subtype ?? null,
    numTurns: addNullable(info.numTurns, result?.numTurns ?? null),
    durationMs: addNullable(info.durationMs, result?.durationMs ?? null),
    costUsd: addNullable(info.costUsd, result?.costUsd ?? null),
    usage: addUsage(info.usage, result?.usage ?? null),
    transcript: deps.findTranscript(info.stateDir, result?.sessionId ?? resumeId) ?? info.transcript,
    endedAt: deps.now().toISOString(),
  };
  const newResume = resumeIdOf(record.sessionId, result).resumeId;
  if (newResume !== undefined) next.resumeId = newResume;
  else delete next.resumeId;
  const statePath = await saveRecord({ ...record, claude: next }, env, deps.cwd);

  if (outcome.status !== "ok") {
    printStderr(res);
    console.error(`error: the Claude turn ${outcome.status}: ${outcome.error}`);
    console.error(`run record (state): ${statePath}`);
    return 1;
  }
  console.log(record.sessionId);
  console.log(`this turn: ${claudeCostLine(result?.costUsd ?? null)}`);
  console.log(`session total: ${claudeCostLine(next.costUsd)}`);
  console.log(`transcript: ${next.transcript ?? "not found in the state folder"}`);
  console.log(`run record (state): ${statePath}`);
  if (result?.result != null) console.log(`\n${result.result}`);
  return 0;
}

/**
 * The `pkill` pattern of the `claude` process of a session. The bracket
 * keeps the pattern from matching a shell whose command line holds the
 * pattern itself. Pure.
 */
export function claudeProcessPattern(sessionId: string): string {
  return `[c]laude .*${sessionId}`;
}

/** `idfx abort SESSION` for a Claude run. Returns the exit code. */
export async function claudeAbort(
  args: { session: string },
  env: Env = process.env,
  deps: ClaudeSessionDeps = defaultClaudeSessionDeps,
): Promise<number> {
  const loaded = await claudeRecord(args.session, env, deps);
  if (typeof loaded === "string") return fail(loaded);
  const { record, info } = loaded;
  const ids = [...new Set([record.sessionId, liveSessionId(record, info)])];
  const unsafe = ids.find((id) => !SAFE_SESSION.test(id));
  if (unsafe !== undefined) return fail(`the session ID ${unsafe} is not safe in a process pattern`);

  const bin = sbxBin(env);
  let killed = false;
  for (const id of ids) {
    const res = deps.runner([bin, "exec", info.sandbox, "pkill", "-TERM", "-f", claudeProcessPattern(id)]);
    // pkill: 0 = signalled a process, 1 = no process matched, other = error.
    if (res.exitCode === 0) killed = true;
    else if (res.exitCode !== 1) {
      printStderr(res);
      return fail(`sbx exec ${info.sandbox} pkill failed with code ${res.exitCode}`);
    }
  }
  if (!killed && info.status !== "running") {
    console.error(`no running Claude process for the session ${args.session} (status ${info.status})`);
    return 1;
  }
  const error = killed ? "aborted with idfx abort" : "aborted with idfx abort; no process was left in the sandbox";
  await saveRecord(
    { ...record, claude: { ...info, status: "aborted", error, endedAt: deps.now().toISOString() } },
    env,
    deps.cwd,
  );
  console.log(killed ? `aborted ${args.session}` : `aborted ${args.session} (no process was left; the record said running)`);
  return 0;
}

/** The largest part of a transcript that `log` reads: the last 32 MiB. */
export const TRANSCRIPT_LIMIT = 32 * 1024 * 1024;

/** The bytes of a file read with `readStateFile`, and whether the start was cut. */
export type TranscriptRead = { bytes: Uint8Array; cut: boolean };

/**
 * Reads `file` inside `stateDir` as untrusted data: the file must be a
 * regular file, not a link, and its real folder must lie inside the real
 * state folder. The open uses `O_NOFOLLOW`. Of a file larger than `limit`,
 * it reads the last `limit` bytes from the start of a line. Throws with a
 * message otherwise.
 */
export function readStateFile(stateDir: string, file: string, limit: number = TRANSCRIPT_LIMIT): TranscriptRead {
  const root = realpathSync(stateDir);
  const folder = realpathSync(path.dirname(file));
  const relative = path.relative(root, folder);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`${file} lies outside the state folder`);
  if (!lstatSync(file).isFile()) throw new Error(`${file} is not a regular file`);
  const fd = openSync(path.join(folder, path.basename(file)), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`${file} is not a regular file`);
    const size = stat.size;
    const length = Math.min(size, limit);
    const bytes = new Uint8Array(length);
    let read = 0;
    while (read < length) {
      const n = readSync(fd, bytes, read, length - read, size - length + read);
      if (n === 0) break;
      read += n;
    }
    if (size <= limit) return { bytes: bytes.subarray(0, read), cut: false };
    // Drop the first, partial line.
    const newline = bytes.indexOf(10);
    return { bytes: newline < 0 ? new Uint8Array() : bytes.subarray(newline + 1, read), cut: true };
  } finally {
    closeSync(fd);
  }
}

/**
 * The text of the last assistant message of a transcript that has text, or
 * null. Claude Code writes one line per content block, so the text blocks
 * of the lines with the same `message.id` join. Pure.
 */
export function lastAssistantText(bytes: Uint8Array): string | null {
  const text = new TextDecoder().decode(bytes);
  let lastId: string | undefined;
  let parts: string[] = [];
  for (const line of text.split("\n")) {
    if (!line.includes('"type":"assistant"')) continue;
    let parsed: { type?: unknown; message?: { id?: unknown; content?: unknown } };
    try {
      parsed = JSON.parse(line) as typeof parsed;
    } catch {
      continue;
    }
    if (parsed.type !== "assistant" || !Array.isArray(parsed.message?.content)) continue;
    const blocks = (parsed.message.content as unknown[])
      .filter((block): block is { type: "text"; text: string } => isObject(block) && block.type === "text" && typeof block.text === "string")
      .map((block) => block.text.trim())
      .filter((block) => block.length > 0);
    if (blocks.length === 0) continue;
    const id = typeof parsed.message.id === "string" ? parsed.message.id : undefined;
    if (id !== undefined && id === lastId) parts.push(...blocks);
    else parts = blocks;
    lastId = id;
  }
  return parts.length === 0 ? null : parts.join("\n\n");
}

/** `idfx log SESSION` for a Claude run: the last answer and the totals. Returns the exit code. */
export async function claudeLog(
  args: { session: string },
  env: Env = process.env,
  deps: ClaudeSessionDeps = defaultClaudeSessionDeps,
): Promise<number> {
  const loaded = await claudeRecord(args.session, env, deps);
  if (typeof loaded === "string") return fail(loaded);
  const { record, info } = loaded;
  const id = liveSessionId(record, info);
  const file = deps.findTranscript(info.stateDir, id);
  if (file === null) {
    console.error(`no transcript of ${id} in the state folder ${info.stateDir}`);
  } else {
    let read: TranscriptRead;
    try {
      read = deps.readTranscript(info.stateDir, file, TRANSCRIPT_LIMIT);
    } catch (error) {
      return fail(`cannot read the transcript: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (read.cut) console.error(`the transcript is larger than ${TRANSCRIPT_LIMIT} bytes; only its end was read`);
    const text = lastAssistantText(read.bytes);
    if (text !== null) {
      console.log(text);
      console.log("");
    } else {
      console.error("no assistant text in this session");
    }
    const tokens = totalTokens(summarizeTranscript(read.bytes).usageByModel);
    console.log(
      `tokens in ${tokens.input}, out ${tokens.output}, thinking ${tokens.thinking}, ` +
        `cache read ${tokens.cacheRead}, cache write ${tokens.cacheWrite5m + tokens.cacheWrite1h}`,
    );
  }
  console.log(`status ${info.status}${info.error === null ? "" : ` (${info.error})`}, turns ${info.numTurns ?? "unknown"}`);
  console.log(claudeCostLine(info.costUsd));
  return file === null ? 1 : 0;
}
