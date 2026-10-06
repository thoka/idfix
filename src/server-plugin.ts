/**
 * The running servers of `oc-sub` and their plugin digests, for the
 * `server-plugin` check of `doctor`, and the restart of an idle
 * server as its fix. The check itself lives in `doctor.ts`; this module holds
 * the parts that reach processes and servers, so the tests replace them.
 */
import { readFileSync } from "node:fs";
import { resolveTarget, type Env } from "./config";
import { probeServer } from "./client";
import { busySessions, commandLineOf, down, formatBusyLine, isOpencodeServe } from "./down";
import {
  defaultRunner,
  downSandbox,
  miseInstallsDir,
  missingMounts,
  requiredSandboxMounts,
  sandboxRecreateFix,
  sbxBin,
  upSandbox,
  type SandboxState,
} from "./sandbox";
import { pluginDataDir } from "./plugin-sync";
import { sharedAgentsDir } from "./shared";
import { readDirs, readServePlugin, serveDirsPath, servePidPath, servePluginPath } from "./state";
import { up } from "./up";

/** A server that `oc-sub up` started and that still runs. */
export type RunningServer = {
  mode: "host" | "sandbox";
  port: number;
  url: string;
  /** The project root of a sandbox server; `upSandbox` takes it as `--dir`. */
  root?: string;
  /** The sandbox name of a sandbox server, such as `oc-sub-<project>`. */
  name?: string;
  /** The recorded plugin digest, or null when the server has no record (started by an older oc-sub). */
  digest: string | null;
};

/** The outcome of one fix action, as in `doctor.ts`. */
export type RestartOutcome = { ok: boolean; note: string };

/** The PID in a PID file, read synchronously, or null. */
function readPidSync(file: string): number | null {
  try {
    const pid = Number(readFileSync(file, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** A short label of a server for the messages, such as `host server :8767`. */
export function serverLabel(server: RunningServer): string {
  return server.mode === "host" ? `host server :${server.port}` : `sandbox server of ${server.root} :${server.port}`;
}

/**
 * The servers that the checks of one project care about: the host server on
 * the default port (`OPENCODE_SERVER_URL`, else 8767) and the sandbox server
 * of the project. A server counts as running when its PID file names a live
 * process of the right kind: `opencode serve --port N` for the host server,
 * and the holder process (`sbx exec ... <name> ...`) for a sandbox server.
 * Each one carries its recorded plugin digest. Synchronous, so the check can
 * use it; `commandLine` is injected for the tests.
 */
export function findRunningServers(
  env: Env,
  sandboxState: SandboxState | null,
  commandLine: (pid: number) => string | null = commandLineOf,
): RunningServer[] {
  const servers: RunningServer[] = [];
  // A bad OPENCODE_SERVER_URL names no host server; the other commands report it.
  let host: number | null = null;
  try {
    host = resolveTarget(undefined, undefined, env).port;
  } catch {
    host = null;
  }
  const hostPid = host === null ? null : readPidSync(servePidPath(env, host));
  const hostCmd = hostPid === null ? null : commandLine(hostPid);
  if (host !== null && hostCmd !== null && isOpencodeServe(hostCmd, host)) {
    servers.push({ mode: "host", port: host, url: `http://127.0.0.1:${host}`, digest: readServePlugin(servePluginPath(env, host)) });
  }
  if (sandboxState !== null && sandboxState.port !== host) {
    const pid = readPidSync(servePidPath(env, sandboxState.port));
    const cmd = pid === null ? null : commandLine(pid);
    if (cmd !== null && cmd.split(/\s+/).includes(sandboxState.name)) {
      servers.push({
        mode: "sandbox",
        port: sandboxState.port,
        url: `http://127.0.0.1:${sandboxState.port}`,
        root: sandboxState.root,
        name: sandboxState.name,
        digest: readServePlugin(servePluginPath(env, sandboxState.port)),
      });
    }
  }
  return servers;
}

/** What `restartServer` reaches outside this module; the tests replace it. */
export type RestartDeps = {
  probe: typeof probeServer;
  busySessions: typeof busySessions;
  down: (port: number) => Promise<number>;
  up: (port: number) => Promise<number>;
  downSandbox: (root: string) => Promise<number>;
  upSandbox: (root: string) => Promise<number>;
  /**
   * The required mounts that the sandbox of a sandbox server lacks, from
   * `sbx ls`. Empty when the sandbox has all of them.
   */
  sandboxMissingMounts: (name: string, root: string, env: Env) => string[];
};

/** The real mount check: `sbx ls` and the same mount plan as `upSandbox`. */
export function defaultSandboxMissingMounts(name: string, root: string, env: Env): string[] {
  const ls = defaultRunner([sbxBin(env), "ls"]).stdout;
  return missingMounts(ls, name, requiredSandboxMounts(root, pluginDataDir(env), miseInstallsDir(env), sharedAgentsDir(env)));
}

export const defaultRestartDeps: RestartDeps = {
  probe: probeServer,
  busySessions,
  down: (port) => down({ port, force: false }),
  up: (port) => up({ port }),
  downSandbox: (root) => downSandbox({ dir: root, force: false }),
  upSandbox: (root) => upSandbox({ dir: root }),
  sandboxMissingMounts: defaultSandboxMissingMounts,
};

/**
 * The busy check that `restartServer` and the recreate fix of
 * `sandbox-mounts` share: probe the server, then check its sessions. The
 * check is clear only when the server answers with valid credentials and no
 * session runs on it. A refused probe, a failed session check, or a busy
 * session blocks both a restart and a recreate.
 */
export type BusyCheck =
  | { kind: "clear" }
  | { kind: "unauthorized" }
  | { kind: "failed"; reason: string }
  | { kind: "busy"; sessions: string };

/** Run the shared busy check of a server. */
export async function busyCheck(
  server: RunningServer,
  env: Env = process.env,
  deps: RestartDeps = defaultRestartDeps,
): Promise<BusyCheck> {
  const state = await deps.probe(server.url, env, 2000);
  if (state.state === "unauthorized") return { kind: "unauthorized" };
  if (state.state === "up") {
    let busy;
    try {
      busy = await deps.busySessions(server.url, await readDirs(serveDirsPath(env, server.port)), env);
    } catch (error) {
      return { kind: "failed", reason: error instanceof Error ? error.message : String(error) };
    }
    if (busy.length > 0) return { kind: "busy", sessions: busy.map(formatBusyLine).join(", ") };
  }
  return { kind: "clear" };
}

/** The cause text of a busy check result, for the notes of the fixes. */
export function busyCheckNote(check: BusyCheck, server: RunningServer): string {
  const label = serverLabel(server);
  switch (check.kind) {
    case "clear":
      return "";
    case "unauthorized":
      return `${label} refused the credentials, so its sessions cannot be checked`;
    case "failed":
      return `${label}: cannot check its sessions (${check.reason})`;
    case "busy":
      return `${label} is busy: ${check.sessions}`;
  }
}

/**
 * Restarts one server when every session on it is idle. It uses the busy
 * check of `down`: the sessions of the folders in `serve-<port>.dirs` that
 * are not idle. A busy server is not restarted, and the outcome names
 * `oc-sub abort` and `oc-sub down`. Then it runs `down` and `up` (or their
 * sandbox forms) without `--force`, so `down` checks the sessions once more.
 * `up` syncs the plugin folder again and records the new digest.
 *
 * The restart prints to stderr, so that `doctor --fix --json` keeps stdout
 * for the JSON object. A server started with `--no-cost-proxy` comes back
 * with the proxy (known gap: the state does not record the flag).
 */
export async function restartServer(
  server: RunningServer,
  env: Env = process.env,
  deps: RestartDeps = defaultRestartDeps,
): Promise<RestartOutcome> {
  const label = serverLabel(server);
  // `upSandbox` refuses a sandbox that lacks a required mount, for example
  // an older one without the synced plugin mount. A stop
  // would then leave the server down, so such a sandbox is never stopped.
  if (server.mode === "sandbox") {
    const name = server.name ?? "";
    const missing = deps.sandboxMissingMounts(name, server.root as string, env);
    if (missing.length > 0) {
      return {
        ok: false,
        note: `${label} is not restarted, because its sandbox lacks the mounts ${missing.join(", ")} and up would not start it again. The sandbox needs a recreate first: ${sandboxRecreateFix(name)}`,
      };
    }
  }
  const busy = await busyCheck(server, env, deps);
  if (busy.kind === "unauthorized") {
    return { ok: false, note: `${busyCheckNote(busy, server)}. It is not restarted` };
  }
  if (busy.kind === "failed") {
    return { ok: false, note: `${busyCheckNote(busy, server)}. It is not restarted` };
  }
  if (busy.kind === "busy") {
    return {
      ok: false,
      note: `${label} is busy, not restarted: ${busy.sessions}. Wait for the sessions, or end them with oc-sub abort or oc-sub down, then run oc-sub doctor --fix again`,
    };
  }
  const log = console.log;
  console.log = console.error;
  try {
    if (server.mode === "host") {
      const stopped = await deps.down(server.port);
      if (stopped !== 0) return { ok: false, note: `${label}: oc-sub down failed with code ${stopped}` };
      const started = await deps.up(server.port);
      if (started !== 0) return { ok: false, note: `${label}: oc-sub up failed with code ${started}` };
    } else {
      const root = server.root as string;
      const stopped = await deps.downSandbox(root);
      if (stopped !== 0) return { ok: false, note: `${label}: oc-sub down failed with code ${stopped}` };
      const started = await deps.upSandbox(root);
      if (started !== 0) return { ok: false, note: `${label}: oc-sub up failed with code ${started}` };
    }
  } finally {
    console.log = log;
  }
  return { ok: true, note: `restarted the ${label}` };
}
