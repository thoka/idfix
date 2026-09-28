/** `oc-sub up`: make sure an opencode server answers, start one if needed. */
import { openSync, closeSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { resolveTarget, type Env } from "./config";
import { assertUsable, probeServer } from "./client";
import { removeFiles, serveDirsPath, serveLogPath, servePidPath } from "./state";

const HEALTH_TIMEOUT_MS = 60_000;
const HEALTH_INTERVAL_MS = 300;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The config directory of this plugin: `opencode/` next to `src/`. It holds
 * the research agents in `agents/`. Computed from this source file, not from
 * the working directory, so it stays correct when `up` runs in any project.
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
 */
export function serveEnv(env: Env, pluginConfigDir: string = PLUGIN_CONFIG_DIR): { env: Env; warning?: string } {
  const current = env.OPENCODE_CONFIG_DIR;
  if (current !== undefined && current.trim().length > 0) {
    // A relative path or a trailing slash still names the same folder.
    const same = path.resolve(current) === path.resolve(pluginConfigDir);
    return {
      env: { ...env },
      warning: same
        ? undefined
        : `OPENCODE_CONFIG_DIR is already set to ${current}. The research agents of the plugin are not loaded.`,
    };
  }
  return { env: { ...env, OPENCODE_CONFIG_DIR: pluginConfigDir } };
}

export async function up(args: { url?: string; port?: number }, env: Env = process.env): Promise<number> {
  const target = resolveTarget(args.url, args.port, env);
  const targetUrl = target.url;
  const existing = await probeServer(targetUrl, env);
  if (existing.state === "up") {
    console.log(`${targetUrl} version ${existing.version}`);
    return 0;
  }
  // A server that refused the credentials still runs: do not start another.
  if (existing.state === "unauthorized") assertUsable(existing, targetUrl, env);

  const serve = serveEnv(env);
  if (serve.warning !== undefined) console.error(`warning: ${serve.warning}`);

  const port = target.port;
  const serveUrl = `http://127.0.0.1:${port}`;
  const logPath = serveLogPath(env, port);
  const pidPath = servePidPath(env, port);

  await mkdir(path.dirname(logPath), { recursive: true });
  // A new server has no runs yet. A list left by a crashed server is stale.
  await removeFiles(serveDirsPath(env, port));
  // The server keeps running after this process exits, so its output goes to
  // a file: fd numbers are inherited by the child and closed here again.
  const logFd = openSync(logPath, "w");
  let proc: Bun.Subprocess;
  try {
    proc = Bun.spawn({
      cmd: ["opencode", "serve", "--port", String(port), "--hostname", "127.0.0.1"],
      cwd: process.cwd(),
      env: { ...serve.env },
      stdin: "ignore",
      stdout: logFd,
      stderr: logFd,
      detached: true,
    });
  } catch (error) {
    closeSync(logFd);
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`error: cannot start "opencode serve": ${reason} (is opencode on PATH?)`);
    return 1;
  }
  proc.unref();
  await Bun.write(pidPath, `${proc.pid}\n`);

  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(HEALTH_INTERVAL_MS);
    // Short per-attempt timeout: one hung fetch must not eat the deadline.
    const health = await probeServer(serveUrl, env, 2000);
    if (health.state === "up") {
      console.log(`${serveUrl} version ${health.version}`);
      console.log(`log: ${logPath}`);
      return 0;
    }
    if (proc.exitCode !== null) {
      console.error(`error: opencode serve exited with code ${proc.exitCode}, see ${logPath}`);
      return 1;
    }
  }
  console.error(`error: opencode serve did not become healthy on ${serveUrl} within ${HEALTH_TIMEOUT_MS / 1000}s, see ${logPath}`);
  return 1;
}
