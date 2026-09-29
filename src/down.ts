/** `oc-sub down`: stop the opencode server that `oc-sub up` started. */
import { resolveTarget, type Env } from "./config";
import { assertUsable, makeClient, probeServer, unwrap } from "./client";
import { readDirs, readPid, removeFiles, serveDirsPath, servePidPath } from "./state";

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

export async function down(args: { url?: string; port?: number; force: boolean }, env: Env = process.env): Promise<number> {
  const { port } = resolveTarget(args.url, args.port, env);
  const serveUrl = `http://127.0.0.1:${port}`;
  const pidPath = servePidPath(env, port);
  const dirsPath = serveDirsPath(env, port);

  const pid = await readPid(pidPath);
  const commandLine = pid === null ? null : commandLineOf(pid);
  if (pid === null || commandLine === null || !isOpencodeServe(commandLine, port)) {
    // No server of ours: the PID file is missing or stale.
    await removeFiles(pidPath, dirsPath);
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
  process.kill(-pid, "SIGTERM");
  if (!(await waitUntilGone(pid))) {
    console.error(`error: opencode serve (PID ${pid}) did not stop within ${STOP_TIMEOUT_MS / 1000}s`);
    return 1;
  }
  await removeFiles(pidPath, dirsPath);
  console.log(`stopped ${serveUrl} (PID ${pid})`);
  return 0;
}
