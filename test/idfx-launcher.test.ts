import { describe, expect, test } from "bun:test";
import path from "node:path";

const ROOT = path.join(import.meta.dir, "..");

describe("bin/idfx", () => {
  test("runs the same CLI as bin/oc-sub", () => {
    const idfx = Bun.spawnSync([path.join(ROOT, "bin", "idfx"), "--help"]);
    const ocSub = Bun.spawnSync([path.join(ROOT, "bin", "oc-sub"), "--help"]);
    expect(idfx.exitCode).toBe(0);
    expect(idfx.stdout.toString()).toBe(ocSub.stdout.toString());
  });
});
