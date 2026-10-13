/**
 * `idfx run --driver claude`: one headless Claude Code run in the Claude
 * sandbox of the project (option D of the Claude sandbox design).
 *
 * The run finds or creates the sandbox `claude-<project>` in clone mode with
 * the state folder as a writable mount, checks the clone after a create,
 * syncs the host configuration into the state folder, and then runs
 * `claude -p <brief> --output-format json` in the run folder through
 * `sbx exec`. The run blocks until Claude Code ends. Then it writes a run
 * record with the result of the run (`ClaudeRunInfo`).
 *
 * All `sbx` calls go through a runner, so the tests replace it with a fake
 * and never call the real `sbx`.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Env } from "../config";
import { gitCommonDir } from "../keys";
import { loadRunRecord, makeRunRecord, writeRunRecord, writeStateRunRecord, type ClaudeRunInfo } from "../runs";
import {
  cloneStatus,
  defaultRunner,
  execFailedMessage,
  listsMounts,
  listsName,
  missingCloneMessage,
  printStderr,
  safeSandboxPart,
  sbxBin,
  type Runner,
} from "../sandbox";
import {
  claudeCreateArgs,
  claudeExecArgs,
  claudeStateDir,
  ensureClaudeStateDir,
  hostClaudeDir,
  syncClaudeState,
  type ClaudeStateSync,
} from "./sandbox-state";

/** The name of the Claude sandbox of a project: `claude-<project>`, sanitized. Pure. */
export function claudeSandboxName(project: string): string {
  return `claude-${safeSandboxPart(project)}`;
}

/** The arguments of a Claude run. */
export type ClaudeRunArgs = {
  dir: string;
  briefFile?: string;
  text?: string;
  title?: string;
  /** A Claude Code model name or alias, for example `sonnet`. */
  model?: string;
  /** An existing sandbox to use instead of `claude-<project>`. */
  sandbox?: string;
};

/** The parts of a Claude run that the tests replace. */
export type ClaudeRunDeps = {
  /** Runs every `sbx` call, also the blocking Claude run. */
  runner: Runner;
  /** Syncs the host configuration into the state folder. */
  sync: (hostDir: string, stateDir: string) => ClaudeStateSync;
  /** Creates the state folder before `sbx create` mounts it. */
  ensureStateDir: (stateDir: string) => void;
  /** The transcript of a session in the state folder, or null. */
  findTranscript: (stateDir: string, sessionId: string) => string | null;
  /** Reads the brief file. */
  readBrief: (file: string) => Promise<string>;
  /** The working folder: its host repository is the project, and it holds `.opencode/runs/`. */
  cwd: string;
  /** The root of the main checkout of the host repository of a folder, or null without git. */
  hostRoot: (directory: string) => string | null;
  now: () => Date;
  /** The session ID of a new run, passed as `--session-id`. */
  newSessionId: () => string;
};

/** A session ID that is safe in a glob, a file name, and a `pkill` pattern. */
export const SAFE_SESSION = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * The transcript `<stateDir>/projects/<folder>/<sessionId>.jsonl`, or null.
 * The agent in the sandbox can write the state folder, so the scan follows
 * no links, and an unsafe session ID finds nothing.
 */
export function findClaudeTranscript(stateDir: string, sessionId: string): string | null {
  if (!SAFE_SESSION.test(sessionId)) return null;
  try {
    const glob = new Bun.Glob(`projects/**/${sessionId}.jsonl`);
    for (const match of glob.scanSync({ cwd: stateDir, followSymlinks: false, onlyFiles: true })) {
      return path.join(stateDir, match);
    }
  } catch {
    // No projects folder yet.
  }
  return null;
}

async function readBriefFile(file: string): Promise<string> {
  try {
    return await Bun.file(file).text();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`cannot read brief file ${file}: ${reason}`);
  }
}

/**
 * The root of the main checkout of the host repository of `directory`, or
 * null without git. From a host worktree, it is the main checkout, like the
 * project of the opencode path.
 */
export function hostRepoRoot(directory: string): string | null {
  const commonDir = gitCommonDir(directory);
  return commonDir === null ? null : path.dirname(commonDir);
}

export const defaultClaudeRunDeps: ClaudeRunDeps = {
  runner: defaultRunner,
  sync: (hostDir, stateDir) => syncClaudeState(hostDir, stateDir),
  ensureStateDir: (stateDir) => ensureClaudeStateDir(stateDir),
  findTranscript: findClaudeTranscript,
  readBrief: readBriefFile,
  cwd: process.cwd(),
  hostRoot: hostRepoRoot,
  now: () => new Date(),
  newSessionId: () => randomUUID(),
};

/** The fields of the result JSON of `claude -p --output-format json` that idfx keeps. */
export type ClaudeResult = {
  sessionId: string | null;
  isError: boolean | null;
  subtype: string | null;
  numTurns: number | null;
  durationMs: number | null;
  costUsd: number | null;
  usage: Record<string, unknown> | null;
  result: string | null;
  model: string | null;
};

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    return asObject(JSON.parse(text));
  } catch {
    return null;
  }
}

/**
 * The result JSON in the stdout of a run, or null. The JSON is the whole
 * stdout; else the last line that holds a JSON object. Pure.
 */
export function parseClaudeResult(stdout: string): ClaudeResult | null {
  const trimmed = stdout.trim();
  let object = parseJsonObject(trimmed);
  if (object === null) {
    const lines = trimmed.split("\n").reverse();
    for (const line of lines) {
      object = parseJsonObject(line.trim());
      if (object !== null) break;
    }
  }
  if (object === null) return null;
  const str = (key: string) => (typeof object[key] === "string" ? (object[key] as string) : null);
  const num = (key: string) => (typeof object[key] === "number" ? (object[key] as number) : null);
  const modelUsage = asObject(object.modelUsage);
  return {
    sessionId: str("session_id"),
    isError: typeof object.is_error === "boolean" ? object.is_error : null,
    subtype: str("subtype"),
    numTurns: num("num_turns"),
    durationMs: num("duration_ms"),
    costUsd: num("total_cost_usd"),
    usage: asObject(object.usage),
    result: str("result"),
    model: modelUsage === null ? null : (Object.keys(modelUsage)[0] ?? null),
  };
}

/**
 * Whether a text is a usage limit message of Claude Code, for example
 * `Claude AI usage limit reached|1760000000` or `You've hit your limit`.
 * Only a short text counts: a long answer that mentions a limit is work, not
 * a stop. The exact form of a real limit stop is not known yet. Pure.
 */
export function isLimitMessage(text: string | null): boolean {
  if (text === null || text.length > 500) return false;
  return /limit (?:reached|exceeded)|hit your (?:\w+ )?limit|out of (?:extra )?usage/i.test(text);
}

/** The outcome of a run: `ok`, or `failed` with a reason. Pure. */
export function claudeOutcome(
  exitCode: number,
  result: ClaudeResult | null,
  stderr: string,
): { status: "ok" } | { status: "failed"; error: string } {
  const detail = (result?.result ?? stderr.trim()).split("\n")[0]?.slice(0, 300) ?? "";
  const suffix = detail.length > 0 ? `: ${detail}` : "";
  if (isLimitMessage(result?.result ?? null) || (result === null && isLimitMessage(stderr.trim()))) {
    return { status: "failed", error: `Claude Code hit a usage limit${suffix}` };
  }
  if (exitCode !== 0) return { status: "failed", error: `sbx exec ended with code ${exitCode}${suffix}` };
  if (result === null) return { status: "failed", error: "the run printed no result JSON" };
  if (result.isError === true) {
    return { status: "failed", error: `Claude Code reported an error (${result.subtype ?? "no subtype"})${suffix}` };
  }
  if (result.sessionId === null) return { status: "failed", error: "the result JSON has no session_id" };
  return { status: "ok" };
}

/** The cost line of a run. Pure. */
export function claudeCostLine(costUsd: number | null): string {
  if (costUsd === null) return "cost: unknown (the result JSON has no total_cost_usd)";
  return `cost ~$${costUsd.toFixed(4)} (API-equivalent estimate; on a Max plan the run costs nothing extra)`;
}

function fail(message: string): number {
  console.error(`error: ${message}`);
  return 1;
}

/**
 * Makes sure that the sandbox exists with the state folder mounted. A
 * missing sandbox is created from the host repository `root`, and the clone
 * is checked at `directory`, the run folder inside the sandbox. Returns an
 * error message, or null when the sandbox is ready.
 */
export function ensureClaudeSandbox(
  input: { bin: string; name: string; root: string; directory: string; stateDir: string },
  deps: Pick<ClaudeRunDeps, "runner" | "ensureStateDir">,
): string | null {
  const { bin, name, root, directory, stateDir } = input;
  const ls = deps.runner([bin, "ls"]);
  if (ls.exitCode !== 0) return `sbx ls failed with code ${ls.exitCode}: ${(ls.stderr ?? "").trim()}`;
  if (listsName(ls.stdout, name)) {
    if (!listsMounts(ls.stdout, name, [stateDir])) {
      return [
        `the sandbox ${name} does not mount the state folder ${stateDir}.`,
        "Without it, Claude Code in the sandbox gets no host configuration, and its transcripts stay in the sandbox.",
        `Remove the sandbox (sbx rm ${name}) and run again, so that idfx creates it with the mount.`,
      ].join("\n");
    }
    return null;
  }
  deps.ensureStateDir(stateDir);
  console.error(`creating the sandbox ${name} for ${root}`);
  const created = deps.runner(claudeCreateArgs(bin, name, root, stateDir));
  if (created.exitCode !== 0) {
    printStderr(created);
    return `sbx create of the sandbox ${name} failed with code ${created.exitCode}`;
  }
  const clone = cloneStatus(deps.runner, bin, name, directory);
  if (clone.state === "missing") return missingCloneMessage(name, directory);
  if (clone.state === "exec-failed") return execFailedMessage(name, clone.exitCode, clone.stderr);
  return null;
}

/** The outcome of a turn, also `aborted`. */
export type ClaudeTurnOutcome = { status: "ok" } | { status: "failed" | "aborted"; error: string };

/**
 * The outcome of a turn after its end. When `idfx abort` marked the record
 * `aborted` while the turn ran, the turn counts as aborted, whatever the
 * exit code says.
 */
export async function finalOutcome(
  sessionId: string,
  cwd: string,
  env: Env,
  outcome: ReturnType<typeof claudeOutcome>,
): Promise<ClaudeTurnOutcome> {
  const now = await loadRunRecord(sessionId, cwd, env).catch(() => null);
  if (now?.claude?.status === "aborted") return { status: "aborted", error: now.claude.error ?? "aborted with idfx abort" };
  return outcome;
}

/** `{ resumeId }` when Claude Code answered with another session ID than `sessionId`, else nothing. Pure. */
export function resumeIdOf(sessionId: string, result: ClaudeResult | null): { resumeId?: string } {
  const answered = result?.sessionId;
  return answered == null || answered === sessionId || !SAFE_SESSION.test(answered) ? {} : { resumeId: answered };
}

/** `idfx run --driver claude`. Returns the exit code. */
export async function claudeRun(
  args: ClaudeRunArgs,
  env: Env = process.env,
  deps: ClaudeRunDeps = defaultClaudeRunDeps,
): Promise<number> {
  // `--dir` is a path inside the sandbox, for example its workspace, and
  // usually does not exist on the host. So the project and the host
  // repository of the create come from the working folder, never from it.
  const directory = path.posix.resolve(args.dir);
  const root = deps.hostRoot(deps.cwd);
  if (root === null) {
    return fail(
      `${deps.cwd} is not in a git repository. Run idfx run --driver claude from the host checkout of the project; ` +
        "--dir names the folder inside the sandbox.",
    );
  }
  const name = args.sandbox ?? claudeSandboxName(path.basename(root));
  const stateDir = claudeStateDir(env, name);
  const bin = sbxBin(env);
  const startedAt = deps.now();

  const brief = args.briefFile !== undefined ? await deps.readBrief(args.briefFile) : (args.text ?? "");
  if (brief.trim().length === 0) return fail("the brief is empty");

  const notReady = ensureClaudeSandbox({ bin, name, root, directory, stateDir }, deps);
  if (notReady !== null) return fail(notReady);

  const folder = deps.runner([bin, "exec", name, "test", "-d", directory]);
  if (folder.exitCode !== 0) {
    return fail(
      `${directory} does not exist in the sandbox ${name}. The sandbox has its own clone of the repository; ` +
        `create the folder inside it, for example with: sbx exec ${name} git -C <workspace in the sandbox> worktree add ${directory}`,
    );
  }

  const synced = deps.sync(hostClaudeDir(env), stateDir);
  if (synced.missingPlugins.length > 0) {
    console.error(`warning: enabled plugins without an install folder on the host: ${synced.missingPlugins.join(", ")}`);
  }

  // The session ID is fixed before the start, so the record exists while the
  // run blocks, and `idfx abort` from another terminal finds the session.
  const sessionId = deps.newSessionId();
  const claudeArgs = [
    "-p",
    brief,
    "--output-format",
    "json",
    "--session-id",
    sessionId,
    ...(args.model === undefined ? [] : ["--model", args.model]),
  ];
  const running: ClaudeRunInfo = {
    sandbox: name,
    stateDir,
    model: args.model ?? null,
    status: "running",
    error: null,
    exitCode: null,
    isError: null,
    subtype: null,
    numTurns: null,
    durationMs: null,
    costUsd: null,
    costKind: "api-equivalent-estimate",
    usage: null,
    transcript: null,
    endedAt: null,
  };
  const base = { sessionId, directory, agent: "claude", title: args.title, startedAt, driver: "claude" as const };
  await writeRunRecord(deps.cwd, makeRunRecord({ ...base, claude: running }));
  await writeStateRunRecord(env, makeRunRecord({ ...base, claude: running }));

  console.error(`running Claude Code in the sandbox ${name}, folder ${directory}, session ${sessionId} (this blocks until the run ends)`);
  const res = deps.runner(claudeExecArgs(bin, name, stateDir, directory, synced.pluginDirs, claudeArgs));
  const result = parseClaudeResult(res.stdout);
  const outcome = await finalOutcome(sessionId, deps.cwd, env, claudeOutcome(res.exitCode, result, res.stderr ?? ""));

  const info: ClaudeRunInfo = {
    ...running,
    model: args.model ?? result?.model ?? null,
    status: outcome.status,
    error: outcome.status === "ok" ? null : outcome.error,
    exitCode: res.exitCode,
    isError: result?.isError ?? null,
    subtype: result?.subtype ?? null,
    numTurns: result?.numTurns ?? null,
    durationMs: result?.durationMs ?? null,
    costUsd: result?.costUsd ?? null,
    usage: result?.usage ?? null,
    transcript: deps.findTranscript(stateDir, result?.sessionId ?? sessionId),
    endedAt: deps.now().toISOString(),
    ...resumeIdOf(sessionId, result),
  };
  const record = makeRunRecord({ ...base, claude: info });
  const recordPath = await writeRunRecord(deps.cwd, record);
  const stateRecordPath = await writeStateRunRecord(env, record);

  if (outcome.status !== "ok") {
    printStderr(res);
    console.error(`error: the Claude run ${outcome.status}: ${outcome.error}`);
    console.error(`run record: ${recordPath}`);
    return 1;
  }
  console.log(sessionId);
  console.log(claudeCostLine(info.costUsd));
  console.log(`transcript: ${info.transcript ?? "not found in the state folder"}`);
  console.log(`run record: ${recordPath}`);
  console.log(`run record (state): ${stateRecordPath}`);
  if (result?.result != null) console.log(`\n${result.result}`);
  return 0;
}
