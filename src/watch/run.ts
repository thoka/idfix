/**
 * `idfx watch --all [--json] [--once]`: the watcher of all Claude Code
 * sessions of the machine. Design: docs/design/idfx-watch.md, sections 2
 * to 4.
 *
 * Every 15 seconds the watcher reads the Claude source of
 * `src/claude/rows.ts` (the same source as `top`), computes the conditions
 * (`conditions.ts`), and appends one event for each edge to the event log
 * (`log.ts`). Every 5 minutes it appends a heartbeat. `--json` also prints
 * each new event on stdout, one JSON line each. Without `--json`, it prints
 * one short line for each event. Warnings go to stderr. `--once` polls one
 * time and exits.
 *
 * After each poll, the waker (`wake.ts`, design section 5) may send one
 * notice to the supervisor through `notify-session`.
 *
 * All processes, the clock, the host name, the state folder, and the Claude
 * files come in through `WatchAllDeps`, so the tests use fakes.
 */
import { spawnSync } from "node:child_process";
import { hostname } from "node:os";
import path from "node:path";
import { claudeRowsLoader, type ClaudeRow, type ClaudeRowsLoader } from "../claude/rows";
import {
  evaluate,
  openCount,
  restoreState,
  PLAN_FILE,
  type HandoverCheck,
  type HandoverResult,
  type PlanCommitReader,
  type WatchRow,
} from "./conditions";
import { createWaker, nodeNotifier, type Notifier } from "./wake";
import {
  acquireLock,
  EVENTS_FILE,
  conditionEvent,
  heartbeatEvent,
  LOCK_FILE,
  nodeLockProcess,
  openEventWriter,
  readLogState,
  sourceOf,
  watchStateDir,
  type CloudEvent,
  type LockProcess,
} from "./log";

/** The time between two polls. */
export const POLL_MS = 15_000;
/** The time between two heartbeats. */
export const HEARTBEAT_MS = 5 * 60 * 1000;
/** The longest time that `handover check` may run. */
export const HANDOVER_TIMEOUT_MS = 60_000;
/** The longest time that `git log` for the plan commit may run. */
export const GIT_TIMEOUT_MS = 10_000;

export type WatchAllDeps = {
  /** The folder of the event log and the lock. */
  stateDir: string;
  now(): number;
  hostname(): string;
  /** The Claude rows at a time, see `claudeRowsLoader`. */
  loadRows: ClaudeRowsLoader;
  handoverCheck: HandoverCheck;
  /** The last commit of `docs/PLAN.md` in a folder, for `SessionHandedOff`. */
  planCommit: PlanCommitReader;
  /** Waits for `ms`, or less when the signal aborts. */
  sleep(ms: number, signal: AbortSignal | undefined): Promise<void>;
  stdout(line: string): void;
  stderr(line: string): void;
  lockProcess: LockProcess;
  /** Sends one wake-up notice to the supervisor. Tests inject a fake; the real one runs `notify-session`. */
  notify: Notifier;
  /** Stops the loop after the current poll. */
  signal?: AbortSignal;
};

/** The fields of a Claude row that the conditions read. A row with a PID has a live process. */
export function toWatchRow(row: ClaudeRow): WatchRow {
  return {
    sessionId: row.sessionId,
    name: row.name,
    directory: row.directory,
    kind: row.kind,
    state: row.state,
    live: row.pid !== undefined,
    waitingFor: row.waitingFor,
    waitingSource: row.waitingSource,
    stateSinceMs: row.stateSinceMs,
    lastActivityMs: row.lastActivityMs,
    transcriptGrowthMs: row.transcriptGrowthMs,
    contextTokens: row.contextTokens,
    contextWindow: row.contextWindow,
    apiErrors: row.apiErrors,
    lastApiErrorText: row.lastApiErrorText,
    lastApiErrorMs: row.lastApiErrorMs,
  };
}

/** One short line for a person: the time, the severity, the subject, the condition, and its reason. */
export function humanLine(event: CloudEvent): string {
  const data = event.data as { condition?: string; status?: string; reason?: string; message?: string; sessions?: number; open?: number };
  if (data.condition === undefined) {
    return `${event.time} ${event.severitytext} heartbeat: ${data.sessions ?? 0} sessions, ${data.open ?? 0} open conditions`;
  }
  const message = data.message !== undefined && data.message.length > 0 ? ` - ${data.message}` : "";
  return `${event.time} ${event.severitytext} ${event.subject ?? ""} ${data.condition}=${data.status} (${data.reason})${message}`;
}

/**
 * The poll loop. It returns 1 when another watcher holds the lock, and 1
 * when the only poll of `--once` failed. Else it returns 0 after `--once` or
 * after the signal aborts.
 */
export async function runWatchAll(options: { json: boolean; once: boolean }, deps: WatchAllDeps): Promise<number> {
  const taken = acquireLock(deps.stateDir, deps.lockProcess);
  if (!taken.ok) {
    deps.stderr(
      `idfx watch: another watcher runs (pid ${taken.holderPid}); the lock is ${path.join(deps.stateDir, LOCK_FILE)}`,
    );
    return 1;
  }
  try {
    const logState = readLogState(deps.stateDir);
    let state = restoreState(logState.records, logState.lastTimeMs ?? deps.now());
    let lastHeartbeat = logState.lastHeartbeatMs;
    const source = sourceOf(deps.hostname());
    const writer = openEventWriter(deps.stateDir, logState.lastSequence);
    const waker = createWaker(deps.notify, path.join(deps.stateDir, EVENTS_FILE), deps.stderr);
    // A log without any event at start: the first poll is the baseline and wakes nobody.
    let baseline = logState.lastSequence === 0;
    const emit = (event: CloudEvent): void => {
      deps.stdout(options.json ? JSON.stringify(event) : humanLine(event));
    };
    const stopped = (): boolean => deps.signal?.aborted === true;
    let failed = false;
    try {
      for (;;) {
        const nowMs = deps.now();
        try {
          const rows = (await deps.loadRows(nowMs)).map(toWatchRow);
          const result = evaluate(state, rows, nowMs, deps.handoverCheck, deps.planCommit);
          state = result.state;
          for (const edge of result.edges) emit(writer.append((sequence) => conditionEvent(edge, sequence, source)));
          waker.afterPoll(result.edges, nowMs, baseline);
          baseline = false;
          if (lastHeartbeat === undefined || nowMs - lastHeartbeat >= HEARTBEAT_MS) {
            const counts = { sessions: rows.length, open: openCount(state) };
            emit(writer.append((sequence) => heartbeatEvent(sequence, source, nowMs, counts)));
            lastHeartbeat = nowMs;
          }
          failed = false;
        } catch (error) {
          failed = true;
          deps.stderr(`idfx watch: the poll failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (options.once || stopped()) break;
        await deps.sleep(POLL_MS, deps.signal);
        if (stopped()) break;
      }
    } finally {
      writer.close();
    }
    return options.once && failed ? 1 : 0;
  } finally {
    taken.lock.release();
  }
}

/**
 * `handover check <cwd>` through the `handover` tool of meta. The first
 * non-empty output line is the first problem. A missing tool or a timeout
 * gives code -1, which changes no condition.
 */
export function nodeHandoverCheck(cwd: string): HandoverResult {
  const result = spawnSync("handover", ["check", cwd], { encoding: "utf8", timeout: HANDOVER_TIMEOUT_MS });
  if (result.error !== undefined || result.status === null) return { code: -1, firstLine: undefined };
  const firstLine = `${result.stdout ?? ""}\n${result.stderr ?? ""}`
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return { code: result.status, firstLine };
}

/**
 * The git variables that point git at one repository (`git rev-parse
 * --local-env-vars`, for example `GIT_DIR`). They are removed from the
 * environment of `git log`, so a watcher that a git hook started still
 * reads the folder of the session (lesson `git-hook-env-leaks-into-other-repos`).
 */
export function gitLocalEnvVars(): string[] {
  const result = spawnSync("git", ["rev-parse", "--local-env-vars"], { encoding: "utf8", timeout: GIT_TIMEOUT_MS });
  if (result.status !== 0) return [];
  return (result.stdout ?? "").split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
}

/**
 * The real plan commit reader: `git -C <cwd> log -1 --format=%H --
 * docs/PLAN.md`. A failure, a timeout, or an empty output gives undefined,
 * which writes no event.
 */
export function nodePlanCommit(env: Record<string, string | undefined> = process.env): PlanCommitReader {
  let clean: NodeJS.ProcessEnv | undefined;
  return (cwd) => {
    if (clean === undefined) {
      clean = { ...env } as NodeJS.ProcessEnv;
      for (const name of gitLocalEnvVars()) delete clean[name];
    }
    const result = spawnSync("git", ["-C", cwd, "log", "-1", "--format=%H", "--", PLAN_FILE], {
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      env: clean,
    });
    if (result.error !== undefined || result.status !== 0) return undefined;
    const hash = (result.stdout ?? "").trim();
    return /^[0-9a-f]{7,64}$/.test(hash) ? hash : undefined;
  };
}

/** A sleep that ends early when the signal aborts. */
export function abortableSleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** The command `idfx watch --all` with the real files, processes, and clock. SIGINT and SIGTERM stop it after the current poll. */
export async function watchAll(
  args: { json: boolean; once: boolean },
  env: Record<string, string | undefined> = process.env,
): Promise<number> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    return await runWatchAll(args, {
      stateDir: watchStateDir(env),
      now: () => Date.now(),
      hostname: () => hostname(),
      loadRows: claudeRowsLoader(env),
      handoverCheck: nodeHandoverCheck,
      planCommit: nodePlanCommit(env),
      sleep: abortableSleep,
      stdout: (line) => console.log(line),
      stderr: (line) => console.error(line),
      lockProcess: nodeLockProcess,
      notify: nodeNotifier(env),
      signal: controller.signal,
    });
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}
