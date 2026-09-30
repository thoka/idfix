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
import { gitCommonDir, PLACEHOLDER_KEY, projectKeyPath, projectNameOfRun } from "./keys";
import { stateDir, serveDirsPath, serveLogPath, servePidPath, readPid, readDirs, removeFiles } from "./state";
import { sharedAgentsDir, sharedConfigEntries } from "./shared";
import { PLUGIN_CONFIG_DIR } from "./up";

/** The first port that a sandbox may take. */
export const SANDBOX_PORT_BASE = 18768;

/**
 * The PATH that the `opencode` kit sets inside a sandbox. The holder command
 * puts the project tool paths of the host in front of it.
 */
export const SANDBOX_PATH =
  "/home/agent/.local/bin:/usr/local/share/npm-global/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/**
 * The hosts and networks that a project sandbox may not reach. The proxy of
 * `sbx` rewrites `host.docker.internal` to `localhost`, so a deny rule for
 * `host.docker.internal` alone is not enough.
 */
export const NETWORK_DENY_HOSTS = [
  "host.docker.internal",
  "localhost",
  "127.0.0.0/8",
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
];

/**
 * The host of the Exa websearch that opencode calls with POST when
 * `OPENCODE_ENABLE_EXA` is truthy. The websearch needs no key and no cost.
 */
export const EXA_HOST = "mcp.exa.ai:443";

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
 * over the agent files. A whole rule value such as `"bash": "allow"`
 * replaces the bash rules of the agent file. The `external_directory`
 * allow goes with it: inside the sandbox the host files are not visible,
 * so the deny rule of the agent file protects nothing, but it blocked a
 * coder from creating a scratch folder in /tmp. The sandbox, not the rule,
 * is the boundary.
 */
export function sandboxConfigContent(sharedDir: string): string {
  const agents: Record<string, { permission: { bash: string; external_directory: string } }> = {};
  for (const agent of SANDBOX_BASH_AGENTS) {
    agents[agent] = { permission: { bash: "allow", external_directory: "allow" } };
  }
  // The kit of `sbx` adds an MCP gateway to the opencode configuration of
  // the sandbox. An agent could call its tools, so the sandbox turns it off.
  // The shared rules and skills load through the absolute paths, because the
  // `OPENCODE_CONFIG_DIR` of the sandbox drops the global AGENTS.md (see
  // docs/research/OPENCODE_RULES.md).
  return JSON.stringify({
    agent: agents,
    mcp: { "mcp-gateway": { enabled: false } },
    ...sharedConfigEntries(sharedDir),
  });
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

/**
 * Every valid sandbox state in the state folder, sorted by project name.
 * A missing state folder, and a missing, unreadable, or invalid state file,
 * contributes nothing.
 */
export function readSandboxStates(env: Env): Array<{ project: string; state: SandboxState }> {
  const dir = stateDir(env);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const found: Array<{ project: string; state: SandboxState }> = [];
  for (const entry of entries) {
    if (!entry.startsWith("sandbox-") || !entry.endsWith(".json")) continue;
    const project = entry.slice("sandbox-".length, -".json".length);
    if (project.length === 0) continue;
    const state = readSandboxState(path.join(dir, entry));
    if (state !== null) found.push({ project, state });
  }
  return found.sort((a, b) => (a.project < b.project ? -1 : a.project > b.project ? 1 : 0));
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
  projectName: (dir: string) => string = projectNameOfRun,
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
  projectName: (dir: string) => string = projectNameOfRun,
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
  for (const { project: name, state } of readSandboxStates(env)) {
    if (name !== project) used.add(state.port);
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

/** The `mise` binary: from `MISE_BIN`, else from `PATH`. */
export function miseBin(env: Env): string {
  const bin = env.MISE_BIN;
  return bin !== undefined && bin.length > 0 ? bin : "mise";
}

/**
 * The folder in which mise installs the tools of a project. The default of
 * `MISE_DATA_DIR` is `$XDG_DATA_HOME/mise`, else `~/.local/share/mise`.
 */
export function miseInstallsDir(env: Env): string {
  const dataDir = env.MISE_DATA_DIR ?? (env.XDG_DATA_HOME !== undefined ? path.join(env.XDG_DATA_HOME, "mise") : path.join(env.HOME ?? "~", ".local/share/mise"));
  return path.join(dataDir, "installs");
}

/**
 * The PATH entries of the JSON from `mise env --json` that live inside the
 * installs folder, in their order, joined with `:`. Pure: no mise call.
 */
export function projectToolPath(miseJson: string, installsDir: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(miseJson);
  } catch {
    return "";
  }
  // mise prints PATH as one string with `:` between the entries.
  const envPath = (parsed as { PATH?: unknown })?.PATH;
  if (typeof envPath !== "string") return "";
  const prefix = installsDir.endsWith("/") ? installsDir : `${installsDir}/`;
  return envPath
    .split(":")
    .filter((entry) => entry.startsWith(prefix))
    .join(":");
}

/** Quote one path for use inside a shell command string. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The PATH entry that puts the tool folders of the project in front of the
 * sandbox PATH. `upSandbox` (the holder command) and `worktree` (the setup
 * command) use it, so both find the mise tools of the project.
 */
export function sandboxToolPathEntry(toolPath: string): string {
  return `PATH=${toolPath ? `${toolPath}:` : ""}${SANDBOX_PATH}`;
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
  /** Whether a binary such as `sbx` exists on the PATH. */
  binExists: (bin: string) => boolean;
  /** Whether a host file such as the shared AGENTS.md exists. */
  fileExists: (file: string) => boolean;
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
  projectName: projectNameOfRun,
  rootOf: projectRoot,
  binExists: (bin) => Bun.which(bin) !== null,
  fileExists: existsSync,
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
 * Whether the line of `sbx ls` for the sandbox lists all the mounts. The
 * WORKSPACE column lists the mounts separated by `, `, each with its
 * read-only suffix such as `/home/u/plugin/opencode:ro`.
 */
export function listsMounts(stdout: string, name: string, mounts: readonly string[]): boolean {
  return stdout.split("\n").some((line) => {
    if (!line.trim().split(/\s+/).includes(name)) return false;
    return mounts.every((mount) => line.includes(mount));
  });
}

/**
 * Whether the stdout of `git remote` in the project root lists the remote
 * `sandbox-<name>` that `sbx` adds for a sandbox in clone mode. Pure, so the
 * tests use it directly.
 */
export function listsCloneRemote(stdout: string, name: string): boolean {
  return stdout.split("\n").some((line) => line.trim() === `sandbox-${name}`);
}

/**
 * The fix text for a sandbox that must be recreated: missing mounts, a
 * missing clone mode, or a missing clone. `sbx rm` asks for a confirmation
 * and fails without a terminal, so the text names `--force`. The removal
 * ends the sessions of the sandbox.
 */
export function sandboxRecreateFix(name: string): string {
  return `Remove it with: sbx rm --force ${name}, then run oc-sub up. It creates the sandbox again in clone mode with all required mounts.`;
}

/**
 * The command that proves the clone exists inside the sandbox:
 * `git -C ROOT rev-parse --git-dir` must succeed there. A create with a
 * mount inside the project root exits 0 but leaves no clone
 * (RUN_ISOLATION.md section 9).
 */
export function cloneCheckCommand(bin: string, name: string, root: string): string[] {
  return [bin, "exec", name, "git", "-C", root, "rev-parse", "--git-dir"];
}

/**
 * Whether the sandbox holds a git clone at the project root. `up` and the
 * `sandbox-mounts` check of `doctor` both call it, so the two never differ.
 */
export function hasClone(runner: Runner, bin: string, name: string, root: string): boolean {
  return runner(cloneCheckCommand(bin, name, root)).exitCode === 0;
}

/** The error message for a sandbox without a clone at the project root. */
export function missingCloneMessage(name: string, root: string): string {
  return `the sandbox ${name} has no git clone at ${root} (git -C ${root} rev-parse --git-dir fails inside it)`;
}

/**
 * Whether the first line of `sbx policy check network` denies the target,
 * as in `Denied: host.docker.internal:8767`.
 */
export function deniesNetwork(stdout: string): boolean {
  const first = stdout.split("\n")[0] ?? "";
  return first.startsWith("Denied");
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

/** Whether `dir` is the folder `root` itself or lies inside it. */
export function isInsideRoot(dir: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(dir));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/**
 * Which of the extra folders of a project sandbox `sbx create --clone` gets
 * as read-only mounts, and which it leaves out because they lie inside the
 * project root (or are equal to it). Pure: `upSandbox`, the mount check of
 * `up`, and the `sandbox-mounts` check of `doctor` all use it, so they
 * never differ.
 *
 * A mount inside the project root stops the clone silently: `sbx create`
 * exits 0, but the sandbox then holds only the mount point at the root and
 * no clone (RUN_ISOLATION.md section 9). This hits the plugin repository
 * itself (the plugin folder `<root>/opencode`) and the project `meta` (the
 * shared agents folder `<root>/agents`). The clone holds the tracked files
 * of such a folder at the same absolute path, so the paths in the
 * configuration still work.
 *
 * Known gap: for a folder in `inClone`, the sandbox uses the committed copy
 * in the clone, not the live host folder. A change on the host reaches the
 * sandbox only after a commit and a new clone, and untracked files of that
 * folder are missing.
 */
export function sandboxMountPlan(
  root: string,
  pluginDir: string,
  installsDir: string,
  sharedDir: string,
): { mounted: string[]; inClone: string[] } {
  const mounted: string[] = [];
  const inClone: string[] = [];
  for (const dir of [pluginDir, installsDir, sharedDir]) {
    (isInsideRoot(dir, root) ? inClone : mounted).push(dir);
  }
  return { mounted, inClone };
}

/**
 * The mounts that a project sandbox must have, in the `WORKSPACE` column form
 * of `sbx ls`: the `mounted` folders of `sandboxMountPlan`, each with `:ro`.
 * `upSandbox` and the health check of step 13 use the same list, so the two
 * never differ.
 */
export function requiredSandboxMounts(root: string, pluginDir: string, installsDir: string, sharedDir: string): string[] {
  return sandboxMountPlan(root, pluginDir, installsDir, sharedDir).mounted.map((dir) => `${dir}:ro`);
}

function printUp(serveUrl: string, name: string, logPath: string, version: string): void {
  console.log(`${serveUrl} version ${version}`);
  console.log(`sandbox: ${name}`);
  console.log(`log: ${logPath}`);
}

/**
 * `oc-sub up` in sandbox mode: make sure an opencode server in the project sandbox
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
  // The shared rules and skills are the only source of the global agent
  // files. Without them, every session in the sandbox would silently lose
  // the global rules, so up stops before anything changes state.
  const sharedDir = sharedAgentsDir(env);
  const sharedFile = path.join(sharedDir, "AGENTS.md");
  if (!deps.fileExists(sharedFile)) {
    console.error(`error: the shared agents file ${sharedFile} does not exist.`);
    console.error("Create it, or set OC_SUB_SHARED_DIR to the folder that holds AGENTS.md.");
    return 1;
  }
  if (!deps.binExists(bin)) {
    console.error(`error: the sbx binary "${bin}" is not on the PATH (set SBX_BIN to its location).`);
    console.error("To start a host server instead, run: oc-sub up --no-sandbox");
    return 1;
  }

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

  // The tools of the project come from the mise of the host. The install
  // runs first, so that every tool of `mise.toml` exists. Then `mise env`
  // gives the tool folders of the project, and the holder command puts them
  // at the start of the sandbox PATH. mise itself is not needed inside.
  const mise = miseBin(env);
  const install = deps.runner([mise, "install"], { cwd: root });
  if (install.exitCode !== 0) {
    console.error(`error: mise install failed in ${root}`);
    return 1;
  }
  const installsDir = miseInstallsDir(env);
  const toolPath = projectToolPath(deps.runner([mise, "env", "-C", root, "--json"], { cwd: root }).stdout, installsDir);

  // `sbx create` accepts read-only mounts only with relative paths, so the
  // working directory is `/` and all mounts are relative from there. The
  // plugin folder keeps its host path, the mise installs folder makes
  // the host tools of the project available unchanged inside the sandbox,
  // and the shared agents folder keeps its host path, so the absolute
  // paths in `OPENCODE_CONFIG_CONTENT` reach the same files.
  // A folder inside the project root gets no mount, because such a mount
  // stops the clone silently; the clone holds its tracked files at the same
  // path instead (see `sandboxMountPlan` for the known gap).
  const plan = sandboxMountPlan(root, PLUGIN_CONFIG_DIR, installsDir, sharedDir);
  const createMounts = plan.mounted.map((dir) => `${relativeMount("/", dir)}:ro`);

  const lsStdout = deps.runner([bin, "ls"]).stdout;
  if (!listsName(lsStdout, name)) {
    // `--clone` is a create-time flag: the sandbox gets a private
    // in-container clone of the repository, the host repo stays read-only at
    // `/run/sandbox/source`, and `sbx` adds a `sandbox-<name>` remote to the
    // host repository for the review fetch (RUN_ISOLATION.md section 2.4).
    // The create must run from the main checkout, because clone mode is
    // rejected inside a worktree; `root` is `projectRoot`, so it already is.
    // The create runs with the working directory `/`, because `sbx` accepts
    // read-only mounts only with relative paths (see above).
    const create = deps.runner(
      [bin, "create", "--clone", "--name", name, "opencode", root, ...createMounts],
      { cwd: "/" },
    );
    if (create.exitCode !== 0) {
      console.error(`error: sbx create failed for ${name}`);
      return 1;
    }
    for (const dir of plan.inClone) {
      console.log(`note: ${dir} lies inside the project root, so the sandbox uses its committed copy in the clone`);
    }
    // The network rules go onto a new sandbox: GET and HEAD to every host,
    // but never to the host server or the private networks. Research needs
    // to read any page; data can still leave in a GET URL. The proxy of
    // `sbx` rewrites `host.docker.internal` to `localhost`, so a deny rule
    // for `host.docker.internal` alone is not enough. The websearch of
    // opencode calls Exa with POST, so Exa gets every method.
    const allow = deps.runner([bin, "policy", "allow", "network", "--sandbox", name, "**", "--method", "GET,HEAD"]);
    if (allow.exitCode !== 0) {
      console.error(`error: sbx policy allow network failed for ${name}`);
      return 1;
    }
    const allowExa = deps.runner([bin, "policy", "allow", "network", "--sandbox", name, EXA_HOST]);
    if (allowExa.exitCode !== 0) {
      console.error(`error: sbx policy allow network for ${EXA_HOST} failed for ${name}`);
      return 1;
    }
    const deny = deps.runner([bin, "policy", "deny", "network", "--sandbox", name, NETWORK_DENY_HOSTS.join(",")]);
    if (deny.exitCode !== 0) {
      console.error(`error: sbx policy deny network failed for ${name}`);
      return 1;
    }
  } else if (!listsMounts(lsStdout, name, requiredSandboxMounts(root, PLUGIN_CONFIG_DIR, installsDir, sharedDir))) {
    // The sandbox holds the sessions, so oc-sub does not remove it itself.
    console.error(`error: the sandbox ${name} lacks the plugin, the mise installs, or the shared agents mount`);
    console.error(sandboxRecreateFix(name));
    return 1;
  } else if (!listsCloneRemote(deps.runner(["git", "-C", root, "remote"]).stdout, name)) {
    // Clone mode is also a create-time flag: an old direct-mount sandbox
    // cannot be converted, so it must be recreated. Without the
    // `sandbox-<name>` remote the review could not fetch the commits of the
    // agent from the clone.
    console.error(`error: the sandbox ${name} is not in clone mode (the project has no sandbox-<name> git remote)`);
    console.error(sandboxRecreateFix(name));
    return 1;
  }

  // After the create, and on every up of an existing sandbox: the clone must
  // exist at the project root. `sbx create --clone` can exit 0 and still
  // leave no clone (RUN_ISOLATION.md section 9), and every run worktree
  // lives in that clone.
  if (!hasClone(deps.runner, bin, name, root)) {
    console.error(`error: ${missingCloneMessage(name, root)}`);
    console.error(sandboxRecreateFix(name));
    return 1;
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

  // An old sandbox without the deny rules may still reach the host server
  // and the LAN. The check runs on every up, before a server starts.
  for (const target of ["host.docker.internal:8767", "localhost:8767"]) {
    const check = deps.runner([bin, "policy", "check", "network", "--sandbox", name, target]);
    if (!deniesNetwork(check.stdout)) {
      console.error(`error: the sandbox ${name} may reach ${target}`);
      console.error(
        `Deny it with: sbx policy deny network --sandbox ${name} "${NETWORK_DENY_HOSTS.join(",")}"`,
      );
      return 1;
    }
  }

  // The shared rules must be readable inside the sandbox before a server
  // uses them. A missing mount would otherwise drop the global rules again.
  const readable = deps.runner([bin, "exec", name, "test", "-r", sharedFile]);
  if (readable.exitCode !== 0) {
    console.error(`error: the sandbox ${name} cannot read the shared agents file ${sharedFile}`);
    console.error(`Remove it with: sbx rm --force ${name}`);
    console.error("Then run oc-sub up. It creates the sandbox again with the shared mount.");
    return 1;
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
  // replaces the bash rules of the sandbox agents with `allow` and allows
  // paths outside the project (the sandbox has no host files anyway), and
  // an empty `SSH_AUTH_SOCK` hides the SSH agent of the host from the
  // commands of the agent.
  const holder = deps.spawnServe(
    [
      bin,
      "exec",
      "-e",
      `OPENCODE_CONFIG_DIR=${PLUGIN_CONFIG_DIR}`,
      "-e",
      `OPENCODE_CONFIG_CONTENT=${sandboxConfigContent(sharedDir)}`,
      "-e",
      "SSH_AUTH_SOCK=",
      "-e",
      // opencode offers the websearch tool only when this is truthy. The
      // researcher reads pages with it; Exa needs no key and no cost.
      "OPENCODE_ENABLE_EXA=1",
      "-e",
      // The tool folders of the project come first, so that the versions of
      // `mise.toml` win over the tools of the sandbox image.
      sandboxToolPathEntry(toolPath),
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
 * `oc-sub down` in sandbox mode: stop the sandbox of the project. It keeps the
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
    console.error(`error: no sandbox state for project ${project}. Run oc-sub up first.`);
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

  // `sbx stop` keeps the clone and the sandbox. After a restart, the git
  // daemon of clone mode publishes a new ephemeral port; the `sbx` CLI
  // updates the `sandbox-<name>` remote URL itself
  // (docs/research/RUN_ISOLATION.md section 2.4).
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
