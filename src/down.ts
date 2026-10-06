/**
 * `oc-sub down`: stop the opencode server that `oc-sub up` started, and its
 * cost proxy.
 *
 * `up` starts both processes detached (`spawnDetached` in `sandbox.ts`), so
 * each one leads its own session and process group: the group ID is the PID
 * in its PID file. The proxy group holds the `sh` restart loop and its `bun`
 * child. A signal to the negative PID reaches the whole group, so `down`
 * never signals a single PID: a loop without its child would start the
 * proxy again, and a child without its loop would be an orphan.
 * `stopStartedGroups` does the same for a caller that cannot wait for the
 * normal `down`, for example the teardown of a test.
 *
 * One SIGTERM does not always end a process. opencode serve has no SIGTERM
 * handler of its own and normally dies at once. But a library can catch
 * SIGTERM for a short time: while opencode installs the dependencies of a
 * config folder with npm's arborist, the `signal-exit` handler of arborist
 * catches the signal, aborts only the install, and removes itself. The
 * server then keeps running. So `stopGroup` repeats SIGTERM while the
 * process lives, and sends SIGKILL to the group at the deadline.
 */
import { resolveTarget, type Env } from "./config";
import { assertUsable, makeClient, probeServer, unwrap } from "./client";
import { readDirs, readPid, removeFiles, proxyPidPath, serveDirsPath, servePidPath, servePluginPath } from "./state";
import { idlePidPath, isIdleWatch, stopIdleWatch } from "./idle";

const STOP_TIMEOUT_MS = 15_000;
const STOP_INTERVAL_MS = 200;
/** How often `stopGroup` repeats SIGTERM while the process still lives. */
const TERM_REPEAT_MS = 1_000;
/** How long `stopGroup` waits for the exit after SIGKILL. */
const KILL_TIMEOUT_MS = 2_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export type BusySession = { directory: string; id: string; state: string };

/**
 * Whether a process command line is `opencode serve` on the given port. This
 * guards against a stale PID file: the PID can belong to another process now.
 */
export function isOpencodeServe(commandLine: string, port: number): boolean {
  const words = commandLine.trim().split(/\s+/);
  const isOpencode = words.some((word) => /(^|\/)opencode$/.test(word));
  const portIndex = words.indexOf("--port");
  const hasPort = words.includes(`--port=${port}`) || (portIndex !== -1 && words[portIndex + 1] === String(port));
  return isOpencode && words.includes("serve") && hasPort;
}

/**
 * Whether a process command line is the cost proxy restart loop of the
 * server whose proxy listens on `proxyPort` (`proxyLoopScript` in
 * `sandbox.ts`), or the proxy itself. Like `isOpencodeServe`, this guards
 * against a stale PID file. The loop script quotes the bundle path, so the
 * name can end with a quote.
 */
export function isProxyLoop(commandLine: string, proxyPort: number): boolean {
  const words = commandLine.trim().split(/\s+/);
  const hasBundle = words.some((word) => /(^|\/)cost-proxy\.js'?$/.test(word));
  const portIndex = words.indexOf("--port");
  return hasBundle && portIndex !== -1 && words[portIndex + 1] === String(proxyPort);
}

export function formatBusyLine(session: BusySession): string {
  return `${session.state} ${session.id} ${session.directory}`;
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The command line of a process, or null when it does not exist. */
export function commandLineOf(pid: number): string | null {
  const proc = Bun.spawnSync(["ps", "-o", "args=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
  const text = proc.stdout.toString().trim();
  return proc.exitCode === 0 && text.length > 0 ? text : null;
}

/** Sessions that are not idle, in the directories that `oc-sub run` used. */
export async function busySessions(serveUrl: string, directories: readonly string[], env: Env): Promise<BusySession[]> {
  const client = makeClient(serveUrl, env);
  const busy: BusySession[] = [];
  for (const directory of directories) {
    // The status map lists only sessions that are not idle.
    const states = unwrap(await client.session.status({ query: { directory } }), `session status of ${directory}`);
    for (const [id, state] of Object.entries(states)) {
      busy.push({ directory, id, state: state.type });
    }
  }
  return busy;
}

export async function waitUntilGone(pid: number, timeoutMs: number = STOP_TIMEOUT_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await sleep(STOP_INTERVAL_MS);
  }
  return !isAlive(pid);
}

/** The times of `stopGroup`. The tests make them short. */
export type StopTiming = { timeoutMs: number; repeatMs: number; killTimeoutMs: number };

export const DEFAULT_STOP_TIMING: StopTiming = {
  timeoutMs: STOP_TIMEOUT_MS,
  repeatMs: TERM_REPEAT_MS,
  killTimeoutMs: KILL_TIMEOUT_MS,
};

/**
 * How `stopGroup` ended: the process stopped after SIGTERM, it stopped only
 * after SIGKILL, or it still lives after SIGKILL.
 */
export type StopResult = "terminated" | "killed" | "stuck";

/**
 * Stops the process group that `pid` leads and waits until `pid` is gone.
 * It sends SIGTERM, and again every `repeatMs` while the process lives,
 * because a library handler can catch one SIGTERM and keep the process
 * running (see the head of this file). At `timeoutMs`, it sends SIGKILL to
 * the group and waits `killTimeoutMs` more.
 */
export async function stopGroup(
  pid: number,
  signalGroup: (pid: number, signal: NodeJS.Signals) => void,
  timing: StopTiming = DEFAULT_STOP_TIMING,
): Promise<StopResult> {
  const deadline = Date.now() + timing.timeoutMs;
  while (Date.now() < deadline) {
    signalGroup(pid, "SIGTERM");
    if (await waitUntilGone(pid, Math.min(timing.repeatMs, deadline - Date.now()))) return "terminated";
  }
  signalGroup(pid, "SIGKILL");
  return (await waitUntilGone(pid, timing.killTimeoutMs)) ? "killed" : "stuck";
}

/** The error text for a process that `stopGroup` could not stop. */
function stuckMessage(what: string, pid: number): string {
  return `${what} (PID ${pid}) did not stop within ${STOP_TIMEOUT_MS / 1000}s, also not after SIGKILL`;
}

/**
 * The injectable process calls of `down`. The tests replace `commandLineOf`
 * and `kill`, so that no real process is needed.
 */
export type DownDeps = {
  commandLineOf: (pid: number) => string | null;
  /**
   * Signals the process group of a detached process of `up`, with SIGTERM
   * when no signal is given. A group that is already gone is fine.
   */
  killGroup: (pid: number, signal?: NodeJS.Signals) => void;
};

export function signalGroup(pid: number, signal: NodeJS.Signals = "SIGTERM"): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // The group is already gone; the wait sees that.
  }
}

export const defaultDownDeps: DownDeps = {
  commandLineOf,
  killGroup: signalGroup,
};

/**
 * Stops the cost proxy of the server on `port` and removes its PID file.
 * Throws when the proxy did not stop in time. A missing or stale PID file is
 * fine: the proxy of an older oc-sub version has none, and a PID that now
 * belongs to another process is not signaled.
 */
async function stopProxy(env: Env, port: number, deps: DownDeps): Promise<void> {
  const pidPath = proxyPidPath(env, port);
  const pid = await readPid(pidPath);
  const commandLine = pid === null ? null : deps.commandLineOf(pid);
  if (pid !== null && commandLine !== null && isProxyLoop(commandLine, port + 1)) {
    if ((await stopGroup(pid, deps.killGroup)) === "stuck") {
      throw new Error(stuckMessage("the cost proxy", pid));
    }
  }
  await removeFiles(pidPath);
}

export async function down(
  args: { url?: string; port?: number; force: boolean },
  env: Env = process.env,
  depsOverrides: Partial<DownDeps> = {},
): Promise<number> {
  const deps = { ...defaultDownDeps, ...depsOverrides };
  const { port } = resolveTarget(args.url, args.port, env);
  const serveUrl = `http://127.0.0.1:${port}`;
  const pidPath = servePidPath(env, port);
  const dirsPath = serveDirsPath(env, port);

  const pid = await readPid(pidPath);
  const commandLine = pid === null ? null : deps.commandLineOf(pid);
  if (pid === null || commandLine === null || !isOpencodeServe(commandLine, port)) {
    // No server of ours: the PID file is missing or stale. The proxy of a
    // server that died can still run, so stop it before its PID file goes.
    try {
      await stopProxy(env, port, deps);
    } catch (error) {
      console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
    await removeFiles(pidPath, dirsPath, servePluginPath(env, port));
    await stopIdleWatch(env, port, deps);
    if ((await probeServer(serveUrl, env, 2000)).state !== "down") {
      console.error(`error: a server answers on ${serveUrl}, but oc-sub up did not start it. Stop it yourself.`);
      return 1;
    }
    console.log(`no server on ${serveUrl}`);
    return 0;
  }

  const server = args.force ? null : await probeServer(serveUrl, env, 2000);
  // Without the credentials, the busy check cannot run. Only --force skips it.
  if (server?.state === "unauthorized") assertUsable(server, serveUrl, env);
  if (server?.state === "up") {
    const busy = await busySessions(serveUrl, await readDirs(dirsPath), env);
    if (busy.length > 0) {
      console.error(`error: ${busy.length} session(s) still run on ${serveUrl}:`);
      for (const session of busy) console.error(formatBusyLine(session));
      console.error("Wait for them, abort them, or stop the server anyway with --force.");
      return 1;
    }
  }

  // `oc-sub up` starts the server detached, so it leads its own process
  // group. Signal the group, so that child processes (for example language
  // servers) stop, too.
  const stopped = await stopGroup(pid, deps.killGroup);
  if (stopped === "stuck") {
    console.error(`error: ${stuckMessage("opencode serve", pid)}`);
    return 1;
  }
  if (stopped === "killed") {
    console.error(`warning: opencode serve (PID ${pid}) ignored SIGTERM for ${STOP_TIMEOUT_MS / 1000}s; it was killed`);
  }
  try {
    await stopProxy(env, port, deps);
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  await removeFiles(pidPath, dirsPath, servePluginPath(env, port));
  // The idle watchdog of the server ends with it. When the watchdog itself
  // runs this stop, it gets no signal (`stopIdleWatch`).
  await stopIdleWatch(env, port, deps);
  console.log(`stopped ${serveUrl} (PID ${pid})`);
  return 0;
}

/**
 * Signals the process groups of the server on `port`, of its cost proxy,
 * and of its idle watchdog, as their PID files name them, and returns the group IDs it signaled. It
 * does not wait and does not remove the PID files. A PID that now belongs to
 * another process is skipped. The teardown of the integration tests uses it
 * with SIGKILL, so that no restart loop outlives a failed test.
 */
export async function stopStartedGroups(
  env: Env,
  port: number,
  signal: NodeJS.Signals = "SIGTERM",
  deps: DownDeps = defaultDownDeps,
): Promise<number[]> {
  const signaled: number[] = [];
  const checks: Array<[string, (commandLine: string) => boolean]> = [
    [servePidPath(env, port), (line) => isOpencodeServe(line, port)],
    [proxyPidPath(env, port), (line) => isProxyLoop(line, port + 1)],
    [idlePidPath(env, port), (line) => isIdleWatch(line, port)],
  ];
  for (const [file, isOurs] of checks) {
    const pid = await readPid(file);
    const commandLine = pid === null ? null : deps.commandLineOf(pid);
    if (pid === null || commandLine === null || !isOurs(commandLine)) continue;
    try {
      process.kill(-pid, signal);
      signaled.push(pid);
    } catch {
      // The group is already gone.
    }
  }
  return signaled;
}
