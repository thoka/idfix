import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RUN_PREFIX } from "./setup";

// The preload in test/setup.ts gives each test run one temporary folder and
// removes it at exit. These tests make sure that the redirect is active, so a
// raw mkdtempSync(tmpdir()) in any test cannot leak into the system /tmp.
describe("temporary folders of the test run", () => {
  test("tmpdir() is the run folder of the preload", () => {
    expect(path.basename(tmpdir())).toStartWith(RUN_PREFIX);
    expect(process.env.TMPDIR).toBe(tmpdir());
  });

  test("a raw mkdtemp lands inside the run folder", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "oc-sub-hygiene-"));
    expect(path.dirname(dir)).toBe(tmpdir());
  });

  test("the XDG folders are inside the run folder", () => {
    expect(process.env.XDG_DATA_HOME?.startsWith(tmpdir())).toBe(true);
    expect(process.env.XDG_STATE_HOME?.startsWith(tmpdir())).toBe(true);
  });
});
