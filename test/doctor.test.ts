import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gateForCommand } from "../src/doctor";
import { main } from "../src/cli";
import {
  ALL_CHECKS,
  FAST_CHECKS,
  PLUGIN_KEY,
  PLUGIN_UPDATE_FIX,
  gateFastChecks,
  isPermissionOnlyAgent,
  makeDoctorDeps,
  runChecks,
  runFastChecksFor,
  SLOW_CHECKS,
  type CheckResult,
  type DoctorDeps,
} from "../src/doctor";
import { requiredSandboxMounts } from "../src/sandbox";
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
    PLUGIN_CONFIG_DIR,
    "/home/u/.local/share/mise/installs",
    "/home/u/dv/meta/agents",
  ).join(", ");
  const lsWithMounts = `NAME STATUS WORKSPACE\noc-sub-repo running /repo, ${mounts}\n`;
  const lsWithout = `NAME STATUS WORKSPACE\noc-sub-repo running /repo\n`;

  test("skips without a sandbox state", () => {
    expect(byName(results(makeDeps(), SLOW_CHECKS), "sandbox-mounts")?.status).toBe("skip");
  });

  test("passes when sbx ls lists all required mounts", () => {
    const deps = makeDeps(
      {},
      {
        runner: () => ({ stdout: lsWithMounts, exitCode: 0 }),
        sandboxState: () => ({ name: "oc-sub-repo", root: "/repo", port: 18768 }),
      },
    );
    expect(byName(results(deps, SLOW_CHECKS), "sandbox-mounts")?.status).toBe("pass");
  });

  test("fails with the sbx rm fix when a mount is missing", () => {
    const deps = makeDeps(
      {},
      {
        runner: () => ({ stdout: lsWithout, exitCode: 0 }),
        sandboxState: () => ({ name: "oc-sub-repo", root: "/repo", port: 18768 }),
      },
    );
    const check = byName(results(deps, SLOW_CHECKS), "sandbox-mounts");
    expect(check?.status).toBe("fail");
    expect(check?.fix).toContain("sbx rm oc-sub-repo");
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
