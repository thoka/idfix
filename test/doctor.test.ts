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
  globalRulesFix,
  isPermissionOnlyAgent,
  doctor,
  makeDoctorDeps,
  pluginFreshFix,
  runChecks,
  runFastChecksFor,
  runFixes,
  SLOW_CHECKS,
  type Check,
  type CheckResult,
  type DoctorDeps,
} from "../src/doctor";
import { cloneCheckCommand, missingCloneMessage, requiredSandboxMounts, sandboxRecreateFix } from "../src/sandbox";
import { PLUGIN_CONFIG_DIR } from "../src/up";

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
    projectName: "repo",
    pluginRepoRoot: "/plugin",
    installedPluginsFile: "/home/u/.claude/plugins/installed_plugins.json",
    originAlphaSha: () => "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    sandboxState: () => null,
    sandboxBin: "sbx",
    runner: () => ({ stdout: "", exitCode: 0 }),
    claudeBin: "claude",
    claudeRunner: () => ({ stdout: "", exitCode: 0 }),
    // The fake swap turns the file entry into a symlink entry, so a re-run of
    // the checks sees the fixed state.
    replaceWithSymlink: (file, target) => files.set(file, { link: target }),
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
    PLUGIN_CONFIG_DIR,
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
    const ls = `NAME STATUS WORKSPACE\noc-sub-repo running ${root}, ${PLUGIN_CONFIG_DIR}:ro, /home/u/.local/share/mise/installs:ro\n`;
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

  test("catches a throwing action as a failed fix and runs the other actions", () => {
    lines.length = 0;
    const checks: Check[] = [
      { name: "boom", run: () => ({ name: "boom", status: "fail", message: "bad" }), fix: () => { throw new Error("boom"); } },
      { name: "after", run: () => ({ name: "after", status: "warn", message: "meh" }), fix: () => ({ ok: true, note: "did it" }) },
    ];
    const deps = makeDeps();
    const records = runFixes(
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

  test("skips pass and skip results and checks without a fix action", () => {
    lines.length = 0;
    const checks: Check[] = [{ name: "no-fix", run: () => ({ name: "no-fix", status: "fail", message: "bad" }) }];
    const records = runFixes(checks, makeDeps(), [{ name: "no-fix", status: "fail", message: "bad" }], { force: false }, print);
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

  test("fixes global-rules and plugin-fresh in registry order and prints the lines", () => {
    const deps = fixDeps({ [codexMd]: { content: "# rules" }, "/home/u/.claude/plugins/installed_plugins.json": { content: installedOld } });
    const lines: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation((line) => lines.push(String(line)));
    let code: number;
    try {
      code = doctor({ fix: true }, { HOME: "/home/u" } as Record<string, string>, deps);
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

  test("returns 1 when a fix fails", () => {
    const deps = fixDeps({ [codexMd]: { content: "# my own rules" } });
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    let code: number;
    try {
      code = doctor({ fix: true }, { HOME: "/home/u" } as Record<string, string>, deps);
    } finally {
      logSpy.mockRestore();
    }
    expect(code).toBe(1);
  });

  test("returns 1 when the re-run still has a fail", () => {
    // The claude fix fails, so plugin-fresh stays a warn (not a fail), but a
    // differing copy keeps global-rules failed in the re-run too.
    const deps = fixDeps({ [codexMd]: { content: "# my own rules" } });
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    let code: number;
    try {
      code = doctor({ fix: true }, { HOME: "/home/u" } as Record<string, string>, deps);
    } finally {
      logSpy.mockRestore();
    }
    expect(code).toBe(1);
  });

  test("prints {fixes, results} with --fix --json", () => {
    const deps = fixDeps({
      [codexMd]: { content: "# rules" },
      "/home/u/.claude/plugins/installed_plugins.json": { content: installedOld },
    });
    const lines: string[] = [];
    const errors: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation((line) => lines.push(String(line)));
    const errorSpy = spyOn(console, "error").mockImplementation((line) => errors.push(String(line)));
    try {
      doctor({ fix: true, json: true }, { HOME: "/home/u" } as Record<string, string>, deps);
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

  test("keeps the plain --json array without --fix", () => {
    const deps = fixDeps({});
    const lines: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation((line) => lines.push(String(line)));
    try {
      doctor({ json: true }, { HOME: "/home/u" } as Record<string, string>, deps);
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
