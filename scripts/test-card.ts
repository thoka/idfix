#!/usr/bin/env bun
/**
 * Run `bun test` and end with one verdict card (step MhF7qogu, rule run-ends-with-verdict-card).
 *
 * The card has the form of the shared card (the same form as the other core test suites): the exit code of the
 * process, the counters, the duration, the first failure with file and line, the path of the full output,
 * and a note when it cut anything. The full output goes to a file (folder: DV_TEST_CARD_DIR, default
 * $XDG_STATE_HOME/idfix/test-runs), so an agent needs no tail or head and keeps the exit code.
 *
 * Usage: bun scripts/test-card.ts [bun test arguments]
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ANSI = /\x1b\[[0-9;]*m/g;

/** Build the card from the full output of a `bun test` run and the exit code of its process. */
export function buildCard(output: string, exitCode: number, seconds: number, logPath: string): string[] {
  const text = output.replace(ANSI, "");
  const count = (word: string): number => {
    const m = text.match(new RegExp(`^\\s*(\\d+) ${word}\\s*$`, "m"));
    return m ? Number(m[1]) : 0;
  };
  const pass = count("pass");
  const fail = count("fail");
  const skip = count("skip");
  const ran = text.match(/^Ran (\d+) tests? across (\d+) files?\./m);
  const total = ran ? Number(ran[1]) : pass + fail + skip;
  const counts = ran
    ? `${total} total ${pass} passed ${fail} failed ${skip} skipped`
    : "no tests";
  const lines = [
    `verdict ${exitCode === 0 ? "PASS" : "FAIL"} exit ${exitCode}: ${counts} in ${seconds.toFixed(1)}s`,
  ];
  const all = text.split("\n");
  const failIdx: number[] = [];
  all.forEach((l, i) => {
    if (/^\(fail\) /.test(l)) failIdx.push(i);
  });
  const names = [...new Set(failIdx.map((i) => all[i]!.replace(/^\(fail\) /, "").replace(/ \(attempt \d+\)/, "").replace(/ \[[\d.]+m?s\]$/, "")))];
  if (names.length > 0) {
    let where = "";
    for (let i = failIdx[0]!; i >= 0 && !where; i--) {
      const m = all[i]!.match(/^\s+at (?:.* \()?(.+?:\d+):\d+\)?\s*$/);
      if (m) where = m[1]!;
      if (i < failIdx[0]! && /^\(fail\) /.test(all[i]!)) break;
    }
    if (!where) {
      // A one-line test body has no "at" line: fall back to the file header above the failure.
      for (let i = failIdx[0]!; i >= 0 && !where; i--) {
        const h = all[i]!.match(/^(\S+\.test\.\w+):$/);
        if (h) where = h[1]!;
      }
    }
    lines.push(`first failure: ${where ? where + " " : ""}${names[0]}`);
  }
  lines.push(`full output: ${logPath}`);
  if (names.length > 1) lines.push(`cut: ${names.length - 1} more failures (see the full output)`);
  return lines;
}

function cardDir(): string {
  const env = process.env.DV_TEST_CARD_DIR;
  if (env) return env;
  return join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "idfix", "test-runs");
}

async function main(): Promise<number> {
  const start = Date.now();
  const dir = cardDir();
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
  const logPath = join(dir, `${stamp}-${process.pid}.log`);
  writeFileSync(logPath, "");
  const proc = Bun.spawn(["bun", "test", ...process.argv.slice(2)], { stdout: "pipe", stderr: "pipe" });
  let output = "";
  const pump = async (stream: ReadableStream<Uint8Array>, sink: NodeJS.WriteStream) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      const s = decoder.decode(chunk, { stream: true });
      output += s;
      appendFileSync(logPath, s);
      sink.write(s);
    }
  };
  await Promise.all([pump(proc.stdout, process.stdout), pump(proc.stderr, process.stderr)]);
  const exitCode = await proc.exited;
  const lines = buildCard(output, exitCode, (Date.now() - start) / 1000, logPath);
  const card = lines.join("\n") + "\n";
  appendFileSync(logPath, "\n" + card);
  process.stderr.write("\n" + card); // stderr, like the summary of bun test, so the card stays last
  return exitCode;
}

if (import.meta.main) process.exit(await main());
