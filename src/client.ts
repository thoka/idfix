/** Thin helpers around the official @opencode-ai/sdk client. */
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk";
import { authHeaderFromEnv, type Env } from "./config";

/** What a health check found: a healthy server, no server, or a server that refused the credentials. */
export type ServerState = { state: "up"; version: string } | { state: "down" } | { state: "unauthorized" };

/** Build an SDK client for a server URL, with basic auth when configured. */
export function makeClient(baseUrl: string, env: Env): OpencodeClient {
  const auth = authHeaderFromEnv(env);
  return createOpencodeClient({
    baseUrl,
    headers: auth === undefined ? undefined : { Authorization: auth },
  });
}

/**
 * Health check against GET /global/health. The 1.18.x SDK has no method for
 * it, so this is a raw fetch. A server that does not answer within timeoutMs
 * counts as down (a booting or firewalled port must never stall callers).
 * HTTP 401 and 403 mean that a server runs but refused the credentials.
 */
export async function probeServer(baseUrl: string, env: Env, timeoutMs = 5000): Promise<ServerState> {
  const auth = authHeaderFromEnv(env);
  try {
    const response = await fetch(`${baseUrl}/global/health`, {
      headers: auth === undefined ? undefined : { Authorization: auth },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 401 || response.status === 403) return { state: "unauthorized" };
    if (!response.ok) return { state: "down" };
    const data: unknown = await response.json();
    if (
      typeof data === "object" &&
      data !== null &&
      (data as { healthy?: unknown }).healthy === true &&
      typeof (data as { version?: unknown }).version === "string"
    ) {
      return { state: "up", version: (data as { version: string }).version };
    }
    return { state: "down" };
  } catch {
    return { state: "down" };
  }
}

/** No opencode server answers on the URL. */
export class ServerDownError extends Error {
  constructor(readonly url: string) {
    super(`no server on ${url}. Start it with: oc-sub up`);
    this.name = "ServerDownError";
  }
}

/** A server answers on the URL, but it refused the credentials. */
export class ServerAuthError extends Error {
  constructor(readonly url: string, hasPassword: boolean) {
    super(
      hasPassword
        ? `the server on ${url} rejected the password in OPENCODE_SERVER_PASSWORD`
        : `the server on ${url} needs a password. Set OPENCODE_SERVER_PASSWORD`,
    );
    this.name = "ServerAuthError";
  }
}

/**
 * Throw ServerDownError or ServerAuthError when the server cannot be used.
 * Commands call this first, so that a missing server or a wrong password
 * gives a clear message and not a raw fetch error.
 */
export async function requireServer(baseUrl: string, env: Env): Promise<void> {
  assertUsable(await probeServer(baseUrl, env, 2000), baseUrl, env);
}

export function assertUsable(server: ServerState, baseUrl: string, env: Env): void {
  if (server.state === "down") throw new ServerDownError(baseUrl);
  if (server.state === "unauthorized") throw new ServerAuthError(baseUrl, authHeaderFromEnv(env) !== undefined);
}

/** Pull the data out of an SDK result, or throw an Error with a readable message. */
export function unwrap<T>(result: { data?: T; error?: unknown }, what: string): T {
  if (result.data !== undefined) {
    return result.data;
  }
  throw new Error(`${what}: ${errorMessage(result.error)}`);
}

/** Like unwrap, for calls that return no payload (204). */
export function assertOk(result: { error?: unknown }, what: string): void {
  if (result.error !== undefined) {
    throw new Error(`${what}: ${errorMessage(result.error)}`);
  }
}

export function errorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const named = error as { name?: unknown; data?: { message?: unknown } };
    const message = named.data?.message;
    if (typeof message === "string" && message.length > 0) return message;
    if (typeof named.name === "string") return named.name;
  }
  if (typeof error === "string" && error.length > 0) return error;
  return "unknown error";
}
