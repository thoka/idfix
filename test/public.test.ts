/**
 * This repository is public, so its tracked files name no local path of the
 * owner (AGENTS.md). The pre-commit hook runs `public-check` when it is on
 * the PATH. This test does the path part of that check without the tool, so
 * that it also runs for a contributor without `public-check`: it fails on
 * a path in the home folder of the owner (the folder `dv` below `~`) or on
 * any path below `/home`, in a tracked file, with the file and the line.
 * The exact strings in `.public-check-allow` are allowed, as in the tool.
 * The test texts below build these paths from parts, so this file passes
 * its own check.
 */
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const ALLOW_FILE = ".public-check-allow";
const LOCKFILES = new Set(["bun.lock", "bun.lockb", "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "mise.lock"]);
const DV = "~" + "/dv";
const HOME = "/" + "home/";
const PATTERNS: [RegExp, string][] = [
  [/~\/dv(?![\w-])/, `local path "${DV}"`],
  [/\/home\//, `local path "${HOME}"`],
];

/** The non-empty lines of the allow file, without `#` comment lines. */
export function allowedStrings(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

/** The findings of one file: `<file>:<line>: <reason>`, after the allowed strings are removed. */
export function findings(file: string, text: string, allowed: readonly string[]): string[] {
  const out: string[] = [];
  text.split("\n").forEach((raw, index) => {
    let line = raw;
    for (const allow of allowed) line = line.split(allow).join("");
    for (const [pattern, reason] of PATTERNS) {
      if (pattern.test(line)) out.push(`${file}:${index + 1}: ${reason}`);
    }
  });
  return out;
}

/** The environment without the variables of `git rev-parse --local-env-vars`, so a git hook does not point git at another repository. */
function cleanEnv(): Record<string, string> {
  const env: Record<string, string | undefined> = { ...process.env };
  const local = Bun.spawnSync(["git", "rev-parse", "--local-env-vars"], { env: env as Record<string, string> });
  for (const name of local.stdout.toString().split("\n")) if (name.trim().length > 0) delete env[name.trim()];
  return env as Record<string, string>;
}

function trackedFiles(): string[] {
  const result = Bun.spawnSync(["git", "-C", ROOT, "ls-files", "-z"], { env: cleanEnv() });
  if (result.exitCode !== 0) throw new Error(`git ls-files failed: ${result.stderr.toString()}`);
  return result.stdout
    .toString()
    .split("\0")
    .filter((file) => file.length > 0);
}

describe("findings", () => {
  test("names the file, the line, and the reason", () => {
    expect(findings("a.md", `ok\nsee ${DV}/x and ${HOME}x/y\n`, [])).toEqual([
      `a.md:2: local path "${DV}"`,
      `a.md:2: local path "${HOME}"`,
    ]);
  });

  test("ignores an allowed string and a longer folder name", () => {
    expect(findings("a.md", `${HOME}user/src and ${DV}d`, [`${HOME}user`])).toEqual([]);
    expect(findings("a.md", `${HOME}user/src and ${HOME}other`, [`${HOME}user`])).toEqual([`a.md:1: local path "${HOME}"`]);
  });

  test("reads the allow file without comments and empty lines", () => {
    expect(allowedStrings(`# note\n\n${HOME}user\n  x  \n`)).toEqual([`${HOME}user`, "x"]);
  });
});

describe("the tracked files", () => {
  test("name no local path outside .public-check-allow", () => {
    const allowPath = path.join(ROOT, ALLOW_FILE);
    const allowed = fs.existsSync(allowPath) ? allowedStrings(fs.readFileSync(allowPath, "utf8")) : [];
    const all: string[] = [];
    for (const file of trackedFiles()) {
      if (file === ALLOW_FILE || LOCKFILES.has(path.basename(file))) continue;
      const full = path.join(ROOT, file);
      if (!fs.existsSync(full) || !fs.statSync(full).isFile()) continue;
      const bytes = fs.readFileSync(full);
      if (bytes.includes(0)) continue;
      all.push(...findings(file, bytes.toString("utf8"), allowed));
    }
    expect(all).toEqual([]);
  });
});
