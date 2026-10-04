/**
 * The critical-research footer. The shared skill `critical-research` holds a
 * fixed footer that every research question ends with. `oc-sub run --agent
 * researcher` appends it to the brief, so that every research report has a
 * section "Critical analysis".
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Env } from "./config";
import { sharedAgentsDir } from "./shared";

/** The skill file that holds the footer, inside the shared folder. */
export function criticalFooterFile(env: Env): string {
  return path.join(sharedAgentsDir(env), "skills", "critical-research", "SKILL.md");
}

/**
 * The footer in the text of the skill file, or null. The footer is the content
 * of the first fenced code block after the heading `## The footer`, and it
 * starts with the line `---`. Pure.
 */
export function extractCriticalFooter(skill: string): string | null {
  const lines = skill.split(/\r?\n/);
  const heading = lines.findIndex((line) => line.trim() === "## The footer");
  if (heading === -1) return null;
  for (let i = heading + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.startsWith("## ")) return null;
    if (!line.trimStart().startsWith("```")) continue;
    const end = lines.findIndex((next, j) => j > i && next.trimStart().startsWith("```"));
    if (end === -1) return null;
    const footer = lines.slice(i + 1, end).join("\n").trim();
    return footer.startsWith("---") ? footer : null;
  }
  return null;
}

/** Read the footer from the skill file. Throws an error that names the file. */
export function readCriticalFooter(env: Env, read: (file: string) => string = (file) => readFileSync(file, "utf8")): string {
  const file = criticalFooterFile(env);
  let text: string;
  try {
    text = read(file);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`cannot read the critical-research footer from ${file}: ${reason}`);
  }
  const footer = extractCriticalFooter(text);
  if (footer === null) {
    throw new Error(`no footer in ${file}: expected a fenced block that starts with --- after "## The footer"`);
  }
  return footer;
}

/** The brief with the footer at the end, after a blank line. A brief that already ends with it stays unchanged. Pure. */
export function appendCriticalFooter(brief: string, footer: string): string {
  if (brief.trim().endsWith(footer.trim())) return brief;
  const body = brief.trimEnd();
  return body.length === 0 ? `${footer}\n` : `${body}\n\n${footer}\n`;
}
