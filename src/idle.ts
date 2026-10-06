/**
 * The idle watchdog of a server that `oc-sub up` started.
 *
 * `up` starts the server in the background, and before this module only
 * `oc-sub down` stopped it, so an idle server ran for days. After a start,
 * `up` starts the hidden command `oc-sub idle-watch --port <port> --minutes
 * <N>` as the unit `ocsub-idle-<port>` (`units.ts`), or detached without a
 * user manager, with its own PID file `idle-<port>.pid` and its output
 * appended to the server log. The watchdog follows the event stream of all folders
 * (`GET /global/event`) and stops the server when no session is busy and no
 * real event came for N minutes (default 30). It uses the normal stop path:
 * `down` for a host server, `stopSandbox` for a sandbox. In sandbox mode,
 * `stopSandbox` calls `sbx stop`. Research: `.plan/research/idle-timeout.md`.
 *
 * The busy signal is the session status. The tracker adds a session on
 * `session.status` with `busy` or `retry`, and removes it on `idle` or on
 * `session.idle`. The stream sends no past state, so the watchdog seeds the
 * busy set from `GET /session/status` of each known folder at the start and
 * on each `server.connected` (the first item of each stream connection, so
 * also after each reconnect). Before a stop, it asks `GET /session/status`
 * of each known folder again, and a busy session resets the timer.
 *
 * The final check and the stop hold the server lock (`lock.ts`). When
 * `oc-sub run` holds it, the run starts a session now, so the watchdog
 * resets its timer and does not stop the server.
 *
 * The watchdog runs the stop path from inside its own unit. A stop of that
 * unit would end the watchdog in the middle of the stop, so the stop path
 * never stops the unit of the calling process (`stopPortUnits`). After a
 * successful stop the watchdog returns, its process ends, and the manager
 * unloads its unit.
 *
 * The watchdog never outlives its server for long. It exits without a stop
 * when the server PID file changes or disappears, or when the server fails
 * the health check 3 times in a row.
 */
import path from "node:path";
import type { Env } from "./config";
import { makeClient, probeServer, unwrap, type ServerState } from "./client";
import { commandLineOf, down, isAlive, signalGroup, stopGroup, type DownDeps } from "./down";
import { readDirs, readPid, removeFiles, serveDirsPath, serveLogPath, servePidPath, stateDir } from "./state";
import { readSandboxStates, stopSandbox, type ServeProcess } from "./sandbox";
import { defaultUnitDeps, stopPortUnits, type UnitDeps, type UnitOptions } from "./units";
import { tryLockServer, type Release } from "./lock";

export { DEFAULT_IDLE_MINUTES } from "./args";
/** How many failed health checks in a row end the watchdog. */
export const HEALTH_FAILS_TO_EXIT = 3;
/** The longest pause between two checks. */
const MAX_CHECK_MS = 60_000;
/** The shortest pause between two checks. */
const MIN_CHECK_MS = 1_000;

/** The events that do not count as activity: they come from the server itself. */
const QUIET_TYPES = new Set(["server.heartbeat", "server.connected"]);

/** The PID file of the watchdog of the server on `port`. */
export function idlePidPath(env: Env, port: number): string {
  return path.join(stateDir(env), `idle-${port}.pid`);
}

/** The pause between two checks: once per minute, shorter for a short limit. Pure. */
export function checkIntervalMs(limitMs: number): number {
  return Math.min(MAX_CHECK_MS, Math.max(MIN_CHECK_MS, Math.floor(limitMs / 4)));
}

/** The limit in minutes as the log shows it, for example `30m` or `0.05m`. Pure. */
export function formatMinutes(minutes: number): string {
  return `${Number(minutes.toFixed(4))}m`;
}

/** The log line of an idle stop. Pure. */
export function idleStopLine(port: number, minutes: number): string {
  return `idle-stop port=${port} idle=${formatMinutes(minutes)}`;
}

/** One item of `GET /global/event`: the folder and the v1 event. */
export type GlobalItem = { directory?: string; payload?: { type?: string; properties?: Record<string, unknown> } };

/** The status map of `GET /session/status`: only sessions that are not idle. */
export type StatusMap = Record<string, { type: string }>;

/** Whether a session status type means the session works. Pure. */
export function isBusyType(type: unknown): boolean {
  return type === "busy" || type === "retry";
}

/**
 * The pure state of the watchdog: the busy sessions, the time of the last
 * real event, and the folders that the stream named.
 */
export class IdleTracker {
  private readonly busy = new Set<string>();
  private lastEventMs: number;
  /** Each folder that an item of the stream named. */
  readonly directories = new Set<string>();

  constructor(nowMs: number) {
    this.lastEventMs = nowMs;
  }

  /** Feeds one stream item. */
  apply(item: GlobalItem, nowMs: number): void {
    if (typeof item.directory === "string" && item.directory.length > 0) this.directories.add(item.directory);
    const type = item.payload?.type;
    if (type === undefined || QUIET_TYPES.has(type)) return;
    this.lastEventMs = nowMs;
    const properties = item.payload?.properties ?? {};
    const sessionId = properties.sessionID;
    if (typeof sessionId !== "string") return;
    if (type === "session.idle") {
      this.busy.delete(sessionId);
    } else if (type === "session.status") {
      const status = (properties.status as { type?: unknown } | undefined)?.type;
      if (isBusyType(status)) this.busy.add(sessionId);
      else if (status === "idle") this.busy.delete(sessionId);
    }
  }

  /**
   * Replaces the busy set with the sessions of the status maps, and resets
   * the time of the last event to `nowMs`. With `null` (the maps could not
   * be read), the busy set stays and only the time resets.
   */
  seed(maps: readonly StatusMap[] | null, nowMs: number): void {
    this.lastEventMs = nowMs;
    if (maps === null) return;
    this.busy.clear();
    for (const map of maps) {
      for (const [id, state] of Object.entries(map)) {
        if (isBusyType(state.type)) this.busy.add(id);
      }
    }
  }

  /** The busy sessions now. */
  busySessions(): string[] {
    return [...this.busy];
  }

  /** How long no real event came, in ms. */
  idleForMs(nowMs: number): number {
    return Math.max(0, nowMs - this.lastEventMs);
  }

  /** True when no session is busy and the last real event is older than the limit. */
  isIdle(nowMs: number, limitMs: number): boolean {
    return this.busy.size === 0 && this.idleForMs(nowMs) >= limitMs;
  }
}

/** Everything that the watchdog reaches outside this module; the tests replace it. */
export type IdleWatchDeps = {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** The health check of the server. */
  probe: () => Promise<ServerState>;
  /** The PID in the server PID file, or null without one. */
  readServerPid: () => Promise<number | null>;
  /** The folders of the `.dirs` file. */
  readDirs: () => Promise<string[]>;
  /** The status map of one folder. Throws when the server does not answer. */
  sessionStatus: (directory: string) => Promise<StatusMap>;
  /**
   * Starts the event stream in the background. It calls `onItem` for each
   * item and keeps the stream open across reconnects. The returned function
   * ends the stream.
   */
  subscribe: (onItem: (item: GlobalItem) => void) => () => void;
  /**
   * Tries the server lock without a wait. Null means that a run holds it
   * and starts a session now.
   */
  tryLock: () => Promise<Release | null>;
  /** Stops the server through the normal stop path. Returns its exit code. */
  stopServer: () => Promise<number>;
  /** Writes one line into the server log. */
  log: (line: string) => void;
};

/** Why the watchdog ended. */
export type IdleWatchResult = "stopped" | "server-gone" | "server-changed" | "no-server";

/**
 * The status maps of the folders, or null when one folder did not answer.
 * A folder that fails must not count as idle.
 */
async function statusMaps(deps: IdleWatchDeps, directories: Iterable<string>): Promise<StatusMap[] | null> {
  const maps: StatusMap[] = [];
  try {
    for (const directory of directories) maps.push(await deps.sessionStatus(directory));
  } catch {
    return null;
  }
  return maps;
}

/**
 * Runs the watchdog of the server on `port` until it stops the server or
 * the server goes away. `minutes` is the idle limit.
 */
export async function idleWatch(port: number, minutes: number, deps: IdleWatchDeps): Promise<IdleWatchResult> {
  const limitMs = minutes * 60_000;
  const intervalMs = checkIntervalMs(limitMs);
  const serverPid = await deps.readServerPid();
  if (serverPid === null) {
    deps.log(`idle-watch port=${port}: no server PID file, so nothing to watch`);
    return "no-server";
  }
  const tracker = new IdleTracker(deps.now());

  const knownDirectories = async (): Promise<Set<string>> =>
    new Set([...(await deps.readDirs()), ...tracker.directories]);
  const reseed = async (): Promise<void> => {
    // A failed read keeps the old set, but still resets the time: the
    // stream may have missed events.
    tracker.seed(await statusMaps(deps, await knownDirectories()), deps.now());
  };

  await reseed();
  const endStream = deps.subscribe((item) => {
    if (item.payload?.type === "server.connected") {
      void reseed();
      return;
    }
    tracker.apply(item, deps.now());
  });

  let healthFails = 0;
  try {
    for (;;) {
      await deps.sleep(intervalMs);
      const pid = await deps.readServerPid();
      if (pid !== serverPid) {
        deps.log(`idle-watch port=${port}: the server PID file changed, so the watchdog ends`);
        return "server-changed";
      }
      const health = await deps.probe();
      if (health.state === "down") {
        healthFails += 1;
        if (healthFails >= HEALTH_FAILS_TO_EXIT) {
          deps.log(`idle-watch port=${port}: the server did not answer ${healthFails} times, so the watchdog ends`);
          return "server-gone";
        }
        continue;
      }
      healthFails = 0;
      if (!tracker.isIdle(deps.now(), limitMs)) continue;

      // The server lock guards the final check and the stop: while a run
      // holds it, the run starts a session on this server.
      const release = await deps.tryLock();
      if (release === null) {
        deps.log(`idle-watch port=${port}: a run holds the server lock, so the timer resets`);
        tracker.seed(null, deps.now());
        continue;
      }
      try {
        // The final check: ask each known folder again. A busy session, or a
        // folder that does not answer, resets the timer.
        const maps = await statusMaps(deps, await knownDirectories());
        const busy = maps === null || maps.some((map) => Object.values(map).some((state) => isBusyType(state.type)));
        if (busy) {
          // Only the timer resets. The busy set stays as the stream keeps it,
          // so a lost idle event cannot hold the server forever: the next
          // check after the limit asks the server again.
          tracker.seed(null, deps.now());
          continue;
        }
        deps.log(idleStopLine(port, minutes));
        const code = await deps.stopServer();
        if (code === 0) return "stopped";
        deps.log(`idle-watch port=${port}: the stop failed with exit code ${code}, so the watchdog keeps watching`);
        tracker.seed(null, deps.now());
      } finally {
        await release();
      }
    }
  } finally {
    endStream();
  }
}

/** Ignores the AbortError of the SDK stream (meta lesson opencode-sdk-sse-abort-unhandled). */
function isStreamAbort(reason: unknown): boolean {
  return (reason as { name?: unknown } | null)?.name === "AbortError";
}

/**
 * The real event stream: `GET /global/event` of the SDK, opened again with
 * a growing delay when it ends or fails.
 */
export function globalEventStream(serveUrl: string, env: Env): IdleWatchDeps["subscribe"] {
  return (onItem) => {
    const controller = new AbortController();
    let stopped = false;
    void (async () => {
      let backoff = 1_000;
      while (!stopped) {
        try {
          const client = makeClient(serveUrl, env);
          const subscription = await client.global.event({
            signal: controller.signal,
            sseDefaultRetryDelay: 1_000,
            sseMaxRetryDelay: 30_000,
          });
          for await (const item of subscription.stream) {
            if (stopped) break;
            backoff = 1_000;
            onItem(item as GlobalItem);
          }
        } catch {
          // The subscription failed; try again below.
        }
        if (stopped) break;
        await Bun.sleep(backoff);
        backoff = Math.min(backoff * 2, 30_000);
      }
    })();
    return () => {
      stopped = true;
      controller.abort();
    };
  };
}

/**
 * Whether a process command line is the watchdog of the server on `port`.
 * This guards against a stale PID file. Pure.
 */
export function isIdleWatch(commandLine: string, port: number): boolean {
  const words = commandLine.trim().split(/\s+/);
  const portIndex = words.indexOf("--port");
  return words.includes("idle-watch") && portIndex !== -1 && words[portIndex + 1] === String(port);
}

/** What `stopIdleWatch` reaches outside: the process calls of `down` and the user manager. */
export type StopIdleDeps = Pick<DownDeps, "commandLineOf" | "killGroup"> & { units: UnitDeps };

/**
 * Stops the watchdog of the server on `port` and removes its PID file. It
 * stops the unit `ocsub-idle-<port>` first, then the process of the PID
 * file, for a watchdog of an older oc-sub or of the fallback path. A
 * missing unit and a missing or stale PID file are fine. The watchdog itself
 * calls the stop path, so neither its own unit nor a PID equal to `selfPid`
 * gets a stop: it ends by itself after the stop path returns.
 */
export async function stopIdleWatch(
  env: Env,
  port: number,
  deps: StopIdleDeps = { commandLineOf, killGroup: signalGroup, units: defaultUnitDeps },
  selfPid: number = process.pid,
): Promise<void> {
  stopPortUnits(port, ["idle"], deps.units);
  const file = idlePidPath(env, port);
  const pid = await readPid(file);
  if (pid !== null && pid !== selfPid) {
    const commandLine = deps.commandLineOf(pid);
    if (commandLine !== null && isIdleWatch(commandLine, port) && isAlive(pid)) {
      // The watchdog has no handler for SIGTERM, so it ends at once.
      await stopGroup(pid, deps.killGroup);
    }
  }
  await removeFiles(file);
}

/** The path of the oc-sub entry point, for the spawn of the watchdog. */
export const CLI_PATH = path.resolve(import.meta.dir, "cli.ts");

/** The command of the watchdog of the server on `port`. Pure. */
export function idleWatchCommand(port: number, minutes: number, bun: string = process.execPath): string[] {
  return [bun, CLI_PATH, "idle-watch", "--port", String(port), "--minutes", String(minutes)];
}

/** Starts the watchdog: `startUnit` (`units.ts`), or a fake in the tests. */
export type SpawnIdleWatch = (opts: UnitOptions, units: UnitDeps) => ServeProcess;

/**
 * Starts the watchdog of the server on `port` after a start of `up`, as the
 * unit `ocsub-idle-<port>` with `owner`. With `minutes` 0, it starts
 * nothing. A failed spawn gives a warning and no error, because the server
 * runs.
 */
export function startIdleWatch(
  env: Env,
  port: number,
  minutes: number,
  spawn: SpawnIdleWatch,
  owner: string,
  units: UnitDeps = defaultUnitDeps,
): void {
  if (minutes <= 0) return;
  try {
    // The watchdog works in the state folder, not in the folder of `up`:
    // a removed worktree must not leave an orphan in a missing folder.
    spawn(
      {
        kind: "idle",
        name: String(port),
        owner,
        reason: `idle watchdog for port ${port}, stops the server after ${formatMinutes(minutes)} without activity`,
        cmd: idleWatchCommand(port, minutes),
        cwd: stateDir(env),
        env,
        logPath: serveLogPath(env, port),
        pidPath: idlePidPath(env, port),
      },
      units,
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`warning: cannot start the idle watchdog: ${reason}. Stop the server with oc-sub down.`);
  }
}

/** The real dependencies of the watchdog of the server on `port`. */
export function defaultIdleWatchDeps(
  env: Env,
  port: number,
  stopServer: () => Promise<number>,
): IdleWatchDeps {
  const serveUrl = `http://127.0.0.1:${port}`;
  const client = makeClient(serveUrl, env);
  return {
    now: () => Date.now(),
    sleep: (ms) => Bun.sleep(ms),
    probe: () => probeServer(serveUrl, env, 5000),
    readServerPid: () => readPid(servePidPath(env, port)),
    readDirs: () => readDirs(serveDirsPath(env, port)),
    sessionStatus: async (directory) =>
      unwrap(await client.session.status({ query: { directory } }), `session status of ${directory}`) as StatusMap,
    subscribe: globalEventStream(serveUrl, env),
    tryLock: () => tryLockServer(env, port),
    stopServer,
    log: (line) => console.log(`${new Date().toISOString()} ${line}`),
  };
}

/**
 * `oc-sub idle-watch --port <port> [--minutes N]`: the hidden command that
 * `up` spawns. It finds the mode by the port: a sandbox state with this port
 * means sandbox mode, else host mode.
 */
export async function runIdleWatch(args: { port: number; minutes: number }, env: Env = process.env): Promise<number> {
  const { port, minutes } = args;
  const onRejection = (reason: unknown) => {
    if (!isStreamAbort(reason)) console.error(reason);
  };
  process.on("unhandledRejection", onRejection);
  const sandbox = readSandboxStates(env).find(({ state }) => state.port === port)?.state;
  const serveUrl = `http://127.0.0.1:${port}`;
  const stopServer = sandbox !== undefined
    ? () => stopSandbox(sandbox, false, env)
    : () => down({ url: serveUrl, port, force: false }, env);
  try {
    const result = await idleWatch(port, minutes, defaultIdleWatchDeps(env, port, stopServer));
    if (result !== "stopped") await removeOwnPidFile(env, port);
    return result === "no-server" ? 1 : 0;
  } finally {
    process.off("unhandledRejection", onRejection);
  }
}

/** Removes the watchdog PID file when it still names this process. */
async function removeOwnPidFile(env: Env, port: number): Promise<void> {
  const file = idlePidPath(env, port);
  if ((await readPid(file)) === process.pid) await removeFiles(file);
}
