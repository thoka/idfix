/** `oc-sub watch`: follow a session and its subagent sessions, end with a summary. */
import path from "node:path";
import { resolveServerUrl, type Env } from "./config";
import { makeClient, requireServer, unwrap } from "./client";
import { belongsToSession, watchEventLine } from "./events";
import { missingSessionIsSettled, treeIsSettled } from "./settled";
import { countToolCalls, formatDuration, formatTotals } from "./summary";
import { childIdsOf, collectDescendants, loadSessionTree, treeUsage } from "./tree";

const STATUS_POLL_MS = 2000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function watch(
  args: { url?: string; session: string; dir?: string; json: boolean },
  env: Env = process.env,
): Promise<number> {
  const baseUrl = resolveServerUrl(args.url, env);
  await requireServer(baseUrl, env);
  const directory = path.resolve(args.dir ?? process.cwd());
  const client = makeClient(baseUrl, env);
  const sessionId = args.session;

  // Fail fast when the session is not in this directory's project.
  unwrap(await client.session.get({ path: { id: sessionId }, query: { directory } }), "load session");

  // Subscribe first: any idle that happens after this point is caught by the
  // stream, so the initial status check below cannot race past the end.
  // The directory query selects the instance whose events carry this session.
  let reconnected = false;
  const subscription = await client.event.subscribe({
    query: { directory },
    onSseError: () => {
      reconnected = true;
      void checkStatus();
    },
  });
  const iterator = subscription.stream[Symbol.asyncIterator]();

  let finished = false;
  let resolveFinished: (() => void) | undefined;
  const finishedPromise = new Promise<null>((resolve) => {
    resolveFinished = () => resolve(null);
  });
  const finish = () => {
    if (!finished) {
      finished = true;
      resolveFinished?.();
    }
  };

  const childrenOf = childIdsOf(client, directory);

  const checkStatus = async (): Promise<void> => {
    try {
      const states = unwrap(await client.session.status({ query: { directory } }), "session status");
      // The watch tree is the session and all of its descendant sessions.
      const descendants = await collectDescendants(sessionId, childrenOf);
      if (!treeIsSettled([sessionId, ...descendants], states)) return; // someone is still busy
      if (states[sessionId] !== undefined) {
        finish();
        return;
      }
      // The server lists only sessions that are not idle in this map. The
      // main session is missing, so it has either ended, or it was started a
      // moment ago and the server has not marked it busy yet. Its messages
      // tell them apart.
      const session = unwrap(
        await client.session.get({ path: { id: sessionId }, query: { directory } }),
        "load session",
      );
      const messages = unwrap(
        await client.session.messages({ path: { id: sessionId }, query: { directory } }),
        "load messages",
      );
      if (missingSessionIsSettled(messages, session.time.updated, Date.now())) finish();
    } catch {
      // Server unreachable right now; the event stream keeps retrying.
    }
  };

  // Safety net: even when events stall, a status check ends the watch.
  const timer = setInterval(() => {
    void checkStatus();
  }, STATUS_POLL_MS);
  timer.unref();

  const startedAt = Date.now();
  const seen = new Set<string>();
  let watchedToolCalls = 0;

  try {
    await checkStatus(); // check at the start
    for (;;) {
      if (finished) break;
      const next = await Promise.race([iterator.next(), finishedPromise]);
      if (next === null || next.done) break;
      const event = next.value;
      if (reconnected) {
        // After a reconnect, check whether the session ended meanwhile.
        reconnected = false;
        await checkStatus();
        if (finished) break;
      }
      if (!belongsToSession(event, sessionId)) continue;
      if (event.type === "session.idle" && event.properties.sessionID === sessionId) {
        if (args.json) console.log(JSON.stringify(event));
        // The main session is idle, but its subagent sessions may still run.
        // The same check decides when the watch ends.
        await checkStatus();
        if (finished) break;
        continue;
      }
      if (args.json) {
        console.log(JSON.stringify(event));
      } else {
        const line = watchEventLine(event, seen);
        if (line === null) continue;
        if (line.kind === "tool") watchedToolCalls++;
        console.log(line.line);
      }
    }
  } finally {
    clearInterval(timer);
  }

  if (!finished) {
    // The stream ended without an idle event; one last check before failing.
    await checkStatus();
    await sleep(0);
  }
  if (!finished) {
    console.error(`error: event stream ended before session ${sessionId} became idle`);
    return 1;
  }

  const elapsed = Date.now() - startedAt;
  let toolCalls = watchedToolCalls;
  let summary = "summary unavailable";
  try {
    const tree = await loadSessionTree(client, sessionId, directory);
    toolCalls = countToolCalls(tree.main);
    summary = formatTotals(treeUsage(tree));
  } catch {
    // Keep the watch-side numbers instead.
  }
  const line = `idle after ${formatDuration(elapsed)}, ${toolCalls} tool calls, ${summary}`;
  if (args.json) {
    console.error(line);
  } else {
    console.log(line);
  }
  return 0;
}
