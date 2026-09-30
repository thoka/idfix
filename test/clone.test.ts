import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fetch, runWorktreePath, worktree, worktreeRm, type CloneDeps } from "../src/clone";
import { projectRootOfRun } from "../src/keys";
import { sandboxStatePath, writeSandboxState, type Runner, type SandboxState } from "../src/sandbox";

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "oc-sub-clone-"));
}

type Call = { cmd: string[] };

/** A fake runner whose answers come from a per-command script. */
function fakeRunner(answer: (cmd: readonly string[]) => { stdout?: string; exitCode?: number }): {
  calls: Call[];
  runner: Runner;
} {
  const calls: Call[] = [];
  const runner: Runner = (cmd) => {
    calls.push({ cmd: [...cmd] });
    const { stdout = "", exitCode = 0 } = answer(cmd);
    return { stdout, exitCode };
  };
  return { calls, runner };
}

const ROOT = "/repo";
const NAME = "oc-sub-test";
const STATE: SandboxState = { name: NAME, root: ROOT, port: 18768 };

async function makeDeps(overrides: Partial<CloneDeps> = {}): Promise<{ env: Record<string, string> } & CloneDeps> {
  const env = { XDG_STATE_HOME: tempDir() };
  await writeSandboxState(sandboxStatePath(env as never, "test"), STATE);
  return {
    env,
    runner: () => ({ stdout: "", exitCode: 0 }),
    sandboxState: () => STATE,
    projectName: () => "test",
    ...overrides,
  };
}

function isSbxGit(cmd: readonly string[], gitArgs: readonly string[]): boolean {
  return (
    cmd[0] === "sbx" &&
    cmd[1] === "exec" &&
    cmd[2] === NAME &&
    cmd[3] === "git" &&
    cmd[4] === "-C" &&
    cmd[5] === ROOT &&
    JSON.stringify(cmd.slice(6)) === JSON.stringify(gitArgs)
  );
}

function callsOf(calls: Call[], match: (cmd: readonly string[]) => boolean): string[][] {
  return calls.filter((call) => match(call.cmd)).map((call) => call.cmd);
}

describe("projectRootOfRun", () => {
  test("an existing folder decides as before", () => {
    // The host-mode worktree and the project root exist on the host.
    expect(projectRootOfRun(ROOT, (file) => file === ROOT)).toBe(ROOT);
    expect(projectRootOfRun(`${ROOT}/.worktrees/x`, (file) => file !== "/nope")).toBe(`${ROOT}/.worktrees/x`);
  });

  test("a run folder that exists only inside the sandbox maps to the root", () => {
    // The folder does not exist on the host, the root does.
    const exists = (file: string) => file === ROOT;
    expect(projectRootOfRun(`${ROOT}/.worktrees/step`, exists)).toBe(ROOT);
    expect(projectRootOfRun(`${ROOT}/.worktrees/step`, exists)).not.toBe(`${ROOT}/.worktrees/step`);
  });

  test("a missing folder without the .worktrees shape stays itself", () => {
    const exists = (file: string) => file === ROOT;
    expect(projectRootOfRun(`${ROOT}/other/step`, exists)).toBe(`${ROOT}/other/step`);
    expect(projectRootOfRun(`${ROOT}/.worktrees/step`, () => false)).toBe(`${ROOT}/.worktrees/step`);
  });

  test("works on the real file system", () => {
    const root = tempDir();
    // The root exists, the run folder does not: the mapping finds the root.
    expect(projectRootOfRun(path.join(root, ".worktrees", "step"), existsSync)).toBe(root);
    expect(projectRootOfRun(path.join(root, ".worktrees", "step"), existsSync)).not.toBe(
      path.join(root, ".worktrees", "step"),
    );
    // An existing folder maps to itself.
    expect(projectRootOfRun(root, existsSync)).toBe(root);
  });
});

describe("worktree", () => {
  test("fetches, sets the host identity, and adds the worktree from origin/alpha", async () => {
    const deps = await makeDeps();
    const { calls, runner } = fakeRunner((cmd) => {
      // The worktree does not exist yet.
      if (cmd[0] === "sbx" && cmd[3] === "test") return { exitCode: 1 };
      if (cmd[0] === "git" && cmd[3] === "config") {
        return { stdout: cmd[4] === "user.name" ? "Ada Lovelace\n" : "ada@example.com\n" };
      }
      return {};
    });
    const code = worktree({ step: "14b" }, deps.env as never, { ...deps, runner });
    expect(code).toBe(0);

    // The exact sbx commands, in order: the existence test, the fetch, the
    // two identity configs, and the worktree add from origin/alpha.
    expect(callsOf(calls, (c) => isSbxGit(c, ["fetch", "-q", "origin"])).length).toBe(1);
    expect(callsOf(calls, (c) => isSbxGit(c, ["config", "user.name", "Ada Lovelace"])).length).toBe(1);
    expect(callsOf(calls, (c) => isSbxGit(c, ["config", "user.email", "ada@example.com"])).length).toBe(1);
    expect(
      callsOf(calls, (c) =>
        isSbxGit(c, ["worktree", "add", "-b", "feature/14b", runWorktreePath(ROOT, "14b"), "origin/alpha"]),
      ).length,
    ).toBe(1);
    // The existence test runs first.
    expect(callsOf(calls, (c) => c[0] === "sbx" && c[3] === "test")[0]).toEqual([
      "sbx",
      "exec",
      NAME,
      "test",
      "-d",
      runWorktreePath(ROOT, "14b"),
    ]);
    // The identity comes from the host repository.
    expect(callsOf(calls, (c) => c[0] === "git" && c[3] === "config")[0]).toEqual([
      "git",
      "-C",
      ROOT,
      "config",
      "user.name",
    ]);
  });

  test("respects --base", async () => {
    const deps = await makeDeps();
    const { calls, runner } = fakeRunner((cmd) => (cmd[0] === "sbx" && cmd[3] === "test" ? { exitCode: 1 } : {}));
    const code = worktree({ step: "x", base: "main" }, deps.env as never, { ...deps, runner });
    expect(code).toBe(0);
    expect(callsOf(calls, (c) => c.includes("worktree") && c.includes("origin/main")).length).toBe(1);
  });

  test("says so and exits 0 when the worktree exists", async () => {
    const deps = await makeDeps();
    const { calls, runner } = fakeRunner((cmd) => (cmd[3] === "test" ? { exitCode: 0 } : {}));
    const code = worktree({ step: "14b" }, deps.env as never, { ...deps, runner });
    expect(code).toBe(0);
    // No fetch, no config, no add after the existence test.
    expect(callsOf(calls, (c) => c[3] === "git").length).toBe(0);
  });

  test("stops with a clear error in host mode (no sandbox state)", async () => {
    const deps = await makeDeps();
    const { runner } = fakeRunner(() => ({}));
    const code = worktree({ step: "14b" }, deps.env as never, {
      ...deps,
      runner,
      sandboxState: () => null,
    });
    expect(code).toBe(1);
  });
});

describe("worktree rm", () => {
  test("removes the worktree and deletes the branch inside the clone", async () => {
    const deps = await makeDeps();
    const { calls, runner } = fakeRunner(() => ({}));
    const code = worktreeRm({ step: "14b" }, deps.env as never, { ...deps, runner });
    expect(code).toBe(0);
    expect(callsOf(calls, (c) => isSbxGit(c, ["worktree", "remove", "--force", runWorktreePath(ROOT, "14b")])).length).toBe(1);
    expect(callsOf(calls, (c) => isSbxGit(c, ["branch", "-D", "feature/14b"])).length).toBe(1);
  });

  test("stops with a clear error in host mode", async () => {
    const deps = await makeDeps();
    const code = worktreeRm({ step: "14b" }, deps.env as never, { ...deps, sandboxState: () => null });
    expect(code).toBe(1);
  });
});

describe("fetch", () => {
  test("fetches the sandbox remote on the host and lists the branches", async () => {
    const deps = await makeDeps();
    const { calls, runner } = fakeRunner((cmd) => {
      if (cmd[3] === "for-each-ref") {
        return { stdout: `sandbox-${NAME}/feature/x\nsandbox-${NAME}/feature/y\n` };
      }
      if (cmd[3] === "rev-list" && cmd[cmd.length - 1]!.endsWith("/feature/x")) return { stdout: "3\n" };
      if (cmd[3] === "rev-list") return { stdout: "0\n" };
      return {};
    });
    const code = fetch({}, deps.env as never, { ...deps, runner });
    expect(code).toBe(0);
    // The fetch and the listing run on the host, without sbx exec.
    expect(callsOf(calls, (c) => JSON.stringify(c) === JSON.stringify(["git", "-C", ROOT, "fetch", `sandbox-${NAME}`])).length).toBe(1);
    expect(callsOf(calls, (c) => c[0] === "sbx").length).toBe(0);
    expect(callsOf(calls, (c) => c[3] === "rev-list" && c[c.length - 1] === `alpha..sandbox-${NAME}/feature/x`).length).toBe(1);
  });

  test("prints the branch list and the review commands", async () => {
    const deps = await makeDeps();
    const logs: string[] = [];
    const original = console.log;
    console.log = (line: string) => logs.push(line);
    try {
      const { runner } = fakeRunner((cmd) =>
        cmd[3] === "for-each-ref" ? { stdout: `sandbox-${NAME}/feature/x\n` } : cmd[3] === "rev-list" ? { stdout: "3\n" } : {},
      );
      const code = fetch({}, deps.env as never, { ...deps, runner });
      expect(code).toBe(0);
    } finally {
      console.log = original;
    }
    expect(logs).toContain(`sandbox-${NAME}/feature/x (+3 over alpha)`);
    expect(logs).toContain(`review: git diff alpha...sandbox-${NAME}/feature/x`);
    expect(logs).toContain(`merge:  git merge --squash sandbox-${NAME}/feature/x`);
  });

  test("says so when no feature branch exists", async () => {
    const deps = await makeDeps();
    const logs: string[] = [];
    const original = console.log;
    console.log = (line: string) => logs.push(line);
    try {
      const { runner } = fakeRunner(() => ({ stdout: "" }));
      const code = fetch({}, deps.env as never, { ...deps, runner });
      expect(code).toBe(0);
    } finally {
      console.log = original;
    }
    expect(logs).toContain(`no feature branches on sandbox-${NAME}`);
  });

  test("stops with a clear error in host mode", async () => {
    const deps = await makeDeps();
    const code = fetch({}, deps.env as never, { ...deps, sandboxState: () => null });
    expect(code).toBe(1);
  });
});
