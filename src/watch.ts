/** `oc-sub watch`: follow a session and its subagent sessions, end with a summary. */
import path from "node:path";
import { resolveServerUrl, type Env } from "./config";
import { makeClient, requireServer, unwrap } from "./client";
import { belongsToSession, eventSessionId, isRequestAskedEvent, watchEventLine } from "./events";
import { createGuard, formatFinding, type Finding } from "./detect";
import { missingSessionIsSettled, treeIsSettled } from "./settled";
import { countToolCalls, formatDuration, formatTotals } from "./summary";
import { childIdsOf, collectDescendants, loadSessionTree, treeUsage } from "./tree";
import { answerHint, filterRequests, formatRequest, listPendingRequests, type PendingRequest } from "./requests";
import { realCostOutput } from "./realcost";

const STATUS_POLL_MS = 2000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Exit codes of watch: 0 ended, 3 waits for an answer, 4 needs attention. */
export const WATCH_PAUSED_EXIT = 3;
export const WATCH_ATTENTION_EXIT = 4;

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

  // The guards watch the session and all of its descendant sessions. A
  // finding does not stop the run: the orchestrator decides.
  const guard = createGuard();
  let treeIdSet = new Set<string>([sessionId]);

  // The watch tree is the session and all of its descendant sessions. A
  // pending request of any of them pauses the watch.
  const treeIds = async (): Promise<Set<string>> =>
    new Set([sessionId, ...(await collectDescendants(sessionId, childrenOf))]);

  /** Print one block per finding, then end with exit code 4. */
  const reportFindings = (findings: readonly Finding[]): void => {
    if (findings.length === 0) return;
    const lines: string[] = [];
    findings.forEach((finding, index) => {
      if (index > 0) lines.push("");
      lines.push(...formatFinding(finding));
    });
    lines.push("", "The run keeps running. Abort it, or send a correction to the session.");
    printLines(lines, args.json);
    finish(WATCH_ATTENTION_EXIT);
  };

  /**
   * The pending requests of the watch tree, or undefined when the lists
   * could not be read. An empty array means: none pending.
   */
  const findPending = async (ids: ReadonlySet<string>): Promise<PendingRequest[] | undefined> => {
    try {
      return filterRequests(await listPendingRequests(baseUrl, directory, env), ids);
    } catch {
      // Server unreachable right now; the next poll tries again.
      return undefined;
    }
  };

  // Print one block per pending request of the watch tree, then end with
  // exit code 3. The session stays busy until the request is answered.
  const checkPending = async (ids?: ReadonlySet<string>): Promise<void> => {
    const mine = await findPending(ids ?? (await treeIds()));
    if (mine === undefined || mine.length === 0) return;
    printPending(mine, directory, args.json);
    finish(WATCH_PAUSED_EXIT);
  };

  const checkStatus = async (): Promise<void> => {
    try {
      const states = unwrap(await client.session.status({ query: { directory } }), "session status");
      const now = Date.now();
      // The watch tree is the session and all of its descendant sessions.
      const descendants = await collectDescendants(sessionId, childrenOf);
      const ids = new Set([sessionId, ...descendants]);
      treeIdSet = ids;
      ids.forEach((id) => guard.touch(id, now));
      reportFindings(guard.checkStalls(states, now));
      if (finished) return;
      if (!treeIsSettled([sessionId, ...descendants], states)) {
        // Someone is still busy. A pending request explains it: the run is
        // paused on a question or a permission and waits for an answer.
        await checkPending(ids);
        return;
      }
      // The tree looks idle, but a request may still wait for an answer.
      // The status of a session can flip to idle for a moment between two
      // requests, so the watch only ends as idle when no request is
      // pending. When the lists cannot be read, it keeps watching.
      const pending = await findPending(ids);
      if (pending === undefined) return;
      if (pending.length > 0) {
        printPending(pending, directory, args.json);
        finish(WATCH_PAUSED_EXIT);
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
      // The guards see the events of the watched session and of its
      // descendant sessions.
      const eventSession = eventSessionId(event);
      if (eventSession !== undefined && treeIdSet.has(eventSession)) {
        reportFindings(guard.feed(event, Date.now()));
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
  if (exitCode !== 0) return exitCode;

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

/** Print lines to stdout, or to stderr in JSON mode, where the events go. */
function printLines(lines: readonly string[], json: boolean): void {
  for (const line of lines) {
    if (json) {
      console.error(line);
    } else {
      console.log(line);
    }
  }
}

/** The pending request blocks, each with the exact answer command as a hint. */
function printPending(pending: readonly PendingRequest[], directory: string, json: boolean): void {
  const lines: string[] = [];
  pending.forEach((request, index) => {
    if (index > 0) lines.push("");
    lines.push(...formatRequest(request), answerHint(request, directory));
  });
  lines.push("", "The session waits for an answer. After answering, watch again.");
  printLines(lines, json);
}
