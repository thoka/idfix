/** `oc-sub status`: sessions of a directory and its worktrees, or of all projects with --all. */
import { existsSync } from "node:fs";
import path from "node:path";
import type { OpencodeClient } from "@opencode-ai/sdk";
import { resolvePort, resolveServerUrl, type Env } from "./config";
import { resolveCommandUrl } from "./sandbox";
import { assertUsable, errorMessage, makeClient, probeServer, unwrap } from "./client";
import { listPendingRequests } from "./requests";
import { readDirs, serveDirsPath } from "./state";

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
};

const defaultDeps: StatusDeps = { worktreesOf, exists: existsSync };

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

/** `oc-sub status [--dir DIR | --all]`: one line per session: ID, state, title. */
export async function status(
  args: { url?: string; dir?: string; all: boolean },
  env: Env = process.env,
  deps: StatusDeps = defaultDeps,
): Promise<number> {
  // With --all, the listing covers every project and does not look at the
  // state file of one sandbox. Otherwise, the sandbox URL of the project
  // can step in before the default.
  const baseUrl = args.all ? resolveServerUrl(args.url, env) : resolveCommandUrl(args.url, env, args.dir);
  // No server means no sessions. That is a normal state, not an error.
  const server = await probeServer(baseUrl, env, 2000);
  if (server.state === "down") {
    console.log(`no server on ${baseUrl}`);
    return 0;
  }
  assertUsable(server, baseUrl, env);
  const client = makeClient(baseUrl, env);

  if (args.all) {
    // The directories come from three sources: the folders of past runs, the
    // projects of the server, and the git worktrees of both.
    const port = resolvePort(undefined, baseUrl);
    const fromDirsFile = await readDirs(serveDirsPath(env, port));
    const projects = unwrap(await client.project.list({}), "list projects");
    const projectDirs = projects.map((project) => project.worktree).filter((dir) => dir !== "/");
    const base = uniqueDirectories([...fromDirsFile, ...projectDirs]);
    const directories = uniqueDirectories([...base, ...base.flatMap((dir) => deps.worktreesOf(dir))]).filter((dir) =>
      deps.exists(dir),
    );

    const running: string[] = [];
    for (const directory of directories) {
      for (const session of await listSessionsSafe(client, baseUrl, directory, env)) {
        // Child sessions are internal subagent runs of a listed parent.
        if (session.child || session.state === "idle") continue;
        running.push(formatStatusLine(session.id, session.state, session.title, directory));
      }
    }
    if (running.length === 0) {
      console.log("no running sessions");
      return 0;
    }
    for (const line of running) console.log(line);
    return 0;
  }

  const directory = path.resolve(args.dir ?? process.cwd());
  for (const dir of deps.worktreesOf(directory)) {
    for (const session of await listSessionsSafe(client, baseUrl, dir, env)) {
      // Child sessions are internal subagent runs, not first-class sessions.
      if (session.child) continue;
      const folder = dir === directory ? undefined : displayFolder(dir, directory);
      console.log(formatStatusLine(session.id, session.state, session.title, folder));
    }
  }
  return 0;
}
