/**
 * The plan folder of a project, from the optional key `plan_dir` in
 * `<root>/.handover.toml`. A project keeps its planning files (plan,
 * research, outbox) in this folder. The default is `docs`. A public
 * repository sets `plan_dir = ".plan"`, a git-ignored clone of a private
 * companion repository.
 *
 * The rules follow `read_plan_dir` of `bin/plandir.py` in meta, so both
 * tools read the same folder: no file or no key gives `docs`; a bad TOML, a
 * value that is not a non-empty string, an absolute path, a path with `..`
 * or a backslash, or the project root itself gives `docs` plus a problem.
 */
import path from "node:path";

/** The config file in the project root. */
export const PLAN_CONFIG = ".handover.toml";
/** The plan folder without a config. */
export const DEFAULT_PLAN_DIR = "docs";

/** The plan folder relative to the root, and the problem of the config, if any. */
export type PlanDir = { planDir: string; problem?: string };

/**
 * Reads the plan folder of the project in `root`. `readText` returns the
 * content of a file, or null when it does not exist or cannot be read; a
 * null counts as no config file.
 */
export function readPlanDir(root: string, readText: (file: string) => string | null): PlanDir {
  const text = readText(path.join(root, PLAN_CONFIG));
  if (text === null) return { planDir: DEFAULT_PLAN_DIR };
  let data: Record<string, unknown>;
  try {
    data = Bun.TOML.parse(text) as Record<string, unknown>;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return bad(`bad ${PLAN_CONFIG}: ${reason}`);
  }
  const value = data.plan_dir ?? DEFAULT_PLAN_DIR;
  if (typeof value !== "string" || value.trim().length === 0) {
    return bad(`bad ${PLAN_CONFIG}: plan_dir is not a non-empty string`);
  }
  const trimmed = value.trim();
  const parts = trimmed.split("/").filter((part) => part.length > 0 && part !== ".");
  if (trimmed.startsWith("/") || parts.includes("..") || value.includes("\\")) {
    return bad(`bad ${PLAN_CONFIG}: plan_dir is not a relative path inside the project: '${value}'`);
  }
  if (parts.length === 0) return bad(`bad ${PLAN_CONFIG}: plan_dir must not be the project root`);
  return { planDir: parts.join("/") };
}

function bad(problem: string): PlanDir {
  return { planDir: DEFAULT_PLAN_DIR, problem };
}
