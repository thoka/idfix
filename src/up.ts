/** `oc-sub up`: make sure an opencode server answers, start one if needed. */
import { openSync, closeSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { resolvePort, resolveServerUrl, type Env } from "./config";
import { fetchHealth } from "./client";
import { removeFiles, serveDirsPath, serveLogPath, servePidPath } from "./state";

const HEALTH_TIMEOUT_MS = 60_000;
const HEALTH_INTERVAL_MS = 300;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function up(args: { url?: string; port?: number }, env: Env = process.env): Promise<number> {
  const targetUrl = resolveServerUrl(args.url, env);
  const alreadyUp = await fetchHealth(targetUrl, env);
  if (alreadyUp !== null) {
    console.log(`${targetUrl} version ${alreadyUp.version}`);
    return 0;
  }

  const port = resolvePort(args.port, targetUrl);
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
      env: { ...env },
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
    const health = await fetchHealth(serveUrl, env, 2000);
    if (health !== null) {
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
