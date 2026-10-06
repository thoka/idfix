/**
 * The CLI is now named idfx. `oc-sub` still works as an alias, but no help,
 * message, comment, or doc tells the user to run `oc-sub <command>`. This
 * test reads the sources and the docs and fails on each such line.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dir, "..");

/** The commands of the CLI, as `idfx --help` lists them, plus the hidden one. */
const COMMANDS = [
  "up",
  "down",
  "restart",
  "run",
  "attach",
  "status",
  "top",
  "ping",
  "watch",
  "log",
  "trace",
  "abort",
  "answer",
  "say",
  "worktree",
  "fetch",
  "doctor",
  "idle-watch",
] as const;

/**
 * `oc-sub`, a space, and a command. The log marker `--- oc-sub <label> ...`
 * of the server log is not a command: step 24.3 renames it with a migration.
 */
const OLD_COMMAND = new RegExp(`(?<!--- )oc-sub (?:${COMMANDS.join("|")})(?![\\w-])`);

/** One line that names the old name with a command. */
interface OldNameHit {
  file: string;
  line: number;
  text: string;
}

/** The lines of `text` that name `oc-sub <command>`. Pure. */
function oldNameHits(file: string, text: string): OldNameHit[] {
  const hits: OldNameHit[] = [];
  text.split("\n").forEach((content, index) => {
    if (OLD_COMMAND.test(content)) hits.push({ file, line: index + 1, text: content.trim() });
  });
  return hits;
}

/** The `.ts` and `.tsx` files under `dir`, relative to ROOT. */
function sourceFiles(dir: string): string[] {
  return readdirSync(path.join(ROOT, dir), { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".ts") || name.endsWith(".tsx"))
    .map((name) => path.join(dir, name))
    .sort();
}

/** The files that this test reads, relative to ROOT. */
function checkedFiles(): string[] {
  const skills = readdirSync(path.join(ROOT, "skills", "oc-sub"))
    .filter((name) => name.endsWith(".md"))
    .map((name) => path.join("skills", "oc-sub", name));
  return [...sourceFiles("src"), "README.md", path.join("docs", "GUIDE.md"), ...skills];
}

describe("oldNameHits", () => {
  test("finds oc-sub with a command and names the line", () => {
    expect(oldNameHits("a.md", "intro\nrun `oc-sub up` first\n")).toEqual([
      { file: "a.md", line: 2, text: "run `oc-sub up` first" },
    ]);
  });

  test("finds the hidden command idle-watch", () => {
    expect(oldNameHits("a.ts", "spawn oc-sub idle-watch --port 1")).toHaveLength(1);
  });

  test("ignores the alias sentence, paths, names, and the log marker", () => {
    const text = [
      "oc-sub is the old name of idfx and still works.",
      "`oc-sub` is the old name of the tool `idfx`, and it still works as an alias.",
      "the sandbox oc-sub-proj and the folder ~/.local/state/oc-sub/runs/",
      "the file .opencode/oc-sub.json and the skill `oc-sub`",
      "--- oc-sub up 2026-10-01T21:00:00.000Z ---",
      "oc-sub upload is not a command",
      "idfx up",
    ].join("\n");
    expect(oldNameHits("a.md", text)).toEqual([]);
  });
});

describe("the old name oc-sub", () => {
  test("no source file or doc tells the user to run oc-sub <command>", () => {
    const files = checkedFiles();
    expect(files).toContain(path.join("src", "cli.ts"));
    expect(files).toContain(path.join("skills", "oc-sub", "SKILL.md"));
    const hits = files.flatMap((file) => oldNameHits(file, readFileSync(path.join(ROOT, file), "utf8")));
    const report = hits.map((hit) => `${hit.file}:${hit.line}: ${hit.text}`).join("\n");
    expect(report).toBe("");
  });
});
