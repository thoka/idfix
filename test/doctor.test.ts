import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gateForCommand } from "../src/doctor";
import { main } from "../src/cli";
import { UsageError, parseArgs } from "../src/args";
import {
  ALL_CHECKS,
  FAST_CHECKS,
  PLUGIN_KEY,
  PLUGIN_UPDATE_FIX,
  defaultReplaceWithSymlink,
  gateFastChecks,
  globalMiseConfigPath,
  globalRulesFix,
  isPermissionOnlyAgent,
  kvmAccessRootFix,
  doctor,
  makeDoctorDeps,
  miseToolVersion,
  pluginFreshFix,
  runChecks,
  runFastChecksFor,
  runFixes,
  sandboxMountsFix,
  SERVER_PLUGIN_FIX,
  serverPluginFix,
  SLOW_CHECKS,
  type Check,
  type CheckResult,
  type DoctorDeps,
} from "../src/doctor";
import type { BusyCheck, RunningServer } from "../src/server-plugin";
import {
  cloneCheckCommand,
  kvmAccessCheck,
  hostRefsKeepingCommit,
  missingCloneMessage,
  parseFeatureBranches,
  parseWorktrees,
  recreateSandbox,
  requiredSandboxMounts,
  sandboxRecreateFix,
  type KvmDeps,
} from "../src/sandbox";

/** The synced plugin folder of the fake deps. */
const PLUGIN_DIR = "/home/u/.local/share/oc-sub/opencode";

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "oc-sub-doctor-"));
}

/** A fake file system: a map of path to metadata, content, or folder entries. */
type FakeFs = {
  files: Map<string, { link?: string; content?: string }>;
  folders: Map<string, string[]>;
};

function makeDeps(fs: Partial<FakeFs> = {}, overrides: Partial<DoctorDeps> = {}): DoctorDeps {
  const files = fs.files ?? new Map();
  const folders = fs.folders ?? new Map();
  const deps: DoctorDeps = {
    lstat: (file) => {
      const entry = files.get(file);
      if (entry === undefined) return null;
      return { isSymbolicLink: entry.link !== undefined };
    },
    readlink: (file) => files.get(file)?.link ?? null,
    readdir: (folder) => folders.get(folder) ?? null,
    exists: (file) => files.has(file),
    readText: (file) => files.get(file)?.content ?? null,
    realpath: (file) => {
      // Resolve one level of symlink into a canonical fake path.
      const entry = files.get(file);
      if (entry === undefined) return null;
      if (entry.link === undefined) return path.resolve(file);
      const target = files.get(entry.link);
      return target === undefined ? null : path.resolve(entry.link);
    },
    home: "/home/u",
    root: "/repo",
    sharedDir: "/home/u/dv/meta/agents",
    installsDir: "/home/u/.local/share/mise/installs",
    pluginSource: "/plugin/opencode",
    pluginDir: PLUGIN_DIR,
    projectName: "repo",
    pluginRepoRoot: "/plugin",
    installedPluginsFile: "/home/u/.claude/plugins/installed_plugins.json",
    originAlphaSha: () => "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    sandboxState: () => null,
    sandboxBin: "sbx",
    runner: () => ({ stdout: "", exitCode: 0 }),
    claudeBin: "claude",
    claudeRunner: () => ({ stdout: "", exitCode: 0 }),
    // No test may call the real mise. Without /plugin/mise.toml in the fake
    // file system, opencode-version skips before it calls the runner.
    miseBin: "mise",
    miseRunner: () => {
      throw new Error("the mise runner must not run in this test");
    },
    globalMiseConfig: "/home/u/.config/mise/config.toml",
    // The fake swap turns the file entry into a symlink entry, so a re-run of
    // the checks sees the fixed state.
    replaceWithSymlink: (file, target) => files.set(file, { link: target }),
    // /dev/kvm exists and is usable by default, so kvm-access passes.
    kvm: {
      platform: "linux",
      statDevice: () => ({ mode: 0o20666, uid: 0, gid: 990 }),
      canReadWrite: () => true,
    },
    rootRunner: () => {
      throw new Error("the root runner must not run in this test");
    },
    stdinIsTTY: true,
    // The plugin source and the synced folder hold the same content, and no
    // server runs, so server-plugin passes by default.
    pluginDigest: () => "sha256:same",
    syncPlugin: () => {
      throw new Error("the sync must not run in this test");
    },
    runningServers: () => [],
    restartServer: async () => {
      throw new Error("no server may restart in this test");
    },
    serverBusy: async () => {
      throw new Error("no serverBusy check may run in this test");
    },
    recreateSandbox: async () => {
      throw new Error("no sandbox may be recreated in this test");
    },
    // No DeepInfra key file by default, so deepinfra-key skips.
    deepinfraKeyFile: "/home/u/.config/repo/deepinfra.key",
    fileMode: () => null,
    ...overrides,
  };
  return deps;
}

function map<T>(entries: Record<string, T>): Map<string, T> {
  return new Map(Object.entries(entries));
}

function byName(resultsList: CheckResult[], name: string): CheckResult | undefined {
  return resultsList.find((check) => check.name === name);
}

function results(deps: DoctorDeps, checks = FAST_CHECKS): CheckResult[] {
  return runChecks(checks, deps);
}

const PERMISSION_ONLY = `---
permission:
  bash:
    "*": allow
    "bun test*": allow
---
`;

const FULL_AGENT = `---
description: The coder
model: openrouter/z-ai/glm-5.3-flash
permission:
  bash: allow
---

The prompt body.
`;

describe("isPermissionOnlyAgent", () => {
  test("accepts a permission-only file with an empty body", () => {
    expect(isPermissionOnlyAgent(PERMISSION_ONLY)).toBe(true);
  });

  test("rejects a full agent copy", () => {
    expect(isPermissionOnlyAgent(FULL_AGENT)).toBe(false);
  });

  test("rejects a file without frontmatter or with a body", () => {
    expect(isPermissionOnlyAgent("no frontmatter")).toBe(false);
    expect(isPermissionOnlyAgent("---\npermission: {}\n---\nbody\n")).toBe(false);
  });
});

describe("env-files", () => {
  test("passes without env files", () => {
    const check = byName(results(makeDeps()), "env-files");
    expect(check?.status).toBe("pass");
  });

  test("passes for example and sample files", () => {
    const deps = makeDeps({ folders: map({ "/repo": [".env.example", ".env.sample"] }) });
    expect(byName(results(deps), "env-files")?.status).toBe("pass");
  });

  test("fails for a .env in the project root without opening it", () => {
    const deps = makeDeps({ folders: map({ "/repo": [".env"] }) });
    const check = byName(results(deps), "env-files");
    expect(check?.status).toBe("fail");
    expect(check?.fix).toContain(".config/repo/openrouter.key");
  });

  test("fails for a .env in a worktree", () => {
    const deps = makeDeps({
      folders: map({ "/repo": [], "/repo/.worktrees": ["13-step"], "/repo/.worktrees/13-step": [".env.local"] }),
    });
    const check = byName(results(deps), "env-files");
    expect(check?.status).toBe("fail");
    expect(check?.message).toContain(".worktrees/13-step/.env.local");
  });
});

describe("claude-md", () => {
  test("passes without the files", () => {
    expect(byName(results(makeDeps()), "claude-md")?.status).toBe("pass");
  });

  test("fails for CLAUDE.md", () => {
    const deps = makeDeps({ files: map({ "/repo/CLAUDE.md": { content: "# rules" } }) });
    const check = byName(results(deps), "claude-md");
    expect(check?.status).toBe("fail");
    expect(check?.fix).toContain("AGENTS.md");
  });
});

describe("agents-md", () => {
  test("passes with AGENTS.md", () => {
    const deps = makeDeps({ files: map({ "/repo/AGENTS.md": { content: "# rules" } }) });
    expect(byName(results(deps), "agents-md")?.status).toBe("pass");
  });

  test("warns without AGENTS.md", () => {
    expect(byName(results(makeDeps()), "agents-md")?.status).toBe("warn");
  });
});

describe("global-rules", () => {
  const sharedFile = "/home/u/dv/meta/agents/AGENTS.md";
  const links = {
    "/home/u/.claude/CLAUDE.md": { link: sharedFile },
    "/home/u/.config/opencode/AGENTS.md": { link: sharedFile },
    "/home/u/.codex/AGENTS.md": { link: sharedFile },
  };

  test("passes when all three are symlinks to the shared file", () => {
    const deps = makeDeps({ files: map({ ...links, [sharedFile]: { content: "# rules" } }) });
    expect(byName(results(deps), "global-rules")?.status).toBe("pass");
  });

  test("warns for a missing path", () => {
    const deps = makeDeps({ files: map({ [sharedFile]: { content: "# rules" } }) });
    expect(byName(results(deps), "global-rules")?.status).toBe("warn");
  });

  test("fails for a regular file copy", () => {
    const deps = makeDeps({
      files: map({ ...links, [sharedFile]: { content: "# rules" }, "/home/u/.codex/AGENTS.md": { content: "# copy" } }),
    });
    const check = byName(results(deps), "global-rules");
    expect(check?.status).toBe("fail");
    expect(check?.message).toContain("regular files instead of symlinks");
  });

  test("fails for a broken link", () => {
    const deps = makeDeps({
      files: map({
        ...links,
        [sharedFile]: { content: "# rules" },
        "/home/u/.codex/AGENTS.md": { link: "/nowhere/AGENTS.md" },
      }),
    });
    const check = byName(results(deps), "global-rules");
    expect(check?.status).toBe("fail");
    expect(check?.message).toContain(".codex/AGENTS.md");
  });
});

describe("skill-links", () => {
  test("skips without skills folders", () => {
    expect(byName(results(makeDeps()), "skill-links")?.status).toBe("skip");
  });

  test("passes when every symlink resolves", () => {
    const deps = makeDeps({
      folders: map({ "/home/u/.claude/skills": ["oc-sub"], "/home/u/.agents/skills": [] }),
      files: map({
        "/home/u/.claude/skills/oc-sub": { link: "/skills/oc-sub" },
        "/skills/oc-sub": {},
      }),
    });
    expect(byName(results(deps), "skill-links")?.status).toBe("pass");
  });

  test("fails for a broken link and names it", () => {
    const deps = makeDeps({
      folders: map({ "/home/u/.claude/skills": ["gone"] }),
      files: map({ "/home/u/.claude/skills/gone": { link: "/nowhere/skill" } }),
    });
    const check = byName(results(deps), "skill-links");
    expect(check?.status).toBe("fail");
    expect(check?.message).toContain("gone");
  });
});

describe("agent-copies", () => {
  test("passes without agent files", () => {
    expect(byName(results(makeDeps()), "agent-copies")?.status).toBe("pass");
  });

  test("passes for a permission-only file", () => {
    const deps = makeDeps({ files: map({ "/repo/.opencode/agents/coder.md": { content: PERMISSION_ONLY } }) });
    expect(byName(results(deps), "agent-copies")?.status).toBe("pass");
  });

  test("fails for a full agent copy", () => {
    const deps = makeDeps({ files: map({ "/repo/.opencode/agents/researcher.md": { content: FULL_AGENT } }) });
    const check = byName(results(deps), "agent-copies");
    expect(check?.status).toBe("fail");
    expect(check?.message).toContain("researcher.md");
  });
});

describe("plugin-fresh", () => {
  // The real shape of ~/.claude/plugins/installed_plugins.json.
  const installed = JSON.stringify({
    version: 2,
    plugins: {
      [PLUGIN_KEY]: [{ scope: "user", installPath: "/cache/p/1", version: "c81121dba98f", gitCommitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }],
    },
  });

  test("skips without the installed plugins file", () => {
    expect(byName(results(makeDeps(), SLOW_CHECKS), "plugin-fresh")?.status).toBe("skip");
  });

  test("skips when the file has no plugins object", () => {
    const deps = makeDeps({ files: map({ "/home/u/.claude/plugins/installed_plugins.json": { content: '{"version": 2}' } }) });
    expect(byName(results(deps, SLOW_CHECKS), "plugin-fresh")?.status).toBe("skip");
  });

  test("skips when the plugins object has no entry for the plugin", () => {
    const other = JSON.stringify({ version: 2, plugins: { "other@market": [{ gitCommitSha: "aaaa" }] } });
    const deps = makeDeps({ files: map({ "/home/u/.claude/plugins/installed_plugins.json": { content: other } }) });
    expect(byName(results(deps, SLOW_CHECKS), "plugin-fresh")?.status).toBe("skip");
  });

  test("passes when the installed commit matches origin/alpha", () => {
    const deps = makeDeps({ files: map({ "/home/u/.claude/plugins/installed_plugins.json": { content: installed } }) });
    const check = byName(results(deps, SLOW_CHECKS), "plugin-fresh");
    expect(check?.status).toBe("pass");
  });

  test("warns when the installed commit differs", () => {
    const old = JSON.stringify({
      version: 2,
      plugins: { [PLUGIN_KEY]: [{ scope: "user", gitCommitSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }] },
    });
    const deps = makeDeps({
      files: map({ "/home/u/.claude/plugins/installed_plugins.json": { content: old } }),
    });
    const check = byName(results(deps, SLOW_CHECKS), "plugin-fresh");
    expect(check?.status).toBe("warn");
    expect(check?.fix).toBe(PLUGIN_UPDATE_FIX);
  });
});

describe("sandbox-mounts", () => {
  const mounts = requiredSandboxMounts(
    "/repo",
    PLUGIN_DIR,
    "/home/u/.local/share/mise/installs",
    "/home/u/dv/meta/agents",
  ).join(", ");
  const lsWithMounts = `NAME STATUS WORKSPACE\noc-sub-repo running /repo, ${mounts}\n`;
  const lsWithout = `NAME STATUS WORKSPACE\noc-sub-repo running /repo\n`;

  /** A runner that answers the git remote call for a clone-mode sandbox. */
  const cloneRunner = (ls: string) => (cmd: readonly string[]) =>
    cmd[0] === "git" ? { stdout: "sandbox-oc-sub-repo\n", exitCode: 0 } : { stdout: ls, exitCode: 0 };

  test("skips without a sandbox state", () => {
    expect(byName(results(makeDeps(), SLOW_CHECKS), "sandbox-mounts")?.status).toBe("skip");
  });

  test("passes when sbx ls lists all required mounts and the clone remote exists", () => {
    const deps = makeDeps(
      {},
      {
        runner: cloneRunner(lsWithMounts),
        sandboxState: () => ({ name: "oc-sub-repo", root: "/repo", port: 18768 }),
      },
    );
    expect(byName(results(deps, SLOW_CHECKS), "sandbox-mounts")?.status).toBe("pass");
  });

  test("fails with the sbx rm fix when a mount is missing", () => {
    const deps = makeDeps(
      {},
      {
        runner: cloneRunner(lsWithout),
        sandboxState: () => ({ name: "oc-sub-repo", root: "/repo", port: 18768 }),
      },
    );
    const check = byName(results(deps, SLOW_CHECKS), "sandbox-mounts");
    expect(check?.status).toBe("fail");
    expect(check?.fix).toContain("sbx rm --force oc-sub-repo");
  });

  test("names the synced plugin mount that a sandbox from before step 15c lacks", () => {
    // An old sandbox mounts the plugin folder of the oc-sub checkout, not the synced folder.
    const old = `NAME STATUS WORKSPACE\noc-sub-repo running /repo, /plugin/opencode:ro, /home/u/.local/share/mise/installs:ro, /home/u/dv/meta/agents:ro\n`;
    const deps = makeDeps(
      {},
      {
        runner: cloneRunner(old),
        sandboxState: () => ({ name: "oc-sub-repo", root: "/repo", port: 18768 }),
      },
    );
    const check = byName(results(deps, SLOW_CHECKS), "sandbox-mounts");
    expect(check?.status).toBe("fail");
    expect(check?.message).toBe(
      `the sandbox oc-sub-repo lacks the mounts ${PLUGIN_DIR}:ro (the synced plugin folder ${PLUGIN_DIR} is the plugin mount since oc-sub step 15c, so a sandbox created before it needs a recreate)`,
    );
    expect(check?.fix).toBe(sandboxRecreateFix("oc-sub-repo"));
  });

  test("passes for a stopped clone-mode sandbox, because the clone check starts it", () => {
    // `sbx stop` removes the `sandbox-<name>` remote, and the `sbx exec` of
    // the clone check starts the sandbox, which adds the remote again.
    let started = false;
    const deps = makeDeps(
      {},
      {
        runner: (cmd) => {
          if (cmd[1] === "exec") started = true;
          if (cmd[0] === "git") return { stdout: started ? "sandbox-oc-sub-repo\n" : "origin\n", exitCode: 0 };
          return { stdout: lsWithMounts, exitCode: 0 };
        },
        sandboxState: () => ({ name: "oc-sub-repo", root: "/repo", port: 18768 }),
      },
    );
    expect(byName(results(deps, SLOW_CHECKS), "sandbox-mounts")?.status).toBe("pass");
  });

  test("fails with the sbx rm fix when the sandbox is not in clone mode", () => {
    const deps = makeDeps(
      {},
      {
        // `git remote` lists no `sandbox-<name>`: an old direct-mount sandbox.
        runner: (cmd) => (cmd[0] === "git" ? { stdout: "origin\n", exitCode: 0 } : { stdout: lsWithMounts, exitCode: 0 }),
        sandboxState: () => ({ name: "oc-sub-repo", root: "/repo", port: 18768 }),
      },
    );
    const check = byName(results(deps, SLOW_CHECKS), "sandbox-mounts");
    expect(check?.status).toBe("fail");
    expect(check?.message).toContain("not in clone mode");
    expect(check?.fix).toContain("sbx rm --force oc-sub-repo");
    expect(check?.fix).toContain("clone mode");
  });

  test("fails with the sbx rm --force fix when the sandbox has no clone", () => {
    const calls: string[][] = [];
    const deps = makeDeps(
      {},
      {
        runner: (cmd) => {
          calls.push([...cmd]);
          if (cmd[0] === "git") return { stdout: "sandbox-oc-sub-repo\n", exitCode: 0 };
          // `git rev-parse --git-dir` fails inside the sandbox: no clone.
          if (cmd[1] === "exec") return { stdout: "", exitCode: 128 };
          return { stdout: lsWithMounts, exitCode: 0 };
        },
        sandboxState: () => ({ name: "oc-sub-repo", root: "/repo", port: 18768 }),
      },
    );
    const check = byName(results(deps, SLOW_CHECKS), "sandbox-mounts");
    expect(check?.status).toBe("fail");
    expect(check?.message).toBe(missingCloneMessage("oc-sub-repo", "/repo"));
    expect(check?.fix).toBe(sandboxRecreateFix("oc-sub-repo"));
    expect(calls).toContainEqual(cloneCheckCommand("sbx", "oc-sub-repo", "/repo"));
  });

  test("passes without the mount of a folder inside the project root", () => {
    // The project meta: the shared agents folder lies inside the root, so
    // `up` does not mount it and the check must not ask for it.
    const root = "/home/u/dv/meta";
    const ls = `NAME STATUS WORKSPACE\noc-sub-repo running ${root}, ${PLUGIN_DIR}:ro, /home/u/.local/share/mise/installs:ro\n`;
    const deps = makeDeps(
      {},
      {
        runner: cloneRunner(ls),
        sandboxState: () => ({ name: "oc-sub-repo", root, port: 18768 }),
      },
    );
    expect(byName(results(deps, SLOW_CHECKS), "sandbox-mounts")?.status).toBe("pass");
  });
});

describe("gateFastChecks", () => {
  const pass: CheckResult = { name: "x", status: "pass", message: "ok" };
  const warn: CheckResult = { name: "w", status: "warn", message: "careful" };
  const fail: CheckResult = { name: "f", status: "fail", message: "bad", fix: "do this" };

  test("continues on pass and warn, stops on fail", () => {
    const lines: string[] = [];
    expect(gateFastChecks([pass, warn], 1, (line) => lines.push(line))).toBe(true);
    expect(gateFastChecks([fail], 1, (line) => lines.push(line))).toBe(false);
    expect(lines).toContain("fix: do this");
    expect(lines).toContain("run oc-sub doctor for details");
    expect(lines).toContain("warning: w: careful");
  });

  test("warns when the fast checks take over 50 ms", () => {
    const lines: string[] = [];
    gateFastChecks([pass], 80, (line) => lines.push(line));
    expect(lines.some((line) => line.includes("80 ms"))).toBe(true);
  });
});

describe("runFastChecksFor with the real file system", () => {
  test("reports a real project folder", () => {
    const dir = tempDir();
    try {
      mkdirSync(path.join(dir, ".worktrees"), { recursive: true });
      writeFileSync(path.join(dir, "AGENTS.md"), "# rules\n");
      const { results: list } = runFastChecksFor(
        { HOME: "/home/u" } as Record<string, string>,
        dir,
        { home: "/home/u" },
      );
      expect(list).toHaveLength(FAST_CHECKS.length);
      expect(byName(list, "agents-md")?.status).toBe("pass");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("main stops up and run on a failed fast check", () => {
  test("sandbox up returns 1 before the sandbox code runs", async () => {
    const dir = tempDir();
    try {
      writeFileSync(path.join(dir, "CLAUDE.md"), "# rules\n");
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});
      try {
        const code = await main(["up", "--dir", dir]);
        expect(code).toBe(1);
        expect(errorSpy.mock.calls.map(String).join("\n")).toContain("run oc-sub doctor for details");
      } finally {
        errorSpy.mockRestore();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("run returns 1 before it contacts the server", async () => {
    const dir = tempDir();
    try {
      writeFileSync(path.join(dir, "CLAUDE.md"), "# rules\n");
      const fetchSpy = spyOn(globalThis, "fetch");
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});
      try {
        const code = await main(["run", "--agent", "coder", "--dir", dir, "hello"]);
        expect(code).toBe(1);
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
        errorSpy.mockRestore();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("gateForCommand checks the project root for a clone-mode run folder", () => {
    // The run folder of clone mode exists only inside the sandbox. The gate
    // must map it to the project root and pass there, instead of failing on
    // the missing folder.
    const dir = tempDir();
    try {
      writeFileSync(path.join(dir, "AGENTS.md"), "# rules\n");
      const runFolder = path.join(dir, ".worktrees", "14b");
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});
      try {
        const ok = gateForCommand({ dir: runFolder }, { HOME: "/home/u" }, {
          home: "/home/u",
          root: dir,
          sharedDir: "/home/u/dv/meta/agents",
        });
        expect(ok).toBe(true);
        expect(errorSpy.mock.calls.map(String).join("\n")).not.toContain("FAIL");
      } finally {
        errorSpy.mockRestore();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("host up checks the current folder and returns 1", async () => {
    const dir = tempDir();
    const previous = process.cwd();
    try {
      writeFileSync(path.join(dir, "CLAUDE.md"), "# rules\n");
      process.chdir(dir);
      const fetchSpy = spyOn(globalThis, "fetch");
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});
      try {
        const code = await main(["up", "--no-sandbox", "--url", "http://127.0.0.1:59999"]);
        expect(code).toBe(1);
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
        errorSpy.mockRestore();
      }
    } finally {
      process.chdir(previous);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("gateForCommand continues on a clean project", () => {
    const dir = tempDir();
    try {
      writeFileSync(path.join(dir, "AGENTS.md"), "# rules\n");
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});
      try {
        const ok = gateForCommand({ dir }, { HOME: "/home/u" }, {
          home: "/home/u",
          root: dir,
          sharedDir: "/home/u/dv/meta/agents",
        });
        expect(ok).toBe(true);
        expect(errorSpy.mock.calls.map(String).join("\n")).not.toContain("FAIL");
      } finally {
        errorSpy.mockRestore();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the registry", () => {
  test("runs every check without throwing on an empty file system", () => {
    const list = runChecks(ALL_CHECKS, makeDeps());
    expect(list).toHaveLength(ALL_CHECKS.length);
    for (const check of list) expect(check.message.length).toBeGreaterThan(0);
  });
});

describe("global-rules with the real file system", () => {
  test("follows a real symlink to the shared file and warns for the rest", () => {
    const home = tempDir();
    try {
      const shared = path.join(home, "dv", "meta", "agents");
      mkdirSync(shared, { recursive: true });
      writeFileSync(path.join(shared, "AGENTS.md"), "# rules\n");
      mkdirSync(path.join(home, ".claude"), { recursive: true });
      symlinkSync(path.join(shared, "AGENTS.md"), path.join(home, ".claude", "CLAUDE.md"));
      const deps = makeDoctorDeps({ HOME: home } as Record<string, string>, home, {
        home,
        sharedDir: shared,
        sandboxState: () => null,
        originAlphaSha: () => null,
      });
      const check = byName(results(deps), "global-rules");
      expect(check?.status).toBe("warn");
      expect(check?.message).toContain(path.join(home, ".config", "opencode"));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("doctor --fix argument parsing", () => {
  test("parses --fix", () => {
    expect(parseArgs(["doctor", "--fix"])).toMatchObject({ command: "doctor", fix: true, force: false });
  });

  test("parses --fix --force", () => {
    expect(parseArgs(["doctor", "--fix", "--force"])).toMatchObject({ command: "doctor", fix: true, force: true });
  });

  test("rejects --force without --fix", () => {
    expect(() => parseArgs(["doctor", "--force"])).toThrow(UsageError);
  });
});

describe("the plugin-fresh fix", () => {
  const depsWithClaude = (calls: string[], exitCodes: number[]): DoctorDeps =>
    makeDeps(
      {},
      {
        claudeRunner: (cmd) => {
          calls.push(cmd.join(" "));
          return { stdout: "", exitCode: exitCodes.shift() ?? 0 };
        },
      },
    );

  test("runs the marketplace update and then the plugin update", () => {
    const calls: string[] = [];
    const outcome = pluginFreshFix(depsWithClaude(calls, [0, 0]), {} as CheckResult, { force: false });
    expect(outcome.ok).toBe(true);
    expect(outcome.note).toContain(`plugin update ${PLUGIN_KEY}`);
    expect(calls).toEqual([
      "claude plugin marketplace update opencode-subagents",
      `claude plugin update ${PLUGIN_KEY}`,
    ]);
  });

  test("fails with the command in the note when the first command fails, and skips the second", () => {
    const calls: string[] = [];
    const outcome = pluginFreshFix(depsWithClaude(calls, [3]), {} as CheckResult, { force: false });
    expect(outcome.ok).toBe(false);
    expect(outcome.note).toContain("marketplace update");
    expect(calls).toHaveLength(1);
  });

  test("fails with the command in the note when the second command fails", () => {
    const calls: string[] = [];
    const outcome = pluginFreshFix(depsWithClaude(calls, [0, 2]), {} as CheckResult, { force: false });
    expect(outcome.ok).toBe(false);
    expect(outcome.note).toContain(`plugin update ${PLUGIN_KEY}`);
    expect(calls).toHaveLength(2);
  });
});

describe("the global-rules fix", () => {
  const sharedFile = "/home/u/dv/meta/agents/AGENTS.md";
  const claudeMd = "/home/u/.claude/CLAUDE.md";
  const opencodeMd = "/home/u/.config/opencode/AGENTS.md";
  const codexMd = "/home/u/.codex/AGENTS.md";
  const base = map({ [sharedFile]: { content: "# rules" } });

  test("replaces an equal copy with a symlink", () => {
    const deps = makeDeps({ files: map({ ...Object.fromEntries(base), [codexMd]: { content: "# rules" } }) });
    const outcome = globalRulesFix(deps, {} as CheckResult, { force: false });
    expect(outcome.ok).toBe(true);
    expect(outcome.note).toContain("replaced with symlinks");
    expect(deps.readlink(codexMd)).toBe(sharedFile);
  });

  test("leaves a differing copy alone and fails the fix", () => {
    const deps = makeDeps({ files: map({ ...Object.fromEntries(base), [codexMd]: { content: "# my own rules" } }) });
    const outcome = globalRulesFix(deps, {} as CheckResult, { force: false });
    expect(outcome.ok).toBe(false);
    expect(outcome.note).toContain("content differs, not changed");
    expect(deps.readText(codexMd)).toBe("# my own rules");
    expect(deps.lstat(codexMd)?.isSymbolicLink).toBe(false);
  });

  test("re-points a wrong or broken symlink", () => {
    const wrong = makeDeps({
      files: map({ ...Object.fromEntries(base), [codexMd]: { link: "/home/u/other/AGENTS.md" }, "/home/u/other/AGENTS.md": { content: "x" } }),
    });
    const outcomeWrong = globalRulesFix(wrong, {} as CheckResult, { force: false });
    expect(outcomeWrong.ok).toBe(true);
    expect(wrong.readlink(codexMd)).toBe(sharedFile);

    const broken = makeDeps({ files: map({ ...Object.fromEntries(base), [codexMd]: { link: "/nowhere/AGENTS.md" } }) });
    const outcomeBroken = globalRulesFix(broken, {} as CheckResult, { force: false });
    expect(outcomeBroken.ok).toBe(true);
    expect(broken.readlink(codexMd)).toBe(sharedFile);
  });

  test("does not create a missing path", () => {
    const deps = makeDeps({ files: base });
    const outcome = globalRulesFix(deps, {} as CheckResult, { force: false });
    expect(outcome.ok).toBe(true);
    expect(deps.exists(codexMd)).toBe(false);
    expect(deps.exists(claudeMd)).toBe(false);
  });

  test("fails without a shared file and changes nothing", () => {
    const deps = makeDeps({ files: map({ [codexMd]: { content: "# rules" } }) });
    const outcome = globalRulesFix(deps, {} as CheckResult, { force: false });
    expect(outcome.ok).toBe(false);
    expect(outcome.note).toContain("is missing");
    expect(deps.lstat(codexMd)?.isSymbolicLink).toBe(false);
  });
});

describe("runFixes", () => {
  const lines: string[] = [];
  const print = (line: string) => lines.push(line);

  test("catches a throwing action as a failed fix and runs the other actions", async () => {
    lines.length = 0;
    const checks: Check[] = [
      { name: "boom", run: () => ({ name: "boom", status: "fail", message: "bad" }), fix: () => { throw new Error("boom"); } },
      { name: "after", run: () => ({ name: "after", status: "warn", message: "meh" }), fix: () => ({ ok: true, note: "did it" }) },
    ];
    const deps = makeDeps();
    const records = await runFixes(
      checks,
      deps,
      [
        { name: "boom", status: "fail", message: "bad" },
        { name: "after", status: "warn", message: "meh" },
      ],
      { force: false },
      print,
    );
    expect(records).toEqual([
      { name: "boom", ok: false, note: "boom" },
      { name: "after", ok: true, note: "did it" },
    ]);
    expect(lines).toContain("fixing boom: bad");
    expect(lines).toContain("fix failed (boom): boom");
    expect(lines).toContain("fixed after: did it");
  });

  test("skips pass and skip results and checks without a fix action", async () => {
    lines.length = 0;
    const checks: Check[] = [{ name: "no-fix", run: () => ({ name: "no-fix", status: "fail", message: "bad" }) }];
    const records = await runFixes(checks, makeDeps(), [{ name: "no-fix", status: "fail", message: "bad" }], { force: false }, print);
    expect(records).toEqual([]);
    expect(lines).toEqual([]);
  });
});

describe("doctor --fix", () => {
  const sharedFile = "/home/u/dv/meta/agents/AGENTS.md";
  const codexMd = "/home/u/.codex/AGENTS.md";
  // The installed plugin commit differs from origin/alpha, so plugin-fresh warns.
  const installedOld = JSON.stringify({
    version: 2,
    plugins: { [PLUGIN_KEY]: [{ scope: "user", gitCommitSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }] },
  });

  function fixDeps(files: Record<string, { link?: string; content?: string }>, claudeExitCode = 0): DoctorDeps {
    return makeDeps(
      {
        files: map({ [sharedFile]: { content: "# rules" }, ...files }),
      },
      {
        installedPluginsFile: "/home/u/.claude/plugins/installed_plugins.json",
        claudeRunner: (cmd) => ({ stdout: cmd.join(" "), exitCode: claudeExitCode }),
      },
    );
  }

  test("fixes global-rules and plugin-fresh in registry order and prints the lines", async () => {
    const deps = fixDeps({ [codexMd]: { content: "# rules" }, "/home/u/.claude/plugins/installed_plugins.json": { content: installedOld } });
    const lines: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation((line) => lines.push(String(line)));
    let code: number;
    try {
      code = await doctor({ fix: true }, { HOME: "/home/u" } as Record<string, string>, deps);
    } finally {
      logSpy.mockRestore();
    }
    expect(code).toBe(0);
    const fixingRules = lines.findIndex((line) => line.startsWith("fixing global-rules:"));
    const fixedRules = lines.findIndex((line) => line.startsWith("fixed global-rules:"));
    const fixingPlugin = lines.findIndex((line) => line.startsWith("fixing plugin-fresh:"));
    const fixedPlugin = lines.findIndex((line) => line.startsWith("fixed plugin-fresh:"));
    expect(fixingRules).toBeGreaterThanOrEqual(0);
    expect(fixedRules).toBeGreaterThan(fixingRules);
    expect(fixingPlugin).toBeGreaterThan(fixedRules);
    expect(fixedPlugin).toBeGreaterThan(fixingPlugin);
    expect(lines[fixingRules]).toContain("ln -sfn");
    expect(lines[fixingPlugin]).toContain(PLUGIN_UPDATE_FIX);
    // The re-run prints the results after the fixes: the fixed copy now links,
    // the other two rule paths stay missing (a missing path is not created).
    expect(lines.findIndex((line) => line.startsWith("warn  global-rules"))).toBeGreaterThan(fixedPlugin);
    expect(lines[lines.length - 1]!).toMatch(/, 0 fail, /);
    expect(deps.readlink(codexMd)).toBe(sharedFile);
  });

  test("returns 1 when a fix fails", async () => {
    const deps = fixDeps({ [codexMd]: { content: "# my own rules" } });
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    let code: number;
    try {
      code = await doctor({ fix: true }, { HOME: "/home/u" } as Record<string, string>, deps);
    } finally {
      logSpy.mockRestore();
    }
    expect(code).toBe(1);
  });

  test("returns 1 when the re-run still has a fail", async () => {
    // The claude fix fails, so plugin-fresh stays a warn (not a fail), but a
    // differing copy keeps global-rules failed in the re-run too.
    const deps = fixDeps({ [codexMd]: { content: "# my own rules" } });
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    let code: number;
    try {
      code = await doctor({ fix: true }, { HOME: "/home/u" } as Record<string, string>, deps);
    } finally {
      logSpy.mockRestore();
    }
    expect(code).toBe(1);
  });

  test("prints {fixes, results} with --fix --json", async () => {
    const deps = fixDeps({
      [codexMd]: { content: "# rules" },
      "/home/u/.claude/plugins/installed_plugins.json": { content: installedOld },
    });
    const lines: string[] = [];
    const errors: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation((line) => lines.push(String(line)));
    const errorSpy = spyOn(console, "error").mockImplementation((line) => errors.push(String(line)));
    try {
      await doctor({ fix: true, json: true }, { HOME: "/home/u" } as Record<string, string>, deps);
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
    // stdout holds only the JSON object; the fix lines go to stderr.
    expect(lines).toHaveLength(1);
    expect(errors.some((line) => line.startsWith("fixing global-rules:"))).toBe(true);
    const parsed = JSON.parse(lines[0]!) as { fixes: { name: string; ok: boolean; note: string }[]; results: CheckResult[] };
    expect(parsed.fixes).toEqual([
      { name: "global-rules", ok: true, note: expect.any(String) },
      { name: "plugin-fresh", ok: true, note: expect.any(String) },
    ]);
    expect(parsed.results).toHaveLength(ALL_CHECKS.length);
    expect(parsed.results.every((check) => check.name.length > 0)).toBe(true);
  });

  test("keeps the plain --json array without --fix", async () => {
    const deps = fixDeps({});
    const lines: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation((line) => lines.push(String(line)));
    try {
      await doctor({ json: true }, { HOME: "/home/u" } as Record<string, string>, deps);
    } finally {
      logSpy.mockRestore();
    }
    const jsonLine = lines.find((line) => line.startsWith("["));
    expect(jsonLine).toBeDefined();
    const parsed = JSON.parse(jsonLine!) as CheckResult[];
    expect(parsed).toHaveLength(ALL_CHECKS.length);
    expect(Object.keys(parsed[0]!)).toContain("name");
  });
});

describe("defaultReplaceWithSymlink with the real file system", () => {
  test("swaps a file for a symlink atomically", () => {
    const dir = tempDir();
    try {
      const target = path.join(dir, "AGENTS.md");
      const file = path.join(dir, "CLAUDE.md");
      writeFileSync(target, "# rules\n");
      writeFileSync(file, "# rules\n");
      defaultReplaceWithSymlink(file, target);
      expect(readlinkSync(file)).toBe(target);
      expect(readFileSync(target, "utf8")).toBe("# rules\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("kvm-access", () => {
  const usable: KvmDeps = {
    platform: "linux",
    statDevice: () => ({ mode: 0o20666, uid: 0, gid: 990 }),
    canReadWrite: () => true,
  };

  test("skips on a platform other than Linux", () => {
    const check = kvmAccessCheck({ ...usable, platform: "darwin" });
    expect(check.status).toBe("skip");
    expect(check.message).toContain("darwin");
  });

  test("fails when /dev/kvm is missing", () => {
    const check = kvmAccessCheck({ ...usable, statDevice: () => null });
    expect(check.status).toBe("fail");
    expect(check.message).toContain("/dev/kvm does not exist");
    expect(check.message).toContain("sbx needs KVM");
  });

  test("fails without read and write access and names the mode, the owner, and the group", () => {
    const paths: string[] = [];
    const check = kvmAccessCheck({
      platform: "linux",
      // The real case of 2026-09-30: a character device, mode 0660, group 109.
      statDevice: (file) => {
        paths.push(file);
        return { mode: 0o20660, uid: 0, gid: 109 };
      },
      canReadWrite: (file) => {
        paths.push(file);
        return false;
      },
    });
    expect(check.status).toBe("fail");
    expect(check.message).toContain("mode 0660");
    expect(check.message).toContain("owner uid 0");
    expect(check.message).toContain("group gid 109");
    expect(check.fix).toContain("oc-sub doctor --fix-as-root");
    expect(check.fix).toContain("sudo chmod 0666 /dev/kvm");
    expect(paths).toEqual(["/dev/kvm", "/dev/kvm"]);
  });

  test("passes with read and write access", () => {
    expect(kvmAccessCheck(usable).status).toBe("pass");
  });

  test("is a slow check and runs before sandbox-mounts", async () => {
    const names = SLOW_CHECKS.map((check) => check.name);
    expect(names).toContain("kvm-access");
    expect(FAST_CHECKS.map((check) => check.name)).not.toContain("kvm-access");
    expect(names.indexOf("kvm-access")).toBeLessThan(names.indexOf("sandbox-mounts"));
  });
});

describe("the kvm-access root fix", () => {
  /** Fake deps whose /dev/kvm becomes usable when the root runner exits 0. */
  function kvmDeps(opts: { tty: boolean; exitCode: number }): { deps: DoctorDeps; calls: string[][] } {
    const calls: string[][] = [];
    let fixed = false;
    // The shared rules file exists, so no other fix runs or fails.
    const deps = makeDeps(
      { files: map({ "/home/u/dv/meta/agents/AGENTS.md": { content: "# rules" } }) },
      {
        kvm: {
          platform: "linux",
          statDevice: () => ({ mode: fixed ? 0o20666 : 0o20660, uid: 0, gid: 109 }),
          canReadWrite: () => fixed,
        },
        stdinIsTTY: opts.tty,
        rootRunner: (cmd) => {
          calls.push([...cmd]);
          if (opts.exitCode === 0) fixed = true;
          return { exitCode: opts.exitCode };
        },
      },
    );
    return { deps, calls };
  }

  async function runDoctor(args: Parameters<typeof doctor>[0], deps: DoctorDeps): Promise<{ code: number; lines: string[] }> {
    const lines: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation((line) => lines.push(String(line)));
    try {
      return { code: await doctor(args, { HOME: "/home/u" } as Record<string, string>, deps), lines };
    } finally {
      logSpy.mockRestore();
    }
  }

  test("--fix never calls the root runner and names --fix-as-root", async () => {
    const { deps, calls } = kvmDeps({ tty: true, exitCode: 0 });
    const { code, lines } = await runDoctor({ fix: true }, deps);
    expect(calls).toEqual([]);
    expect(lines).toContain("needs --fix-as-root (kvm-access): this fix runs sudo; run oc-sub doctor --fix-as-root");
    expect(lines.some((line) => line.startsWith("FAIL  kvm-access"))).toBe(true);
    expect(code).toBe(1);
  });

  test("--fix-as-root runs sudo chmod 0666 /dev/kvm, and the re-run decides the exit code", async () => {
    const { deps, calls } = kvmDeps({ tty: true, exitCode: 0 });
    const { code, lines } = await runDoctor({ fixAsRoot: true }, deps);
    expect(calls).toEqual([["sudo", "chmod", "0666", "/dev/kvm"]]);
    expect(lines.some((line) => line.startsWith("fixing kvm-access:"))).toBe(true);
    expect(lines.some((line) => line.startsWith("fixed kvm-access: sudo chmod 0666 /dev/kvm"))).toBe(true);
    // The first run failed, the re-run passes, so the exit code is 0.
    expect(lines.some((line) => line.startsWith("pass  kvm-access"))).toBe(true);
    expect(code).toBe(0);
  });

  test("--fix-as-root returns 1 when the re-run still fails", async () => {
    // sudo exits 0, but the device stays unusable (for example a wrong device).
    const calls: string[][] = [];
    const deps = makeDeps(
      {},
      {
        kvm: { platform: "linux", statDevice: () => ({ mode: 0o20660, uid: 0, gid: 109 }), canReadWrite: () => false },
        rootRunner: (cmd) => {
          calls.push([...cmd]);
          return { exitCode: 0 };
        },
      },
    );
    const { code, lines } = await runDoctor({ fixAsRoot: true }, deps);
    expect(calls).toHaveLength(1);
    expect(lines.some((line) => line.startsWith("FAIL  kvm-access"))).toBe(true);
    expect(code).toBe(1);
  });

  test("without a terminal, the root fix runs sudo -n and a failure says to use a terminal", async () => {
    const { deps, calls } = kvmDeps({ tty: false, exitCode: 1 });
    const { code, lines } = await runDoctor({ fixAsRoot: true }, deps);
    expect(calls).toEqual([["sudo", "-n", "chmod", "0666", "/dev/kvm"]]);
    const failed = lines.find((line) => line.startsWith("fix failed (kvm-access):"));
    expect(failed).toContain("run in a terminal: sudo chmod 0666 /dev/kvm");
    expect(code).toBe(1);
  });

  test("the root fix reports a failed sudo in a terminal with its exit code", async () => {
    const { deps } = kvmDeps({ tty: true, exitCode: 1 });
    const outcome = kvmAccessRootFix(deps, {} as CheckResult, { force: false });
    expect(outcome).toEqual({ ok: false, note: "sudo chmod 0666 /dev/kvm exited with code 1" });
  });

  test("runFixes runs a root fix only with asRoot, and a pass result runs nothing", async () => {
    const ran: string[] = [];
    const checks: Check[] = [
      {
        name: "root",
        run: () => ({ name: "root", status: "fail", message: "bad" }),
        rootFix: () => {
          ran.push("root");
          return { ok: true, note: "done" };
        },
      },
    ];
    const failed: CheckResult[] = [{ name: "root", status: "fail", message: "bad" }];
    const print = () => {};
    expect(await runFixes(checks, makeDeps(), failed, { force: false }, print)).toEqual([]);
    expect(ran).toEqual([]);
    expect(await runFixes(checks, makeDeps(), [{ name: "root", status: "pass", message: "ok" }], { force: false, asRoot: true }, print)).toEqual([]);
    expect(ran).toEqual([]);
    expect(await runFixes(checks, makeDeps(), failed, { force: false, asRoot: true }, print)).toEqual([
      { name: "root", ok: true, note: "done" },
    ]);
    expect(ran).toEqual(["root"]);
  });
});

describe("doctor --fix-as-root argument parsing", () => {
  test("--fix-as-root implies --fix", () => {
    expect(parseArgs(["doctor", "--fix-as-root"])).toMatchObject({ command: "doctor", fix: true, fixAsRoot: true, force: false });
  });

  test("--fix alone does not set fixAsRoot", () => {
    expect(parseArgs(["doctor", "--fix"])).toMatchObject({ fix: true, fixAsRoot: false });
    expect(parseArgs(["doctor"])).toMatchObject({ fix: false, fixAsRoot: false });
  });

  test("--fix-as-root allows --force and --json", () => {
    expect(parseArgs(["doctor", "--fix-as-root", "--force", "--json"])).toMatchObject({
      fix: true,
      fixAsRoot: true,
      force: true,
      json: true,
    });
  });
});

describe("sandbox-mounts when the sandbox does not start", () => {
  test("names the stderr of sbx exec instead of a missing clone", () => {
    const mounts = requiredSandboxMounts("/repo", PLUGIN_DIR, "/home/u/.local/share/mise/installs", "/home/u/dv/meta/agents").join(", ");
    const deps = makeDeps(
      {},
      {
        runner: (cmd) => {
          if (cmd[1] === "exec") return { stdout: "", exitCode: 1, stderr: "start runtime: 500 Internal Server Error\n" };
          return { stdout: `NAME STATUS WORKSPACE\noc-sub-repo running /repo, ${mounts}\n`, exitCode: 0 };
        },
        sandboxState: () => ({ name: "oc-sub-repo", root: "/repo", port: 18768 }),
      },
    );
    const check = byName(results(deps, SLOW_CHECKS), "sandbox-mounts");
    expect(check?.status).toBe("fail");
    expect(check?.message).toContain("start runtime: 500 Internal Server Error");
    expect(check?.message).not.toContain("has no git clone");
    expect(check?.fix).toContain("sbx diagnose");
  });
});

describe("server-plugin", () => {
  const host = (digest: string | null): RunningServer => ({ mode: "host", port: 8767, url: "http://127.0.0.1:8767", digest });
  const sandbox = (digest: string | null): RunningServer => ({
    mode: "sandbox",
    port: 18768,
    url: "http://127.0.0.1:18768",
    root: "/repo",
    digest,
  });
  /** Fake digests: the source folder and the synced folder can differ. */
  const digests = (source: string | null, synced: string | null) => (dir: string) =>
    dir === "/plugin/opencode" ? source : dir === PLUGIN_DIR ? synced : null;
  const check = (deps: DoctorDeps) => byName(results(deps, SLOW_CHECKS), "server-plugin");
  /** The shared rules file exists, so the other fixes of a doctor run succeed. */
  const withRules = { files: map({ "/home/u/dv/meta/agents/AGENTS.md": { content: "# rules" } }) };

  test("comes right after plugin-fresh in the order", () => {
    const names = ALL_CHECKS.map((c) => c.name);
    expect(names.indexOf("server-plugin")).toBe(names.indexOf("plugin-fresh") + 1);
  });

  test("passes when the synced folder matches and no server runs", () => {
    expect(check(makeDeps())?.status).toBe("pass");
  });

  test("passes without a synced folder when no server runs", () => {
    const result = check(makeDeps({}, { pluginDigest: digests("sha256:a", null) }));
    expect(result?.status).toBe("pass");
    expect(result?.message).toContain("the next oc-sub up syncs");
  });

  test("passes when every running server started with the synced content", () => {
    const result = check(makeDeps({}, { pluginDigest: digests("sha256:a", "sha256:a"), runningServers: () => [host("sha256:a"), sandbox("sha256:a")] }));
    expect(result?.status).toBe("pass");
    expect(result?.message).toContain("2 running server(s)");
  });

  test("skips when the plugin folder of this oc-sub does not exist", () => {
    expect(check(makeDeps({}, { pluginDigest: digests(null, "sha256:a") }))?.status).toBe("skip");
  });

  test("warns when the synced folder differs from the plugin", () => {
    const result = check(makeDeps({}, { pluginDigest: digests("sha256:new", "sha256:old") }));
    expect(result?.status).toBe("warn");
    expect(result?.message).toBe(`the synced plugin folder ${PLUGIN_DIR} differs from the plugin /plugin/opencode`);
    expect(result?.fix).toBe(SERVER_PLUGIN_FIX);
  });

  test("warns when a running server started with other content than the synced folder holds", () => {
    const result = check(makeDeps({}, { pluginDigest: digests("sha256:a", "sha256:a"), runningServers: () => [host("sha256:a"), sandbox("sha256:old")] }));
    expect(result?.status).toBe("warn");
    expect(result?.message).toBe("the sandbox server of /repo :18768 started with other plugin content than the synced folder holds");
  });

  test("warns for a server without a plugin record and names step 15c", () => {
    const result = check(makeDeps({}, { pluginDigest: digests("sha256:a", "sha256:a"), runningServers: () => [host(null)] }));
    expect(result?.status).toBe("warn");
    expect(result?.message).toContain("host server :8767 has no plugin record (started before oc-sub step 15c)");
  });

  test("the fix syncs the folder and restarts only the servers with other content", async () => {
    const synced: string[] = [];
    const restarted: RunningServer[] = [];
    const deps = makeDeps({}, {
      syncPlugin: (source, dest) => {
        synced.push(`${source} -> ${dest}`);
        return "sha256:new";
      },
      runningServers: () => [host("sha256:new"), sandbox("sha256:old")],
      restartServer: async (server) => {
        restarted.push(server);
        return { ok: true, note: "restarted the sandbox server" };
      },
    });
    const outcome = await serverPluginFix(deps, { name: "server-plugin", status: "warn", message: "" }, { force: false });
    expect(synced).toEqual([`/plugin/opencode -> ${PLUGIN_DIR}`]);
    expect(restarted.map((server) => server.mode)).toEqual(["sandbox"]);
    expect(outcome).toEqual({ ok: true, note: `synced ${PLUGIN_DIR}, restarted the sandbox server` });
  });

  test("the fix fails and keeps the note of a busy server", async () => {
    const deps = makeDeps({}, {
      syncPlugin: () => "sha256:new",
      runningServers: () => [host("sha256:old")],
      restartServer: async () => ({ ok: false, note: "host server :8767 is busy, not restarted: busy s1 /repo. Wait for the sessions, or end them with oc-sub abort or oc-sub down" }),
    });
    const outcome = await serverPluginFix(deps, { name: "server-plugin", status: "warn", message: "" }, { force: false });
    expect(outcome.ok).toBe(false);
    expect(outcome.note).toContain("oc-sub abort or oc-sub down");
  });

  test("doctor --fix syncs, restarts the stale server, and the re-run passes", async () => {
    let synced = "sha256:old";
    let serverDigest = "sha256:old";
    const deps = makeDeps(withRules, {
      pluginDigest: (dir) => (dir === "/plugin/opencode" ? "sha256:new" : dir === PLUGIN_DIR ? synced : null),
      syncPlugin: () => {
        synced = "sha256:new";
        return synced;
      },
      runningServers: () => [host(serverDigest)],
      restartServer: async () => {
        serverDigest = synced;
        return { ok: true, note: "restarted the host server :8767" };
      },
    });
    const lines: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation((line) => lines.push(String(line)));
    let code: number;
    try {
      code = await doctor({ fix: true }, { HOME: "/home/u" } as Record<string, string>, deps);
    } finally {
      logSpy.mockRestore();
    }
    expect(code).toBe(0);
    expect(lines).toContain(`fixed server-plugin: synced ${PLUGIN_DIR}, restarted the host server :8767`);
    expect(lines.some((line) => line.startsWith("pass  server-plugin"))).toBe(true);
  });

  test("doctor --fix restarts nothing when server-plugin passes", async () => {
    // The default fakes throw on a sync and a restart, so a call would fail the fix.
    const deps = makeDeps(withRules, { runningServers: () => [host("sha256:same")] });
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    let code: number;
    try {
      code = await doctor({ fix: true }, { HOME: "/home/u" } as Record<string, string>, deps);
    } finally {
      logSpy.mockRestore();
    }
    expect(code).toBe(0);
  });
});

describe("parseFeatureBranches", () => {
  test("keeps only the local feature branches, with the prefix removed", () => {
    const out = [
      "1111111111111111111111111111111111111111 refs/heads/alpha",
      "2222222222222222222222222222222222222222 refs/heads/feature/15d",
      "3333333333333333333333333333333333333333 refs/heads/feature/15e",
      "4444444444444444444444444444444444444444 refs/remotes/host/alpha",
      "",
    ].join("\n");
    expect(parseFeatureBranches(out)).toEqual([
      { sha: "2222222222222222222222222222222222222222", branch: "feature/15d" },
      { sha: "3333333333333333333333333333333333333333", branch: "feature/15e" },
    ]);
  });

  test("ignores empty and malformed lines", () => {
    expect(parseFeatureBranches("\nrefs/heads/feature/x\nno space\n")).toEqual([]);
  });
});

describe("hostRefsKeepingCommit", () => {
  test("drops the refs that sbx rm deletes with the sandbox-<name> remote", () => {
    const out = [
      "refs/heads/alpha",
      "refs/remotes/sandbox-oc-sub-repo/feature/15d",
      "refs/sandboxes/oc-sub-repo/heads/feature/15d",
      "refs/remotes/origin/alpha",
      "",
    ].join("\n");
    expect(hostRefsKeepingCommit(out, "oc-sub-repo")).toEqual(["refs/heads/alpha", "refs/remotes/origin/alpha"]);
  });

  test("returns nothing when every ref sits under the two namespaces", () => {
    const out = [
      "refs/remotes/sandbox-oc-sub-repo/feature/15d",
      "refs/sandboxes/oc-sub-repo/heads/feature/15d",
    ].join("\n");
    expect(hostRefsKeepingCommit(out, "oc-sub-repo")).toEqual([]);
  });
});

describe("parseWorktrees", () => {
  test("reads the worktree paths of the porcelain output, spaces included", () => {
    const out = [
      "worktree /repo",
      "HEAD 1111111111111111111111111111111111111111",
      "branch refs/heads/alpha",
      "",
      "worktree /repo/.worktrees/15d test",
      "HEAD 2222222222222222222222222222222222222222",
      "branch refs/heads/feature/15d",
      "",
    ].join("\n");
    expect(parseWorktrees(out)).toEqual(["/repo", "/repo/.worktrees/15d test"]);
  });

  test("returns nothing without worktree lines", () => {
    expect(parseWorktrees("bare\n")).toEqual([]);
  });
});

describe("the sandbox-mounts fix (step 15d)", () => {
  const MOUNTS = requiredSandboxMounts("/repo", PLUGIN_DIR, "/home/u/.local/share/mise/installs", "/home/u/dv/meta/agents").join(", ");
  const LS_OK = `NAME STATUS WORKSPACE\noc-sub-repo running /repo, ${MOUNTS}\n`;
  const LS_MISSING = `NAME STATUS WORKSPACE\noc-sub-repo running /repo\n`;
  const SANDBOX_SERVER: RunningServer = {
    mode: "sandbox",
    port: 18768,
    url: "http://127.0.0.1:18768",
    root: "/repo",
    name: "oc-sub-repo",
    digest: "sha256:same",
  };
  const FAIL_RESULT: CheckResult = { name: "sandbox-mounts", status: "fail", message: "bad" };

  /**
   * A fake runner for the classifier and the guard. It matches on the shape
   * of the command: `sbx ls`, the git host calls, and the `sbx exec` git
   * calls of the clone check and the guard.
   */
  function fakeRunner(rules: {
    ls: string;
    /** Exit code of the clone check exec (`git rev-parse --git-dir`). */
    clone?: number;
    /** Exit code of the `test -d /run/sandbox/source` exec (1 = direct mount). */
    test?: number;
    /** Stdout of `git remote` on the host. */
    remote?: string;
    /** Exit code of the for-each-ref exec, or its stdout. */
    refs?: number | string;
    /** The host refs that contain a branch commit, per sha, or an exit code. */
    contains?: number | string | ((sha: string) => number | string);
    /** Exit code of the worktree list exec, or its porcelain stdout. */
    worktrees?: number | string;
    /** Exit code of a worktree status exec, or its stdout, per worktree path. */
    status?: number | string | ((path: string) => number | string);
  }): { runner: DoctorDeps["runner"]; calls: string[] } {
    const calls: string[] = [];
    const runner: DoctorDeps["runner"] = (cmd) => {
      calls.push(cmd.join(" "));
      const joined = cmd.join(" ");
      if (cmd[0] === "sbx" && cmd[1] === "ls") return { stdout: rules.ls, exitCode: 0 };
      if (cmd[0] === "sbx" && joined.includes("test -d")) return { stdout: "", exitCode: rules.test ?? 0 };
      if (cmd[0] === "git") {
        if (cmd[3] === "remote") return { stdout: rules.remote ?? "sandbox-oc-sub-repo\n", exitCode: 0 };
        if (cmd[3] === "for-each-ref") {
          const rule = typeof rules.contains === "function" ? rules.contains(cmd[5] ?? "") : rules.contains;
          if (typeof rule === "number") return { stdout: "", exitCode: rule };
          return { stdout: rule ?? "", exitCode: 0 };
        }
        return { stdout: "", exitCode: 0 };
      }
      if (joined.includes("rev-parse")) return { stdout: "", exitCode: rules.clone ?? 0 };
      if (joined.includes("for-each-ref")) {
        if (typeof rules.refs === "number") return { stdout: "", exitCode: rules.refs };
        return { stdout: rules.refs ?? "", exitCode: 0 };
      }
      if (joined.includes("worktree")) {
        if (typeof rules.worktrees === "number") return { stdout: "", exitCode: rules.worktrees };
        return { stdout: rules.worktrees ?? "", exitCode: 0 };
      }
      if (joined.includes("status")) {
        const rule = typeof rules.status === "function" ? rules.status(cmd[5] ?? "") : rules.status;
        if (typeof rule === "number") return { stdout: "", exitCode: rule };
        return { stdout: rule ?? "", exitCode: 0 };
      }
      return { stdout: "", exitCode: 0 };
    };
    return { runner, calls };
  }

  function fixDeps(
    runner: DoctorDeps["runner"],
    overrides: Partial<DoctorDeps> = {},
  ): { deps: DoctorDeps; recreateCalls: Array<[string, string, boolean]> } {
    const recreateCalls: Array<[string, string, boolean]> = [];
    const deps = makeDeps(
      {},
      {
        runner,
        sandboxState: () => ({ name: "oc-sub-repo", root: "/repo", port: 18768 }),
        recreateSandbox: async (name, root, stop) => {
          recreateCalls.push([name, root, stop]);
          return { ok: true, note: "recreated" };
        },
        ...overrides,
      },
    );
    return { deps, recreateCalls };
  }

  test("does nothing without --force and names the flag", async () => {
    const { runner } = fakeRunner({ ls: LS_MISSING });
    const { deps, recreateCalls } = fixDeps(runner);
    const outcome = await sandboxMountsFix(deps, FAIL_RESULT, { force: false });
    expect(outcome.ok).toBe(false);
    expect(outcome.note).toContain("ends all sessions");
    expect(outcome.note).toContain("oc-sub doctor --fix --force");
    expect(recreateCalls).toEqual([]);
  });

  test("does not recreate when the sandbox does not start, even with --force", async () => {
    const { runner } = fakeRunner({ ls: LS_OK, clone: 1 });
    const { deps, recreateCalls } = fixDeps(runner);
    const outcome = await sandboxMountsFix(deps, FAIL_RESULT, { force: true });
    expect(outcome.ok).toBe(false);
    expect(outcome.note).toContain("does not help");
    expect(outcome.note).toContain("sbx diagnose");
    expect(recreateCalls).toEqual([]);
  });

  test("blocks on a busy session of the sandbox server, also with --force", async () => {
    const { runner } = fakeRunner({ ls: LS_MISSING });
    const { deps, recreateCalls } = fixDeps(runner, {
      runningServers: () => [SANDBOX_SERVER],
      serverBusy: async (): Promise<BusyCheck> => ({ kind: "busy", sessions: "busy ses_1 /repo" }),
    });
    const outcome = await sandboxMountsFix(deps, FAIL_RESULT, { force: true });
    expect(outcome.ok).toBe(false);
    expect(outcome.note).toContain("busy ses_1 /repo");
    expect(outcome.note).toContain("oc-sub abort or oc-sub down");
    expect(recreateCalls).toEqual([]);
  });

  test("blocks on a server that refuses the credentials", async () => {
    const { runner } = fakeRunner({ ls: LS_MISSING });
    const { deps, recreateCalls } = fixDeps(runner, {
      runningServers: () => [SANDBOX_SERVER],
      serverBusy: async (): Promise<BusyCheck> => ({ kind: "unauthorized" }),
    });
    const outcome = await sandboxMountsFix(deps, FAIL_RESULT, { force: true });
    expect(outcome.ok).toBe(false);
    expect(outcome.note).toContain("refused the credentials");
    expect(recreateCalls).toEqual([]);
  });

  test("blocks on a clone feature branch whose only host refs sit under sandbox-<name>", async () => {
    const sha = "2222222222222222222222222222222222222222";
    const { runner } = fakeRunner({
      ls: LS_MISSING,
      refs: `${sha} refs/heads/feature/15d\n`,
      contains: `refs/remotes/sandbox-oc-sub-repo/feature/15d\nrefs/sandboxes/oc-sub-repo/heads/feature/15d\n`,
    });
    const { deps, recreateCalls } = fixDeps(runner);
    const outcome = await sandboxMountsFix(deps, FAIL_RESULT, { force: true });
    expect(outcome.ok).toBe(false);
    expect(outcome.note).toContain("the host would lose with sbx rm");
    expect(outcome.note).toContain("Merge the branch");
    expect(outcome.note).toContain("git branch feature/15d sandbox-oc-sub-repo/feature/15d");
    expect(outcome.note).toContain("oc-sub worktree rm 15d");
    expect(outcome.note).toContain("A squash merge does not contain the feature commits");
    expect(recreateCalls).toEqual([]);
  });

  test("recreates when a host ref outside sandbox-<name> contains the branch commit", async () => {
    const sha = "2222222222222222222222222222222222222222";
    const { runner } = fakeRunner({
      ls: LS_MISSING,
      refs: `${sha} refs/heads/feature/15d\n`,
      contains: "refs/heads/alpha\n",
      worktrees: "worktree /repo\n",
      status: "",
    });
    const { deps, recreateCalls } = fixDeps(runner);
    const outcome = await sandboxMountsFix(deps, FAIL_RESULT, { force: true });
    expect(outcome.ok).toBe(true);
    expect(recreateCalls).toEqual([["oc-sub-repo", "/repo", false]]);
  });

  test("blocks when the host for-each-ref --contains fails", async () => {
    const sha = "2222222222222222222222222222222222222222";
    const { runner } = fakeRunner({
      ls: LS_MISSING,
      refs: `${sha} refs/heads/feature/15d\n`,
      contains: 1,
    });
    const { deps, recreateCalls } = fixDeps(runner);
    const outcome = await sandboxMountsFix(deps, FAIL_RESULT, { force: true });
    expect(outcome.ok).toBe(false);
    expect(outcome.note).toContain("cannot prove that no work is lost");
    expect(outcome.note).toContain("feature/15d");
    expect(recreateCalls).toEqual([]);
  });

  test("skips the guard for a direct-mount sandbox and leaves a dirty host tree alone", async () => {
    const sha = "2222222222222222222222222222222222222222";
    const { runner, calls } = fakeRunner({
      ls: LS_MISSING,
      test: 1,
      refs: `${sha} refs/heads/feature/15d\n`,
    });
    const { deps, recreateCalls } = fixDeps(runner);
    const outcome = await sandboxMountsFix(deps, FAIL_RESULT, { force: true });
    expect(outcome.ok).toBe(true);
    expect(recreateCalls).toEqual([["oc-sub-repo", "/repo", false]]);
    expect(calls.some((call) => call.includes("for-each-ref"))).toBe(false);
    expect(calls.some((call) => call.includes("status"))).toBe(false);
  });

  test("blocks when the clone-mode probe fails, because the fix cannot prove that no work is lost", async () => {
    const { runner } = fakeRunner({ ls: LS_MISSING, test: 2 });
    const { deps, recreateCalls } = fixDeps(runner);
    const outcome = await sandboxMountsFix(deps, FAIL_RESULT, { force: true });
    expect(outcome.ok).toBe(false);
    expect(outcome.note).toContain("cannot prove that no work is lost");
    expect(outcome.note).toContain("/run/sandbox/source");
    expect(recreateCalls).toEqual([]);
  });

  test("blocks on a clone worktree with uncommitted changes", async () => {
    const { runner } = fakeRunner({
      ls: LS_MISSING,
      refs: "",
      worktrees: "worktree /repo\n\nworktree /repo/.worktrees/15d\n",
      status: (wt) => (wt === "/repo/.worktrees/15d" ? " M file\n" : ""),
    });
    const { deps, recreateCalls } = fixDeps(runner);
    const outcome = await sandboxMountsFix(deps, FAIL_RESULT, { force: true });
    expect(outcome.ok).toBe(false);
    expect(outcome.note).toContain("oc-sub fetch");
    expect(outcome.note).toContain("/repo/.worktrees/15d");
    expect(recreateCalls).toEqual([]);
  });

  test("blocks when for-each-ref fails, because the fix cannot prove that no work is lost", async () => {
    const { runner } = fakeRunner({ ls: LS_MISSING, refs: 1 });
    const { deps, recreateCalls } = fixDeps(runner);
    const outcome = await sandboxMountsFix(deps, FAIL_RESULT, { force: true });
    expect(outcome.ok).toBe(false);
    expect(outcome.note).toContain("cannot prove that no work is lost");
    expect(recreateCalls).toEqual([]);
  });

  test("blocks when git status in a worktree fails", async () => {
    const { runner } = fakeRunner({
      ls: LS_MISSING,
      refs: "",
      worktrees: "worktree /repo\n",
      status: 3,
    });
    const { deps, recreateCalls } = fixDeps(runner);
    const outcome = await sandboxMountsFix(deps, FAIL_RESULT, { force: true });
    expect(outcome.ok).toBe(false);
    expect(outcome.note).toContain("cannot prove that no work is lost");
    expect(outcome.note).toContain("/repo");
    expect(recreateCalls).toEqual([]);
  });

  test("recreates for a missing mount, with a clean clone, and names no down without a server", async () => {
    const { runner } = fakeRunner({
      ls: LS_MISSING,
      refs: "",
      worktrees: "worktree /repo\n",
      status: "",
    });
    const { deps, recreateCalls } = fixDeps(runner);
    const outcome = await sandboxMountsFix(deps, FAIL_RESULT, { force: true });
    expect(outcome.ok).toBe(true);
    expect(recreateCalls).toEqual([["oc-sub-repo", "/repo", false]]);
  });

  test("recreates for a missing clone and skips the work guard", async () => {
    const { runner, calls } = fakeRunner({ ls: LS_OK, clone: 128 });
    const { deps, recreateCalls } = fixDeps(runner);
    const outcome = await sandboxMountsFix(deps, FAIL_RESULT, { force: true });
    expect(outcome.ok).toBe(true);
    expect(recreateCalls).toEqual([["oc-sub-repo", "/repo", false]]);
    expect(calls.some((call) => call.includes("for-each-ref"))).toBe(false);
  });

  test("recreates for a direct-mount sandbox without clone mode", async () => {
    const { runner } = fakeRunner({ ls: LS_OK, remote: "origin\n", refs: "", worktrees: "worktree /repo\n", status: "" });
    const { deps, recreateCalls } = fixDeps(runner);
    const outcome = await sandboxMountsFix(deps, FAIL_RESULT, { force: true });
    expect(outcome.ok).toBe(true);
    expect(recreateCalls).toEqual([["oc-sub-repo", "/repo", false]]);
  });

  test("stops the server first when one runs and its sessions are idle", async () => {
    const { runner } = fakeRunner({ ls: LS_MISSING, refs: "", worktrees: "worktree /repo\n", status: "" });
    const { deps, recreateCalls } = fixDeps(runner, {
      runningServers: () => [SANDBOX_SERVER],
      serverBusy: async (): Promise<BusyCheck> => ({ kind: "clear" }),
    });
    const outcome = await sandboxMountsFix(deps, FAIL_RESULT, { force: true });
    expect(outcome.ok).toBe(true);
    expect(recreateCalls).toEqual([["oc-sub-repo", "/repo", true]]);
  });

  test("doctor --fix --force runs the fix through the registry and prints the lines", async () => {
    const { runner } = fakeRunner({ ls: LS_MISSING, refs: "", worktrees: "worktree /repo\n", status: "" });
    const { deps } = fixDeps(runner);
    const lines: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation((line) => lines.push(String(line)));
    let code: number;
    try {
      code = await doctor({ fix: true, force: true }, { HOME: "/home/u" } as Record<string, string>, deps);
    } finally {
      logSpy.mockRestore();
    }
    expect(lines).toContain("fixing sandbox-mounts: Recreate it with: oc-sub doctor --fix --force. It recreates the sandbox in clone mode with all required mounts. To do it by hand: sbx rm --force oc-sub-repo, then oc-sub up.");
    expect(lines).toContain("fixed sandbox-mounts: recreated");
    // The re-run of the checks still fails: the fake runner does not change
    // the sandbox, so the exit code is 1.
    expect(code).toBe(1);
  });

  test("doctor --fix without --force fails the fix and names --force", async () => {
    const { runner } = fakeRunner({ ls: LS_MISSING });
    const { deps } = fixDeps(runner);
    const lines: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation((line) => lines.push(String(line)));
    let code: number;
    try {
      code = await doctor({ fix: true }, { HOME: "/home/u" } as Record<string, string>, deps);
    } finally {
      logSpy.mockRestore();
    }
    expect(code).toBe(1);
    const failed = lines.find((line) => line.startsWith("fix failed (sandbox-mounts):"));
    expect(failed).toContain("oc-sub doctor --fix --force");
  });
});

describe("recreateSandbox", () => {
  type Step = "down" | "rm" | "up";
  function fakeRecreate(opts: { downCode?: number; rmCode?: number; upCode?: number } = {}): {
    deps: import("../src/sandbox").RecreateDeps;
    steps: Step[];
    logged: string[];
    errored: string[];
  } {
    const steps: Step[] = [];
    const logged: string[] = [];
    const errored: string[] = [];
    return {
      deps: {
        runner: (cmd) => {
          steps.push("rm");
          return { stdout: "", exitCode: opts.rmCode ?? 0 };
        },
        downSandbox: async () => {
          steps.push("down");
          return opts.downCode ?? 0;
        },
        upSandbox: async () => {
          steps.push("up");
          // The real `oc-sub up` prints to stdout; recreateSandbox must send
          // it to stderr.
          console.log("up printed a line");
          return opts.upCode ?? 0;
        },
      },
      steps,
      logged,
      errored,
    };
  }

  test("runs down, then sbx rm --force, then oc-sub up", async () => {
    const { deps, steps } = fakeRecreate();
    const outcome = await recreateSandbox("oc-sub-repo", "/repo", true, process.env, deps);
    expect(outcome.ok).toBe(true);
    expect(steps).toEqual(["down", "rm", "up"]);
  });

  test("skips down when no server runs", async () => {
    const { deps, steps } = fakeRecreate();
    const outcome = await recreateSandbox("oc-sub-repo", "/repo", false, process.env, deps);
    expect(outcome.ok).toBe(true);
    expect(steps).toEqual(["rm", "up"]);
  });

  test("a failed down stops before sbx rm", async () => {
    const { deps, steps } = fakeRecreate({ downCode: 1 });
    const outcome = await recreateSandbox("oc-sub-repo", "/repo", true, process.env, deps);
    expect(outcome.ok).toBe(false);
    expect(outcome.note).toContain("oc-sub down failed with code 1");
    expect(steps).toEqual(["down"]);
  });

  test("a failed sbx rm reports its exit code and skips oc-sub up", async () => {
    const { deps, steps } = fakeRecreate({ rmCode: 5 });
    const outcome = await recreateSandbox("oc-sub-repo", "/repo", false, process.env, deps);
    expect(outcome.ok).toBe(false);
    expect(outcome.note).toContain("sbx rm --force oc-sub-repo exited with code 5");
    expect(steps).toEqual(["rm"]);
  });

  test("a failed oc-sub up reports its exit code", async () => {
    const { deps, steps } = fakeRecreate({ upCode: 2 });
    const outcome = await recreateSandbox("oc-sub-repo", "/repo", false, process.env, deps);
    expect(outcome.ok).toBe(false);
    expect(outcome.note).toContain("oc-sub up failed with code 2");
    expect(steps).toEqual(["rm", "up"]);
  });

  test("prints the output of down and up to stderr, so --json keeps stdout clean", async () => {
    const { deps } = fakeRecreate();
    const out: string[] = [];
    const err: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation((line) => out.push(String(line)));
    const errorSpy = spyOn(console, "error").mockImplementation((line) => err.push(String(line)));
    try {
      await recreateSandbox("oc-sub-repo", "/repo", false, process.env, deps);
      console.log("after");
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
    expect(err).toEqual(["up printed a line"]);
    expect(out).toEqual(["after"]);
  });
});

describe("the opencode-version check", () => {
  const TESTED = '[tools]\nbun = "1.4.2"\nopencode = "1.18.32"\n';
  const check = (deps: DoctorDeps) => byName(results(deps, SLOW_CHECKS), "opencode-version");
  /** Fake deps with the given files and a mise runner that prints `stdout` and records its calls. */
  function versionDeps(files: Record<string, string>, stdout: string, exitCode = 0) {
    const calls: { cmd: readonly string[]; cwd?: string }[] = [];
    const entries: Record<string, { content: string }> = {};
    for (const [file, content] of Object.entries(files)) entries[file] = { content };
    const deps = makeDeps(
      { files: map(entries) },
      {
        miseRunner: (cmd, opts) => {
          calls.push({ cmd, cwd: opts?.cwd });
          return { stdout, exitCode };
        },
      },
    );
    return { deps, calls };
  }

  test("is a slow check and keeps server-plugin right after plugin-fresh", () => {
    const names = SLOW_CHECKS.map((c) => c.name);
    expect(names).toContain("opencode-version");
    expect(FAST_CHECKS.map((c) => c.name)).not.toContain("opencode-version");
    expect(names.indexOf("opencode-version")).toBeLessThan(names.indexOf("server-plugin"));
    expect(ALL_CHECKS.find((c) => c.name === "opencode-version")?.fix).toBeUndefined();
  });

  test("passes when mise resolves the tested version in the project root", () => {
    const { deps, calls } = versionDeps({ "/plugin/mise.toml": TESTED }, "1.18.32\n");
    const res = check(deps);
    expect(res?.status).toBe("pass");
    expect(res?.message).toContain("1.18.32");
    expect(calls[0]).toEqual({ cmd: ["mise", "current", "opencode"], cwd: "/repo" });
  });

  test("warns and names the project pin when the project mise.toml pins opencode", () => {
    const { deps } = versionDeps(
      { "/plugin/mise.toml": TESTED, "/repo/mise.toml": '[tools]\nopencode = "latest"\n' },
      "1.19.0\n",
    );
    const res = check(deps);
    expect(res?.status).toBe("warn");
    expect(res?.message).toContain("1.19.0");
    expect(res?.message).toContain("1.18.32");
    expect(res?.message).toContain('opencode = "latest"');
    expect(res?.message).toContain("/repo/mise.toml");
    expect(res?.fix).toBe('set opencode = "1.18.32" in /repo/mise.toml and run mise install');
  });

  test("warns and names the global configuration when the project has no pin", () => {
    const { deps } = versionDeps(
      { "/plugin/mise.toml": TESTED, "/repo/mise.toml": '[tools]\nbun = "1.4.2"\n' },
      "1.19.0\n",
    );
    const res = check(deps);
    expect(res?.status).toBe("warn");
    expect(res?.message).toContain("global mise configuration");
    expect(res?.fix).toBe('set opencode = "1.18.32" in /home/u/.config/mise/config.toml and run mise install');
  });

  test("warns when the project pins latest, even if it resolves to the tested version now", () => {
    const { deps } = versionDeps(
      { "/plugin/mise.toml": TESTED, "/repo/mise.toml": '[tools]\nopencode = "latest"\n' },
      "1.18.32\n",
    );
    const res = check(deps);
    expect(res?.status).toBe("warn");
    expect(res?.message).toContain('opencode = "latest"');
    expect(res?.message).toContain("/repo/mise.toml");
    expect(res?.message).toContain("resolves to opencode 1.18.32");
    expect(res?.fix).toBe('set opencode = "1.18.32" in /repo/mise.toml and run mise install');
  });

  test("warns when the global configuration pins latest and the project has no pin", () => {
    const { deps } = versionDeps(
      { "/plugin/mise.toml": TESTED, "/home/u/.config/mise/config.toml": '[tools]\nopencode = "latest"\n' },
      "1.18.32\n",
    );
    const res = check(deps);
    expect(res?.status).toBe("warn");
    expect(res?.message).toContain('opencode = "latest"');
    expect(res?.message).toContain("global mise configuration /home/u/.config/mise/config.toml");
    expect(res?.message).toContain("resolves to opencode 1.18.32");
    expect(res?.fix).toBe('set opencode = "1.18.32" in /home/u/.config/mise/config.toml and run mise install');
  });

  test("passes when the project pins the tested version, whatever the global pin is", () => {
    const { deps } = versionDeps(
      {
        "/plugin/mise.toml": TESTED,
        "/repo/mise.toml": '[tools]\nopencode = "1.18.32"\n',
        "/home/u/.config/mise/config.toml": '[tools]\nopencode = "latest"\n',
      },
      "1.18.32\n",
    );
    expect(check(deps)?.status).toBe("pass");
  });

  test("reads the tested version from a table with version", () => {
    const { deps } = versionDeps(
      { "/plugin/mise.toml": '[tools]\nopencode = { version = "1.18.32" }\n' },
      "1.18.32",
    );
    expect(check(deps)?.status).toBe("pass");
  });

  test("takes the first token of the mise output", () => {
    const { deps } = versionDeps({ "/plugin/mise.toml": TESTED }, "1.18.32 1.17.0\n");
    expect(check(deps)?.status).toBe("pass");
  });

  test("skips without an opencode pin in the plugin repository and never calls mise", () => {
    const { deps, calls } = versionDeps({ "/plugin/mise.toml": '[tools]\nbun = "1.4.2"\n' }, "1.18.32");
    const res = check(deps);
    expect(res?.status).toBe("skip");
    expect(res?.message).toContain("/plugin/mise.toml");
    expect(calls).toHaveLength(0);
  });

  test("skips when the plugin mise.toml is not valid TOML", () => {
    const { deps } = versionDeps({ "/plugin/mise.toml": "[tools\nopencode = " }, "1.18.32");
    expect(check(deps)?.status).toBe("skip");
  });

  test("skips when mise fails", () => {
    const { deps } = versionDeps({ "/plugin/mise.toml": TESTED }, "", 1);
    const res = check(deps);
    expect(res?.status).toBe("skip");
    expect(res?.message).toContain("code 1");
  });

  test("skips when mise prints no version", () => {
    const { deps } = versionDeps({ "/plugin/mise.toml": TESTED }, "  \n");
    expect(check(deps)?.status).toBe("skip");
  });
});

describe("the opencode-release check", () => {
  const TESTED = '[tools]\nbun = "1.4.2"\nopencode = "1.18.32"\n';
  const REVIEW = JSON.stringify({ reviewed: "1.18.33", date: "2026-09-30", decision: "stay on 1.18.32" });
  const FIX = "read the release notes of opencode <latest>, then either raise the pin in the mise.toml of oc-sub and run the tests, or record the decision in opencode-review.json";
  const check = (deps: DoctorDeps) => byName(results(deps, SLOW_CHECKS), "opencode-release");
  /** Fake deps with the given files and a mise runner that prints `stdout` and records its calls. */
  function reviewDeps(files: Record<string, string>, stdout: string, exitCode = 0) {
    const calls: { cmd: readonly string[] }[] = [];
    const entries: Record<string, { content: string }> = {};
    for (const [file, content] of Object.entries(files)) entries[file] = { content };
    const deps = makeDeps(
      { files: map(entries) },
      {
        miseRunner: (cmd) => {
          calls.push({ cmd });
          return { stdout, exitCode };
        },
      },
    );
    return { deps, calls };
  }

  test("is a slow check right after opencode-version, with no fix action", () => {
    const names = SLOW_CHECKS.map((c) => c.name);
    expect(names.indexOf("opencode-release")).toBe(names.indexOf("opencode-version") + 1);
    expect(ALL_CHECKS.find((c) => c.name === "opencode-release")?.fix).toBeUndefined();
  });

  test("passes when the latest version equals the tested version", () => {
    const { deps, calls } = reviewDeps({ "/plugin/mise.toml": TESTED, "/plugin/opencode-review.json": REVIEW }, "1.18.32\n");
    const res = check(deps);
    expect(res?.status).toBe("pass");
    expect(res?.message).toContain("1.18.32");
    expect(calls.filter((call) => call.cmd.includes("latest"))).toEqual([{ cmd: ["mise", "latest", "opencode"] }]);
  });

  test("passes when the latest version equals the reviewed version", () => {
    const { deps } = reviewDeps({ "/plugin/mise.toml": TESTED, "/plugin/opencode-review.json": REVIEW }, "1.18.33\n");
    const res = check(deps);
    expect(res?.status).toBe("pass");
    expect(res?.message).toContain("reviewed on 2026-09-30");
  });

  test("passes when the latest version is older than the reviewed version", () => {
    const { deps } = reviewDeps({ "/plugin/mise.toml": TESTED, "/plugin/opencode-review.json": REVIEW }, "1.18.33\n");
    expect(check(deps)?.status).toBe("pass");
  });

  test("warns when the latest version is newer than both tested and reviewed", () => {
    const { deps } = reviewDeps({ "/plugin/mise.toml": TESTED, "/plugin/opencode-review.json": REVIEW }, "1.19.0\n");
    const res = check(deps);
    expect(res?.status).toBe("warn");
    expect(res?.message).toContain("opencode 1.19.0 is out");
    expect(res?.message).toContain("oc-sub is tested with 1.18.32");
    expect(res?.message).toContain("last review 1.18.33 on 2026-09-30");
    expect(res?.fix).toBe(`read the release notes of opencode 1.19.0, then either raise the pin in the mise.toml of oc-sub and run the tests, or record the decision in opencode-review.json`);
  });

  test("warns when the review file is missing and the latest is newer than tested", () => {
    const { deps } = reviewDeps({ "/plugin/mise.toml": TESTED }, "1.19.0\n");
    const res = check(deps);
    expect(res?.status).toBe("warn");
    expect(res?.message).toContain("last review none");
  });

  test("treats a broken review file as nothing reviewed", () => {
    const { deps } = reviewDeps({ "/plugin/mise.toml": TESTED, "/plugin/opencode-review.json": "{ no json" }, "1.19.0\n");
    expect(check(deps)?.status).toBe("warn");
  });

  test("skips when mise fails and never treats that as a pass", () => {
    const { deps } = reviewDeps({ "/plugin/mise.toml": TESTED, "/plugin/opencode-review.json": REVIEW }, "", 1);
    const res = check(deps);
    expect(res?.status).toBe("skip");
    expect(res?.message).toContain("code 1");
  });

  test("skips when mise prints no version", () => {
    const { deps } = reviewDeps({ "/plugin/mise.toml": TESTED, "/plugin/opencode-review.json": REVIEW }, "  \n");
    expect(check(deps)?.status).toBe("skip");
  });

  test("skips without an opencode pin in the plugin repository", () => {
    const { deps } = reviewDeps({ "/plugin/mise.toml": '[tools]\nbun = "1.4.2"\n' }, "1.19.0\n");
    expect(check(deps)?.status).toBe("skip");
  });
});

describe("globalMiseConfigPath", () => {
  test("prefers MISE_GLOBAL_CONFIG_FILE, then XDG_CONFIG_HOME, then HOME", () => {
    expect(globalMiseConfigPath({ MISE_GLOBAL_CONFIG_FILE: "/etc/m.toml", HOME: "/h" })).toBe("/etc/m.toml");
    expect(globalMiseConfigPath({ XDG_CONFIG_HOME: "/x", HOME: "/h" })).toBe("/x/mise/config.toml");
    expect(globalMiseConfigPath({ HOME: "/h" })).toBe("/h/.config/mise/config.toml");
  });
});

describe("miseToolVersion", () => {
  test("reads a string, a table, and nothing", () => {
    expect(miseToolVersion('[tools]\nopencode = "1.2.3"', "opencode")).toBe("1.2.3");
    expect(miseToolVersion('[tools]\nopencode = { version = "1.2.3" }', "opencode")).toBe("1.2.3");
    expect(miseToolVersion('[tools]\nbun = "1"', "opencode")).toBeNull();
    expect(miseToolVersion(null, "opencode")).toBeNull();
  });
});

describe("deepinfra-key check (step 16)", () => {
  test("skips without the key file", () => {
    const check = byName(results(makeDeps(), SLOW_CHECKS), "deepinfra-key");
    expect(check?.status).toBe("skip");
    expect(check?.message).toContain("/home/u/.config/repo/deepinfra.key");
  });

  test("passes with mode 600", () => {
    const check = byName(results(makeDeps({}, { fileMode: () => 0o600 }), SLOW_CHECKS), "deepinfra-key");
    expect(check?.status).toBe("pass");
    expect(check?.message).toContain("mode 600");
  });

  test("warns with a wider mode and names chmod 600", () => {
    const check = byName(results(makeDeps({}, { fileMode: () => 0o644 }), SLOW_CHECKS), "deepinfra-key");
    expect(check?.status).toBe("warn");
    expect(check?.message).toContain("mode 644");
    expect(check?.fix).toBe("chmod 600 /home/u/.config/repo/deepinfra.key");
  });

  test("only looks at the mode, never at the content", () => {
    const read: string[] = [];
    const deps = makeDeps({}, {
      fileMode: () => 0o600,
      readText: (file) => {
        read.push(file);
        return null;
      },
    });
    byName(results(deps, SLOW_CHECKS), "deepinfra-key");
    expect(read.filter((file) => file.endsWith("deepinfra.key"))).toEqual([]);
  });

  test("makeDoctorDeps puts the key file into the config folder of the project", () => {
    const deps = makeDoctorDeps({ XDG_CONFIG_HOME: "/cfg", HOME: "/home/u" }, "/work/myproj");
    expect(deps.deepinfraKeyFile).toBe("/cfg/myproj/deepinfra.key");
  });
});
