/**
 * The shared agent files of the user: one folder with `AGENTS.md` (the global
 * rules) and `skills/<name>/SKILL.md`. It is the only source; oc-sub never
 * copies it. The folder comes from `OC_SUB_SHARED_DIR`, else from
 * `$HOME/dv/meta/agents`.
 */
import path from "node:path";
import type { Env } from "./config";

/**
 * The folder with the shared agent files. Pure: it only reads the env object.
 * An empty `OC_SUB_SHARED_DIR` counts as unset, like the other oc-sub
 * variables. Without `HOME` the path keeps the `~` placeholder.
 */
export function sharedAgentsDir(env: Env): string {
  const fromEnv = env.OC_SUB_SHARED_DIR;
  if (fromEnv !== undefined && fromEnv.trim().length > 0) return fromEnv;
  return path.join(env.HOME ?? "~", "dv", "meta", "agents");
}

/** The global rules file inside the shared folder. */
export function sharedAgentsFile(env: Env): string {
  return path.join(sharedAgentsDir(env), "AGENTS.md");
}

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
