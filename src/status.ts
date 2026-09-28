/** `oc-sub status`: one line per session of a directory: ID, state, title. */
import path from "node:path";
import { resolveServerUrl, type Env } from "./config";
import { assertUsable, makeClient, probeServer, unwrap } from "./client";

export function formatStatusLine(id: string, state: string, title: string): string {
  return `${id} ${state} ${title}`;
}

export async function status(args: { url?: string; dir?: string }, env: Env = process.env): Promise<number> {
  const baseUrl = resolveServerUrl(args.url, env);
  // No server means no sessions. That is a normal state, not an error.
  const server = await probeServer(baseUrl, env, 2000);
  if (server.state === "down") {
    console.log(`no server on ${baseUrl}`);
    return 0;
  }
  assertUsable(server, baseUrl, env);
  const directory = path.resolve(args.dir ?? process.cwd());
  const client = makeClient(baseUrl, env);

  const sessions = unwrap(await client.session.list({ query: { directory } }), "list sessions");
  const states = unwrap(await client.session.status({ query: { directory } }), "session status");

  for (const session of sessions) {
    // Child sessions are internal subagent runs, not first-class sessions.
    if (session.parentID !== undefined) continue;
    // The status map only lists sessions that are not idle, so a session
    // missing from it is idle. It is shown because session.list returned it.
    const state = states[session.id]?.type ?? "idle";
    console.log(formatStatusLine(session.id, state, session.title));
  }
  return 0;
}
