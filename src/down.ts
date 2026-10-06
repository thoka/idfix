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
 */
import { resolveTarget, type Env } from "./config";
import { assertUsable, makeClient, probeServer, unwrap } from "./client";
import { readDirs, readPid, removeFiles, proxyPidPath, serveDirsPath, servePidPath, servePluginPath } from "./state";

const STOP_TIMEOUT_MS = 15_000;
const STOP_INTERVAL_MS = 200;

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

export async function waitUntilGone(pid: number): Promise<boolean> {
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await sleep(STOP_INTERVAL_MS);
  }
  return !isAlive(pid);
}

/**
 * The injectable process calls of `down`. The tests replace `commandLineOf`
 * and `kill`, so that no real process is needed.
 */
export type DownDeps = {
  commandLineOf: (pid: number) => string | null;
  /** Signals the process group of a detached process of `up`. */
  killGroup: (pid: number) => void;
};

export const defaultDownDeps: DownDeps = {
  commandLineOf,
  killGroup: (pid) => process.kill(-pid, "SIGTERM"),
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
    deps.killGroup(pid);
    if (!(await waitUntilGone(pid))) {
      throw new Error(`the cost proxy (PID ${pid}) did not stop within ${STOP_TIMEOUT_MS / 1000}s`);
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
  deps.killGroup(pid);
  if (!(await waitUntilGone(pid))) {
    console.error(`error: opencode serve (PID ${pid}) did not stop within ${STOP_TIMEOUT_MS / 1000}s`);
    return 1;
  }
  try {
    await stopProxy(env, port, deps);
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  await removeFiles(pidPath, dirsPath, servePluginPath(env, port));
  console.log(`stopped ${serveUrl} (PID ${pid})`);
  return 0;
}

/**
 * Signals the process groups of the server on `port` and of its cost proxy,
 * as their PID files name them, and returns the group IDs it signaled. It
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
