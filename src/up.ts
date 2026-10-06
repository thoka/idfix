/** `oc-sub up`: make sure an opencode server answers, start one if needed. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { resolveTarget, type Env } from "./config";
import { assertUsable, probeServer, type ServerState } from "./client";
import { SHARED_DIR_HINT, SHARED_DIR_UNSET, sharedAgentsFile, sharedConfigEntries, sharedAgentsDir } from "./shared";
import { deepinfraKeyPath, hostDeepInfraKey, projectNameOf } from "./keys";
import {
  miseInstallsDir,
  bunBinFromInstalls,
  deepinfraProxyBaseUrl,
  providerEntries,
  proxyBaseUrl,
  proxyLoopScript,
  type ServeProcess,
} from "./sandbox";
import { removeFiles, appendLogMarker, readLogTail, proxyLogPath, proxyPidPath, serveDirsPath, serveLogPath, servePidPath, servePluginPath } from "./state";
import { pluginDataDir, proxyBundleIn, syncPluginDir } from "./plugin-sync";
import { DEFAULT_IDLE_MINUTES } from "./args";
import { startIdleWatch, stopIdleWatch, type SpawnIdleWatch } from "./idle";
import { commandLineOf, signalGroup } from "./down";
import {
  defaultUnitDeps,
  portUnitName,
  startUnit,
  stopPortUnits,
  stopUnit,
  UNIT_STOP_TIMEOUT_SEC,
  unitOwner,
  unitsAvailable,
  type UnitDeps,
  type UnitOptions,
} from "./units";

const HEALTH_TIMEOUT_MS = 60_000;
const HEALTH_INTERVAL_MS = 300;
/** The wait between two starts of the cost proxy, like the `sleep 1` of the fallback loop. */
export const PROXY_RESTART_SEC = 1;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The config directory of this plugin: `opencode/` next to `src/`. It holds
 * the research agents in `agents/` and the committed single-file bundle of
 * the cost proxy in `cost-proxy/` (opencode 1.18.32 loads `.js` files only
 * from the direct `plugin(s)/` and `tool(s)/` children of a config
 * directory, so the bundle is neither a plugin nor a tool for opencode).
 * Computed from this source file, not from the working directory, so it
 * stays correct when `up` runs in any project.
 *
 * No server uses this folder directly. `up` syncs it into the fixed folder
 * `pluginDataDir(env)` first, and the server loads that copy.
 */
export const PLUGIN_CONFIG_DIR = path.resolve(import.meta.dir, "..", "opencode");

/**
 * The environment for the `opencode serve` child. Sets `OPENCODE_CONFIG_DIR`
 * to the plugin config directory, so that the server loads the research
 * agents of the plugin for every project. opencode loads that directory after
 * the project `.opencode` directory, so its agents win over project agents
 * with the same name. An existing `OPENCODE_CONFIG_DIR` stays, because it may
 * point to other agent files, and gives a warning. Pure: the input env object
 * is not changed.
 *
 * opencode 1.18.32 drops the global `~/.config/opencode/AGENTS.md` whenever
 * `OPENCODE_CONFIG_DIR` is set (see .plan/research/opencode-rules.md). So the
 * serve environment also sets `OPENCODE_CONFIG_CONTENT` with the shared rules
 * file in `instructions` and the shared skills folder in `skills.paths`. With
 * `proxyUrl`, it also points the openrouter provider at the cost proxy, and
 * with `deepinfraProxyUrl` the deepinfra provider. An existing
 * `OPENCODE_CONFIG_CONTENT` stays and gives a warning, because the shared
 * entries are then not added.
 *
 * With `deepinfraKey`, the serve environment sets `DEEPINFRA_API_KEY`, so the
 * built-in deepinfra provider of opencode has its key.
 *
 * opencode offers the websearch tool to an OpenRouter model only when
 * `OPENCODE_ENABLE_EXA` is truthy. The researcher needs it to read web pages.
 * So the serve environment sets it to `1`, unless the environment already
 * sets it.
 */
export function serveEnv(
  env: Env,
  pluginConfigDir: string = PLUGIN_CONFIG_DIR,
  sharedDir: string | undefined = sharedAgentsDir(env),
  opts: { proxyUrl?: string; deepinfraProxyUrl?: string; deepinfraKey?: string } = {},
): { env: Env; warnings: string[] } {
  const exa = { OPENCODE_ENABLE_EXA: env.OPENCODE_ENABLE_EXA ?? "1" };
  const warnings: string[] = [];
  const withConfigDir = { ...env };
  const current = env.OPENCODE_CONFIG_DIR;
  if (current !== undefined && current.trim().length > 0) {
    // A relative path or a trailing slash still names the same folder.
    if (path.resolve(current) !== path.resolve(pluginConfigDir)) {
      warnings.push(
        `OPENCODE_CONFIG_DIR is already set to ${current}. The research agents of the plugin are not loaded.`,
      );
    }
  } else {
    withConfigDir.OPENCODE_CONFIG_DIR = pluginConfigDir;
  }

  const currentContent = env.OPENCODE_CONFIG_CONTENT;
  if (currentContent !== undefined && currentContent.trim().length > 0) {
    warnings.push(
      "OPENCODE_CONFIG_CONTENT is already set on the host. The shared rules and skills are not added to it.",
    );
  } else {
    // Without a shared folder there are no shared entries. `up` stops
    // before that case, so it only happens in a direct call.
    const content = sharedDir === undefined ? {} : sharedConfigEntries(sharedDir);
    withConfigDir.OPENCODE_CONFIG_CONTENT = JSON.stringify({
      ...content,
      ...providerEntries(opts.proxyUrl, opts.deepinfraProxyUrl),
    });
  }
  if (opts.deepinfraKey !== undefined) withConfigDir.DEEPINFRA_API_KEY = opts.deepinfraKey;
  return { env: { ...withConfigDir, ...exa }, warnings };
}

/**
 * Starts one long-lived process of `up` and gives its PID. The default is
 * `startUnit`: a transient user service `ocsub-<kind>-<port>`, or a detached
 * process without a user manager.
 */
export type StartProcess = (opts: UnitOptions, units: UnitDeps) => ServeProcess;

/** Everything that `up` reaches outside this module; the tests replace it. */
export type UpDeps = {
  /** Probes a server URL. */
  probe: (url: string) => Promise<ServerState>;
  /** The absolute bun binary that runs the proxy, or null without one. */
  bunBin: () => string | null;
  /** Starts the server process. */
  spawnServe: StartProcess;
  /** Starts the proxy process. */
  spawnProxy: StartProcess;
  /** Starts the idle watchdog (`idle.ts`) after a healthy start. */
  spawnIdleWatch: SpawnIdleWatch;
  /** The user manager: whether it answers, and the stop of a unit. */
  units: UnitDeps;
  /** The plugin folder that `up` syncs from; the default is `PLUGIN_CONFIG_DIR`. */
  pluginSource?: string;
  /** The project name of a directory, for the DeepInfra key file and the owner of the units. */
  projectName: (directory: string) => string;
  /** The content of a key file, or null when it is missing. The tests replace it. */
  readKeyFile: (file: string) => string | null;
  /**
   * Signals the process group of a detached process. `up` stops the proxy
   * group with it when the server does not start on the fallback path. The
   * default sends SIGTERM to the negative PID and ignores a group that is
   * already gone.
   */
  killGroup?: (pid: number) => void;
};

function killGroupQuietly(pid: number): void {
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    // The group is already gone.
  }
}

/** The default dependencies, with the real bun from PATH and real units. */
export const defaultUpDeps: UpDeps = {
  probe: (url) => probeServer(url, process.env),
  bunBin: () => Bun.which("bun"),
  // The server keeps running after this process exits. On both paths its
  // output goes to the log in append mode, so the proxy `end` lines of older
  // runs stay in the log and `oc-sub log` of an older run keeps the real cost.
  spawnServe: startUnit,
  spawnProxy: startUnit,
  spawnIdleWatch: startUnit,
  units: defaultUnitDeps,
  projectName: projectNameOf,
  readKeyFile: (file) => {
    try {
      return readFileSync(file, "utf8");
    } catch {
      return null;
    }
  },
};

/**
 * The command of the cost proxy. On the unit path, the plain bun command:
 * the manager starts it again after each end (`Restart=always`, no start
 * limit). On the
 * fallback path, the `sh` loop of `proxyLoopScript` does the restart. Pure.
 */
export function proxyCommand(onUnits: boolean, bunBin: string, bundlePath: string, proxyPort: number): string[] {
  if (onUnits) return [bunBin, bundlePath, "--port", String(proxyPort), "--hostname", "127.0.0.1"];
  return ["sh", "-c", proxyLoopScript(bunBin, bundlePath, proxyPort, "127.0.0.1")];
}

export async function up(
  args: { url?: string; port?: number; noCostProxy?: boolean; idleMinutes?: number },
  env: Env = process.env,
  deps: UpDeps = defaultUpDeps,
): Promise<number> {
  const target = resolveTarget(args.url, args.port, env);
  const targetUrl = target.url;
  const existing = await deps.probe(targetUrl);
  if (existing.state === "up") {
    console.log(`${targetUrl} version ${existing.version}`);
    return 0;
  }
  // A server that refused the credentials still runs: do not start another.
  if (existing.state === "unauthorized") assertUsable(existing, targetUrl, env);

  // The shared rules and skills are the only source of the global agent
  // files. Without them, every session would silently lose the global rules.
  const sharedFile = sharedAgentsFile(env);
  if (sharedFile === undefined) {
    console.error(`error: ${SHARED_DIR_UNSET}`);
    console.error(SHARED_DIR_HINT);
    return 1;
  }
  if (!existsSync(sharedFile)) {
    console.error(`error: the shared agents file ${sharedFile} does not exist.`);
    console.error("Create it, or set OC_SUB_SHARED_DIR to the folder that holds AGENTS.md.");
    return 1;
  }

  // The cost proxy runs next to the server on the port of the server plus
  // one, on 127.0.0.1. Its bun comes from PATH. `--no-cost-proxy` turns the
  // proxy off for the case that it breaks runs.
  const port = target.port;
  const proxyPort = port + 1;
  let bunBin: string | null = null;
  if (!args.noCostProxy) {
    bunBin = deps.bunBin() ?? fallbackBunBin(env);
    if (bunBin === null) {
      console.error("error: no bun on the PATH; the cost proxy needs it.");
      console.error("Install bun (mise use -g bun), or start without the proxy: oc-sub up --no-cost-proxy.");
      return 1;
    }
    if (proxyPort > 65535) {
      console.error(`error: the cost proxy needs the port ${proxyPort}, above the port of the server ${port}.`);
      return 1;
    }
  }

  // The server loads the synced copy of the plugin folder, never the folder
  // of this oc-sub itself. The sync runs right before the start, so the new
  // server gets the current plugin, and its digest goes into the state.
  const pluginDir = pluginDataDir(env);
  let digest: string;
  try {
    digest = syncPluginDir(deps.pluginSource ?? PLUGIN_CONFIG_DIR, pluginDir).digest;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`error: cannot sync the plugin folder into ${pluginDir}: ${reason}`);
    return 1;
  }

  // DeepInfra is optional: `DEEPINFRA_API_KEY` of the environment
  // first, then the DeepInfra key file of the project of the current folder.
  // Without either, nothing changes.
  // The project of the current folder owns the processes of this start, and
  // `OC_SUB_OWNER` overrides the owner of the units, not the key file.
  const project = deps.projectName(process.cwd());
  const owner = unitOwner(env, project);
  const deepinfraKey = hostDeepInfraKey(env, deepinfraKeyPath(project, env), deps.readKeyFile);
  const serve = serveEnv(env, pluginDir, sharedAgentsDir(env), {
    proxyUrl: args.noCostProxy ? undefined : proxyBaseUrl(proxyPort),
    deepinfraProxyUrl: args.noCostProxy || deepinfraKey === undefined ? undefined : deepinfraProxyBaseUrl(proxyPort),
    deepinfraKey,
  });
  for (const warning of serve.warnings) console.error(`warning: ${warning}`);

  const serveUrl = `http://127.0.0.1:${port}`;
  const logPath = serveLogPath(env, port);
  const pidPath = servePidPath(env, port);

  await mkdir(path.dirname(logPath), { recursive: true });
  // A new server has no runs yet. A list left by a crashed server is stale,
  // and so is its plugin digest. A watchdog of a crashed server would end by
  // itself, but stop it now, so that the new server gets one watchdog.
  await removeFiles(serveDirsPath(env, port), servePluginPath(env, port));
  // A unit of a dead or hung server of this port can still be loaded, and
  // `systemd-run` refuses a second unit with the same name. A healthy
  // server returned above, so these units belong to no working server.
  try {
    stopPortUnits(port, ["serve", "proxy"], deps.units);
    await stopIdleWatch(env, port, { commandLineOf, killGroup: signalGroup, units: deps.units });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`error: cannot stop the old units of port ${port}: ${reason}`);
    return 1;
  }
  const onUnits = unitsAvailable(deps.units);
  const unitStop = { timeoutStopSec: UNIT_STOP_TIMEOUT_SEC };

  // The proxy starts first, so that it listens before the first request of
  // the server. Its log and pid live next to the ones of the server. Both
  // logs keep the lines of older starts, so each start writes one marker
  // line first: a reader sees where a new start begins.
  let proxyPid: number | null = null;
  if (bunBin !== null) {
    try {
      await appendLogMarker(proxyLogPath(env, port), "up");
      proxyPid = deps.spawnProxy(
        {
          kind: "proxy",
          name: String(port),
          owner,
          reason: `cost proxy for port ${port}`,
          cmd: proxyCommand(onUnits, bunBin, proxyBundleIn(pluginDir), proxyPort),
          cwd: process.cwd(),
          env,
          logPath: proxyLogPath(env, port),
          pidPath: proxyPidPath(env, port),
          // Like the `sh` loop of the fallback path: a restart after every
          // end, also a clean one, and no start limit.
          ...(onUnits ? { restart: "always" as const, restartSec: PROXY_RESTART_SEC, startLimitIntervalSec: 0 } : {}),
          ...unitStop,
        },
        deps.units,
      ).pid;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`warning: cannot start the cost proxy: ${reason}. Model calls will fail until it runs.`);
    }
  }

  // A failed start must not leave the proxy behind: nothing would stop it,
  // and the next `up` would start a second proxy on the same port. So each
  // error path below stops the proxy unit, or on the fallback path the
  // whole proxy group (loop and bun child). After a restart of the unit,
  // the PID file is stale, so the unit is the only safe handle.
  const stopProxyGroup = async (): Promise<void> => {
    if (proxyPid === null) return;
    if (onUnits) {
      try {
        stopUnit(portUnitName("proxy", port), deps.units);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        console.error(`warning: cannot stop the cost proxy: ${reason}`);
      }
    } else {
      (deps.killGroup ?? killGroupQuietly)(proxyPid);
    }
    await removeFiles(proxyPidPath(env, port));
  };

  let proc: ServeProcess;
  try {
    await appendLogMarker(logPath, "up");
    proc = deps.spawnServe(
      {
        kind: "serve",
        name: String(port),
        owner,
        reason: `opencode server of up on port ${port}`,
        cmd: ["opencode", "serve", "--port", String(port), "--hostname", "127.0.0.1"],
        cwd: process.cwd(),
        env: serve.env,
        logPath,
        pidPath,
        ...unitStop,
      },
      deps.units,
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`error: cannot start "opencode serve": ${reason} (is opencode on PATH?)`);
    await stopProxyGroup();
    return 1;
  }
  writeFileSync(servePluginPath(env, port), `${digest}\n`);

  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(HEALTH_INTERVAL_MS);
    // Short per-attempt timeout: one hung fetch must not eat the deadline.
    const health = await deps.probe(serveUrl);
    if (health.state === "up") {
      console.log(`${serveUrl} version ${health.version}`);
      console.log(`log: ${logPath}`);
      // The watchdog stops the server after the idle limit (`idle.ts`).
      startIdleWatch(env, port, args.idleMinutes ?? DEFAULT_IDLE_MINUTES, deps.spawnIdleWatch, owner, deps.units);
      return 0;
    }
    if (proc.exitCode() !== null) {
      console.error(`error: opencode serve exited with code ${proc.exitCode()}, see ${logPath}`);
      await printLogTail(logPath);
      await stopProxyGroup();
      return 1;
    }
  }
  console.error(`error: opencode serve did not become healthy on ${serveUrl} within ${HEALTH_TIMEOUT_MS / 1000}s, see ${logPath}`);
  await printLogTail(logPath);
  await stopProxyGroup();
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
 * The bun for the proxy without a bun on the PATH: the newest bun in the
 * shared mise installs folder, like the sandbox mode finds it. Null without
 * one. `up` prefers `Bun.which("bun")` and uses this only as a fallback.
 */
function fallbackBunBin(env: Env): string | null {
  return bunBinFromInstalls(miseInstallsDir(env));
}
