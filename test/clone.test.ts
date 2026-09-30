import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fetch, HOST_REMOTE, HOST_SOURCE, runWorktreePath, worktree, worktreeRm, type CloneDeps } from "../src/clone";
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
    // Default answers: commands succeed, but `test -d <folder>` fails, like
    // a folder that git has just removed.
    const { stdout = "", exitCode = cmd[3] === "test" && cmd[4] === "-d" ? 1 : 0 } = answer(cmd);
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
  const deps: CloneDeps = {
    runner: () => ({ stdout: "", exitCode: 0 }),
    sandboxState: () => STATE,
    projectName: () => "test",
    setupCommand: () => undefined,
    dispose: async () => {},
    sleep: async () => {},
  };
  return { env, ...deps, ...overrides };
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
  test("adds the host remote, fetches it, sets the host identity, and adds the worktree from host/alpha", async () => {
    const deps = await makeDeps();
    const { calls, runner } = fakeRunner((cmd) => {
      // The worktree does not exist yet.
      if (cmd[0] === "sbx" && cmd[3] === "test") return { exitCode: 1 };
      // A fresh clone has no remote `host` yet.
      if (isSbxGit(cmd, ["remote", "get-url", "host"])) return { exitCode: 2 };
      if (cmd[0] === "git" && cmd[3] === "config") {
        return { stdout: cmd[4] === "user.name" ? "Ada Lovelace\n" : "ada@example.com\n" };
      }
      return {};
    });
    const code = worktree({ step: "14b" }, deps.env as never, { ...deps, runner });
    expect(code).toBe(0);

    // The exact sbx commands, in order: the existence test, the host remote,
    // the fetch, the two identity configs, and the worktree add from host/alpha.
    expect(HOST_REMOTE).toBe("host");
    expect(HOST_SOURCE).toBe("/run/sandbox/source");
    const gitCalls = callsOf(calls, (c) => c[0] === "sbx" && c[3] === "git").map((c) => c.slice(6));
    expect(gitCalls).toEqual([
      ["remote", "get-url", "host"],
      ["remote", "add", "host", "/run/sandbox/source"],
      ["fetch", "-q", "host"],
      ["config", "user.name", "Ada Lovelace"],
      ["config", "user.email", "ada@example.com"],
      ["worktree", "add", "-b", "feature/14b", runWorktreePath(ROOT, "14b"), "host/alpha"],
    ]);
    // It never fetches origin: the clone copies the remotes of the host, and
    // an SSH origin is out of reach in the sandbox.
    expect(callsOf(calls, (c) => c.includes("origin")).length).toBe(0);
    expect(callsOf(calls, (c) => isSbxGit(c, ["config", "user.name", "Ada Lovelace"])).length).toBe(1);
    expect(callsOf(calls, (c) => isSbxGit(c, ["config", "user.email", "ada@example.com"])).length).toBe(1);
    expect(
      callsOf(calls, (c) =>
        isSbxGit(c, ["worktree", "add", "-b", "feature/14b", runWorktreePath(ROOT, "14b"), "host/alpha"]),
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
    expect(callsOf(calls, (c) => c.includes("worktree") && c.includes("host/main")).length).toBe(1);
  });

  test("sets the URL of an existing host remote instead of adding it", async () => {
    const deps = await makeDeps();
    const { calls, runner } = fakeRunner((cmd) => {
      if (cmd[0] === "sbx" && cmd[3] === "test") return { exitCode: 1 };
      if (isSbxGit(cmd, ["remote", "get-url", "host"])) return { stdout: "/somewhere/else\n" };
      return {};
    });
    const code = worktree({ step: "x" }, deps.env as never, { ...deps, runner });
    expect(code).toBe(0);
    expect(callsOf(calls, (c) => isSbxGit(c, ["remote", "set-url", "host", HOST_SOURCE])).length).toBe(1);
    expect(callsOf(calls, (c) => isSbxGit(c, ["remote", "add", "host", HOST_SOURCE])).length).toBe(0);
  });

  test("stops when the host remote cannot be added", async () => {
    const deps = await makeDeps();
    const { calls, runner } = fakeRunner((cmd) => {
      if (cmd[0] === "sbx" && cmd[3] === "test") return { exitCode: 1 };
      if (isSbxGit(cmd, ["remote", "get-url", "host"])) return { exitCode: 2 };
      if (isSbxGit(cmd, ["remote", "add", "host", HOST_SOURCE])) return { exitCode: 1 };
      return {};
    });
    const errors: string[] = [];
    const err = console.error;
    console.error = (line: string) => errors.push(line);
    let code: number;
    try {
      code = worktree({ step: "x" }, deps.env as never, { ...deps, runner });
    } finally {
      console.error = err;
    }
    expect(code).toBe(1);
    expect(errors).toEqual([`error: git remote add host failed in the clone of ${NAME}`]);
    expect(callsOf(calls, (c) => c.includes("fetch")).length).toBe(0);
  });

  test("stops when the fetch of the host remote fails", async () => {
    const deps = await makeDeps();
    const { calls, runner } = fakeRunner((cmd) => {
      if (cmd[0] === "sbx" && cmd[3] === "test") return { exitCode: 1 };
      if (isSbxGit(cmd, ["fetch", "-q", "host"])) return { exitCode: 1 };
      return {};
    });
    const errors: string[] = [];
    const err = console.error;
    console.error = (line: string) => errors.push(line);
    let code: number;
    try {
      code = worktree({ step: "x" }, deps.env as never, { ...deps, runner });
    } finally {
      console.error = err;
    }
    expect(code).toBe(1);
    expect(errors).toEqual([`error: git fetch host failed in the clone of ${NAME}`]);
    expect(callsOf(calls, (c) => c.includes("worktree")).length).toBe(0);
  });

  test("says so and exits 0 when the worktree exists and git knows it", async () => {
    const deps = await makeDeps();
    const { calls, runner } = fakeRunner((cmd) => (cmd[3] === "test" ? { exitCode: 0 } : cmd.includes("rev-parse") ? { stdout: "/repo/.git/worktrees/14b\n" } : {}));
    const code = worktree({ step: "14b" }, deps.env as never, { ...deps, runner });
    expect(code).toBe(0);
    // No fetch, no config, no add after the existence test.
    expect(callsOf(calls, (c) => c[3] === "git" && !c.includes("rev-parse")).length).toBe(0);
    // The registration check runs git inside the folder, not at the root.
    expect(callsOf(calls, (c) => c[3] === "git" && c.includes("rev-parse"))[0]).toEqual([
      "sbx",
      "exec",
      NAME,
      "git",
      "-C",
      runWorktreePath(ROOT, "14b"),
      "rev-parse",
      "--git-dir",
    ]);
  });

  test("stops with an error when the folder exists but is not a registered worktree", async () => {
    const deps = await makeDeps();
    // The folder exists (test -d succeeds), but rev-parse fails: stale.
    const { calls, runner } = fakeRunner((cmd) => (cmd[3] === "test" ? { exitCode: 0 } : cmd.includes("rev-parse") ? { exitCode: 128 } : {}));
    const errors: string[] = [];
    const err = console.error;
    console.error = (line: string) => errors.push(line);
    let code: number;
    try {
      code = worktree({ step: "14b" }, deps.env as never, { ...deps, runner });
    } finally {
      console.error = err;
    }
    expect(code).toBe(1);
    expect(errors[0]).toContain(runWorktreePath(ROOT, "14b"));
    expect(errors[0]).toContain("oc-sub worktree rm 14b");
    // Nothing was added and nothing was fetched for a stale folder.
    expect(callsOf(calls, (c) => c.includes("worktree") && c.includes("add")).length).toBe(0);
    expect(callsOf(calls, (c) => c.includes("fetch")).length).toBe(0);
  });

  test("runs the setup command with the sandbox PATH after the worktree add", async () => {
    const deps = await makeDeps();
    const { calls, runner } = fakeRunner((cmd) => {
      if (cmd[0] === "sbx" && cmd[3] === "test") return { exitCode: 1 };
      // A faked `mise env --json` with one tool folder inside the installs dir.
      if (cmd[0] === "mise" && cmd[1] === "env") {
        return { stdout: JSON.stringify({ PATH: "/home/u/.local/share/mise/installs/bun/bin:/usr/bin" }) };
      }
      return {};
    });
    const code = worktree({ step: "14b" }, { ...deps.env, HOME: "/home/u" } as never, {
      ...deps,
      runner,
      setupCommand: (root) => (root === ROOT ? "bun install --frozen-lockfile" : undefined),
    });
    expect(code).toBe(0);
    // The setup runs after the worktree add.
    const indexOf = (predicate: (c: readonly string[]) => boolean) =>
      calls.findIndex((call) => predicate(call.cmd));
    const addIndex = indexOf((c) => c.includes("worktree") && c.includes("add"));
    const setupIndex = indexOf((c) => c.includes("sh") && c.includes("-c"));
    expect(addIndex).toBeGreaterThanOrEqual(0);
    expect(setupIndex).toBeGreaterThan(addIndex);
    // The exact setup command, with the tool path from the faked mise env.
    expect(calls[setupIndex]!.cmd).toEqual([
      "sbx",
      "exec",
      "-w",
      runWorktreePath(ROOT, "14b"),
      "-e",
      "PATH=/home/u/.local/share/mise/installs/bun/bin:/home/agent/.local/bin:/usr/local/share/npm-global/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      NAME,
      "sh",
      "-c",
      "exec 2>&1; bun install --frozen-lockfile",
    ]);
  });

  test("runs no setup without a setup command", async () => {
    const deps = await makeDeps();
    const { calls, runner } = fakeRunner((cmd) => (cmd[3] === "test" ? { exitCode: 1 } : {}));
    const code = worktree({ step: "14b" }, deps.env as never, { ...deps, runner, setupCommand: () => undefined });
    expect(code).toBe(0);
    expect(callsOf(calls, (c) => c.includes("sh") && c.includes("-c")).length).toBe(0);
    expect(callsOf(calls, (c) => c[0] === "mise").length).toBe(0);
  });

  test("runs no setup with --no-setup", async () => {
    const deps = await makeDeps();
    const { calls, runner } = fakeRunner((cmd) => (cmd[3] === "test" ? { exitCode: 1 } : {}));
    const code = worktree({ step: "14b", noSetup: true }, deps.env as never, {
      ...deps,
      runner,
      setupCommand: () => "bun install",
    });
    expect(code).toBe(0);
    expect(callsOf(calls, (c) => c.includes("sh") && c.includes("-c")).length).toBe(0);
    expect(callsOf(calls, (c) => c[0] === "mise").length).toBe(0);
  });

  test("runs no setup when the worktree already exists", async () => {
    const deps = await makeDeps();
    const { calls, runner } = fakeRunner((cmd) => (cmd[3] === "test" ? { exitCode: 0 } : cmd.includes("rev-parse") ? { stdout: "/repo/.git/worktrees/14b\n" } : {}));
    const code = worktree({ step: "14b" }, deps.env as never, {
      ...deps,
      runner,
      setupCommand: () => "bun install",
    });
    expect(code).toBe(0);
    expect(callsOf(calls, (c) => c.includes("sh") && c.includes("-c")).length).toBe(0);
  });

  test("fails with exit 1 and keeps the worktree when the setup command fails", async () => {
    const deps = await makeDeps();
    const { calls, runner } = fakeRunner((cmd) => {
      if (cmd[0] === "sbx" && cmd[3] === "test") return { exitCode: 1 };
      if (cmd.includes("sh") && cmd.includes("-c")) return { stdout: "some setup output\n", exitCode: 7 };
      return {};
    });
    const errors: string[] = [];
    const err = console.error;
    console.error = (line: string) => errors.push(line);
    let code: number;
    try {
      code = worktree({ step: "14b" }, { ...deps.env, HOME: "/home/u" } as never, {
        ...deps,
        runner,
        setupCommand: () => "bun install",
      });
    } finally {
      console.error = err;
    }
    expect(code).toBe(1);
    // The output, the error, and the exact command to run it again by hand.
    expect(errors).toContain("some setup output\n");
    expect(errors).toContain(`error: the setup command failed in ${runWorktreePath(ROOT, "14b")} (exit 7)`);
    const rerun = errors.find((line) => line.startsWith("run it again by hand: "));
    // Every argument is shell-quoted, so the user can paste the line as it is.
    expect(rerun).toStartWith(`run it again by hand: 'sbx' 'exec' '-w' '${runWorktreePath(ROOT, "14b")}'`);
    expect(rerun).toEndWith(`'sh' '-c' 'exec 2>&1; bun install'`);
    // The worktree stays: no `worktree remove` runs.
    expect(callsOf(calls, (c) => c.includes("worktree") && c.includes("remove")).length).toBe(0);
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
  test("disposes the instance, removes the worktree, and deletes the branch inside the clone", async () => {
    const deps = await makeDeps();
    const disposed: string[] = [];
    const { calls, runner } = fakeRunner(() => ({}));
    const code = await worktreeRm({ step: "14b" }, deps.env as never, {
      ...deps,
      runner,
      dispose: async (_url, directory) => {
        disposed.push(directory);
      },
    });
    expect(code).toBe(0);
    // The dispose runs before the remove, with the folder as directory.
    expect(disposed).toEqual([runWorktreePath(ROOT, "14b")]);
    expect(callsOf(calls, (c) => isSbxGit(c, ["worktree", "remove", "--force", runWorktreePath(ROOT, "14b")])).length).toBe(1);
    expect(callsOf(calls, (c) => isSbxGit(c, ["branch", "-D", "feature/14b"])).length).toBe(1);
    // No fallback when the first remove worked.
    expect(callsOf(calls, (c) => c.includes("rm") && c.includes("-rf")).length).toBe(0);
    expect(callsOf(calls, (c) => isSbxGit(c, ["worktree", "prune"])).length).toBe(0);
  });

  test("a failed dispose is only a warning and the removal continues", async () => {
    const deps = await makeDeps();
    const { calls, runner } = fakeRunner(() => ({}));
    const errors: string[] = [];
    const err = console.error;
    console.error = (line: string) => errors.push(line);
    let code: number;
    try {
      code = await worktreeRm({ step: "14b" }, deps.env as never, {
        ...deps,
        runner,
        dispose: async () => {
          throw new Error("connection refused");
        },
      });
    } finally {
      console.error = err;
    }
    expect(code).toBe(0);
    expect(errors[0]).toContain("disposing the opencode instance");
    expect(callsOf(calls, (c) => isSbxGit(c, ["worktree", "remove", "--force", runWorktreePath(ROOT, "14b")])).length).toBe(1);
  });

  test("a failing remove prints its stderr, waits two seconds, and retries once", async () => {
    const deps = await makeDeps();
    let attempts = 0;
    const waits: number[] = [];
    const { calls, runner } = fakeRunner((cmd) => {
      if (isSbxGit(cmd, ["worktree", "remove", "--force", runWorktreePath(ROOT, "14b")])) {
        attempts += 1;
        // The first attempt fails, the second one succeeds.
        return attempts === 1 ? { stderr: "fatal: cache still held\n", exitCode: 1 } : {};
      }
      return {};
    });
    const code = await worktreeRm({ step: "14b" }, deps.env as never, {
      ...deps,
      runner,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    expect(code).toBe(0);
    expect(attempts).toBe(2);
    expect(waits).toEqual([2000]);
    expect(callsOf(calls, (c) => c.includes("rm") && c.includes("-rf")).length).toBe(0);
  });

  test("a remove that fails twice falls back to rm -rf and worktree prune, and reports the failure", async () => {
    const deps = await makeDeps();
    const { calls, runner } = fakeRunner((cmd) => {
      // The folder exists while git tries to remove it, and is gone after
      // the rm -rf fallback: `test -d` succeeds before it, fails after.
      if (cmd[3] === "test" && cmd[4] === "-d") {
        const pruned = callsOf(calls, (c) => isSbxGit(c, ["worktree", "prune"]));
        return { exitCode: pruned.length === 0 ? 0 : 1 };
      }
      if (isSbxGit(cmd, ["worktree", "remove", "--force", runWorktreePath(ROOT, "14b")])) return { stderr: "device busy\n", exitCode: 1 };
      return {};
    });
    const errors: string[] = [];
    const err = console.error;
    console.error = (line: string) => errors.push(line);
    let code: number;
    try {
      code = await worktreeRm({ step: "14b" }, deps.env as never, { ...deps, runner });
    } finally {
      console.error = err;
    }
    // Nothing is left, but the removal did not succeed cleanly: exit 1.
    expect(code).toBe(1);
    expect(errors[0]).toContain("git worktree remove failed twice");
    expect(callsOf(calls, (c) => isSbxGit(c, ["worktree", "remove", "--force", runWorktreePath(ROOT, "14b")])).length).toBe(2);
    expect(callsOf(calls, (c) => c[3] === "rm" && c.includes("-rf") && c.includes(runWorktreePath(ROOT, "14b"))).length).toBe(1);
    expect(callsOf(calls, (c) => isSbxGit(c, ["worktree", "prune"])).length).toBe(1);
  });

  test("a folder that survives even the fallback fails with exit 1", async () => {
    const deps = await makeDeps();
    const { runner } = fakeRunner((cmd) => {
      if (cmd[3] === "test" && cmd[4] === "-d") return { exitCode: 0 };
      if (isSbxGit(cmd, ["worktree", "remove", "--force", runWorktreePath(ROOT, "14b")])) return { stderr: "device busy\n", exitCode: 1 };
      return {};
    });
    const errors: string[] = [];
    const err = console.error;
    console.error = (line: string) => errors.push(line);
    let code: number;
    try {
      code = await worktreeRm({ step: "14b" }, deps.env as never, { ...deps, runner });
    } finally {
      console.error = err;
    }
    expect(code).toBe(1);
    expect(errors[0]).toContain(`folder ${runWorktreePath(ROOT, "14b")}`);
  });

  test("a branch that survives the deletion fails with exit 1", async () => {
    const deps = await makeDeps();
    const { runner } = fakeRunner((cmd) => {
      if (isSbxGit(cmd, ["worktree", "remove", "--force", runWorktreePath(ROOT, "14b")])) return { stderr: "device busy\n", exitCode: 1 };
      if (isSbxGit(cmd, ["branch", "--list", "feature/14b"])) return { stdout: "feature/14b\n" };
      return {};
    });
    const errors: string[] = [];
    const err = console.error;
    console.error = (line: string) => errors.push(line);
    let code: number;
    try {
      code = await worktreeRm({ step: "14b" }, deps.env as never, { ...deps, runner });
    } finally {
      console.error = err;
    }
    expect(code).toBe(1);
    expect(errors[0]).toContain("branch feature/14b");
  });

  test("stops with a clear error in host mode", async () => {
    const deps = await makeDeps();
    const code = await worktreeRm({ step: "14b" }, deps.env as never, { ...deps, sandboxState: () => null });
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
