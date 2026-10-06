/** `oc-sub status`: sessions of a directory and its worktrees, or of all projects with --all. */
import { existsSync } from "node:fs";
import path from "node:path";
import type { OpencodeClient } from "@opencode-ai/sdk";
import { resolvePort, resolveServerUrl, type Env } from "./config";
import { defaultRunner, readSandboxState, readSandboxStates, resolveCommandUrl, sandboxStatePath, sbxBin, type Runner } from "./sandbox";
import { projectRootOfRun, projectNameOf, projectNameOfRun } from "./keys";
import { assertUsable, errorMessage, makeClient, probeServer, unwrap } from "./client";
import { listPendingRequests } from "./requests";
import { listServers } from "./servers";
import { readDirs, serveDirsPath } from "./state";
import { claudeRowsLoader, inScope, type ClaudeRow, type ClaudeRowsLoader } from "./claude/rows";
import { hostname } from "node:os";
import { CONDITION_TYPES, conditionKey, evaluate, restoreState, type ConditionType } from "./watch/conditions";
import { formatSequence, readLogState, sourceOf, watchStateDir, type LogState } from "./watch/log";
import { toWatchRow } from "./watch/run";
import { idfxVersion, TOOL } from "./protocol";

/**
 * One status line: `<id> <state> <title>`, plus ` (<folder>)` for a session
 * of another worktree.
 */
export function formatStatusLine(id: string, state: string, title: string, folder?: string): string {
  return `${id} ${state} ${title}${folder === undefined ? "" : ` (${folder})`}`;
}

/**
 * The paths of the `worktree ` lines of a `git worktree list --porcelain`
 * output. The path is the rest of the line, so a path with a space stays
 * whole. A bare repository and a detached worktree carry their attributes on
 * their own lines, which the parser ignores.
 */
export function parseWorktreeList(porcelain: string): string[] {
  const paths: string[] = [];
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("worktree ")) paths.push(line.slice("worktree ".length));
  }
  return paths;
}

/** The directories without duplicates, in first-seen order. */
export function uniqueDirectories(directories: readonly string[]): string[] {
  return [...new Set(directories)];
}

/**
 * The directories of the sandbox clone of a project: the project root first,
 * then the worktrees that `git worktree list` shows inside the clone. The
 * worktree of a run in clone mode exists only inside the sandbox, so git runs
 * through `sbx exec NAME git -C ROOT ...`, with ROOT and NAME from the sandbox
 * state of the project. Without a state file, and when the command fails (for
 * example a stopped sandbox), the list is empty.
 */
export function cloneDirectories(project: string, env: Env, runner: Runner): string[] {
  const state = readSandboxState(sandboxStatePath(env, project));
  if (state === null) return [];
  const proc = runner([sbxBin(env), "exec", state.name, "git", "-C", state.root, "worktree", "list", "--porcelain"]);
  if (proc.exitCode !== 0) return [];
  return uniqueDirectories([state.root, ...parseWorktreeList(proc.stdout)]);
}

/**
 * The directories that one run covers for one directory: without a sandbox
 * state for the project, the directory and its host git worktrees. With one,
 * the project root plus the worktrees of the clone, which exist only inside
 * the sandbox. The directory is mapped with `projectRootOfRun` first, so a
 * clone-mode run folder `<root>/.worktrees/<name>` that is missing on the
 * host maps to its project root. `oc-sub status` without `--all` and
 * `scopeDirectories` of `top` share this helper, so they never differ.
 */
export function projectDirectories(directory: string, env: Env, deps: StatusDeps): string[] {
  const root = projectRootOfRun(directory, deps.exists, deps.commonDirOf);
  const project = projectNameOf(root);
  if (readSandboxState(sandboxStatePath(env, project)) !== null) {
    return uniqueDirectories(deps.cloneDirectoriesOf(project));
  }
  return uniqueDirectories(deps.worktreesOf(root));
}

/** The folder shown for a worktree session: relative inside the directory, else absolute. */
export function displayFolder(folder: string, directory: string): string {
  const relative = path.relative(directory, folder);
  if (relative.length === 0 || relative.startsWith("..") || path.isAbsolute(relative)) return folder;
  return relative;
}

/** The directory first, then its git worktrees. Without git, only the directory. */
export function worktreesOf(directory: string): string[] {
  const proc = Bun.spawnSync(["git", "-C", directory, "worktree", "list", "--porcelain"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  if (proc.exitCode !== 0) return [directory];
  return uniqueDirectories([directory, ...parseWorktreeList(proc.stdout.toString())]);
}

/** The parts of status that the tests replace: git and the file system. */
export type StatusDeps = {
  /** The directories of a project: the directory first, then its git worktrees. */
  worktreesOf: (directory: string) => string[];
  /** Whether a directory exists. */
  exists: (file: string) => boolean;
  /** The directories of the sandbox clone of a project: the root first, then the worktrees in the clone. Empty without a state file or when the sandbox does not answer. */
  cloneDirectoriesOf: (project: string) => string[];
  /** The absolute path of the main `.git` folder of a directory, or null without git. The tests replace it, so a fake host worktree needs no real git. */
  commonDirOf?: (directory: string) => string | null;
  /** The clock of the `--json` snapshot. Default: `Date.now`. */
  now?: () => number;
  /** The host name in `source` of the `--json` snapshot. Default: `os.hostname`. */
  hostname?: () => string;
  /** The tool version of the `--json` snapshot. Default: `idfxVersion` of `src/protocol.ts`. */
  version?: () => string;
};

const defaultDeps: StatusDeps = {
  worktreesOf,
  exists: existsSync,
  cloneDirectoriesOf: (project) => cloneDirectories(project, process.env as Env, defaultRunner),
};

export { defaultDeps };

/** A session as status shows it: ID, title, whether it is a child, and its state. */
type ListedSession = { id: string; title: string; child: boolean; state: string };

/**
 * The state of one session. A busy session with a pending question or
 * permission request is not making progress: it waits for an answer.
 */
export function sessionState(state: string | undefined, waiting: ReadonlySet<string>, id: string): string {
  if (state === "busy" && waiting.has(id)) return "waiting";
  return state ?? "idle";
}

/**
 * The sessions of one directory that have a pending question or permission
 * request. A failure of the two pending lists must not break the listing,
 * so it only costs the waiting display.
 */
async function waitingSessions(baseUrl: string, directory: string, env: Env): Promise<Set<string>> {
  try {
    const pending = await listPendingRequests(baseUrl, directory, env);
    return new Set(pending.map((entry) => entry.request.sessionID));
  } catch {
    return new Set();
  }
}

/** The sessions of one directory, with the state from the status map. A session missing from the map is idle. */
async function listSessions(
  client: OpencodeClient,
  baseUrl: string,
  directory: string,
  env: Env,
): Promise<ListedSession[]> {
  const sessions = unwrap(await client.session.list({ query: { directory } }), "list sessions");
  const states = unwrap(await client.session.status({ query: { directory } }), "session status");
  const waiting = await waitingSessions(baseUrl, directory, env);
  return sessions.map((session) => ({
    id: session.id,
    title: session.title,
    child: session.parentID !== undefined,
    state: sessionState(states[session.id]?.type, waiting, session.id),
  }));
}

/**
 * The sessions of one directory, or nothing with a warning on stderr when
 * the directory fails. One broken project must not stop the listing of the
 * others, for example when its configuration references a missing key file.
 */
async function listSessionsSafe(
  client: OpencodeClient,
  baseUrl: string,
  directory: string,
  env: Env,
): Promise<ListedSession[]> {
  try {
    return await listSessions(client, baseUrl, directory, env);
  } catch (error) {
    // unwrap already prefixed the message with what failed, so use it as is.
    const message = error instanceof Error ? error.message : errorMessage(error);
    console.error(`warning: ${directory}: ${message}`);
    return [];
  }
}

/**
 * The directories that one server knows. For a sandbox server (a project
 * with a valid state file whose port this server serves): the project root
 * and the worktrees of the clone, which exist only inside the sandbox. No
 * host `exists` filter and no host git apply there. For the host server: the
 * folders of past runs on its port, the projects of the server, and the git
 * worktrees of both, without a directory that does not exist on this
 * machine. `oc-sub status --all` and `oc-sub top --all` share this listing.
 */
export async function serverDirectories(baseUrl: string, env: Env, deps: StatusDeps): Promise<string[]> {
  const client = makeClient(baseUrl, env);
  const port = resolvePort(undefined, baseUrl);
  const sandbox = readSandboxStates(env).find((entry) => entry.state.port === port);
  if (sandbox !== undefined) return deps.cloneDirectoriesOf(sandbox.project);
  const fromDirsFile = await readDirs(serveDirsPath(env, port));
  const projects = unwrap(await client.project.list({}), "list projects");
  const projectDirs = projects.map((project) => project.worktree).filter((dir) => dir !== "/");
  const base = uniqueDirectories([...fromDirsFile, ...projectDirs]);
  return uniqueDirectories([...base, ...base.flatMap((dir) => deps.worktreesOf(dir))]).filter((dir) =>
    deps.exists(dir),
  );
}

/** One session as the output of status shows it. */
export type StatusRow = {
  id: string;
  state: string;
  title: string;
  /** The absolute directory whose listing produced the session (the `cwd` of a Claude session). */
  folder: string;
  /** The project of the session, only in the listing of `--all`. */
  project?: string;
  /** The server URL that listed the session, only for an opencode session in the listing of `--all`. */
  server?: string;
  /** The agent program of the session. */
  driver: "opencode" | "claude";
  /** The fields below exist only for a Claude session. */
  name?: string | null;
  kind?: "interactive" | "background";
  waitingFor?: string | null;
  model?: string | null;
  contextTokens?: number;
  contextWindow?: number | null;
  /** The context tokens divided by the context window, or null without a window. */
  contextShare?: number | null;
  /** The ISO time of the last activity, or null when unknown. */
  lastActivity?: string | null;
  /** The API price of the tokens in USD, not a real charge, or null without a price. */
  apiEquivalentUsd?: number | null;
};

export type { ClaudeRowsLoader };

/**
 * The default loader: the files under `$CLAUDE_CONFIG_DIR` (else
 * `~/.claude`) and the LiteLLM prices under `$XDG_CACHE_HOME/idfix/`, both
 * from the environment of the process.
 */
export const defaultClaudeRows: ClaudeRowsLoader = (nowMs) => claudeRowsLoader(process.env)(nowMs);

const round = (value: number, digits: number): number => Number(value.toFixed(digits));

/** The status row of a Claude session. */
export function claudeStatusRow(row: ClaudeRow, project?: string): StatusRow {
  const window = row.contextWindow;
  return {
    id: row.sessionId,
    state: row.state,
    title: row.title,
    folder: row.directory,
    ...(project === undefined ? {} : { project }),
    driver: "claude",
    name: row.name ?? null,
    kind: row.kind,
    waitingFor: row.waitingFor ?? null,
    model: row.model ?? null,
    contextTokens: row.contextTokens,
    contextWindow: window ?? null,
    contextShare: window === undefined || window <= 0 ? null : round(row.contextTokens / window, 4),
    lastActivity: row.lastActivityMs === undefined ? null : new Date(row.lastActivityMs).toISOString(),
    apiEquivalentUsd: row.apiEquivalentUsd === undefined ? null : round(row.apiEquivalentUsd, 4),
  };
}

/**
 * The Claude rows of `status` and `top`. A failure costs only the Claude
 * rows, with a warning on stderr.
 */
export async function claudeRowsSafe(loader: ClaudeRowsLoader, nowMs: number = Date.now()): Promise<ClaudeRow[]> {
  try {
    return await loader(nowMs);
  } catch (error) {
    console.error(`warning: claude sessions: ${error instanceof Error ? error.message : errorMessage(error)}`);
    return [];
  }
}

/**
 * One True condition of the `status --json` snapshot, in the Kubernetes
 * form (`type`, `status`, `reason`, `message`, `lastTransitionTime`), plus
 * the `subject` (session name, else the first 8 characters of the ID) and
 * the full `session` ID.
 */
export type StatusCondition = {
  type: ConditionType;
  status: "True";
  reason: string;
  message: string;
  lastTransitionTime: string;
  subject: string;
  session: string;
};

/**
 * The conditions that `status` leaves out. `HandoverFailed` needs a run of
 * `handover check` for each ended session, which is too slow for a
 * snapshot, so only the event log of `idfx watch --all` carries it.
 * `SessionHandedOff` is a one-shot event, not a current state, so only the
 * event log carries it too.
 */
export const STATUS_SKIPPED_CONDITIONS: ReadonlySet<ConditionType> = new Set(["HandoverFailed", "SessionHandedOff"]);

/**
 * The current True conditions of the Claude rows, as the watcher computes
 * them (`evaluate` of `src/watch/conditions.ts`). The state starts from the
 * event log, so a condition that the log already holds as True keeps its
 * `lastTransitionTime` from the log. A new condition gets `nowMs`. The
 * order is the order of the rows, then of `CONDITION_TYPES`.
 */
export function statusConditions(rows: readonly ClaudeRow[], log: LogState, nowMs: number): StatusCondition[] {
  const old = restoreState(log.records, log.lastTimeMs ?? nowMs);
  // No `handover check` here: a code of -1 keeps the old value, and the result is left out below.
  const { state } = evaluate(old, rows.map((row) => toWatchRow(row)), nowMs, () => ({ code: -1, firstLine: undefined }));
  const conditions: StatusCondition[] = [];
  for (const row of rows) {
    for (const type of CONDITION_TYPES) {
      if (STATUS_SKIPPED_CONDITIONS.has(type)) continue;
      const record = state.conditions.get(conditionKey(type, row.sessionId));
      if (record?.status !== "True") continue;
      conditions.push({
        type,
        status: "True",
        reason: record.reason,
        message: record.message,
        lastTransitionTime: new Date(record.lastTransitionMs).toISOString(),
        subject: record.subject,
        session: record.session,
      });
    }
  }
  return conditions;
}

/** The `status --json` object of the tool protocol, version 0. */
export type StatusSnapshot = {
  tool: string;
  version: string;
  time: string;
  source: string;
  /** The last sequence of the event log, with 20 digits. Absent without an event. */
  sequence?: string;
  conditions: StatusCondition[];
  items: StatusRow[];
};

/**
 * The snapshot: the protocol fields, the True conditions of the Claude rows
 * of the listing, and the listed rows as `items`. The event log is read
 * from `$XDG_STATE_HOME/idfx` of `env`.
 */
export function statusSnapshot(
  items: StatusRow[],
  claude: readonly ClaudeRow[],
  env: Env,
  deps: StatusDeps,
  nowMs: number,
): StatusSnapshot {
  const log = readLogState(watchStateDir(env));
  return {
    tool: TOOL,
    version: (deps.version ?? idfxVersion)(),
    time: new Date(nowMs).toISOString(),
    source: sourceOf((deps.hostname ?? hostname)()),
    ...(log.lastSequence > 0 ? { sequence: formatSequence(log.lastSequence) } : {}),
    conditions: statusConditions(claude, log, nowMs),
    items,
  };
}

/**
 * The running sessions of one server, one row each, from the directories of
 * `serverDirectories`. A session that another server already listed (same
 * session ID) is skipped.
 */
async function allServerRows(
  baseUrl: string,
  env: Env,
  deps: StatusDeps,
  listed: Set<string>,
): Promise<StatusRow[]> {
  const client = makeClient(baseUrl, env);
  const directories = await serverDirectories(baseUrl, env, deps);
  const sandbox = readSandboxStates(env).find((entry) => entry.state.port === resolvePort(undefined, baseUrl));

  const rows: StatusRow[] = [];
  for (const directory of directories) {
    for (const session of await listSessionsSafe(client, baseUrl, directory, env)) {
      // Child sessions are internal subagent runs of a listed parent.
      if (session.child || session.state === "idle") continue;
      if (listed.has(session.id)) continue;
      listed.add(session.id);
      rows.push({
        id: session.id,
        state: session.state,
        title: session.title,
        folder: directory,
        // The folders of a sandbox server belong to its project; the folders
        // of a host server name their own project.
        project: sandbox?.project ?? projectNameOfRun(directory),
        server: baseUrl,
        driver: "opencode",
      });
    }
  }
  return rows;
}

/**
 * `oc-sub status [--dir DIR | --all] [--json]`: one line per session
 * (`ID state title`), or with `--json` one JSON object as the whole stdout:
 * the snapshot of the tool protocol (`statusSnapshot`) with `tool`,
 * `version`, `time`, `source`, `sequence`, `conditions`, and `items`. Each
 * item has `id`, `state`, `title`, `folder`, and `driver` (plus `project`,
 * and `server` for opencode, with `--all`). In JSON mode, messages such as
 * `no server on ...` go to stderr.
 *
 * The Claude Code sessions follow the opencode sessions (design
 * .plan/design/claude-sessions-top.md, sections 6 and 8): live and waiting
 * sessions, and ended sessions for 60 minutes. Without `--all`, only the
 * sessions whose folder is inside the directories of the project show.
 * They show also when no opencode server runs.
 */
export async function status(
  args: { url?: string; dir?: string; all: boolean; json?: boolean },
  env: Env = process.env,
  deps: StatusDeps = defaultDeps,
  claudeRows: ClaudeRowsLoader = defaultClaudeRows,
): Promise<number> {
  const json = args.json === true;
  const nowMs = (deps.now ?? Date.now)();
  // Nothing but the JSON document may go to stdout in JSON mode, so the
  // messages go to stderr there.
  const say = (message: string): void => {
    (json ? console.error : console.log)(message);
  };

  // With --all, the listing covers every known server: the host server (or
  // the server of --url) and each sandbox with a valid state file. Without
  // it, the sandbox URL of the project can step in before the default.
  if (args.all) {
    const servers = listServers(env, args.url);
    const hostUrl = servers[0]?.url ?? resolveServerUrl(args.url, env);
    const rows: StatusRow[] = [];
    const listed = new Set<string>();
    let answered = false;
    for (const server of servers) {
      const probe = await probeServer(server.url, env, 2000);
      if (probe.state === "down") continue;
      try {
        assertUsable(probe, server.url, env);
      } catch (error) {
        const message = error instanceof Error ? error.message : errorMessage(error);
        console.error(`warning: ${server.url}: ${message}`);
        continue;
      }
      answered = true;
      // One broken server must not stop the listing of the others.
      try {
        rows.push(...(await allServerRows(server.url, env, deps, listed)));
      } catch (error) {
        const message = error instanceof Error ? error.message : errorMessage(error);
        console.error(`warning: ${server.url}: ${message}`);
      }
    }
    const claude = await claudeRowsSafe(claudeRows, nowMs);
    for (const row of claude) {
      rows.push(claudeStatusRow(row, projectNameOfRun(row.directory, deps.exists, deps.commonDirOf)));
    }
    if (!answered) {
      // No server means no opencode sessions. That is a normal state, not an error.
      say(`no server on ${hostUrl}`);
    } else if (rows.length === 0) {
      say("no running sessions");
    }
    if (json) {
      console.log(JSON.stringify(statusSnapshot(rows, claude, env, deps, nowMs), null, 2));
    } else {
      for (const row of rows) console.log(formatStatusLine(row.id, row.state, row.title, row.folder));
    }
    return 0;
  }

  const baseUrl = resolveCommandUrl(args.url, env, args.dir);
  const directory = path.resolve(args.dir ?? process.cwd());
  const rows: StatusRow[] = [];
  // No server means no opencode sessions. That is a normal state, not an error.
  const server = await probeServer(baseUrl, env, 2000);
  let directories: string[] | undefined;
  if (server.state === "down") {
    say(`no server on ${baseUrl}`);
  } else {
    assertUsable(server, baseUrl, env);
    const client = makeClient(baseUrl, env);
    directories = projectDirectories(directory, env, deps);
    for (const dir of directories) {
      for (const session of await listSessionsSafe(client, baseUrl, dir, env)) {
        // Child sessions are internal subagent runs, not first-class sessions.
        if (session.child) continue;
        rows.push({ id: session.id, state: session.state, title: session.title, folder: dir, driver: "opencode" });
      }
    }
  }
  const claude: ClaudeRow[] = [];
  const loaded = await claudeRowsSafe(claudeRows, nowMs);
  if (loaded.length > 0) {
    // The folder rule: the project and its worktrees.
    const scope = directories ?? projectDirectories(directory, env, deps);
    for (const row of loaded) {
      if (!inScope(row.directory, scope)) continue;
      claude.push(row);
      rows.push(claudeStatusRow(row));
    }
  }
  if (json) {
    console.log(JSON.stringify(statusSnapshot(rows, claude, env, deps, nowMs), null, 2));
    return 0;
  }
  for (const row of rows) {
    const folder = row.folder === directory ? undefined : displayFolder(row.folder, directory);
    console.log(formatStatusLine(row.id, row.state, row.title, folder));
  }
  return 0;
}
