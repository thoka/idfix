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
 */
import path from "node:path";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import type { Session, SessionStatus } from "@opencode-ai/sdk";
import { assertUsable, errorMessage, makeClient, probeServer, unwrap } from "../client";
import type { Env } from "../config";
import { listPendingRequests, type PendingRequest } from "../requests";
import { listServers } from "../servers";
import { serverDirectories, uniqueDirectories, worktreesOf, type StatusDeps } from "../status";
import { createTopModel, type SessionDetail, type TopModel } from "./model";
import { DEFAULT_WIDTH, formatTopTable, type TopTableOptions, type TopTableRow } from "./format";

/** A session counts as recent when its last update is at most this old. */
const RECENT_MS = 60 * 60 * 1000;

/** The default worktree and existence checks, overridable in the tests. */
export const defaultDeps: StatusDeps = { worktreesOf, exists: existsSync };

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
 * the directories that the server knows, else the directory of `--dir` and
 * its git worktrees. `startLive` in `src/top/live.ts` shares this scope.
 */
export function scopeDirectories(args: { dir?: string; all: boolean }, env: Env, deps: StatusDeps): (url: string) => Promise<string[]> {
  const directory = path.resolve(args.dir ?? process.cwd());
  if (!args.all) {
    const dirs = uniqueDirectories(deps.worktreesOf(directory));
    return async () => dirs;
  }
  return (url) => serverDirectories(url, env, deps);
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
  model: TopModel;
  /** Whether at least one known server answered. */
  answered: boolean;
  /** The URL that the "no server" message names. */
  hostUrl: string;
};

/** Load the start data of `top` from every known server into one model. */
export async function loadTopAll(
  args: { url?: string; dir?: string; all: boolean },
  env: Env,
  deps: StatusDeps = defaultDeps,
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
  return { model, answered, hostUrl };
}

/** The plain model loader, as the later live view will use it. */
export async function loadTop(
  args: { url?: string; dir?: string; all: boolean },
  env: Env = process.env,
  deps: StatusDeps = defaultDeps,
): Promise<TopModel> {
  return (await loadTopAll(args, env, deps)).model;
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

/** `oc-sub top [--once] [--dir DIR | --all] [--json]`: one text snapshot, or a hint for now. */
export async function top(args: TopArgs, env: Env = process.env, deps: StatusDeps = defaultDeps): Promise<number> {
  if (!args.once) {
    console.error("oc-sub top: the live view comes in a later step, use --once");
    return 2;
  }
  const { model, answered, hostUrl } = await loadTopAll(args, env, deps);
  if (!answered) {
    // No server means no sessions. That is a normal state, not an error.
    console.log(`no server on ${hostUrl}`);
    return 0;
  }
  const nowMs = Date.now();
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
  const scopeDir = args.all ? undefined : path.resolve(args.dir ?? process.cwd());
  // Without a terminal, `stdout.columns` is undefined; use a fixed width.
  const width = process.stdout.columns ?? DEFAULT_WIDTH;
  const options: TopTableOptions = { scopeDir, width, home: homedir() };
  for (const line of formatTopTable(rows, nowMs, options)) console.log(line);
  return 0;
}
