/**
 * OpenRouter key handling: fingerprints, key sources, the key check at
 * OpenRouter, and the refusal of a key that two projects share. A key is
 * never printed, logged, or stored. Only its fingerprint appears in output.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { OpencodeClient } from "@opencode-ai/sdk";
import { errorMessage, unwrap } from "./client";
import type { Env } from "./config";

/** The OpenRouter key endpoint. It checks a key and costs nothing. */
export const OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/key";
const OPENROUTER_TIMEOUT_MS = 10_000;

/** The label of the project key file candidate, without the path. */
export const PROJECT_KEY_SOURCE_PREFIX = "project key file ";

/** The key value that `sbx` puts into the sandbox instead of the real key. */
export const PLACEHOLDER_KEY = "proxy-managed";

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

/**
 * The optional DeepInfra project key file `<configHome>/<project>/deepinfra.key`.
 * Only when it exists does `up` set DeepInfra up (step 16).
 */
export function deepinfraKeyPath(project: string, env: Env): string {
  return path.join(configHome(env), project, "deepinfra.key");
}

/** The DeepInfra API host, the target of the custom secret of `sbx`. */
export const DEEPINFRA_HOST = "api.deepinfra.com";

/**
 * The value that the sandbox server gets as `DEEPINFRA_API_KEY`. The proxy of
 * `sbx` replaces it with the real key in the request headers of every request
 * to `DEEPINFRA_HOST`. One fixed value, so the `-e` option of the holder and
 * the `--placeholder` of the secret always match.
 */
export const DEEPINFRA_PLACEHOLDER = "oc-sub-deepinfra-proxy-managed";

/**
 * The DeepInfra key for a host server: the environment variable
 * `DEEPINFRA_API_KEY` first, then the project key file, else undefined. The
 * same order as the OpenRouter key. The key is never printed or logged.
 */
export function hostDeepInfraKey(
  env: Env,
  keyFile: string,
  readText: (file: string) => string | null,
): string | undefined {
  const fromEnv = env.DEEPINFRA_API_KEY?.trim();
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  const fromFile = readText(keyFile)?.trim();
  return fromFile !== undefined && fromFile.length > 0 ? fromFile : undefined;
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
 * file that we cannot name, and a key from `key` has an unknown origin.
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

/** The part of a provider that we need. The SDK type is wider. */
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

/** The fetch that the tests replace. */
export type KeyFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Ask OpenRouter whether it accepts the key. The key goes into one header, never into output. */
export async function checkOpenRouterKey(key: string, doFetch: KeyFetch): Promise<OpenRouterCheck> {
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

/** The cumulative USD usage of the key, or null when OpenRouter does not answer. */
export async function fetchKeyUsage(key: string, doFetch: KeyFetch): Promise<number | null> {
  const check = await checkOpenRouterKey(key, doFetch);
  return check.status === "ok" ? check.usage : null;
}

/** The absolute path of the main `.git` folder of a directory, or null without git. */
export function gitCommonDir(directory: string): string | null {
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

/**
 * The project root of a run folder. In sandbox clone mode, the worktree of a
 * run exists only inside the sandbox, at `<root>/.worktrees/<name>`; on the
 * host the folder is missing. When the folder itself exists on the host (the
 * project root, or a host-mode worktree), the existing logic stays and the
 * folder decides. When it does not, and the path has the form
 * `<root>/.worktrees/<name>` with an existing `<root>` on the host, the
 * root is `<root>`. Otherwise the folder itself.
 */
export function projectRootOfRun(directory: string, exists: (file: string) => boolean = existsSync): string {
  if (exists(directory)) return directory;
  const parent = path.dirname(directory);
  if (path.basename(parent) === ".worktrees") {
    const root = path.dirname(parent);
    if (exists(root)) return root;
  }
  return directory;
}

/** The project name of a run folder, through `projectRootOfRun`. */
export function projectNameOfRun(directory: string): string {
  return projectNameOf(projectRootOfRun(directory));
}

/** The content of a text file, or null when it is missing or unreadable. */
export async function readTextFile(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

/** The file reads and the project name that the tests replace. */
export type KeyDeps = {
  /** The content of a file, or null when it is missing or unreadable. */
  readText: (file: string) => Promise<string | null>;
  /** The project name for a directory. */
  projectName: (directory: string) => string;
};

export const defaultKeyDeps: KeyDeps = {
  readText: readTextFile,
  projectName: projectNameOf,
};

/** The known key origins, in the order in which the server resolves them. */
export async function keyCandidates(project: string, env: Env, deps: Pick<KeyDeps, "readText">): Promise<KeyCandidate[]> {
  const projectPath = projectKeyPath(project, env);
  const authPath = authJsonPath(env);
  const [projectFile, authFile] = await Promise.all([deps.readText(projectPath), deps.readText(authPath)]);
  return [
    { label: `${PROJECT_KEY_SOURCE_PREFIX}${projectPath}`, key: projectFile?.trim() },
    { label: "environment OPENROUTER_API_KEY", key: env.OPENROUTER_API_KEY },
    { label: `global auth.json ${authPath}`, key: authJsonKey(authFile) },
  ];
}

/** The OpenRouter key that the server uses for one directory, with its origin. */
export type ResolvedKey = {
  /** The resolved key. Never printed or stored. */
  key: string;
  /** The first 8 hex digits of the SHA-256 of the key. */
  fingerprint: string;
  /** True when the key equals the project key file of the project. */
  isProjectKey: boolean;
  /** The source label, as `oc-sub ping` prints it. */
  source: string;
};

/**
 * The source label of the sandbox proxy rule. With the file, the proxy of
 * `sbx` adds the real key from the project key file on the host. Without
 * it, the placeholder stays and no real key exists.
 */
export function sbxProxySource(withFile: boolean, keyPath: string): string {
  return withFile
    ? `sbx proxy with the project key file ${keyPath}`
    : `sbx proxy without a project key file (${keyPath} is missing)`;
}

/**
 * The key and its origin for the key that the server reports. This is the
 * one place with the sandbox rule: the placeholder `proxy-managed` means
 * that the proxy of `sbx` adds the real key from the project key file of
 * the project on the host. `resolveDirectoryKey` and `ping` both use it.
 */
export async function resolvedKeyOf(
  resolved: { key: string; fromConfigFile: boolean },
  project: string,
  env: Env,
  deps: Pick<KeyDeps, "readText"> = defaultKeyDeps,
): Promise<ResolvedKey> {
  if (resolved.key === PLACEHOLDER_KEY) {
    const keyPath = projectKeyPath(project, env);
    const fileKey = (await deps.readText(keyPath))?.trim();
    if (fileKey !== undefined && fileKey.length > 0) {
      return {
        key: fileKey,
        fingerprint: keyFingerprint(fileKey),
        isProjectKey: true,
        source: sbxProxySource(true, keyPath),
      };
    }
    return {
      key: resolved.key,
      fingerprint: keyFingerprint(resolved.key),
      isProjectKey: false,
      source: sbxProxySource(false, keyPath),
    };
  }
  const source = identifyKeySource(resolved.key, resolved.fromConfigFile, await keyCandidates(project, env, deps));
  return {
    key: resolved.key,
    fingerprint: keyFingerprint(resolved.key),
    isProjectKey: source.startsWith(PROJECT_KEY_SOURCE_PREFIX),
    source,
  };
}

/**
 * The OpenRouter key that the server uses for one directory. Returns null
 * when openrouter is not configured there or has no key. Throws when the
 * configuration cannot be loaded, like the SDK client does.
 */
export async function resolveDirectoryKey(
  client: OpencodeClient,
  directory: string,
  env: Env,
  deps: Pick<KeyDeps, "readText"> = defaultKeyDeps,
): Promise<ResolvedKey | null> {
  const config = unwrap(await client.config.providers({ query: { directory } }), "load providers");
  const provider = config.providers.find((entry) => entry.id === "openrouter");
  if (provider === undefined) return null;
  const resolved = resolvedProviderKey(provider);
  if (resolved === undefined) return null;
  return resolvedKeyOf(resolved, projectNameOfRun(directory), env, deps);
}

/** The key owner that the shared-key check compares. */
export type KeyOwner = {
  /** The project name of the directory, from `projectNameOf`. */
  project: string;
  /** The key fingerprint, or null without a key. */
  fingerprint: string | null;
  /** True when the key equals the project key file of the project. */
  isProjectKey: boolean;
};

/**
 * The refusal message when a run must not start, or null when the key setup
 * is fine. Pure function.
 *
 * Rules: each project needs its own OpenRouter key. When the run directory
 * does not use its project key (for example the global auth.json key or the
 * environment key), the run stops. When a directory of another project
 * resolves to the same fingerprint, the run stops too. Directories of the
 * same project share the key legally, so the project name decides.
 */
export function sharedKeyRefusal(
  run: { project: string; fingerprint: string; isProjectKey: boolean },
  others: readonly KeyOwner[],
  env: Env,
): string | null {
  if (!run.isProjectKey) {
    return (
      `error: the run directory of project ${run.project} does not use its project key. ` +
      `Each project needs its own OpenRouter key. ` +
      `Create ${projectKeyPath(run.project, env)} and refer to it in opencode.json, then run oc-sub restart.`
    );
  }
  const shared = [...new Set(
    others
      .filter((other) => other.fingerprint === run.fingerprint && other.project !== run.project)
      .map((other) => other.project),
  )].sort();
  if (shared.length === 0) return null;
  const names = shared.join(", ");
  return (
    `error: the OpenRouter key sha256 ${run.fingerprint} is shared by the projects ${run.project} and ${names}. ` +
    `Each project needs its own key. ` +
    `Create ${projectKeyPath(run.project, env)} or ${projectKeyPath(shared[0] as string, env)} for one of them, then run oc-sub restart.`
  );
}
