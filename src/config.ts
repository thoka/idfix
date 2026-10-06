/** Server URL and basic-auth resolution. Pure functions, no I/O. */
import { UsageError } from "./args";
import { idfxEnv } from "./env-names";

export const DEFAULT_PORT = 8767;
export const DEFAULT_SERVER_URL = `http://127.0.0.1:${DEFAULT_PORT}`;

export type Env = Record<string, string | undefined>;

/** Resolve the server URL from a CLI flag, `IDFX_URL` (or the old `OC_SUB_URL`), or the default. */
export function resolveServerUrl(flag: string | undefined, env: Env): string {
  const raw = flag ?? idfxEnv(env, "url") ?? DEFAULT_SERVER_URL;
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new Error("server URL is empty");
  }
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  return withScheme.replace(/\/+$/, "");
}

/**
 * HTTP basic-auth header from OPENCODE_SERVER_PASSWORD and
 * OPENCODE_SERVER_USERNAME (default "opencode", as opencode itself does).
 * Returns undefined when no password is set. The secret must never be
 * printed anywhere.
 */
export function authHeaderFromEnv(env: Env): string | undefined {
  const password = env.OPENCODE_SERVER_PASSWORD;
  if (password === undefined || password.length === 0) {
    return undefined;
  }
  const username = env.OPENCODE_SERVER_USERNAME || "opencode";
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

/** The port of a URL, or undefined when it carries none. */
export function portFromUrl(url: string): number | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.port.length === 0) return undefined;
    const port = Number(parsed.port);
    return Number.isInteger(port) && port > 0 ? port : undefined;
  } catch {
    return undefined;
  }
}

/** The server port: the --port flag, else the port of the URL, else the default. */
export function resolvePort(flag: number | undefined, url: string): number {
  return flag ?? portFromUrl(url) ?? DEFAULT_PORT;
}

/**
 * The target of `up` and `down`: the server URL and its port. The `--port`
 * flag names the port without touching the host, so `IDFX_URL` keeps its
 * host and only the port changes. When both `--url` and `--port` are given
 * and their ports differ, that is ambiguous and a usage error. Without
 * `--port`, the port comes from the URL, else from the default.
 */
export function resolveTarget(urlFlag: string | undefined, portFlag: number | undefined, env: Env): { url: string; port: number } {
  const url = resolveServerUrl(urlFlag, env);
  if (portFlag === undefined) {
    return { url, port: resolvePort(undefined, url) };
  }
  const urlPort = portFromUrl(url);
  if (urlFlag !== undefined && urlPort !== undefined && urlPort !== portFlag) {
    throw new UsageError(`--port ${portFlag} does not match the port ${urlPort} of --url ${url}`);
  }
  // --port N replaces the port of the URL without changing the host or path.
  const withPort = new URL(url);
  withPort.port = String(portFlag);
  return { url: withPort.toString().replace(/\/+$/, ""), port: portFlag };
}
