/**
 * Sandbox mode: run `opencode serve` inside a Docker Sandbox (`sbx`) per
 * project, instead of on the host. See `docs/research/SANDBOX.md` and the
 * design of step 9a in `docs/PLAN.md`. Every `sbx` call goes through a
 * runner, so the tests replace it with a fake and never call the real `sbx`.
 */
import { existsSync, openSync, closeSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import type { Env } from "./config";
import type { ServerState } from "./client";
// The busy check and the holder stop reuse the helpers of `down`.
import { busySessions, formatBusyLine, isAlive, waitUntilGone } from "./down";
import { assertUsable, probeServer } from "./client";
import { resolveServerUrl } from "./config";
import { gitCommonDir, PLACEHOLDER_KEY, projectKeyPath, projectNameOf } from "./keys";
import { stateDir, serveDirsPath, serveLogPath, servePidPath, readPid, readDirs, removeFiles } from "./state";
import { PLUGIN_CONFIG_DIR } from "./up";

/** The first port that a sandbox may take. */
export const SANDBOX_PORT_BASE = 18768;

const HEALTH_TIMEOUT_MS = 60_000;
const HEALTH_INTERVAL_MS = 300;

/** The port inside the sandbox that `opencode serve` listens on. */
const SERVE_PORT = 4096;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The agents that may run every bash command inside the sandbox. `reader` is
 * not one of them: its file denies bash on purpose, because it only reads
 * web pages.
 */
export const SANDBOX_BASH_AGENTS = ["coder", "researcher"] as const;

/**
 * The JSON that `upSandbox` passes as `OPENCODE_CONFIG_CONTENT` into the
 * sandbox. opencode merges it into its configuration, and its value wins
 * over the agent files. A whole rule object such as `"bash": "allow"`
 * replaces the bash rules of the agent file; an object value would only be
 * merged key by key, and the later `ask` rules of the file would win.
 */
export function sandboxConfigContent(): string {
  const agents: Record<string, { permission: { bash: string } }> = {};
  for (const agent of SANDBOX_BASH_AGENTS) agents[agent] = { permission: { bash: "allow" } };
  return JSON.stringify({ agent: agents });
}

/** The name of the sandbox of a project: `oc-sub-<project>`, sanitized. */
export function sandboxName(project: string): string {
  const safe = project.toLowerCase().replace(/[^a-z0-9_.-]/g, "-");
  return `oc-sub-${safe}`;
}

/** The folder of the main repository, or the directory itself without git. */
export function projectRoot(directory: string): string {
  const commonDir = gitCommonDir(directory);
  return commonDir === null ? directory : path.dirname(commonDir);
}

/** The state file of one project sandbox in the oc-sub state folder. */
export function sandboxStatePath(env: Env, project: string): string {
  return path.join(stateDir(env), `sandbox-${project}.json`);
}

/** The persisted state of one project sandbox. */
export type SandboxState = { name: string; root: string; port: number };

/** Parse the content of a state file, or null when it is invalid. */
export function parseSandboxState(text: string): SandboxState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { name, root, port } = parsed as { name?: unknown; root?: unknown; port?: unknown };
  if (typeof name !== "string" || name.length === 0) return null;
  if (typeof root !== "string" || root.length === 0) return null;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { name, root, port };
}

/** The state of a project, or null when the file is missing or invalid. */
export function readSandboxState(file: string): SandboxState | null {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  return parseSandboxState(text);
}

/** Write the state file, so that the port stays the same across restarts. */
export async function writeSandboxState(file: string, state: SandboxState): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await Bun.write(file, `${JSON.stringify(state)}\n`);
}

/**
 * The server URL of the sandbox of a project, or undefined without a valid
 * state file. Pure lookup of the state folder, no `sbx` call.
 */
export function sandboxUrlFor(
  directory: string,
  env: Env,
  projectName: (dir: string) => string = projectNameOf,
): string | undefined {
  const state = readSandboxState(sandboxStatePath(env, projectName(directory)));
  return state === null ? undefined : `http://127.0.0.1:${state.port}`;
}

/**
 * The server URL for the commands of one directory: the `--url` flag, then
 * `OC_SUB_URL`, then the sandbox state of the project of the directory,
 * then the default. `resolveServerUrl` normalizes the result.
 */
export function resolveCommandUrl(
  flag: string | undefined,
  env: Env,
  directory?: string,
  projectName: (dir: string) => string = projectNameOf,
): string {
  if (flag !== undefined || env.OC_SUB_URL !== undefined) return resolveServerUrl(flag, env);
  const sandboxUrl = sandboxUrlFor(directory ?? process.cwd(), env, projectName);
  return resolveServerUrl(sandboxUrl, env);
}

/**
 * The ports that other project sandboxes already use, from their state
 * files. A missing, unreadable, or invalid state file contributes no port.
 */
export function usedSandboxPorts(env: Env, project: string): Set<number> {
  const used = new Set<number>();
  const dir = stateDir(env);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return used;
  }
  const own = `sandbox-${project}.json`;
  for (const entry of entries) {
    if (!entry.startsWith("sandbox-") || !entry.endsWith(".json") || entry === own) continue;
    const state = readSandboxState(path.join(dir, entry));
    if (state !== null) used.add(state.port);
  }
  return used;
}

/** Whether nothing listens on the port on 127.0.0.1. */
export function defaultIsPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, "127.0.0.1");
  });
}

/**
 * The first port from `SANDBOX_PORT_BASE` upward that no other sandbox state
 * uses and that is free on 127.0.0.1.
 */
export async function pickPort(
  usedPorts: ReadonlySet<number>,
  isFree: (port: number) => boolean | Promise<boolean> = defaultIsPortFree,
): Promise<number> {
  for (let port = SANDBOX_PORT_BASE; port <= 65535; port++) {
    if (usedPorts.has(port)) continue;
    if (await isFree(port)) return port;
  }
  throw new Error(`no free port from ${SANDBOX_PORT_BASE} upward`);
}

/** The result of one `sbx` call. */
export type RunnerResult = { stdout: string; exitCode: number };

/** A runner for the `sbx` binary. The tests replace it with a fake. */
export type Runner = (cmd: readonly string[], opts?: { cwd?: string }) => RunnerResult;

/** The real runner: one synchronous subprocess per call. */
export const defaultRunner: Runner = (cmd, opts = {}) => {
  const proc = Bun.spawnSync([...cmd], { stdout: "pipe", stderr: "pipe", cwd: opts.cwd });
  return { stdout: proc.stdout.toString(), exitCode: proc.exitCode ?? 1 };
};

/** The `sbx` binary: from `SBX_BIN`, else from `PATH`. */
export function sbxBin(env: Env): string {
  const bin = env.SBX_BIN;
  return bin !== undefined && bin.length > 0 ? bin : "sbx";
}

/** Quote one path for use inside a shell command string. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * A relative mount path for `:ro`, because `sbx` 0.45.1 rejects an absolute
 * path with `:ro`.
 */
export function relativeMount(from: string, target: string): string {
  const relative = path.relative(from, target);
  return relative.length === 0 ? "." : relative.startsWith(".") ? relative : `./${relative}`;
}

/** A detached holder process, like `up` starts its server. */
export type ServeProcess = {
  pid: number;
  /** The exit code, or null while the process still runs. */
  exitCode: () => number | null;
};

/** Spawn a detached process with its output in a log file and a PID file. */
export function spawnDetached(cmd: readonly string[], logPath: string, pidPath: string): ServeProcess {
  // The process keeps running after this one exits, so its output goes to
  // a file: fd numbers are inherited by the child and closed here again.
  const logFd = openSync(logPath, "w");
  let proc: Bun.Subprocess;
  try {
    proc = Bun.spawn({
      cmd: [...cmd],
      cwd: process.cwd(),
      stdin: "ignore",
      stdout: logFd,
      stderr: logFd,
      detached: true,
    });
  } finally {
    closeSync(logFd);
  }
  proc.unref();
  writeFileSync(pidPath, `${proc.pid}\n`);
  return { pid: proc.pid, exitCode: () => proc.exitCode };
}

/** Everything that `upSandbox` and `downSandbox` reach outside this module. */
export type SandboxDeps = {
  /** Runs the `sbx` commands. */
  runner: Runner;
  /** Whether the project key file exists. Never reads its content. */
  keyExists: (file: string) => boolean | Promise<boolean>;
  /** Whether a port is free on 127.0.0.1. */
  isPortFree: (port: number) => boolean | Promise<boolean>;
  /** Probes the server URL. */
  probe: (url: string) => Promise<ServerState>;
  /** Starts the detached holder process. */
  spawnServe: (cmd: readonly string[], logPath: string, pidPath: string) => ServeProcess;
  /** The project name of a directory. */
  projectName: (directory: string) => string;
  /** The main repository folder of a directory. */
  rootOf: (directory: string) => string;
  healthTimeoutMs: number;
  healthIntervalMs: number;
};

/** The default dependencies, with the real `sbx`, git, and network. */
export const defaultSandboxDeps: SandboxDeps = {
  runner: defaultRunner,
  keyExists: existsSync,
  isPortFree: defaultIsPortFree,
  probe: (url) => probeServer(url, process.env, 2000),
  spawnServe: spawnDetached,
  projectName: projectNameOf,
  rootOf: projectRoot,
  healthTimeoutMs: HEALTH_TIMEOUT_MS,
  healthIntervalMs: HEALTH_INTERVAL_MS,
};

function mergeDeps(overrides: Partial<SandboxDeps>): SandboxDeps {
  return { ...defaultSandboxDeps, ...overrides };
}

/** Whether the output of `sbx ls` lists the sandbox name. */
export function listsName(stdout: string, name: string): boolean {
  return stdout.split("\n").some((line) => line.trim().split(/\s+/).includes(name));
}

/**
 * Whether the output of `sbx secret ls --sandbox NAME` lists an openrouter
 * secret for that scope. The columns are `SCOPE TYPE NAME SECRET`.
 */
export function listsOpenRouterSecret(stdout: string, name: string): boolean {
  return stdout.split("\n").some((line) => {
    const [scope, , secretName] = line.trim().split(/\s+/);
    return scope === name && secretName === "openrouter";
  });
}

/**
 * Whether the output of `sbx ports NAME` already publishes the host port.
 * The columns are `HOST IP  HOST PORT  SANDBOX PORT  PROTOCOL`.
 */
export function listsPublishedPort(stdout: string, port: number): boolean {
  return stdout.split("\n").some((line) => {
    const [, hostPort, sandboxPort] = line.trim().split(/\s+/);
    return hostPort === String(port) && sandboxPort === String(SERVE_PORT);
  });
}

/** The key value that `sbx` puts into the sandbox instead of the real key. */
export { PLACEHOLDER_KEY } from "./keys";

/**
 * A shell script that writes the placeholder key file
 * `$HOME/.config/<project>/openrouter.key` inside the sandbox.
 */
export function placeholderKeyScript(project: string): string {
  const dir = `"$HOME/.config/"${shellQuote(project)}`;
  return `mkdir -p ${dir} && chmod 700 ${dir} && printf %s ${PLACEHOLDER_KEY} > ${dir}/openrouter.key`;
}

function printUp(serveUrl: string, name: string, logPath: string, version: string): void {
  console.log(`${serveUrl} version ${version}`);
  console.log(`sandbox: ${name}`);
  console.log(`log: ${logPath}`);
}

/**
 * `oc-sub up --sandbox`: make sure an opencode server in the project sandbox
 * answers, set the sandbox up and start one if needed.
 */
export async function upSandbox(
  args: { dir?: string },
  env: Env = process.env,
  depsOverrides: Partial<SandboxDeps> = {},
): Promise<number> {
  const deps = mergeDeps(depsOverrides);
  const dir = path.resolve(args.dir ?? process.cwd());
  const project = deps.projectName(dir);
  const name = sandboxName(project);
  const root = deps.rootOf(dir);
  const bin = sbxBin(env);

  // The host value stays on the host: only an `-e` option of the holder
  // command reaches the sandbox, so the host value never gets there anyway.
  if (env.OPENCODE_CONFIG_CONTENT !== undefined && env.OPENCODE_CONFIG_CONTENT.trim().length > 0) {
    console.error(
      `warning: OPENCODE_CONFIG_CONTENT is set on the host. Its value does not go into the sandbox ${name}.`,
    );
  }

  const keyPath = projectKeyPath(project, env);
  if (!(await deps.keyExists(keyPath))) {
    console.error(`error: no OpenRouter key file for project ${project}: ${keyPath}`);
    console.error("Create it first. oc-sub only checks that the file exists, it never reads its content.");
    return 1;
  }

  const statePath = sandboxStatePath(env, project);
  const existing = readSandboxState(statePath);

  if (!listsName(deps.runner([bin, "ls"]).stdout, name)) {
    // The plugin folder is mounted read-only under its host path, so that
    // `OPENCODE_CONFIG_DIR` keeps the same value as on the host. The mount
    // path is relative and the working directory is the plugin folder.
    const pluginParent = path.dirname(PLUGIN_CONFIG_DIR);
    const create = deps.runner(
      [bin, "create", "--name", name, "opencode", root, `${relativeMount(pluginParent, PLUGIN_CONFIG_DIR)}:ro`],
      { cwd: pluginParent },
    );
    if (create.exitCode !== 0) {
      console.error(`error: sbx create failed for ${name}`);
      return 1;
    }
  }

  if (!listsOpenRouterSecret(deps.runner([bin, "secret", "ls", "--sandbox", name]).stdout, name)) {
    const set = deps.runner([
      bin,
      "secret",
      "set",
      "openrouter",
      "--sandbox",
      name,
      "--command",
      `cat ${shellQuote(keyPath)}`,
    ]);
    if (set.exitCode !== 0) {
      console.error(`error: sbx secret set failed for ${name}`);
      return 1;
    }
  }

  // The project opencode.json can read the key with {file:~/.config/<project>/openrouter.key}.
  // That file does not exist inside the sandbox, and opencode then rejects the
  // whole configuration. A placeholder file fixes it: the proxy of `sbx`
  // replaces the key of every request to openrouter.ai with the real one.
  const placeholder = deps.runner([bin, "exec", name, "sh", "-c", placeholderKeyScript(project)]);
  if (placeholder.exitCode !== 0) {
    console.error(`error: cannot write the placeholder key file in ${name}`);
    return 1;
  }

  let port = existing?.port;
  if (port === undefined) {
    port = await pickPort(usedSandboxPorts(env, project), deps.isPortFree);
  }
  await writeSandboxState(statePath, { name, root, port });

  if (!listsPublishedPort(deps.runner([bin, "ports", name]).stdout, port)) {
    const publish = deps.runner([bin, "ports", name, "--publish", `${port}:${SERVE_PORT}`]);
    // A stopped sandbox can list no ports although its publication persists.
    // Then the publish fails with "already published", and a second list shows it.
    if (publish.exitCode !== 0 && !listsPublishedPort(deps.runner([bin, "ports", name]).stdout, port)) {
      console.error(`error: sbx ports --publish ${port}:${SERVE_PORT} failed for ${name}`);
      return 1;
    }
  }

  const serveUrl = `http://127.0.0.1:${port}`;
  const healthy = await deps.probe(serveUrl);
  if (healthy.state === "up") {
    printUp(serveUrl, name, serveLogPath(env, port), healthy.version);
    return 0;
  }

  const logPath = serveLogPath(env, port);
  const pidPath = servePidPath(env, port);
  await mkdir(path.dirname(logPath), { recursive: true });
  // A new server has no runs yet. A list left by a crashed server is stale.
  await removeFiles(serveDirsPath(env, port));
  // The holder process keeps the sandbox alive: `sbx` stops a sandbox 30
  // seconds after the last `sbx` session ends. `OPENCODE_CONFIG_CONTENT`
  // replaces the whole bash rule object of the sandbox agents with `allow`,
  // and an empty `SSH_AUTH_SOCK` hides the SSH agent of the host from the
  // commands of the agent.
  const holder = deps.spawnServe(
    [
      bin,
      "exec",
      "-e",
      `OPENCODE_CONFIG_DIR=${PLUGIN_CONFIG_DIR}`,
      "-e",
      `OPENCODE_CONFIG_CONTENT=${sandboxConfigContent()}`,
      "-e",
      "SSH_AUTH_SOCK=",
      name,
      "opencode",
      "serve",
      "--hostname",
      "0.0.0.0",
      "--port",
      String(SERVE_PORT),
    ],
    logPath,
    pidPath,
  );

  const deadline = Date.now() + deps.healthTimeoutMs;
  while (Date.now() < deadline) {
    await sleep(deps.healthIntervalMs);
    const health = await deps.probe(serveUrl);
    if (health.state === "up") {
      printUp(serveUrl, name, logPath, health.version);
      return 0;
    }
    const code = holder.exitCode();
    if (code !== null) {
      console.error(`error: the sandbox holder process exited with code ${code}, see ${logPath}`);
      return 1;
    }
  }
  console.error(
    `error: opencode serve did not become healthy on ${serveUrl} within ${deps.healthTimeoutMs / 1000}s, see ${logPath}`,
  );
  return 1;
}

/**
 * `oc-sub down --sandbox`: stop the sandbox of the project. It keeps the
 * busy check of `down`, stops the sandbox, and removes the PID file. The
 * state file stays, so that the port stays the same.
 */
export async function downSandbox(
  args: { dir?: string; force: boolean },
  env: Env = process.env,
  depsOverrides: Partial<SandboxDeps> = {},
): Promise<number> {
  const deps = mergeDeps(depsOverrides);
  const dir = path.resolve(args.dir ?? process.cwd());
  const project = deps.projectName(dir);
  const state = readSandboxState(sandboxStatePath(env, project));
  if (state === null) {
    console.error(`error: no sandbox state for project ${project}. Run oc-sub up --sandbox first.`);
    return 1;
  }
  const { name, port } = state;
  const serveUrl = `http://127.0.0.1:${port}`;
  const pidPath = servePidPath(env, port);
  const dirsPath = serveDirsPath(env, port);

  const server = args.force ? null : await deps.probe(serveUrl);
  // Without the credentials, the busy check cannot run. Only --force skips it.
  if (server?.state === "unauthorized") assertUsable(server, serveUrl, env);
  if (server?.state === "up") {
    const busy = await busySessions(serveUrl, await readDirs(dirsPath), env);
    if (busy.length > 0) {
      console.error(`error: ${busy.length} session(s) still run on ${serveUrl}:`);
      for (const session of busy) console.error(formatBusyLine(session));
      console.error("Wait for them, abort them, or stop the sandbox anyway with --force.");
      return 1;
    }
  }

  const stop = deps.runner([sbxBin(env), "stop", name]);
  if (stop.exitCode !== 0) {
    console.error(`error: sbx stop ${name} failed`);
    return 1;
  }

  const pid = await readPid(pidPath);
  if (pid !== null && isAlive(pid)) {
    // The holder process leads its own process group, like the server of
    // `up`. Signal the group, so that child processes stop, too.
    process.kill(-pid, "SIGTERM");
    if (!(await waitUntilGone(pid))) {
      console.error(`error: the sandbox holder process (PID ${pid}) did not stop`);
      return 1;
    }
  }
  await removeFiles(pidPath, dirsPath);
  console.log(`stopped sandbox ${name} (${serveUrl})`);
  return 0;
}
