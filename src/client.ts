/** Thin helpers around the official @opencode-ai/sdk client. */
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk";
import { authHeaderFromEnv, type Env } from "./config";

export type Health = { healthy: true; version: string };

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
 * it, so this is a raw fetch. Returns null when the server does not answer
 * within timeoutMs (a booting or firewalled port must never stall callers).
 */
export async function fetchHealth(baseUrl: string, env: Env, timeoutMs = 5000): Promise<Health | null> {
  const auth = authHeaderFromEnv(env);
  try {
    const response = await fetch(`${baseUrl}/global/health`, {
      headers: auth === undefined ? undefined : { Authorization: auth },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const data: unknown = await response.json();
    if (
      typeof data === "object" &&
      data !== null &&
      (data as { healthy?: unknown }).healthy === true &&
      typeof (data as { version?: unknown }).version === "string"
    ) {
      return { healthy: true, version: (data as { version: string }).version };
    }
    return null;
  } catch {
    return null;
  }
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
