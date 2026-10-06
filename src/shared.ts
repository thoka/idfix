/**
 * The shared agent files of the user: one folder with `AGENTS.md` (the global
 * rules) and `skills/<name>/SKILL.md`. It is the only source; idfx never
 * copies it. The folder comes from `IDFX_SHARED_DIR` (the old name
 * `OC_SUB_SHARED_DIR` still works). Without the variable,
 * there is no shared folder: `up` and `ping --rules` stop, and doctor warns.
 */
import path from "node:path";
import type { Env } from "./config";
import { idfxEnv } from "./env-names";

/**
 * The folder with the shared agent files, or undefined when neither
 * `IDFX_SHARED_DIR` nor the old `OC_SUB_SHARED_DIR` is set. Pure: it only
 * reads the env object. A blank value counts as unset (`idfxEnv`).
 */
export function sharedAgentsDir(env: Env): string | undefined {
  return idfxEnv(env, "sharedDir");
}

/** The global rules file inside the shared folder, or undefined without a folder. */
export function sharedAgentsFile(env: Env): string | undefined {
  const dir = sharedAgentsDir(env);
  return dir === undefined ? undefined : path.join(dir, "AGENTS.md");
}

/** The message when no shared folder variable is set. */
export const SHARED_DIR_UNSET = "IDFX_SHARED_DIR is not set.";

/** What the shared folder must hold, as the fix of a missing folder. */
export const SHARED_DIR_HINT =
  "Set IDFX_SHARED_DIR to the folder that holds AGENTS.md (your global rules) and skills/<name>/SKILL.md (your skills).";

/**
 * The configuration entries that make opencode load the shared rules and
 * skills. They go into `OPENCODE_CONFIG_CONTENT` in host mode and in sandbox
 * mode. The `instructions` entry works around the bug of opencode 1.18.32:
 * with `OPENCODE_CONFIG_DIR` set, the global `~/.config/opencode/AGENTS.md`
 * is silently dropped, but an absolute path in `instructions` still loads
 * (see .plan/research/opencode-rules.md). The skills object form
 * `{"paths": [...]}` is the form that opencode 1.18.32 reads (see
 * .plan/research/opencode-skills.md).
 */
export function sharedConfigEntries(dir: string): {
  instructions: string[];
  skills: { paths: string[] };
} {
  return {
    instructions: [path.join(dir, "AGENTS.md")],
    skills: { paths: [path.join(dir, "skills")] },
  };
}

/**
 * The first line of the content that starts with `# `. Pure. Returns null
 * when no line starts with it.
 */
export function firstHeading(content: string): string | null {
  for (const line of content.split("\n")) {
    if (line.startsWith("# ")) return line;
  }
  return null;
}
