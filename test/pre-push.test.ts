import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const script = join(root, "scripts", "pre-push-tests.sh");
const sh = Bun.which("sh") ?? "/bin/sh";

// A folder that is the whole PATH of the script. Each fake tool prints its
// name and arguments, then exits with the code of FAKE_EXIT (default 0).
let bin = "";

function fakeTool(name: string): void {
  const file = join(bin, name);
  writeFileSync(file, `#!${sh}\necho "${name} $*"\nexit "\${FAKE_EXIT:-0}"\n`);
  chmodSync(file, 0o755);
}

function runJob(env: Record<string, string> = {}): { code: number; lines: string[] } {
  const run = Bun.spawnSync([sh, script], { env: { PATH: bin, ...env } });
  return { code: run.exitCode, lines: run.stdout.toString().trim().split("\n") };
}

beforeEach(() => {
  bin = mkdtempSync(join(tmpdir(), "idfix-pre-push-"));
});

afterEach(() => {
  rmSync(bin, { recursive: true, force: true });
});

describe("the test job of the pre-push hook", () => {
  test("lefthook.yml runs the script as the job idfix tests, with nothing else", async () => {
    const hooks = Bun.YAML.parse(await Bun.file(join(root, "lefthook.yml")).text()) as {
      "pre-push": { jobs: { name: string; run: string }[] };
    };
    const job = hooks["pre-push"].jobs.find((j) => j.name === "idfix tests");
    expect(job?.run).toBe("sh scripts/pre-push-tests.sh");
  });

  test("without git-autopush, it names the missing tool, then runs mise run test", () => {
    fakeTool("mise");
    const { code, lines } = runJob();
    expect(code).toBe(0);
    expect(lines[0]).toContain("git-autopush not found");
    expect(lines[0]).toContain("plain suite");
    expect(lines[1]).toBe("mise run test");
  });

  test("without git-autopush, a failing suite fails the job with its exit code", () => {
    fakeTool("mise");
    expect(runJob({ FAKE_EXIT: "3" }).code).toBe(3);
  });

  test("with git-autopush, it runs the suite in a snapshot and prints no fallback line", () => {
    fakeTool("git-autopush");
    fakeTool("mise");
    const { code, lines } = runJob();
    expect(code).toBe(0);
    expect(lines).toEqual(["git-autopush tests --snapshot -- mise run test"]);
  });

  test("with git-autopush, its failure fails the job", () => {
    fakeTool("git-autopush");
    expect(runJob({ FAKE_EXIT: "4" }).code).toBe(4);
  });

  test("TEST_RUNNER replaces the suite command", () => {
    fakeTool("git-autopush");
    expect(runJob({ TEST_RUNNER: "bun test" }).lines).toEqual(["git-autopush tests --snapshot -- bun test"]);
  });

  test("without git-autopush, TEST_RUNNER replaces the plain suite command", () => {
    fakeTool("bun");
    fakeTool("mise");
    const { lines } = runJob({ TEST_RUNNER: "bun test" });
    expect(lines[0]).toContain("git-autopush not found");
    expect(lines.slice(1)).toEqual(["bun test"]);
  });
});
