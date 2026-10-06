import { describe, expect, test } from "bun:test";
import { clearLocalGitEnv, localGitEnvVars } from "./setup";

// A git hook (for example pre-push) sets GIT_DIR and GIT_INDEX_FILE. The
// preload removes them, so a git command of a test never acts on idfix.
describe("test preload and the git hook environment", () => {
  test("the local git variables are not in process.env", () => {
    for (const name of localGitEnvVars()) expect(process.env[name]).toBeUndefined();
  });

  test("a git child process does not see GIT_DIR", () => {
    const proc = Bun.spawnSync(["sh", "-c", 'printf %s "${GIT_DIR-unset}"'], { stdout: "pipe" });
    expect(proc.stdout.toString()).toBe("unset");
  });

  test("clearLocalGitEnv removes GIT_DIR and GIT_INDEX_FILE and keeps other variables", () => {
    const env: Record<string, string | undefined> = { GIT_DIR: "/x/.git", GIT_INDEX_FILE: "/x/.git/index", HOME: "/home/u" };
    clearLocalGitEnv(env);
    expect(env).toEqual({ HOME: "/home/u" });
  });
});
