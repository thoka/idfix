/**
 * The host cost proxy: one cost proxy per user on the host, as the systemd
 * user service `idfx-proxy.service` on `127.0.0.1:4090` (design
 * `.plan/design/driver-layer.md`, section 2.4). A Claude Code session that
 * runs GLM on the host points `ANTHROPIC_BASE_URL` at it, so its cost lands
 * in one log per user: `<state>/proxy-host.log`.
 *
 * `idfx proxy` runs the proxy in the foreground. The unit runs this command,
 * so systemd keeps it alive. The unit file ships in
 * `contrib/systemd/idfx-proxy.service`; the `host-proxy` check of
 * `idfx doctor` compares the installed copy with it, and `doctor --fix`
 * installs and starts it.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { DEFAULT_HOST_PROXY_PORT } from "./args";
import type { Env } from "./config";
import { IDFIX_ROOT } from "./protocol";
import { DEFAULT_DEEPINFRA_UPSTREAM, DEFAULT_UPSTREAM, LOG_SOURCE, startProxy, type StartProxyOptions } from "./proxy/proxy";
import { hostProxyLogPath, logMarkerLine } from "./state";

/** The port of the host proxy. */
export const HOST_PROXY_PORT = DEFAULT_HOST_PROXY_PORT;
/** The host of the host proxy: loopback only. */
export const HOST_PROXY_HOSTNAME = "127.0.0.1";
/** The name of the systemd user unit, without `.service`. */
export const HOST_PROXY_UNIT = "idfx-proxy";
/** The shipped unit file. */
export const HOST_PROXY_UNIT_SOURCE = path.join(IDFIX_ROOT, "contrib", "systemd", `${HOST_PROXY_UNIT}.service`);

/** The folder of the units of the user: `$XDG_CONFIG_HOME/systemd/user` when absolute, else `~/.config/systemd/user`. Pure. */
export function systemdUserDir(env: Env, home: string = homedir()): string {
  const base =
    env.XDG_CONFIG_HOME !== undefined && path.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.join(home, ".config");
  return path.join(base, "systemd", "user");
}

/** The options of `idfx proxy`. */
export type HostProxyOptions = {
  port: number;
  hostname: string;
  /** The log file; it gets the start marker and one JSON line per event. */
  logFile: string;
  upstream?: string;
  deepinfraUpstream?: string;
  /** Upstream fetch, injectable for tests. */
  fetchImpl?: typeof fetch;
  /** Where the `listening` line goes besides the log. Default: stdout, so the journal shows it. */
  print?: (line: string) => void;
};

/** A started host proxy. */
export type HostProxy = {
  server: Bun.Server<never>;
  /** Stops the proxy. It lets open requests finish, so their `end` lines with the cost reach the log. */
  stop: () => Promise<void>;
};

/**
 * Starts the host proxy in this process: it appends the start marker to the
 * log, starts the proxy with a log function that appends each JSON line to
 * the log, and writes the `listening` line to the log and to `print`.
 */
export function startHostProxy(opts: HostProxyOptions): HostProxy {
  mkdirSync(path.dirname(opts.logFile), { recursive: true });
  appendFileSync(opts.logFile, `${logMarkerLine("proxy")}\n`);
  const append = (line: Record<string, unknown>) => appendFileSync(opts.logFile, `${JSON.stringify(line)}\n`);
  const proxyOptions: StartProxyOptions = {
    port: opts.port,
    hostname: opts.hostname,
    upstream: opts.upstream,
    deepinfraUpstream: opts.deepinfraUpstream,
    log: append,
  };
  if (opts.fetchImpl !== undefined) proxyOptions.fetchImpl = opts.fetchImpl;
  const server = startProxy(proxyOptions);
  const listening = {
    source: LOG_SOURCE,
    event: "listening",
    time: new Date().toISOString(),
    hostname: server.hostname,
    port: server.port,
    upstream: opts.upstream ?? DEFAULT_UPSTREAM,
    deepinfraUpstream: opts.deepinfraUpstream ?? DEFAULT_DEEPINFRA_UPSTREAM,
    log: opts.logFile,
  };
  append(listening);
  (opts.print ?? console.log)(JSON.stringify(listening));
  return { server, stop: () => server.stop() };
}

/**
 * `idfx proxy`: runs the host proxy in the foreground until SIGTERM or
 * SIGINT, then stops it and returns 0. The default log is
 * `<state>/proxy-host.log`.
 */
export async function hostProxyCommand(
  args: { port: number; hostname: string; log?: string; upstream?: string; deepinfraUpstream?: string },
  env: Env = process.env,
): Promise<number> {
  const proxy = startHostProxy({
    port: args.port,
    hostname: args.hostname,
    logFile: args.log ?? hostProxyLogPath(env),
    upstream: args.upstream,
    deepinfraUpstream: args.deepinfraUpstream,
  });
  await new Promise<void>((resolve) => {
    process.once("SIGTERM", () => resolve());
    process.once("SIGINT", () => resolve());
  });
  await proxy.stop();
  return 0;
}

/**
 * Sends `HEAD http://127.0.0.1:<port>/api/hello` with a short timeout. True
 * when any HTTP answer comes back: then something listens and answers HTTP.
 * The proxy answers this probe itself, without an upstream call.
 */
export async function probeHello(port: number, timeoutMs = 1000): Promise<boolean> {
  try {
    await fetch(`http://${HOST_PROXY_HOSTNAME}:${port}/api/hello`, { method: "HEAD", signal: AbortSignal.timeout(timeoutMs) });
    return true;
  } catch {
    return false;
  }
}
