/** `oc-sub up`: make sure an opencode server answers, start one if needed. */
import { existsSync, openSync, closeSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { resolveTarget, type Env } from "./config";
import { assertUsable, probeServer, type ServerState } from "./client";
import { sharedAgentsFile, sharedConfigEntries, sharedAgentsDir } from "./shared";
import {
  miseInstallsDir,
  bunBinFromInstalls,
  proxyBaseUrl,
  proxyLoopScript,
  spawnDetached,
  type ServeProcess,
} from "./sandbox";
import { removeFiles, proxyLogPath, proxyPidPath, serveDirsPath, serveLogPath, servePidPath, servePluginPath } from "./state";
import { pluginDataDir, proxyBundleIn, syncPluginDir } from "./plugin-sync";

const HEALTH_TIMEOUT_MS = 60_000;
const HEALTH_INTERVAL_MS = 300;

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
 * `pluginDataDir(env)` first, and the server loads that copy (step 15c).
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
 * `OPENCODE_CONFIG_DIR` is set (see docs/research/OPENCODE_RULES.md). So the
 * serve environment also sets `OPENCODE_CONFIG_CONTENT` with the shared rules
 * file in `instructions` and the shared skills folder in `skills.paths`. With
 * `proxyUrl`, it also points the openrouter provider at the cost proxy. An
 * existing `OPENCODE_CONFIG_CONTENT` stays and gives a warning, because the
 * shared entries are then not added.
 *
 * opencode offers the websearch tool to an OpenRouter model only when
 * `OPENCODE_ENABLE_EXA` is truthy. The researcher needs it to read web pages.
 * So the serve environment sets it to `1`, unless the environment already
 * sets it.
 */
export function serveEnv(
  env: Env,
  pluginConfigDir: string = PLUGIN_CONFIG_DIR,
  sharedDir: string = sharedAgentsDir(env),
  opts: { proxyUrl?: string } = {},
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
    const content = sharedConfigEntries(sharedDir);
    withConfigDir.OPENCODE_CONFIG_CONTENT = JSON.stringify(
      opts.proxyUrl !== undefined
        ? { ...content, provider: { openrouter: { options: { baseURL: opts.proxyUrl } } } }
        : content,
    );
  }
  return { env: { ...withConfigDir, ...exa }, warnings };
}

/** Everything that `up` reaches outside this module; the tests replace it. */
export type UpDeps = {
  /** Probes a server URL. */
  probe: (url: string) => Promise<ServerState>;
  /** The absolute bun binary that runs the proxy, or null without one. */
  bunBin: () => string | null;
  /** Starts the detached server process. */
  spawnServe: (cmd: readonly string[], logPath: string, pidPath: string, env: Env) => ServeProcess;
  /** Starts the detached proxy process. */
  spawnProxy: (cmd: readonly string[], logPath: string, pidPath: string) => ServeProcess;
  /** The plugin folder that `up` syncs from; the default is `PLUGIN_CONFIG_DIR`. */
  pluginSource?: string;
};

/** The default dependencies, with the real bun from PATH and real spawns. */
export const defaultUpDeps: UpDeps = {
  probe: (url) => probeServer(url, process.env),
  bunBin: () => Bun.which("bun"),
  spawnServe: (cmd, logPath, pidPath, env) => {
    // The server keeps running after this process exits, so its output goes
    // to a file: fd numbers are inherited by the child and closed here again.
    const logFd = openSync(logPath, "w");
    let proc: Bun.Subprocess;
    try {
      proc = Bun.spawn({
        cmd: [...cmd],
        cwd: process.cwd(),
        env: { ...env },
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
  },
  spawnProxy: spawnDetached,
};

export async function up(
  args: { url?: string; port?: number; noCostProxy?: boolean },
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

  const serve = serveEnv(env, pluginDir, sharedAgentsDir(env), {
    proxyUrl: args.noCostProxy ? undefined : proxyBaseUrl(proxyPort),
  });
  for (const warning of serve.warnings) console.error(`warning: ${warning}`);

  const serveUrl = `http://127.0.0.1:${port}`;
  const logPath = serveLogPath(env, port);
  const pidPath = servePidPath(env, port);

  await mkdir(path.dirname(logPath), { recursive: true });
  // A new server has no runs yet. A list left by a crashed server is stale,
  // and so is its plugin digest.
  await removeFiles(serveDirsPath(env, port), servePluginPath(env, port));

  // The proxy starts first, so that it listens before the first request of
  // the server. Its log and pid live next to the ones of the server.
  if (bunBin !== null) {
    try {
      deps.spawnProxy(
        ["sh", "-c", proxyLoopScript(bunBin, proxyBundleIn(pluginDir), proxyPort, "127.0.0.1")],
        proxyLogPath(env, port),
        proxyPidPath(env, port),
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`warning: cannot start the cost proxy: ${reason}. Model calls will fail until it runs.`);
    }
  }

  let proc: ServeProcess;
  try {
    proc = deps.spawnServe(
      ["opencode", "serve", "--port", String(port), "--hostname", "127.0.0.1"],
      logPath,
      pidPath,
      serve.env,
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`error: cannot start "opencode serve": ${reason} (is opencode on PATH?)`);
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
      return 0;
    }
    if (proc.exitCode() !== null) {
      console.error(`error: opencode serve exited with code ${proc.exitCode()}, see ${logPath}`);
      return 1;
    }
  }
  console.error(`error: opencode serve did not become healthy on ${serveUrl} within ${HEALTH_TIMEOUT_MS / 1000}s, see ${logPath}`);
  return 1;
}

/**
 * The bun for the proxy without a bun on the PATH: the newest bun in the
 * shared mise installs folder, like the sandbox mode finds it. Null without
 * one. `up` prefers `Bun.which("bun")` and uses this only as a fallback.
 */
function fallbackBunBin(env: Env): string | null {
  return bunBinFromInstalls(miseInstallsDir(env));
}
