/**
 * The test preload (test/setup.ts) keeps every test away from the real state
 * of the user: the home folder, the current folder, and the XDG folders all
 * point into the run folder of this test run.
 */
import { describe, expect, test } from "bun:test";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { REPO_ROOT, RUN_PREFIX, TEST_CWD, TEST_HOME } from "./setup";
import { stateDir } from "../src/state";

/** Whether `file` lies inside a test run folder of the system temp folder. */
function inRunFolder(file: string): boolean {
  return path.relative(path.dirname(tmpdir()), file).split(path.sep)[0]?.startsWith(RUN_PREFIX) === true;
}

describe("test isolation", () => {
  test("homedir() is the test home in the run folder", () => {
    expect(homedir()).toBe(TEST_HOME);
    expect(inRunFolder(TEST_HOME)).toBe(true);
  });

  test("the current folder is the test folder, not the repository", () => {
    expect(process.cwd()).toBe(TEST_CWD);
    expect(process.cwd()).not.toBe(REPO_ROOT);
    expect(inRunFolder(TEST_CWD)).toBe(true);
  });

  test("the state folder stays in the run folder, also for an empty env", () => {
    expect(inRunFolder(stateDir({}))).toBe(true);
    expect(inRunFolder(stateDir(process.env))).toBe(true);
  });

  test("a spawn without cwd starts in the repository root", () => {
    const proc = Bun.spawnSync(["pwd"], { stdout: "pipe" });
    expect(proc.stdout.toString().trim()).toBe(REPO_ROOT);
  });
});
