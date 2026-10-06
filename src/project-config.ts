/**
 * The per-project configuration of oc-sub: the file `.opencode/oc-sub.json`
 * in the project root. It holds two settings: the `shortName`
 * that the project column of `oc-sub top` shows, and the `setup` shell
 * command that `oc-sub worktree` runs inside a new run worktree. Without
 * the file, or with an invalid one, there is no setting; nothing fails.
 *
 * The reader is sync and injectable, and reads each project root at most
 * once per process, so the live view can call it per row and per frame.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { projectRootOfRun } from "./keys";
import { splitFolder } from "./top/columns";

/** The config file of a project root, relative to the root. */
export const PROJECT_CONFIG_RELATIVE = path.join(".opencode", "oc-sub.json");

/** The config file of a project root. */
export function projectConfigFile(root: string): string {
  return path.join(root, PROJECT_CONFIG_RELATIVE);
}

/**
 * The `shortName` of an `oc-sub.json` text, or undefined. The text must be
 * a JSON object with a non-empty string `shortName`; anything else gives
 * undefined.
 */
export function shortNameFromConfigText(text: string | null): string | undefined {
  if (text === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const shortName = (parsed as { shortName?: unknown }).shortName;
  return typeof shortName === "string" && shortName.length > 0 ? shortName : undefined;
}

/**
 * The `setup` of an `oc-sub.json` text, or undefined. The text must be a
 * JSON object with a non-empty string `setup`; anything else gives
 * undefined.
 */
export function setupFromConfigText(text: string | null): string | undefined {
  if (text === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const setup = (parsed as { setup?: unknown }).setup;
  return typeof setup === "string" && setup.length > 0 ? setup : undefined;
}

/** The file reads that the tests replace. */
export type ProjectConfigDeps = {
  /** The content of a text file, or null when it is missing or unreadable. */
  readTextSync: (file: string) => string | null;
  /** Whether a folder exists; used to map a run folder to its project root. */
  exists: (file: string) => boolean;
};

export const defaultProjectConfigDeps: ProjectConfigDeps = {
  readTextSync: (file) => {
    try {
      return readFileSync(file, "utf8");
    } catch {
      return null;
    }
  },
  exists: existsSync,
};

/** The default cache: one entry per project root, for the whole process. */
const defaultConfigCache = new Map<string, string | undefined>();

/**
 * The configured `shortName` of a project root, or undefined. It reads the
 * config file at most once per root per process (the `cache`).
 */
export function projectShortName(
  root: string,
  deps: ProjectConfigDeps = defaultProjectConfigDeps,
  cache: Map<string, string | undefined> = defaultConfigCache,
): string | undefined {
  if (cache.has(root)) return cache.get(root);
  const shortName = shortNameFromConfigText(deps.readTextSync(projectConfigFile(root)));
  cache.set(root, shortName);
  return shortName;
}

/**
 * The configured `setup` command of a project root, or undefined. It reads
 * the file of the root each time; no cache is needed, because `oc-sub
 * worktree` calls it at most once per process.
 */
export function projectSetupCommand(
  root: string,
  deps: ProjectConfigDeps = defaultProjectConfigDeps,
): string | undefined {
  return setupFromConfigText(deps.readTextSync(projectConfigFile(root)));
}

/**
 * The shown project name for a run folder: the configured `shortName` of
 * the project root, else the computed name from the folder. The run folder
 * maps to its root with `projectRootOfRun`, so a clone-mode run folder that
 * exists only inside the sandbox maps to its root on the host.
 */
export function makeProjectNameResolver(
  deps: ProjectConfigDeps = defaultProjectConfigDeps,
  cache: Map<string, string | undefined> = defaultConfigCache,
): (directory: string) => string {
  return (directory) => {
    const root = projectRootOfRun(directory, deps.exists);
    return projectShortName(root, deps, cache) ?? splitFolder(directory).project;
  };
}
