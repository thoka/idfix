/**
 * The common fields of the tool protocol (version 0, section 6)
 * for `status --json` and `doctor --json`: the tool name and its version.
 *
 * The version comes from the first of these sources that gives one:
 * 1. the `version` field of `package.json` in the idfix checkout,
 * 2. the short git SHA of the checkout (`git rev-parse --short HEAD`),
 * 3. `0.0.0`.
 * idfix has no releases yet and its `package.json` has no `version`, so in
 * practice the short git SHA names the code that runs.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

/** The name of the tool in the protocol output. */
export const TOOL = "idfx";

/** The version when no source gives one. */
export const UNKNOWN_VERSION = "0.0.0";

/** The idfix checkout that holds this file. */
export const IDFIX_ROOT = path.resolve(import.meta.dir, "..");

/** The parts of the version lookup that the tests replace. */
export type VersionSources = {
  /** The text of `package.json`, or null when it cannot be read. */
  packageJson: () => string | null;
  /** The short git SHA of the checkout, or null without git. */
  gitSha: () => string | null;
};

/** The `version` field of a `package.json` text, or null. */
export function packageVersion(text: string | null): string | null {
  if (text === null) return null;
  try {
    const value = (JSON.parse(text) as { version?: unknown }).version;
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
  } catch {
    return null;
  }
}

/** The version of the tool: `package.json`, else the short git SHA, else `0.0.0`. */
export function toolVersion(sources: VersionSources): string {
  return packageVersion(sources.packageJson()) ?? sources.gitSha() ?? UNKNOWN_VERSION;
}

/** The real sources: the files and the git of the idfix checkout. */
export function checkoutVersionSources(root: string = IDFIX_ROOT): VersionSources {
  return {
    packageJson: () => {
      try {
        return readFileSync(path.join(root, "package.json"), "utf8");
      } catch {
        return null;
      }
    },
    gitSha: () => {
      try {
        const proc = Bun.spawnSync(["git", "-C", root, "rev-parse", "--short", "HEAD"], {
          stdout: "pipe",
          stderr: "ignore",
        });
        const sha = proc.stdout.toString().trim();
        return proc.exitCode === 0 && sha.length > 0 ? sha : null;
      } catch {
        return null;
      }
    },
  };
}

let cached: string | undefined;

/** The version of the running idfix checkout, computed once per process. */
export function idfxVersion(): string {
  cached ??= toolVersion(checkoutVersionSources());
  return cached;
}
