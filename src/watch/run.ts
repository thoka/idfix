/**
 * `idfx watch --all [--json] [--once]`: the watcher of all Claude Code
 * sessions of the machine. Design: .plan/design/idfx-watch.md, sections 2
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
  type HandoverCheck,
  type HandoverResult,
  type PlanCommitReader,
  type WatchRow,
} from "./conditions";
import { sessionNamesSource, readTextSync, type SessionNamesReader } from "../folder-config";
import { projectNameOf, projectRootOfRun } from "../keys";
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
  /** The last commit of the plan (`PLAN.md` in the plan folder) of a folder, for `SessionHandedOff`. */
  planCommit: PlanCommitReader;
  /**
   * A reader of the extra session names of a main folder (`.idfix.toml`)
   * for one poll. The watcher calls it once per poll.
   */
  sessionNames(): SessionNamesReader;
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

/**
 * The fields of a Claude row that the conditions read. A row with a PID has
 * a live process. `projectOf` gives the main folder of the project and its
 * name; tests replace it, so that they need no real folders.
 */
export function toWatchRow(
  row: ClaudeRow,
  projectOf: (directory: string) => { root: string; name: string } = projectOfRun,
): WatchRow {
  const project = projectOf(row.directory);
  return {
    sessionId: row.sessionId,
    name: row.name,
    directory: row.directory,
    project: project.name,
    projectRoot: project.root,
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
    turn: row.turn,
    backgroundTasks: row.backgroundTasks,
  };
}

/** The main folder of the project of a run folder and its name, as `projectNameOfRun` finds them. */
export function projectOfRun(directory: string): { root: string; name: string } {
  const root = projectRootOfRun(directory);
  return { root, name: projectNameOf(root) };
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
          const rows = (await deps.loadRows(nowMs)).map((row) => toWatchRow(row));
          const result = evaluate(state, rows, nowMs, deps.handoverCheck, deps.planCommit, deps.sessionNames());
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
 * `handover check <cwd>` through the `handover` tool. The first
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
 * environment of `handover show`, so a watcher that a git hook started still
 * reads the folder of the session.
 */
export function gitLocalEnvVars(): string[] {
  const result = spawnSync("git", ["rev-parse", "--local-env-vars"], { encoding: "utf8", timeout: GIT_TIMEOUT_MS });
  if (result.status !== 0) return [];
  return (result.stdout ?? "").split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
}

/**
 * The field `planCommit` of the output of `handover show --json`: the full
 * hash of the last commit of the plan, or undefined when the output is not
 * a JSON object, the field is null or missing, or it is not a hex hash.
 */
export function parsePlanCommit(stdout: string): string | undefined {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const hash = (value as { planCommit?: unknown }).planCommit;
  return typeof hash === "string" && /^[0-9a-f]{7,64}$/.test(hash) ? hash : undefined;
}

/**
 * The real plan commit reader: `handover show --json <cwd>` through the
 * `handover` tool, field `planCommit`. The tool reads `plan_dir` of
 * `.handover.toml` and finds a companion plan repository, so idfix does not
 * repeat that logic. Exit code 0 or 1 gives the parsed output. Another exit
 * code, a missing tool, a timeout, or a bad output gives undefined, which
 * writes no event.
 */
export function nodePlanCommit(env: Record<string, string | undefined> = process.env): PlanCommitReader {
  let clean: NodeJS.ProcessEnv | undefined;
  return (cwd) => {
    if (clean === undefined) {
      clean = { ...env } as NodeJS.ProcessEnv;
      for (const name of gitLocalEnvVars()) delete clean[name];
    }
    const result = spawnSync("handover", ["show", "--json", cwd], {
      encoding: "utf8",
      timeout: HANDOVER_TIMEOUT_MS,
      env: clean,
    });
    if (result.error !== undefined || (result.status !== 0 && result.status !== 1)) return undefined;
    return parsePlanCommit(result.stdout ?? "");
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
  const names = sessionNamesSource(readTextSync, (line) => console.error(`idfx watch: ${line}`));
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
      sessionNames: () => names.forTick(),
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
