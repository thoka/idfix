/**
 * The data fetch of `oc-sub top`: it loads the start data for the model from
 * every known server and turns it into one text snapshot with `--once`. The
 * live event stream and the Ink view come in later steps, so this module has
 * no event stream and no Ink.
 *
 * Without `--all`, it loads the directory of `--dir` (default: the current
 * folder) and its git worktrees, on every known server. With `--all`, it
 * loads every directory of every known server, like `status --all`. A server
 * that is down is skipped. A server that rejects the password or fails
 * prints `warning: <url>: <message>` to stderr and is skipped.
 *
 * The Claude Code sessions (step 25g.2) come from `src/claude/rows.ts` and
 * join the opencode rows through `withClaudeRows` of `src/top/claude.ts`.
 * The same folder rule and `--all` apply. They show also when no opencode
 * server answers.
 *
 * `loadView` loads the live view with the production build of React, because
 * the development build keeps data of every render and leaks memory.
 */
import path from "node:path";
import type { Session, SessionStatus } from "@opencode-ai/sdk";
import { assertUsable, errorMessage, makeClient, probeServer, unwrap } from "../client";
import type { Env } from "../config";
import { listPendingRequests, type PendingRequest } from "../requests";
import { listServers } from "../servers";
import { claudeRowsLoader, type ClaudeRowsLoader } from "../claude/rows";
import {
  claudeRowsSafe,
  defaultDeps as defaultStatusDeps,
  projectDirectories,
  serverDirectories,
  type StatusDeps,
} from "../status";
import { scopeClaudeRows, withClaudeRows } from "./claude";
import { createTopModel, type SessionDetail, type TopModel } from "./model";
import { DEFAULT_WIDTH, formatTopTable, type TopTableOptions, type TopTableRow } from "./format";
import { makeProjectNameResolver } from "../project-config";

/** A session counts as recent when its last update is at most this old. */
const RECENT_MS = 60 * 60 * 1000;

/** The default worktree and existence checks, overridable in the tests. */
export const defaultDeps: StatusDeps = { ...defaultStatusDeps };

/** One listed session with the directory it came from. */
type Listed = { session: Session; directory: string };

/** The data of one server that was listed before the seeding decision. */
type ServerList = {
  listed: Map<string, Listed>;
  states: Map<string, SessionStatus>;
  pendingByDirectory: Map<string, PendingRequest[]>;
};

/**
 * The directories that one run of `top` covers on one server: with `--all`
 * the directories that the server knows, else the directories of `--dir`
 * through the shared `projectDirectories` of `status` (host worktrees, or the
 * root plus the clone worktrees when the project has a sandbox state file).
 * `startLive` in `src/top/live.ts` shares this scope.
 */
export function scopeDirectories(args: { dir?: string; all: boolean }, env: Env, deps: StatusDeps): (url: string) => Promise<string[]> {
  if (!args.all) {
    const directory = path.resolve(args.dir ?? process.cwd());
    const dirs = projectDirectories(directory, env, deps);
    return async () => dirs;
  }
  return (url) => serverDirectories(url, env, deps);
}

/**
 * The folders of the Claude rows: undefined with `--all` (every session),
 * else the folder of `--dir` and its worktrees, as for `status`.
 */
export function claudeScope(args: { dir?: string; all: boolean }, env: Env, deps: StatusDeps): string[] | undefined {
  if (args.all) return undefined;
  return projectDirectories(path.resolve(args.dir ?? process.cwd()), env, deps);
}

/**
 * The default Claude loader of `top`. It reads the environment of the
 * process, like `status`, so a test that passes its own `env` never reads
 * the real `~/.claude`.
 */
export function defaultClaudeLoader(): ClaudeRowsLoader {
  return claudeRowsLoader(process.env);
}

/** List the sessions, the status map, and the pending requests of one directory. */
async function listDirectory(
  client: ReturnType<typeof makeClient>,
  baseUrl: string,
  directory: string,
  env: Env,
  result: ServerList,
): Promise<void> {
  let sessions: Session[];
  let states: Record<string, SessionStatus>;
  try {
    sessions = unwrap(await client.session.list({ query: { directory } }), "list sessions");
    states = unwrap(await client.session.status({ query: { directory } }), "session status");
  } catch (error) {
    const message = error instanceof Error ? error.message : errorMessage(error);
    console.error(`warning: ${directory}: ${message}`);
    return;
  }
  let pending: PendingRequest[];
  try {
    pending = await listPendingRequests(baseUrl, directory, env);
  } catch {
    // A failed pending list must not break the listing; it only costs the
    // waiting display, as in `oc-sub status`.
    pending = [];
  }
  for (const session of sessions) result.listed.set(session.id, { session, directory });
  for (const [id, status] of Object.entries(states)) result.states.set(id, status);
  result.pendingByDirectory.set(directory, pending);
}

/** The IDs to seed: the direct matches plus all of their descendants. */
function seedIds(list: ServerList, nowMs: number): Set<string> {
  const direct = new Set<string>();
  for (const [id, { session }] of list.listed) {
    if (list.states.has(id) || nowMs - session.time.updated <= RECENT_MS) direct.add(id);
  }
  const children = new Map<string, string[]>();
  for (const [id, { session }] of list.listed) {
    if (session.parentID === undefined) continue;
    const siblings = children.get(session.parentID);
    if (siblings === undefined) children.set(session.parentID, [id]);
    else siblings.push(id);
  }
  const seeds = new Set(direct);
  let frontier = [...direct];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const child of children.get(id) ?? []) {
        if (seeds.has(child)) continue;
        seeds.add(child);
        next.push(child);
      }
    }
    frontier = next;
  }
  return seeds;
}

/**
 * Load one server into the model: list its scope, then seed the sessions
 * from the REST data. One broken directory does not stop the others. The
 * live view of `src/top/live.ts` calls this again after every reconnect,
 * because events can be lost in the gap.
 */
export async function seedServer(model: TopModel, baseUrl: string, directories: string[], env: Env, nowMs: number): Promise<void> {
  const client = makeClient(baseUrl, env);
  const list: ServerList = { listed: new Map(), states: new Map(), pendingByDirectory: new Map() };
  for (const directory of directories) {
    await listDirectory(client, baseUrl, directory, env, list);
  }
  for (const id of seedIds(list, nowMs)) {
    const entry = list.listed.get(id);
    if (entry === undefined) continue;
    let messages;
    try {
      messages = unwrap(
        await client.session.messages({ path: { id }, query: { directory: entry.directory } }),
        "load messages",
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : errorMessage(error);
      console.error(`warning: ${baseUrl}: ${message}`);
      continue;
    }
    model.seed(baseUrl, {
      session: entry.session,
      status: list.states.get(id),
      messages,
      pending: list.pendingByDirectory.get(entry.directory) ?? [],
    }, nowMs);
  }
}

export type TopResult = {
  /** The opencode sessions and the Claude sessions in scope. */
  model: TopModel;
  /** Whether at least one known server answered. */
  answered: boolean;
  /** The URL that the "no server" message names. */
  hostUrl: string;
};

/** Load the start data of `top` from every known server and the Claude sessions into one model. */
export async function loadTopAll(
  args: { url?: string; dir?: string; all: boolean },
  env: Env,
  deps: StatusDeps = defaultDeps,
  claude: ClaudeRowsLoader = defaultClaudeLoader(),
): Promise<TopResult> {
  const model = createTopModel();
  const servers = listServers(env, args.url);
  const hostUrl = servers[0]?.url ?? "";
  const directoriesOf = scopeDirectories(args, env, deps);
  const nowMs = Date.now();
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
    // One broken server must not stop the loading of the others.
    try {
      await seedServer(model, server.url, await directoriesOf(server.url), env, nowMs);
    } catch (error) {
      const message = error instanceof Error ? error.message : errorMessage(error);
      console.error(`warning: ${server.url}: ${message}`);
    }
  }
  const claudeRows = scopeClaudeRows(await claudeRowsSafe(claude, nowMs), claudeScope(args, env, deps));
  return { model: withClaudeRows(model, () => claudeRows), answered, hostUrl };
}

/** The plain model loader, as the later live view will use it. */
export async function loadTop(
  args: { url?: string; dir?: string; all: boolean },
  env: Env = process.env,
  deps: StatusDeps = defaultDeps,
  claude: ClaudeRowsLoader = defaultClaudeLoader(),
): Promise<TopModel> {
  return (await loadTopAll(args, env, deps, claude)).model;
}

/**
 * The pending requests of a session and all its descendants. Child sessions
 * have no row of their own, so their requests show under the row of the
 * top-level session.
 */
export function treePending(detail: SessionDetail): PendingRequest[] {
  return [...detail.pending, ...detail.children.flatMap((child) => treePending(child))];
}

export type TopArgs = { url?: string; dir?: string; all: boolean; once: boolean; json: boolean };

/** The terminal parts of `top` that the tests replace. */
export type TopUi = {
  /** Whether stdin and stdout are a terminal, so that the full-screen view can run. */
  interactive(): boolean;
  /** Run the full-screen view until the user quits; returns the exit code. */
  runView(args: TopArgs, env: Env, deps: StatusDeps): Promise<number>;
};

/**
 * Set `NODE_ENV` to `production` when the user did not set it, so that React
 * loads its production build. The start scripts in `bin/` run bun without
 * `NODE_ENV`, and then `react` loads its development build. That build keeps
 * data of every render, so the live view of `top` grew about 1.5 MB per
 * minute at its redraw of once per second (7 GB after 2 days). A value that
 * the user set stays. Call it before the first import of React or Ink.
 */
export function preferReactProduction(env: Env = process.env): void {
  env.NODE_ENV ??= "production";
}

/**
 * Load the module of the live view. It first calls `preferReactProduction`,
 * then imports `./app` dynamically, so that Ink and React load only after
 * `NODE_ENV` is set. No module on the path of `top` imports them earlier.
 */
export async function loadView(): Promise<typeof import("./app")> {
  preferReactProduction();
  return import("./app");
}

export const defaultUi: TopUi = {
  interactive: () => process.stdout.isTTY === true && process.stdin.isTTY === true,
  // The view loads Ink and React only when it runs, so `--once` stays light.
  runView: async (args, env, deps) => (await loadView()).runTopView(args, env, deps),
};

/** The hint that `top` prints to stderr when it has no terminal for the view. */
export const NO_TERMINAL_HINT = "oc-sub top: no terminal, printed one snapshot instead of the live view (use --once to skip this hint)";

/**
 * `oc-sub top [--once] [--dir DIR | --all] [--json]`. With `--once`, one text
 * snapshot. Without it, the full-screen live view of `src/top/view.tsx`. When
 * stdin or stdout is not a terminal, it prints the snapshot and a one-line
 * hint to stderr instead of the view. `claude` loads the Claude rows of the
 * snapshot. The tests replace it.
 */
export async function top(
  args: TopArgs,
  env: Env = process.env,
  deps: StatusDeps = defaultDeps,
  ui: TopUi = defaultUi,
  claude: ClaudeRowsLoader = defaultClaudeLoader(),
): Promise<number> {
  if (!args.once) {
    if (ui.interactive()) return ui.runView(args, env, deps);
    const code = await snapshot(args, env, deps, claude);
    console.error(NO_TERMINAL_HINT);
    return code;
  }
  return snapshot(args, env, deps, claude);
}

/**
 * Print one text snapshot, or the rows as JSON with `--json`. Without an
 * answering server, the Claude rows still show. Then the `no server` line
 * comes first, on stdout, or on stderr in JSON mode.
 */
async function snapshot(args: TopArgs, env: Env, deps: StatusDeps, claude: ClaudeRowsLoader): Promise<number> {
  const { model, answered, hostUrl } = await loadTopAll(args, env, deps, claude);
  const nowMs = Date.now();
  if (!answered) {
    // No server means no opencode sessions. That is a normal state, not an error.
    const noServer = `no server on ${hostUrl}`;
    if (model.rows(nowMs).length === 0) {
      console.log(noServer);
      return 0;
    }
    (args.json ? console.error : console.log)(noServer);
  }
  const rows: TopTableRow[] = model.rows(nowMs).map((row) => {
    const detail = model.session(row.sessionId);
    return { ...row, pending: detail === undefined ? [] : treePending(detail) };
  });
  if (args.json) {
    console.log(JSON.stringify(rows, null, 2));
    return 0;
  }
  if (rows.length === 0) {
    console.log("no sessions");
    return 0;
  }
  // Without a terminal, `stdout.columns` is undefined; use a fixed width.
  const width = process.stdout.columns ?? DEFAULT_WIDTH;
  // Without --all, every row belongs to one project, so its column is hidden.
  // A terminal gets the state as the color of the id; a pipe gets a state column.
  const options: TopTableOptions = {
    showProject: args.all,
    projectName: makeProjectNameResolver(),
    width,
    color: process.stdout.isTTY === true,
  };
  for (const line of formatTopTable(rows, nowMs, options)) console.log(line);
  return 0;
}
