import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const BUNDLE = path.join(ROOT, "opencode", "cost-proxy", "cost-proxy.js");

describe("committed proxy bundle", () => {
  test("matches a fresh `bun run build:proxy` build", () => {
    const out = mkdtempSync(path.join(tmpdir(), "oc-sub-bundle-"));
    try {
      const build = Bun.spawnSync(
        ["bun", "build", "src/proxy/main.ts", "--target", "bun", "--outfile", path.join(out, "cost-proxy.js")],
        { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
      );
      expect(build.exitCode).toBe(0);
      const fresh = readFileSync(path.join(out, "cost-proxy.js"));
      let committed: Buffer;
      try {
        committed = readFileSync(BUNDLE);
      } catch {
        throw new Error(`the committed bundle ${BUNDLE} is missing: run bun run build:proxy`);
      }
      expect(committed.equals(fresh)).toBe(true);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
