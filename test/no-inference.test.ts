/**
 * No test may cause inference costs. The preload (test/setup.ts) guards each
 * test at run time. This static check catches the intent before a run: it
 * reads each `.ts` and `.tsx` file of `test/` and fails on two things.
 *
 * - A model provider host (`MODEL_PROVIDER_HOSTS` of the preload, for
 *   example the API host of Anthropic or of OpenRouter). A file of
 *   `HOST_ALLOWED` may name one, but only as plain data: a URL that the
 *   code under test computes and a fake fetch or a fake runner records,
 *   never a URL that a request goes to.
 * - A real model CLI as the start of a command (`SPAWN_PATTERNS`): an
 *   argv that starts with the Claude Code CLI or with claude-glm, an argv
 *   of opencode with the command run, or a `sh -c` text that starts with
 *   one of them. Only a file of `SPAWN_ALLOWED` may hold one.
 *
 * A file with the marker `live` (it calls `liveTest` or `liveDescribe` of
 * the preload) is exempt from both rules. Its tests run only with
 * `IDFX_LIVE=1`, never in the push gate.
 *
 * Each entry of the allow lists names its reason. A new entry needs a
 * review. This file builds its examples from parts, so it passes its own
 * check.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { MODEL_PROVIDER_HOSTS } from "./setup";

const TEST_DIR = import.meta.dir;

/** The files that may name a model provider host as data, with the reason. */
export const HOST_ALLOWED: Readonly<Record<string, string>> = {
  "setup.ts": "the host list of the inference guard",
  "inference-guard.test.ts": "tests that the guard refuses a fetch to a provider",
  "jev.test.ts": "asserts that no fake fetch saw a provider URL",
  "ping.test.ts": "a fake fetch records the key URL that ping computes",
  "probe-jev.test.ts": "a fake fetch records the URLs that the probe computes",
  "proxy.test.ts": "a fake fetch records the upstream URLs that the proxy computes",
  "proxy-anthropic.test.ts": "a fake upstream records the target URL that the proxy computes",
  "proxy-tap.test.ts": "a link to the stream format docs in a comment",
  "sandbox.test.ts": "argv data of `sbx secret` and `sbx policy` for a fake runner",
};

/** The files that may hold a real model CLI as the start of a command, with the reason. */
export const SPAWN_ALLOWED: Readonly<Record<string, string>> = {
  "setup.ts": "writes the fake model CLIs of the guard",
  "inference-guard.test.ts": "runs the fake model CLIs and expects their refusal",
};

/** The marker of a live test: a call of `liveTest` or `liveDescribe`. */
const LIVE_MARKER = /\blive(Test|Describe)\s*[.(]/;

const Q = "[\"'`]";
/** The starts of a command of a real model CLI. */
const SPAWN_PATTERNS: RegExp[] = [
  new RegExp(`\\[\\s*${Q}(claude|claude-glm)${Q}\\s*[,\\]]`),
  new RegExp(`${Q}opencode${Q}\\s*,\\s*${Q}run${Q}`),
  new RegExp(`${Q}-c${Q}\\s*,\\s*${Q}\\s*(\\$\\{\\w+\\}|claude|claude-glm|opencode\\s+run)\\b`),
];

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A host as a whole word: not a part of a longer host name. */
const HOST_PATTERN = new RegExp(`(?<![\\w.-])(${MODEL_PROVIDER_HOSTS.map(escapeRegExp).join("|")})(?![\\w-])`, "i");

export type Finding = { file: string; line: number; rule: "host" | "spawn"; text: string };

/** The findings of one test file. Pure. */
export function findingsOf(file: string, text: string): Finding[] {
  if (LIVE_MARKER.test(text)) return [];
  const out: Finding[] = [];
  text.split("\n").forEach((line, index) => {
    if (!(file in HOST_ALLOWED) && HOST_PATTERN.test(line)) {
      out.push({ file, line: index + 1, rule: "host", text: line.trim() });
    }
    if (!(file in SPAWN_ALLOWED) && SPAWN_PATTERNS.some((p) => p.test(line))) {
      out.push({ file, line: index + 1, rule: "spawn", text: line.trim() });
    }
  });
  return out;
}

/** The `.ts` and `.tsx` files of `test/`, relative to it. */
function testFiles(): string[] {
  return readdirSync(TEST_DIR, { recursive: true, encoding: "utf8" })
    .filter((name) => /\.tsx?$/.test(name))
    .sort();
}

describe("no test causes inference costs", () => {
  test("no test file names a model provider host or starts a model CLI without a reason", () => {
    const findings = testFiles().flatMap((name) => findingsOf(name, readFileSync(path.join(TEST_DIR, name), "utf8")));
    expect(findings.map((f) => `${f.file}:${f.line} [${f.rule}] ${f.text}`)).toEqual([]);
  });

  test("this file carries no live marker, so it checks itself", () => {
    expect(LIVE_MARKER.test(readFileSync(import.meta.path, "utf8"))).toBe(false);
  });

  test("each allow-listed file exists and still needs its entry", () => {
    const files = new Set(testFiles());
    for (const name of [...Object.keys(HOST_ALLOWED), ...Object.keys(SPAWN_ALLOWED)]) expect(files).toContain(name);
    for (const name of Object.keys(HOST_ALLOWED)) {
      expect(HOST_PATTERN.test(readFileSync(path.join(TEST_DIR, name), "utf8"))).toBe(true);
    }
    for (const name of Object.keys(SPAWN_ALLOWED)) {
      const text = readFileSync(path.join(TEST_DIR, name), "utf8");
      expect(SPAWN_PATTERNS.some((p) => p.test(text))).toBe(true);
    }
  });

  const host = ["api", "anthropic", "com"].join(".");
  const cli = ["clau", "de"].join("");

  test("a provider URL in another file is a finding", () => {
    expect(findingsOf("x.test.ts", `await fetch("https://${host}/v1/messages");`)).toHaveLength(1);
    expect(findingsOf("x.test.ts", `const u = "https://openrouter.${"ai"}/api";`)).toHaveLength(1);
  });

  test("a longer host name or a local URL is no finding", () => {
    expect(findingsOf("x.test.ts", `"https://my${host}.example/"`)).toEqual([]);
    expect(findingsOf("x.test.ts", `fetch("http://127.0.0.1:8790/v1/messages")`)).toEqual([]);
  });

  test("an argv or a shell text that starts a model CLI is a finding", () => {
    expect(findingsOf("x.test.ts", `Bun.spawnSync(["${cli}", "-p", "hi"])`)).toHaveLength(1);
    expect(findingsOf("x.test.ts", `Bun.spawnSync(["${cli}-glm"])`)).toHaveLength(1);
    expect(findingsOf("x.test.ts", `spawn(["opencode", "${"run"}", "hi"])`)).toHaveLength(1);
    expect(findingsOf("x.test.ts", `spawn(["sh", "-c", "${cli} -p hi"])`)).toHaveLength(1);
  });

  test("a label or another opencode command is no finding", () => {
    expect(findingsOf("x.test.ts", `expect(frame).toContain("${cli} interactive  model -");`)).toEqual([]);
    expect(findingsOf("x.test.ts", `spawn(["opencode", "serve", "--port", "1"])`)).toEqual([]);
    expect(findingsOf("x.test.ts", `const driver = "${cli}";`)).toEqual([]);
  });

  test("a file with the live marker is exempt", () => {
    const marker = ["live", "Test"].join("");
    const text = `${marker}("calls a model", async () => { await fetch("https://${host}/v1/messages"); });`;
    expect(findingsOf("x.test.ts", text)).toEqual([]);
  });
});
