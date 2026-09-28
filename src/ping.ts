/** `oc-sub ping`: show which OpenRouter key the server uses for a directory. */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { makeClient, requireServer, unwrap } from "./client";
import { resolveServerUrl, type Env } from "./config";

/** The OpenRouter key endpoint. It checks a key and costs nothing. */
const OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/key";
const OPENROUTER_TIMEOUT_MS = 10_000;

/** The label of the project key file candidate, without the path. */
export const PROJECT_KEY_SOURCE_PREFIX = "project key file ";

/** The first 8 hex digits of the SHA-256 of the key. The key itself is never printed. */
export function keyFingerprint(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 8);
}

/** The user config folder: $XDG_CONFIG_HOME, else ~/.config. */
export function configHome(env: Env, home: string = homedir()): string {
  return env.XDG_CONFIG_HOME !== undefined && path.isAbsolute(env.XDG_CONFIG_HOME)
    ? env.XDG_CONFIG_HOME
    : path.join(home, ".config");
}

/** The user data folder: $XDG_DATA_HOME, else ~/.local/share. */
export function dataHome(env: Env, home: string = homedir()): string {
  return env.XDG_DATA_HOME !== undefined && path.isAbsolute(env.XDG_DATA_HOME)
    ? env.XDG_DATA_HOME
    : path.join(home, ".local", "share");
}

/** The project key file `<configHome>/<project>/openrouter.key`. */
export function projectKeyPath(project: string, env: Env): string {
  return path.join(configHome(env), project, "openrouter.key");
}

/** The global opencode auth file `<dataHome>/opencode/auth.json`. */
export function authJsonPath(env: Env): string {
  return path.join(dataHome(env), "opencode", "auth.json");
}

/** Where the resolved key can come from: a label and the key that it holds. */
export type KeyCandidate = { label: string; key: string | undefined };

/**
 * The label of the first candidate whose key equals the resolved key.
 * With no match, a key from options.apiKey comes from a configuration
 * file that ping cannot name, and a key from `key` has an unknown origin.
 */
export function identifyKeySource(key: string, fromConfigFile: boolean, candidates: readonly KeyCandidate[]): string {
  for (const candidate of candidates) {
    if (candidate.key !== undefined && candidate.key === key) return candidate.label;
  }
  return fromConfigFile ? "a configuration file (not the project key file)" : "unknown";
}

/** The `openrouter.key` value of an auth.json text, or undefined when there is none. */
export function authJsonKey(text: string | null): string | undefined {
  if (text === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const openrouter = (parsed as { openrouter?: unknown }).openrouter;
  if (typeof openrouter !== "object" || openrouter === null) return undefined;
  const key = (openrouter as { key?: unknown }).key;
  return typeof key === "string" ? key : undefined;
}

/** The part of a provider that ping needs. The SDK type is wider. */
export type ProviderLike = {
  key?: string;
  options?: { [key: string]: unknown };
};

/** The key that the server resolved: options.apiKey first, then key. */
export function resolvedProviderKey(provider: ProviderLike): { key: string; fromConfigFile: boolean } | undefined {
  const optionKey = provider.options?.apiKey;
  if (typeof optionKey === "string" && optionKey.length > 0) return { key: optionKey, fromConfigFile: true };
  if (typeof provider.key === "string" && provider.key.length > 0) return { key: provider.key, fromConfigFile: false };
  return undefined;
}

/** What the OpenRouter key endpoint answered. */
export type OpenRouterCheck =
  | { status: "ok"; limit: number | null; limitRemaining: number | null; usage: number }
  | { status: "rejected"; httpStatus: number; message?: string }
  | { status: "unreachable"; message: string };

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatUsd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

/** One `openrouter:` line for ok, rejected, and unreachable. */
export function formatOpenRouterLine(result: OpenRouterCheck): string {
  if (result.status === "ok") {
    if (result.limit === null) return `openrouter: ok, limit none, used ${formatUsd(result.usage)}`;
    const line = `openrouter: ok, limit ${formatUsd(result.limit)}, used ${formatUsd(result.usage)}`;
    return result.limitRemaining === null ? line : `${line}, remaining ${formatUsd(result.limitRemaining)}`;
  }
  if (result.status === "rejected") {
    const detail = result.message === undefined ? "" : `: ${result.message}`;
    return `openrouter: rejected (HTTP ${result.httpStatus}${detail})`;
  }
  return `openrouter: unreachable (${result.message})`;
}

async function jsonBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

/** Ask OpenRouter whether it accepts the key. The key goes into one header, never into output. */
export async function checkOpenRouterKey(key: string, doFetch: PingDeps["fetch"]): Promise<OpenRouterCheck> {
  let response: Response;
  try {
    response = await doFetch(OPENROUTER_KEY_URL, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(OPENROUTER_TIMEOUT_MS),
    });
  } catch (error) {
    return { status: "unreachable", message: error instanceof Error ? error.message : String(error) };
  }
  if (response.status !== 200) {
    const error = (await jsonBody(response)) as { error?: { message?: unknown } } | undefined;
    const message = typeof error?.error?.message === "string" ? error.error.message : undefined;
    return { status: "rejected", httpStatus: response.status, message };
  }
  const body = (await jsonBody(response)) as { data?: unknown } | undefined;
  const data = typeof body?.data === "object" && body.data !== null ? (body.data as { [key: string]: unknown }) : {};
  return {
    status: "ok",
    limit: finiteNumber(data.limit),
    limitRemaining: finiteNumber(data.limit_remaining),
    usage: finiteNumber(data.usage) ?? 0,
  };
}

/** The absolute path of the main `.git` folder of a directory, or null without git. */
function gitCommonDir(directory: string): string | null {
  const proc = Bun.spawnSync(["git", "-C", directory, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const text = proc.stdout.toString().trim();
  return proc.exitCode === 0 && text.length > 0 ? text : null;
}

/**
 * The project name: the folder that holds the main repository. A worktree in
 * `<repo>/.worktrees/x` counts as `<repo>`, because the git common dir of a
 * worktree is `<repo>/.git`. Without git, it is the folder name.
 */
export function projectNameOf(directory: string): string {
  const commonDir = gitCommonDir(directory);
  return commonDir === null ? path.basename(directory) : path.basename(path.dirname(commonDir));
}

/** The content of a text file, or null when it is missing or unreadable. */
export async function readTextFile(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

/** The parts of ping that the tests replace: fetch, file reads, and git. */
export type PingDeps = {
  /** The fetch for the OpenRouter call. */
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  /** The content of a file, or null when it is missing or unreadable. */
  readText: (file: string) => Promise<string | null>;
  /** The project name for a directory. */
  projectName: (directory: string) => string;
};

const defaultDeps: PingDeps = {
  fetch,
  readText: readTextFile,
  projectName: projectNameOf,
};

/** The known key origins, in the order in which the server resolves them. */
async function keyCandidates(project: string, env: Env, deps: PingDeps): Promise<KeyCandidate[]> {
  const projectPath = projectKeyPath(project, env);
  const authPath = authJsonPath(env);
  const [projectFile, authFile] = await Promise.all([deps.readText(projectPath), deps.readText(authPath)]);
  return [
    { label: `${PROJECT_KEY_SOURCE_PREFIX}${projectPath}`, key: projectFile?.trim() },
    { label: "environment OPENROUTER_API_KEY", key: env.OPENROUTER_API_KEY },
    { label: `global auth.json ${authPath}`, key: authJsonKey(authFile) },
  ];
}

/** `oc-sub ping`: which key does the server use, where from, and does OpenRouter accept it? */
export async function ping(
  args: { url?: string; dir?: string },
  env: Env = process.env,
  deps: PingDeps = defaultDeps,
): Promise<number> {
  const baseUrl = resolveServerUrl(args.url, env);
  await requireServer(baseUrl, env);
  const directory = path.resolve(args.dir ?? process.cwd());
  const client = makeClient(baseUrl, env);

  const config = unwrap(await client.config.providers({ query: { directory } }), "load providers");
  const provider = config.providers.find((entry) => entry.id === "openrouter");
  if (provider === undefined) {
    console.log(`openrouter: not configured for ${directory}`);
    return 1;
  }

  const project = deps.projectName(directory);
  console.log(`directory: ${directory}`);
  console.log(`project: ${project}`);
  const resolved = resolvedProviderKey(provider);
  if (resolved === undefined) {
    console.log("key: none");
    return 1;
  }

  const source = identifyKeySource(resolved.key, resolved.fromConfigFile, await keyCandidates(project, env, deps));
  console.log(`key: sha256 ${keyFingerprint(resolved.key)}`);
  console.log(`source: ${source}`);

  const check = await checkOpenRouterKey(resolved.key, deps.fetch);
  console.log(formatOpenRouterLine(check));
  if (check.status !== "ok") return 1;
  if (!source.startsWith(PROJECT_KEY_SOURCE_PREFIX)) {
    console.log(
      `warning: not the project key. The cost goes to another key. Create ${projectKeyPath(project, env)} and refer to it in opencode.json. If you changed a configuration file, run oc-sub restart.`,
    );
  }
  return 0;
}
