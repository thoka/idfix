/**
 * Sandbox mode: run `opencode serve` inside a Docker Sandbox (`sbx`) per
 * project, instead of on the host. See `.plan/research/sandbox.md` and the
 * sandbox design in the plan. Every `sbx` call goes through a
 * runner, so the tests replace it with a fake and never call the real `sbx`.
 */
import { accessSync, constants as fsConstants, existsSync, openSync, closeSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import type { Env } from "./config";
import type { ServerState } from "./client";
import type { CheckResult } from "./doctor";
// The busy check and the holder stop reuse the helpers of `down`.
import { busySessions, formatBusyLine, isAlive, signalGroup, stopGroup } from "./down";
import { assertUsable, probeServer } from "./client";
import { resolveServerUrl } from "./config";
import { DEEPINFRA_HOST, DEEPINFRA_PLACEHOLDER, deepinfraKeyPath, gitCommonDir, PLACEHOLDER_KEY, projectKeyPath, projectNameOfRun } from "./keys";
import { stateDir, serveDirsPath, serveLogPath, servePidPath, servePluginPath, readPid, readDirs, removeFiles, appendLogMarker, readLogTail } from "./state";
import { sharedAgentsDir, sharedConfigEntries } from "./shared";
import { PLUGIN_CONFIG_DIR } from "./up";
import { pluginDataDir, proxyBundleIn, syncPluginDir } from "./plugin-sync";

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

/**
 * The DeepInfra API with its port, for the network allow rule of a sandbox
 * with DeepInfra. The sandbox allows only GET and HEAD to every host, and the
 * model calls are POST requests. The host is public, so the deny list never
 * matches it.
 */
export const DEEPINFRA_NETWORK_HOST = `${DEEPINFRA_HOST}:443`;

const HEALTH_TIMEOUT_MS = 60_000;
const HEALTH_INTERVAL_MS = 300;

/** The port inside the sandbox that `opencode serve` listens on. */
const SERVE_PORT = 4096;

/** The port inside the sandbox that the cost proxy listens on. */
export const SANDBOX_PROXY_PORT = 4097;

/** The base URL that points the openrouter provider of opencode at the proxy. */
export function proxyBaseUrl(port: number): string {
  return `http://127.0.0.1:${port}/v1`;
}

/**
 * The base URL that points the deepinfra provider of opencode at the proxy.
 * The SDK `@ai-sdk/deepinfra` appends `/openai/chat/completions` to its base
 * URL (default `https://api.deepinfra.com/v1`), so the base ends in `/v1`,
 * not in `/v1/openai`. The proxy removes the `/deepinfra` prefix.
 */
export function deepinfraProxyBaseUrl(port: number): string {
  return `http://127.0.0.1:${port}/deepinfra/v1`;
}

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
 *
 * With `proxyUrl`, it also points the openrouter provider at the cost
 * proxy that runs next to the server in the sandbox. With
 * `deepinfraProxyUrl`, it points the deepinfra provider at the same proxy.
 */
export function sandboxConfigContent(sharedDir: string, proxyUrl?: string, deepinfraProxyUrl?: string): string {
  const agents: Record<string, { permission: { bash: string; external_directory: string } }> = {};
  for (const agent of SANDBOX_BASH_AGENTS) {
    agents[agent] = { permission: { bash: "allow", external_directory: "allow" } };
  }
  // The kit of `sbx` adds an MCP gateway to the opencode configuration of
  // the sandbox. An agent could call its tools, so the sandbox turns it off.
  // The shared rules and skills load through the absolute paths, because the
  // `OPENCODE_CONFIG_DIR` of the sandbox drops the global AGENTS.md (see
  // .plan/research/opencode-rules.md).
  return JSON.stringify({
    agent: agents,
    mcp: { "mcp-gateway": { enabled: false } },
    ...providerEntries(proxyUrl, deepinfraProxyUrl),
    ...sharedConfigEntries(sharedDir),
  });
}

/**
 * The `provider` entry of `OPENCODE_CONFIG_CONTENT` that points the providers
 * at the cost proxy, or an empty object without any proxy URL. Both server
 * modes use it.
 */
export function providerEntries(
  proxyUrl?: string,
  deepinfraProxyUrl?: string,
): { provider?: Record<string, { options: { baseURL: string } }> } {
  const provider: Record<string, { options: { baseURL: string } }> = {};
  if (proxyUrl !== undefined) provider.openrouter = { options: { baseURL: proxyUrl } };
  if (deepinfraProxyUrl !== undefined) provider.deepinfra = { options: { baseURL: deepinfraProxyUrl } };
  return Object.keys(provider).length === 0 ? {} : { provider };
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

/**
 * The result of one `sbx` call. `stderr` is optional, so a fake runner in a
 * test may leave it out.
 */
export type RunnerResult = { stdout: string; exitCode: number; stderr?: string };

/** A runner for the `sbx` binary. The tests replace it with a fake. */
export type Runner = (cmd: readonly string[], opts?: { cwd?: string }) => RunnerResult;

/** The real runner: one synchronous subprocess per call. */
export const defaultRunner: Runner = (cmd, opts = {}) => {
  const proc = Bun.spawnSync([...cmd], { stdout: "pipe", stderr: "pipe", cwd: opts.cwd });
  return { stdout: proc.stdout.toString(), exitCode: proc.exitCode ?? 1, stderr: proc.stderr.toString() };
};

/**
 * Print the stderr of a failed call, indented, so that the cause of the
 * failure is visible. An empty stderr prints nothing.
 */
export function printStderr(res: RunnerResult, print: (line: string) => void = console.error): void {
  const text = (res.stderr ?? "").trim();
  if (text.length === 0) return;
  for (const line of text.split("\n")) print(`  ${line}`);
}

/** The KVM device. `sbx` runs every sandbox as a microVM and needs it. */
export const KVM_DEVICE = "/dev/kvm";

/**
 * The plain root fix of the `kvm-access` check. Mode 0666 works at once,
 * without a new login for a group membership. It lasts only until WSL
 * creates /dev/kvm again (the next WSL restart); a permanent fix is a task
 * of the machine setup (for example a udev rule or the WSL boot command).
 */
export const KVM_CHMOD_COMMAND = ["chmod", "0666", KVM_DEVICE] as const;

/** The fix text of the `kvm-access` check. */
export const KVM_FIX = `run oc-sub doctor --fix-as-root, or: sudo ${KVM_CHMOD_COMMAND.join(" ")} (it lasts until the next WSL restart)`;

/** The metadata of /dev/kvm that the check names in its message. */
export type KvmStat = { mode: number; uid: number; gid: number };

/** What the `kvm-access` check reaches outside this module. */
export type KvmDeps = {
  /** The platform, as in `process.platform`. */
  platform: string;
  /** The metadata of a path, or null when it does not exist. */
  statDevice: (file: string) => KvmStat | null;
  /** Whether the current process can read and write the path. */
  canReadWrite: (file: string) => boolean;
};

/** The real dependencies of the `kvm-access` check. */
export const defaultKvmDeps: KvmDeps = {
  platform: process.platform,
  statDevice: (file) => {
    try {
      const info = statSync(file);
      return { mode: info.mode, uid: info.uid, gid: info.gid };
    } catch {
      return null;
    }
  },
  canReadWrite: (file) => {
    try {
      accessSync(file, fsConstants.R_OK | fsConstants.W_OK);
      return true;
    } catch {
      return false;
    }
  },
};

/**
 * The `kvm-access` check: the current process can read and write /dev/kvm.
 * `oc-sub doctor` runs it as a slow check, and `upSandbox` runs it before
 * its first `sbx` call. Without the access, `sbx create` and the start of a
 * sandbox fail with an error that does not name the cause.
 */
export function kvmAccessCheck(deps: KvmDeps = defaultKvmDeps): CheckResult {
  const name = "kvm-access";
  if (deps.platform !== "linux") {
    return { name, status: "skip", message: `not on Linux (${deps.platform})` };
  }
  const info = deps.statDevice(KVM_DEVICE);
  if (info === null) {
    return {
      name,
      status: "fail",
      message: `${KVM_DEVICE} does not exist; sbx needs KVM`,
      fix: "turn on KVM (on WSL: nestedVirtualization=true in .wslconfig), then restart the machine or WSL",
    };
  }
  if (!deps.canReadWrite(KVM_DEVICE)) {
    const mode = (info.mode & 0o7777).toString(8).padStart(4, "0");
    return {
      name,
      status: "fail",
      message: `the current user cannot read and write ${KVM_DEVICE} (mode ${mode}, owner uid ${info.uid}, group gid ${info.gid}); sbx cannot start a sandbox`,
      fix: KVM_FIX,
    };
  }
  return { name, status: "pass", message: `the current user can read and write ${KVM_DEVICE}` };
}

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

/** The home of the sandbox user; `SANDBOX_PATH` already hardcodes it. */
export const SANDBOX_HOME = "/home/agent";

/**
 * The PATH entry that puts the tool folders of the project in front of the
 * sandbox PATH. `upSandbox` (the holder command) and `worktree` (the setup
 * command) use it, so both find the mise tools of the project.
 *
 * `miseBinDir` is optional: the bin folder of the sandbox mise. It
 * sits after the tool folders of the project and before the sandbox PATH, so
 * a version of the project `mise.toml` wins over the sandbox mise, and the
 * sandbox mise wins over a tool of the sandbox image.
 */
export function sandboxToolPathEntry(toolPath: string, miseBinDir?: string): string {
  const start = toolPath ? `${toolPath}:` : "";
  const miseDir = miseBinDir ? `${miseBinDir}:` : "";
  return `PATH=${start}${miseDir}${SANDBOX_PATH}`;
}

/**
 * The name of mise in the mise tool registry. A plain `mise install
 * mise@<version>` fails ("mise not found in mise tool registry"); the tool
 * comes from the aqua backend.
 */
export const MISE_TOOL = "aqua:jdx/mise";

/**
 * The first version-looking token of the output of `mise --version`, for
 * example `2026.10.1` from `2026.10.1 linux-x64`. Null when the output holds
 * no such token, so that a warning or a git hash alone never installs mise.
 */
export function parseMiseVersion(stdout: string): string | null {
  for (const token of stdout.trim().split(/\s+/)) {
    if (/^v?\d+[\w.-]*$/.test(token)) return token.replace(/^v/, "");
  }
  return null;
}

/**
 * The first non-empty line of the output of `mise bin-paths <tool>@<version>`,
 * for example `<installs>/aqua-jdx-mise/<version>/mise/bin`. Null when the
 * output holds no path. Pure.
 */
export function parseBinPaths(stdout: string): string | null {
  const line = stdout
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return line ?? null;
}

/**
 * The extra `-e` entries of the holder command that give the sandbox mise
 * its settings: the read-only shared installs of the host, trust
 * for the `mise.toml` of the project (and, with the shared trust folder
 * semantics of mise, of its worktrees), and writable state folders in the
 * home of the sandbox user, so mise never writes to the read-only mount.
 * The defaults of mise already point to the home, but an explicit value
 * wins over any inherited host value. mise trusts every config file under
 * a trusted path, so the `mise.toml` of the project root also covers the
 * `mise.toml` of each worktree of the project. `MISE_EXPERIMENTAL` is not
 * needed: `shared_install_dirs` works without it (tested live, see
 * .plan/research/sandbox-mise.md).
 */
export function sandboxMiseEnv(installsDir: string, projectRoot: string): string[] {
  const homeData = `${SANDBOX_HOME}/.local/share/mise`;
  return [
    `MISE_SHARED_INSTALL_DIRS=${installsDir}`,
    `MISE_TRUSTED_CONFIG_PATHS=${projectRoot}`,
    `MISE_DATA_DIR=${homeData}`,
    `MISE_CACHE_DIR=${SANDBOX_HOME}/.cache/mise`,
    `MISE_STATE_DIR=${SANDBOX_HOME}/.local/state/mise`,
    // The sandbox mise sits on a read-only mount, so `mise self-update`
    // cannot run. The env form of the mise setting `disable_update_warning`
    // turns off the "mise version ... available" warning and its hint to run
    // `mise self-update` (tested live with mise 2026.9.9).
    "MISE_DISABLE_UPDATE_WARNING=true",
  ];
}

/**
 * The bin folder of the sandbox mise, or undefined without one. It asks the
 * host mise for its version, installs that exact version as the tool
 * `aqua:jdx/mise` in the shared installs folder (which the sandbox mounts
 * read-only), and takes the bin folder from `mise bin-paths`. The bin folder
 * must lie inside the installs folder. On any failure it prints a warning
 * and returns undefined, so mise inside the sandbox stays a comfort, not a
 * must. `upSandbox` and `worktree` both use it, so they never
 * differ.
 */
export function sandboxMiseBinDir(runner: Runner, env: Env, root: string): string | undefined {
  const mise = miseBin(env);
  const installsDir = miseInstallsDir(env);
  const version = parseMiseVersion(runner([mise, "--version"]).stdout);
  if (version === null) {
    console.error(`warning: cannot read the version of "${mise}" with mise --version, the sandbox gets no mise`);
    return undefined;
  }
  const miseInstall = runner([mise, "install", `${MISE_TOOL}@${version}`], { cwd: root });
  if (miseInstall.exitCode !== 0) {
    console.error(`warning: mise install ${MISE_TOOL}@${version} failed, the sandbox gets no mise`);
    printStderr(miseInstall);
    return undefined;
  }
  const binDir = parseBinPaths(runner([mise, "bin-paths", `${MISE_TOOL}@${version}`]).stdout);
  if (binDir === null) {
    console.error(`warning: mise bin-paths prints no bin folder for ${MISE_TOOL}@${version}, the sandbox gets no mise`);
    return undefined;
  }
  if (!isInsideRoot(binDir, installsDir)) {
    console.error(
      `warning: the bin folder ${binDir} of ${MISE_TOOL}@${version} lies outside the installs folder ${installsDir}, the sandbox gets no mise`,
    );
    return undefined;
  }
  return binDir;
}

/**
 * The absolute path of a `bun` binary inside the mise installs folder, taken
 * from the tool PATH entries that `projectToolPath` built, in their order.
 * The entry must sit in the installs folder under a `bun` tool folder and end
 * in `/bin`. Pure: no file system access. Null when no entry matches, for
 * example when the project has no bun in its own `mise.toml`.
 */
export function bunBinFromToolPath(toolPath: string, installsDir: string): string | null {
  const prefix = installsDir.endsWith("/") ? installsDir : `${installsDir}/`;
  for (const entry of toolPath.split(":")) {
    if (!entry.startsWith(prefix) || !entry.endsWith("/bin")) continue;
    // The entry shape is `<installs>/bun/<version>/bin`.
    const relative = entry.slice(prefix.length).split("/");
    if (relative[0] === "bun" && relative.length === 3) return `${entry}/bun`;
  }
  return null;
}

/**
 * The newest installed `bun` inside the mise installs folder, as a fallback
 * for a project without bun in its own `mise.toml`: the installs folder is
 * shared across projects, so the bun of the oc-sub `mise.toml` is usually
 * there. Scans `installs/bun/<version>/bin/bun` and picks the last version
 * in lexicographic order. Null when no bun is installed.
 */
export function bunBinFromInstalls(installsDir: string): string | null {
  let versions: string[];
  try {
    versions = readdirSync(path.join(installsDir, "bun"));
  } catch {
    return null;
  }
  const sorted = versions.sort();
  for (let i = sorted.length - 1; i >= 0; i--) {
    const candidate = path.join(installsDir, "bun", sorted[i] as string, "bin", "bun");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * A shell loop that keeps the cost proxy running: when the proxy exits, it
 * starts again after one second, so a crash does not end the model calls of
 * the server (C7 in .plan/research/cost-proxy.md). Every argument is quoted,
 * so no string from the user reaches the shell unquoted.
 *
 * The loop never ends by itself. To stop it, signal its whole process group
 * (the negative PID of the `sh` that `spawnDetached` starts): a signal to the
 * `bun` child alone only restarts it, and a signal to the `sh` alone leaves
 * the child. `oc-sub down` and `stopStartedGroups` in `down.ts` do this.
 */
export function proxyLoopScript(bunBin: string, bundlePath: string, port: number, hostname: string): string {
  return [
    "while :;",
    "do",
    shellQuote(bunBin),
    shellQuote(bundlePath),
    "--port",
    String(port),
    "--hostname",
    shellQuote(hostname),
    ";",
    "sleep 1;",
    "done",
  ].join(" ");
}

/**
 * The holder command script of sandbox mode: the proxy loop in the
 * background, then `exec opencode serve` in the front, so the holder PID
 * stays the server PID that `down` knows. With `noProxy`, the plain serve
 * command of the older steps.
 */
export function sandboxHolderScript(
  bunBin: string,
  bundlePath: string,
  proxyPort: number,
  servePort: number,
): string {
  return `${proxyLoopScript(bunBin, bundlePath, proxyPort, "127.0.0.1")} & exec opencode serve --hostname 0.0.0.0 --port ${servePort}`;
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

/**
 * Spawn a detached process with its output in a log file and a PID file.
 * `detached: true` makes bun call `setsid`, so the process leads a new
 * session and process group, and its PID is the group ID. A caller stops it
 * and all its children with `process.kill(-pid, signal)`.
 */
export function spawnDetached(cmd: readonly string[], logPath: string, pidPath: string): ServeProcess {
  // The process keeps running after this one exits, so its output goes to
  // a file: fd numbers are inherited by the child and closed here again.
  // The file opens in append mode, so the proxy `end` lines of older runs
  // stay in the log and `oc-sub log` of an older run keeps the real cost.
  const logFd = openSync(logPath, "a");
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
  /** The `kvm-access` check of `doctor`; the tests replace it. */
  checkKvm: () => CheckResult;
  healthTimeoutMs: number;
  healthIntervalMs: number;
  /** The plugin folder that `up` syncs from; the default is `PLUGIN_CONFIG_DIR`. */
  pluginSource?: string;
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
  checkKvm: () => kvmAccessCheck(defaultKvmDeps),
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
 * Whether the output of `sbx secret ls --sandbox NAME` lists the DeepInfra
 * custom secret for that scope. `sbx` 0.45.1 prints custom secrets in a
 * separate table under the heading `CUSTOM SECRETS`, with the columns
 * `SCOPE TARGETS ENV`. A row counts when its scope is the sandbox and its
 * target is `api.deepinfra.com`.
 */
export function listsDeepInfraSecret(stdout: string, name: string): boolean {
  return stdout.split("\n").some((line) => {
    const [scope, target] = line.trim().split(/\s+/);
    return scope === name && target === DEEPINFRA_HOST;
  });
}

/**
 * The `sbx` command that stores the DeepInfra key as a custom secret of one
 * sandbox. `sbx` runs `cat` on the host when it needs the value, so the key
 * never enters the sandbox; the sandbox sees only the placeholder.
 */
export function deepinfraSecretCommand(bin: string, name: string, keyPath: string): string[] {
  return [
    bin,
    "secret",
    "set-custom",
    "--sandbox",
    name,
    "--host",
    DEEPINFRA_HOST,
    "--env",
    "DEEPINFRA_API_KEY",
    "--placeholder",
    DEEPINFRA_PLACEHOLDER,
    "--command",
    `cat ${shellQuote(keyPath)}`,
  ];
}

/**
 * Whether the line of `sbx ls` for the sandbox lists all the mounts. The
 * WORKSPACE column lists the mounts separated by `, `, each with its
 * read-only suffix such as `/home/user/plugin/opencode:ro`.
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
 * The mounts of `required` that the line of `sbx ls` for the sandbox lacks,
 * in their order. Pure, so `upSandbox` and `doctor` name the same mounts.
 */
export function missingMounts(stdout: string, name: string, required: readonly string[]): string[] {
  return required.filter((mount) => !listsMounts(stdout, name, [mount]));
}

/**
 * The error message for a sandbox that lacks mounts. When the synced plugin
 * folder is among them, it says why: newer versions moved the plugin mount to that
 * folder, so a sandbox created before has the old plugin mount only.
 */
export function missingMountsMessage(name: string, missing: readonly string[], pluginDir: string): string {
  let message = `the sandbox ${name} lacks the mounts ${missing.join(", ")}`;
  if (missing.includes(`${pluginDir}:ro`)) {
    message += ` (the synced plugin folder ${pluginDir} is the plugin mount of newer oc-sub versions, so an older sandbox needs a recreate)`;
  }
  return message;
}

/**
 * The fix text for a sandbox that must be recreated: missing mounts, a
 * missing clone mode, or a missing clone. `sbx rm` asks for a confirmation
 * and fails without a terminal, so the text names `--force`. The removal
 * ends the sessions of the sandbox.
 */
export function sandboxRecreateFix(name: string): string {
  return `Recreate it with: oc-sub doctor --fix --force. It recreates the sandbox in clone mode with all required mounts. To do it by hand: sbx rm --force ${name}, then oc-sub up.`;
}

/**
 * The format of `git for-each-ref` in the recreate guard: one line per branch
 * with the commit SHA and the full ref name, separated by one space.
 */
export const RECREATE_REF_FORMAT = "%(objectname) %(refname)";

/**
 * Parses the output of `git for-each-ref --format="%(objectname) %(refname)"`.
 * It returns the local branches under `refs/heads/feature/`, in their order,
 * with the branch name without the `refs/heads/` prefix. Pure, so the tests
 * use it directly.
 */
export function parseFeatureBranches(stdout: string): Array<{ sha: string; branch: string }> {
  const found: Array<{ sha: string; branch: string }> = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const space = trimmed.indexOf(" ");
    if (space <= 0) continue;
    const sha = trimmed.slice(0, space);
    const ref = trimmed.slice(space + 1).trim();
    if (!ref.startsWith("refs/heads/feature/")) continue;
    found.push({ sha, branch: ref.slice("refs/heads/".length) });
  }
  return found;
}

/**
 * The host refs that keep the commit of a clone feature branch when the
 * sandbox goes. `sbx rm` removes the `sandbox-<name>` remote on the host,
 * and git then deletes the refs under `refs/remotes/sandbox-<name>/` and
 * `refs/sandboxes/<name>/`, so a commit that only these refs name is lost.
 * It parses the output of `git for-each-ref --contains SHA
 * --format=%(refname)` and drops the two namespaces. Pure, so the tests use
 * it directly.
 */
export function hostRefsKeepingCommit(stdout: string, name: string): string[] {
  const dead = [`refs/remotes/sandbox-${name}/`, `refs/sandboxes/${name}/`];
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((ref) => ref.length > 0 && !dead.some((prefix) => ref.startsWith(prefix)));
}

/**
 * Parses the output of `git worktree list --porcelain`. It returns the paths
 * of the worktrees, in their order. The path starts after `worktree ` and may
 * contain spaces. Pure, so the tests use it directly.
 */
export function parseWorktrees(stdout: string): string[] {
  const found: string[] = [];
  for (const line of stdout.split("\n")) {
    if (line.startsWith("worktree ")) found.push(line.slice("worktree ".length));
  }
  return found;
}

/**
 * Why the `sandbox-mounts` check fails and a recreate would fix it. This is
 * the classifier that the check and its fix both use, so they never disagree.
 * `not-listed` means the check skips: the sandbox is stopped or removed.
 * Null means the sandbox is healthy.
 */
export type SandboxRecreateCase =
  | { reason: "not-listed" }
  | { reason: "missing-mount"; missing: string[] }
  | { reason: "exec-failed"; exitCode: number; stderr: string }
  | { reason: "missing-clone" }
  | { reason: "not-clone-mode" };

/**
 * The recreate case of a project sandbox, or null when it is healthy. It runs
 * the same three probes as the `sandbox-mounts` check: `sbx ls` for the
 * mounts, the clone check, and the `sandbox-<name>` git remote for clone
 * mode. In that order, because the clone check starts a stopped sandbox and
 * the remote check must come after it.
 */
export function sandboxRecreateCase(
  runner: Runner,
  args: { bin: string; name: string; root: string; pluginDir: string; installsDir: string; sharedDir: string },
): SandboxRecreateCase | null {
  const ls = runner([args.bin, "ls"]).stdout;
  if (!listsName(ls, args.name)) return { reason: "not-listed" };
  const missing = missingMounts(ls, args.name, requiredSandboxMounts(args.root, args.pluginDir, args.installsDir, args.sharedDir));
  if (missing.length > 0) return { reason: "missing-mount", missing };
  const clone = cloneStatus(runner, args.bin, args.name, args.root);
  if (clone.state === "exec-failed") return { reason: "exec-failed", exitCode: clone.exitCode, stderr: clone.stderr };
  if (clone.state === "missing") return { reason: "missing-clone" };
  if (!listsCloneRemote(runner(["git", "-C", args.root, "remote"]).stdout, args.name)) return { reason: "not-clone-mode" };
  return null;
}

/** The parts that `recreateSandbox` reaches outside this module. */
export type RecreateDeps = {
  /** Runs the `sbx rm` command. */
  runner: Runner;
  /** Stops the sandbox of a project root, as `oc-sub down` does. */
  downSandbox: (root: string) => Promise<number>;
  /** Creates the sandbox again and starts its server, as `oc-sub up` does. */
  upSandbox: (root: string) => Promise<number>;
};

/** The real recreate dependencies. */
export const defaultRecreateDeps: RecreateDeps = {
  runner: defaultRunner,
  downSandbox: (root) => downSandbox({ dir: root, force: false }),
  upSandbox: (root) => upSandbox({ dir: root }),
};

/**
 * Recreates a project sandbox: `sbx rm --force NAME`, then `oc-sub up`. With
 * `stopServer`, `oc-sub down` runs first, so the proxy and the state files of
 * the server go. The caller has already checked that no session runs (the
 * busy guard), so down runs without `--force` and re-checks it.
 *
 * The prints of down and up go to stderr during the calls, so that
 * `doctor --fix --json` keeps stdout clean for the JSON object.
 */
export async function recreateSandbox(
  name: string,
  root: string,
  stopServer: boolean,
  env: Env = process.env,
  deps: RecreateDeps = defaultRecreateDeps,
): Promise<{ ok: boolean; note: string }> {
  const log = console.log;
  console.log = console.error;
  try {
    if (stopServer) {
      const stopped = await deps.downSandbox(root);
      if (stopped !== 0) return { ok: false, note: `oc-sub down failed with code ${stopped}, the sandbox ${name} is not recreated` };
    }
    const rm = deps.runner([sbxBin(env), "rm", "--force", name]);
    if (rm.exitCode !== 0) return { ok: false, note: `sbx rm --force ${name} exited with code ${rm.exitCode}` };
    const started = await deps.upSandbox(root);
    if (started !== 0) return { ok: false, note: `oc-sub up failed with code ${started}` };
    return { ok: true, note: `recreated the sandbox ${name}: sbx rm --force ${name}, then oc-sub up` };
  } finally {
    console.log = log;
  }
}

/**
 * The command that proves the clone exists inside the sandbox:
 * `git -C ROOT rev-parse --git-dir` must succeed there. A create with a
 * mount inside the project root exits 0 but leaves no clone
 * (run-isolation.md section 9).
 */
export function cloneCheckCommand(bin: string, name: string, root: string): string[] {
  return [bin, "exec", name, "git", "-C", root, "rev-parse", "--git-dir"];
}

/**
 * Whether the sandbox holds a git clone at the project root. `up` and the
 * `sandbox-mounts` check of `doctor` both call it, so the two never differ.
 */
export function hasClone(runner: Runner, bin: string, name: string, root: string): boolean {
  return cloneStatus(runner, bin, name, root).state === "present";
}

/**
 * The exit code of git for "not a git repository" and for a missing `-C`
 * folder. Any other exit code of the clone check means that `sbx exec`
 * itself failed, for example because the sandbox did not start.
 */
const GIT_FATAL_EXIT = 128;

/**
 * The clone check with the cause of a failure: `present`, `missing` (git ran
 * inside the sandbox and found no repository), or `exec-failed` (the
 * `sbx exec` failed, for example because the sandbox did not start), with
 * the stderr of the call.
 */
export function cloneStatus(
  runner: Runner,
  bin: string,
  name: string,
  root: string,
): { state: "present" } | { state: "missing" } | { state: "exec-failed"; exitCode: number; stderr: string } {
  const res = runner(cloneCheckCommand(bin, name, root));
  if (res.exitCode === 0) return { state: "present" };
  if (res.exitCode === GIT_FATAL_EXIT) return { state: "missing" };
  return { state: "exec-failed", exitCode: res.exitCode, stderr: (res.stderr ?? "").trim() };
}

/** The error message for a clone check whose `sbx exec` failed. */
export function execFailedMessage(name: string, exitCode: number, stderr: string): string {
  const cause = stderr.length > 0 ? `: ${stderr}` : " (no stderr)";
  return `sbx exec in the sandbox ${name} failed with code ${exitCode}, the sandbox may not start${cause}`;
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
 * no clone (run-isolation.md section 9). This hits the repository that
 * holds the shared agents folder. The plugin folder is the synced
 * folder of `pluginDataDir`, which lies outside every project
 * root, so it is always mounted. The clone holds the tracked files
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
 * `upSandbox` and the health check use the same list, so the two
 * never differ.
 */
export function requiredSandboxMounts(root: string, pluginDir: string, installsDir: string, sharedDir: string): string[] {
  return sandboxMountPlan(root, pluginDir, installsDir, sharedDir).mounted.map((dir) => `${dir}:ro`);
}

/**
 * Syncs the plugin folder for `upSandbox` and returns the digest, or prints
 * the error and returns null.
 */
function syncPlugin(source: string, pluginDir: string): string | null {
  try {
    return syncPluginDir(source, pluginDir).digest;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`error: cannot sync the plugin folder into ${pluginDir}: ${reason}`);
    return null;
  }
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
  args: { dir?: string; noCostProxy?: boolean },
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
  // `sbx` runs the sandbox as a microVM and needs read and write access to
  // /dev/kvm, both for `sbx create` and for the start of an existing
  // sandbox. Without it, `sbx` fails with an error that does not name the
  // cause, so up stops here, before any `sbx` call.
  const kvm = deps.checkKvm();
  if (kvm.status === "fail") {
    console.error(`error: ${kvm.name}: ${kvm.message}`);
    if (kvm.fix !== undefined) console.error(`fix: ${kvm.fix}`);
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

  // DeepInfra is optional: only a project key file turns it on.
  const deepinfraKey = deepinfraKeyPath(project, env);
  const withDeepInfra = await deps.keyExists(deepinfraKey);

  const statePath = sandboxStatePath(env, project);
  const existing = readSandboxState(statePath);

  // The tools of the project come from the mise of the host. The install
  // runs first, so that every tool of `mise.toml` exists. Then `mise env`
  // gives the tool folders of the project, and the holder command puts them
  // at the start of the sandbox PATH.
  const mise = miseBin(env);
  const install = deps.runner([mise, "install"], { cwd: root });
  if (install.exitCode !== 0) {
    console.error(`error: mise install failed in ${root}`);
    printStderr(install);
    return 1;
  }
  const installsDir = miseInstallsDir(env);
  const toolPath = projectToolPath(deps.runner([mise, "env", "-C", root, "--json"], { cwd: root }).stdout, installsDir);

  // mise inside the sandbox is a comfort, not a must: an agent can
  // run `mise x <tool>@latest -- <cmd>` there and install a tool it needs.
  // See `sandboxMiseBinDir`.
  const miseBinDir = sandboxMiseBinDir(deps.runner, env, root);

  // The cost proxy runs next to the server in the sandbox, from the bundle
  // inside the mounted plugin folder. Its bun comes from the mounted mise
  // installs folder: first the bun of the project tool PATH, then the newest
  // bun installed for any project (the project itself may have no bun in its
  // `mise.toml`). Without any bun, up stops: the proxy is on by default, and
  // `--no-cost-proxy` turns it off for the case that it breaks runs.
  // The server and the proxy load the synced copy of the plugin folder.
  // It lies outside every project root, so it is always mounted.
  const pluginDir = pluginDataDir(env);
  const pluginSource = deps.pluginSource ?? PLUGIN_CONFIG_DIR;
  const bundlePath = proxyBundleIn(pluginDir);
  let bunBin: string | null = null;
  if (!args.noCostProxy) {
    bunBin = bunBinFromToolPath(toolPath, installsDir) ?? bunBinFromInstalls(installsDir);
    if (bunBin === null) {
      console.error(`error: no bun in the mise installs folder ${installsDir}; the cost proxy needs it.`);
      console.error("Install bun (mise use bun), or start without the proxy: oc-sub up --no-cost-proxy.");
      return 1;
    }
  }
  const configContent = sandboxConfigContent(
    sharedDir,
    args.noCostProxy ? undefined : proxyBaseUrl(SANDBOX_PROXY_PORT),
    args.noCostProxy || !withDeepInfra ? undefined : deepinfraProxyBaseUrl(SANDBOX_PROXY_PORT),
  );

  // `sbx create` accepts read-only mounts only with relative paths, so the
  // working directory is `/` and all mounts are relative from there. The
  // plugin folder keeps its host path, the mise installs folder makes
  // the host tools of the project available unchanged inside the sandbox,
  // and the shared agents folder keeps its host path, so the absolute
  // paths in `OPENCODE_CONFIG_CONTENT` reach the same files.
  // A folder inside the project root gets no mount, because such a mount
  // stops the clone silently; the clone holds its tracked files at the same
  // path instead (see `sandboxMountPlan` for the known gap).
  const plan = sandboxMountPlan(root, pluginDir, installsDir, sharedDir);
  const createMounts = plan.mounted.map((dir) => `${relativeMount("/", dir)}:ro`);

  const lsStdout = deps.runner([bin, "ls"]).stdout;
  if (!listsName(lsStdout, name)) {
    // A mount source must exist at create time, so the plugin folder is
    // synced before the create. No server of this sandbox runs yet.
    if (syncPlugin(pluginSource, pluginDir) === null) return 1;
    // `--clone` is a create-time flag: the sandbox gets a private
    // in-container clone of the repository, the host repo stays read-only at
    // `/run/sandbox/source`, and `sbx` adds a `sandbox-<name>` remote to the
    // host repository for the review fetch (run-isolation.md section 2.4).
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
      printStderr(create);
      console.error(`For the cause, run: ${bin} diagnose`);
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
      printStderr(allow);
      return 1;
    }
    const allowExa = deps.runner([bin, "policy", "allow", "network", "--sandbox", name, EXA_HOST]);
    if (allowExa.exitCode !== 0) {
      console.error(`error: sbx policy allow network for ${EXA_HOST} failed for ${name}`);
      printStderr(allowExa);
      return 1;
    }
    const deny = deps.runner([bin, "policy", "deny", "network", "--sandbox", name, NETWORK_DENY_HOSTS.join(",")]);
    if (deny.exitCode !== 0) {
      console.error(`error: sbx policy deny network failed for ${name}`);
      printStderr(deny);
      return 1;
    }
  } else {
    const missing = missingMounts(lsStdout, name, requiredSandboxMounts(root, pluginDir, installsDir, sharedDir));
    if (missing.length > 0) {
      // The sandbox holds the sessions, so oc-sub does not remove it itself.
      console.error(`error: ${missingMountsMessage(name, missing, pluginDir)}`);
      console.error(sandboxRecreateFix(name));
      return 1;
    }
  }

  // After the create, and on every up of an existing sandbox: the clone must
  // exist at the project root. `sbx create --clone` can exit 0 and still
  // leave no clone (run-isolation.md section 9), and every run worktree
  // lives in that clone. This `sbx exec` also starts a stopped sandbox.
  // When the exec itself fails (the sandbox does not start), the cause is in
  // its stderr, and a recreate would not help.
  const clone = cloneStatus(deps.runner, bin, name, root);
  if (clone.state === "exec-failed") {
    console.error(`error: ${execFailedMessage(name, clone.exitCode, clone.stderr)}`);
    console.error(`For the cause, run: ${bin} diagnose`);
    return 1;
  }
  if (clone.state === "missing") {
    console.error(`error: ${missingCloneMessage(name, root)}`);
    console.error(sandboxRecreateFix(name));
    return 1;
  }

  // Clone mode is also a create-time flag: an old direct-mount sandbox
  // cannot be converted, so it must be recreated. Without the
  // `sandbox-<name>` remote the review could not fetch the commits of the
  // agent from the clone. `sbx stop` removes the remote, and the next start
  // of the sandbox adds it again. The `sbx exec` of the clone check above
  // starts a stopped sandbox, so this check must come after it.
  if (!listsCloneRemote(deps.runner(["git", "-C", root, "remote"]).stdout, name)) {
    console.error(`error: the sandbox ${name} is not in clone mode (the project has no sandbox-<name> git remote)`);
    console.error(sandboxRecreateFix(name));
    return 1;
  }

  const secrets = deps.runner([bin, "secret", "ls", "--sandbox", name]).stdout;
  if (!listsOpenRouterSecret(secrets, name)) {
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
      printStderr(set);
      return 1;
    }
  }

  // DeepInfra: the key stays on the host as a custom secret of
  // this sandbox, like the openrouter one. The model calls are POST
  // requests, and the sandbox allows only GET and HEAD to every host, so the
  // DeepInfra API gets its own allow rule. Both run once per sandbox: when
  // the secret is listed, up skips them.
  if (withDeepInfra && !listsDeepInfraSecret(secrets, name)) {
    const allow = deps.runner([bin, "policy", "allow", "network", "--sandbox", name, DEEPINFRA_NETWORK_HOST]);
    if (allow.exitCode !== 0) {
      console.error(`error: sbx policy allow network for ${DEEPINFRA_NETWORK_HOST} failed for ${name}`);
      printStderr(allow);
      return 1;
    }
    const set = deps.runner(deepinfraSecretCommand(bin, name, deepinfraKey));
    if (set.exitCode !== 0) {
      console.error(`error: sbx secret set-custom for DeepInfra failed for ${name}`);
      printStderr(set);
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
    printStderr(placeholder);
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
      printStderr(publish);
      return 1;
    }
  }

  // An old sandbox without the deny rules may still reach the host server
  // and the LAN. The check runs on every up, before a server starts.
  for (const target of ["host.docker.internal:8767", "localhost:8767"]) {
    const check = deps.runner([bin, "policy", "check", "network", "--sandbox", name, target]);
    if (!deniesNetwork(check.stdout)) {
      console.error(`error: the sandbox ${name} may reach ${target}`);
      if (check.exitCode !== 0) printStderr(check);
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
    printStderr(readable);
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

  // The new server gets the current plugin. The mount shows the new content
  // inside the sandbox at once, and the digest goes into the state.
  const synced = syncPlugin(pluginSource, pluginDir);
  if (synced === null) return 1;

  const logPath = serveLogPath(env, port);
  const pidPath = servePidPath(env, port);
  await mkdir(path.dirname(logPath), { recursive: true });
  // A new server has no runs yet. A list left by a crashed server is stale,
  // and so is its plugin digest.
  await removeFiles(serveDirsPath(env, port), servePluginPath(env, port));
  // The holder process keeps the sandbox alive: `sbx` stops a sandbox 30
  // seconds after the last `sbx` session ends. `OPENCODE_CONFIG_CONTENT`
  // replaces the bash rules of the sandbox agents with `allow` and allows
  // paths outside the project (the sandbox has no host files anyway), and
  // an empty `SSH_AUTH_SOCK` hides the SSH agent of the host from the
  // commands of the agent. With the cost proxy (the default), the holder
  // script starts the proxy in a restart loop in the background and execs
  // the server in the front, so the holder PID stays the server PID.
  const holderArgs: string[] = args.noCostProxy
    ? [
        "opencode",
        "serve",
        "--hostname",
        "0.0.0.0",
        "--port",
        String(SERVE_PORT),
      ]
    : ["sh", "-c", sandboxHolderScript(bunBin as string, bundlePath, SANDBOX_PROXY_PORT, SERVE_PORT)];
  // The log keeps the lines of older starts, so this start writes one
  // marker line first: a reader sees where a new start begins.
  await appendLogMarker(logPath, "up");
  const holder = deps.spawnServe(
    [
      bin,
      "exec",
      "-e",
      `OPENCODE_CONFIG_DIR=${pluginDir}`,
      "-e",
      `OPENCODE_CONFIG_CONTENT=${configContent}`,
      "-e",
      "SSH_AUTH_SOCK=",
      "-e",
      // opencode offers the websearch tool only when this is truthy. The
      // researcher reads pages with it; Exa needs no key and no cost.
      "OPENCODE_ENABLE_EXA=1",
      "-e",
      // The tool folders of the project come first, so that the versions of
      // `mise.toml` win over the tools of the sandbox image. The mise of the
      // sandbox (if installed) follows, so it wins over a tool of the image.
      // With `sandboxMiseEnv`, the server runs a mise that sees the host
      // versions read-only, trusts the project `mise.toml`, and installs new
      // tools into its own home.
      sandboxToolPathEntry(toolPath, miseBinDir),
      ...sandboxMiseEnv(installsDir, root).flatMap((entry) => ["-e", entry]),
      // With DeepInfra, the server gets the placeholder; the proxy of `sbx`
      // puts the real key into the requests to the DeepInfra API.
      ...(withDeepInfra ? ["-e", `DEEPINFRA_API_KEY=${DEEPINFRA_PLACEHOLDER}`] : []),
      name,
      ...holderArgs,
    ],
    logPath,
    pidPath,
  );
  writeFileSync(servePluginPath(env, port), `${synced}\n`);

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
      await printLogTail(logPath);
      return 1;
    }
  }
  console.error(
    `error: opencode serve did not become healthy on ${serveUrl} within ${deps.healthTimeoutMs / 1000}s, see ${logPath}`,
  );
  await printLogTail(logPath);
  return 1;
}

/** The output of the newest start, under the error that points to the log. */
async function printLogTail(logPath: string): Promise<void> {
  const lines = await readLogTail(logPath);
  if (lines.length > 0) {
    console.error("output of this start:");
    for (const line of lines) console.error(`  ${line}`);
  }
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
  return stopSandbox(state, args.force, env, deps);
}

/**
 * Whether the output of `sbx ls` lists the sandbox `name` with the STATUS
 * `running`. The columns are `SANDBOX AGENT STATUS PORTS WORKSPACE`.
 */
export function listsRunning(stdout: string, name: string): boolean {
  return stdout.split("\n").some((line) => {
    const [sandbox, , status] = line.trim().split(/\s+/);
    return sandbox === name && status === "running";
  });
}

/**
 * Stops the sandbox of a state file: the busy check (unless `force`), then
 * `sbx stop` and the holder process. The state file stays, so that the port
 * stays the same. `downSandbox` and `downAll` share it.
 */
export async function stopSandbox(
  state: SandboxState,
  force: boolean,
  env: Env = process.env,
  depsOverrides: Partial<SandboxDeps> = {},
): Promise<number> {
  const deps = mergeDeps(depsOverrides);
  const { name, port } = state;
  const serveUrl = `http://127.0.0.1:${port}`;
  const pidPath = servePidPath(env, port);
  const dirsPath = serveDirsPath(env, port);

  const server = force ? null : await deps.probe(serveUrl);
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

  // `sbx stop` keeps the clone and the sandbox, but it removes the
  // `sandbox-<name>` remote from the host repository. The next start of the
  // sandbox adds the remote again, with the new ephemeral port of the git
  // daemon (.plan/research/run-isolation.md section 2.4). `upSandbox`
  // therefore checks the remote only after its first `sbx exec`.
  const stop = deps.runner([sbxBin(env), "stop", name]);
  if (stop.exitCode !== 0) {
    console.error(`error: sbx stop ${name} failed`);
    printStderr(stop);
    return 1;
  }

  const pid = await readPid(pidPath);
  if (pid !== null && isAlive(pid)) {
    // The holder process leads its own process group, like the server of
    // `up`. Signal the group, so that child processes stop, too. `stopGroup`
    // repeats SIGTERM and ends with SIGKILL, like `oc-sub down`.
    if ((await stopGroup(pid, signalGroup)) === "stuck") {
      console.error(`error: the sandbox holder process (PID ${pid}) did not stop, also not after SIGKILL`);
      return 1;
    }
  }
  await removeFiles(pidPath, dirsPath, servePluginPath(env, port));
  console.log(`stopped sandbox ${name} (${serveUrl})`);
  return 0;
}
