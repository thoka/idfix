import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve(import.meta.dir, "..", "scripts", "pre-push-tests.sh");
const sh = Bun.which("sh") ?? "/bin/sh";

describe("pre-push tests job", () => {
  test("lefthook.yml runs the script as the test job", async () => {
    const hooks = await Bun.file(resolve(import.meta.dir, "..", "lefthook.yml")).text();
    expect(hooks).toContain("run: sh scripts/pre-push-tests.sh");
  });

  test("names a missing git-autopush, then runs the plain suite", () => {
    // An empty PATH holds no git-autopush; echo and exit are shell builtins.
    const bin = mkdtempSync(join(tmpdir(), "idfix-pre-push-"));
    try {
      const run = Bun.spawnSync([sh, script], {
        env: { PATH: bin, TEST_RUNNER: "echo plain-suite-ran" },
      });
      const out = run.stdout.toString();
      expect(run.exitCode).toBe(0);
      const lines = out.trim().split("\n");
      expect(lines[0]).toContain("git-autopush not found");
      expect(lines[0]).toContain("plain suite");
      expect(lines[1]).toBe("plain-suite-ran");
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });

  test("returns the exit code of the plain suite", () => {
    const bin = mkdtempSync(join(tmpdir(), "idfix-pre-push-"));
    try {
      const run = Bun.spawnSync([sh, script], {
        env: { PATH: bin, TEST_RUNNER: "exit 3" },
      });
      expect(run.exitCode).toBe(3);
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });
});
