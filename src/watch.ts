/** `oc-sub watch`: follow a session and its subagent sessions, end with a summary. */
import path from "node:path";
import { resolveServerUrl, type Env } from "./config";
import { makeClient, requireServer, unwrap } from "./client";
import { belongsToSession, isRequestAskedEvent, watchEventLine } from "./events";
import { missingSessionIsSettled, treeIsSettled } from "./settled";
import { countToolCalls, formatDuration, formatTotals } from "./summary";
import { childIdsOf, collectDescendants, loadSessionTree, treeUsage } from "./tree";
import { answerHint, filterRequests, formatRequest, listPendingRequests, type PendingRequest } from "./requests";
import { realCostOutput } from "./realcost";

const STATUS_POLL_MS = 2000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Exit codes of watch: 0 when the run ended, 3 when it waits for an answer. */
export const WATCH_PAUSED_EXIT = 3;

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
  let exitCode = 0;
  let resolveFinished: (() => void) | undefined;
  const finishedPromise = new Promise<null>((resolve) => {
    resolveFinished = () => resolve(null);
  });
  const finish = (code: number = 0) => {
    if (!finished) {
      finished = true;
      exitCode = code;
      resolveFinished?.();
    }
  };

  const childrenOf = childIdsOf(client, directory);

  // The watched session and all of its descendant sessions. A pending request
  // of any of them pauses the watch.
  const treeIds = async (): Promise<Set<string>> =>
    new Set([sessionId, ...(await collectDescendants(sessionId, childrenOf))]);

  // Print one block per pending request of the watch tree, then end with
  // exit code 3. The session stays busy until the request is answered.
  const checkPending = async (ids?: ReadonlySet<string>): Promise<void> => {
    try {
      const mine = filterRequests(await listPendingRequests(baseUrl, directory, env), ids ?? (await treeIds()));
      if (mine.length === 0) return;
      printPending(mine, directory, args.json);
      finish(WATCH_PAUSED_EXIT);
    } catch {
      // Server unreachable right now; the next poll tries again.
    }
  };

  const checkStatus = async (): Promise<void> => {
    try {
      const states = unwrap(await client.session.status({ query: { directory } }), "session status");
      // The watch tree is the session and all of its descendant sessions.
      const descendants = await collectDescendants(sessionId, childrenOf);
      const ids = new Set([sessionId, ...descendants]);
      if (!treeIsSettled([sessionId, ...descendants], states)) {
        // Someone is still busy. A pending request explains it: the run is
        // paused on a question or a permission and waits for an answer.
        await checkPending(ids);
        return;
      }
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
      if (isRequestAskedEvent(event)) {
        // A new request may not be in the lists yet. This check usually
        // catches it at once, the next poll otherwise.
        await checkPending();
        if (finished) break;
        continue;
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
  if (exitCode === WATCH_PAUSED_EXIT) return exitCode;

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
  // The real cost from OpenRouter, below the estimated cost of the summary.
  const realCost = await realCostOutput(client, sessionId, env);
  if (realCost !== null) {
    if (args.json) {
      console.error(realCost);
    } else {
      console.log(realCost);
    }
  }
  return 0;
}

/** The pending request blocks, each with the exact answer command as a hint. */
function printPending(pending: readonly PendingRequest[], directory: string, json: boolean): void {
  const lines: string[] = [];
  pending.forEach((request, index) => {
    if (index > 0) lines.push("");
    lines.push(...formatRequest(request), answerHint(request, directory));
  });
  lines.push("", "The session waits for an answer. After answering, watch again.");
  for (const line of lines) {
    if (json) {
      console.error(line);
    } else {
      console.log(line);
    }
  }
}
