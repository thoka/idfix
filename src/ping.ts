/** `oc-sub ping`: show which OpenRouter key the server uses for a directory. */
import path from "node:path";
import { makeClient, requireServer, unwrap } from "./client";
import { type Env } from "./config";
import { resolveCommandUrl } from "./sandbox";
import {
  checkOpenRouterKey,
  formatOpenRouterLine,
  projectNameOf,
  projectKeyPath,
  readTextFile,
  resolvedKeyOf,
  resolvedProviderKey,
  type KeyFetch,
} from "./keys";

// The key logic lives in src/keys.ts so that run, watch, and log reuse it.
export {
  authJsonKey,
  authJsonPath,
  checkOpenRouterKey,
  configHome,
  dataHome,
  fetchKeyUsage,
  formatOpenRouterLine,
  gitCommonDir,
  identifyKeySource,
  keyCandidates,
  keyFingerprint,
  projectNameOf,
  projectKeyPath,
  PROJECT_KEY_SOURCE_PREFIX,
  readTextFile,
  resolvedKeyOf,
  resolvedProviderKey,
  type KeyCandidate,
  type KeyFetch,
  type OpenRouterCheck,
  type ProviderLike,
} from "./keys";

/** The parts of ping that the tests replace: fetch, file reads, and git. */
export type PingDeps = {
  /** The fetch for the OpenRouter call. */
  fetch: KeyFetch;
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

/** `oc-sub ping`: which key does the server use, where from, and does OpenRouter accept it? */
export async function ping(
  args: { url?: string; dir?: string },
  env: Env = process.env,
  deps: PingDeps = defaultDeps,
): Promise<number> {
  const baseUrl = resolveCommandUrl(args.url, env, args.dir);
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

  // The sandbox rule lives in src/keys.ts; run and the real cost share it.
  const key = await resolvedKeyOf(resolved, project, env, { readText: deps.readText });
  console.log(`key: sha256 ${key.fingerprint}`);
  console.log(`source: ${key.source}`);

  const check = await checkOpenRouterKey(key.key, deps.fetch);
  console.log(formatOpenRouterLine(check));
  if (check.status !== "ok") return 1;
  if (!key.isProjectKey) {
    console.log(
      `warning: not the project key. The cost goes to another key. Create ${projectKeyPath(project, env)} and refer to it in opencode.json. If you changed a configuration file, run oc-sub restart.`,
    );
  }
  return 0;
}
