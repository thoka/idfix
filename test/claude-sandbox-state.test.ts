import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  KIT_CREDENTIALS,
  claudeCreateArgs,
  claudeExecArgs,
  claudeStateDir,
  enabledPlugins,
  ensureClaudeStateDir,
  hostClaudeDir,
  inClaudeTmp,
  sandboxSettings,
  syncClaudeState,
} from "../src/claude/sandbox-state";

/** A uid that never matches the temp folder of the test run. */
const UID = 999_999;

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "idfx-claude-state-"));
}

function write(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

describe("claudeStateDir", () => {
  test("uses XDG_STATE_HOME when it is absolute", () => {
    expect(claudeStateDir({ XDG_STATE_HOME: "/x/state" }, "claude-p", "/home/u")).toBe("/x/state/idfx/sbx/claude-p/claude");
  });
  test("falls back to ~/.local/state", () => {
    expect(claudeStateDir({ XDG_STATE_HOME: "rel" }, "claude-p", "/home/u")).toBe("/home/u/.local/state/idfx/sbx/claude-p/claude");
  });
});

describe("inClaudeTmp and ensureClaudeStateDir", () => {
  test("detects the Claude temp folder", () => {
    expect(inClaudeTmp("/tmp/claude-1000", 1000)).toBe(true);
    expect(inClaudeTmp("/tmp/claude-1000/x/../y", 1000)).toBe(true);
    expect(inClaudeTmp("/tmp/claude-10000/x", 1000)).toBe(false);
    expect(inClaudeTmp("/home/u/.local/state", 1000)).toBe(false);
  });
  test("refuses a folder in the Claude temp folder", () => {
    expect(() => ensureClaudeStateDir("/tmp/claude-42/state", 42)).toThrow(/claude-42/);
  });
  test("creates the folder with mode 700", () => {
    const dir = path.join(tempDir(), "a", "claude");
    ensureClaudeStateDir(dir, UID);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });
});

describe("hostClaudeDir", () => {
  test("honors an absolute CLAUDE_CONFIG_DIR", () => {
    expect(hostClaudeDir({ CLAUDE_CONFIG_DIR: "/c" }, "/home/u")).toBe("/c");
    expect(hostClaudeDir({}, "/home/u")).toBe("/home/u/.claude");
  });
});

describe("enabledPlugins", () => {
  const installed = JSON.stringify({
    version: 2,
    plugins: {
      "alpha@m1": [{ scope: "project", installPath: "/p/alpha-project" }, { scope: "user", installPath: "/p/alpha" }],
      "beta@m2": [{ scope: "user", installPath: "/p/beta" }],
      "off@m1": [{ scope: "user", installPath: "/p/off" }],
      "rel@m1": [{ scope: "user", installPath: "relative" }],
    },
  });
  test("takes the user entry of each enabled plugin", () => {
    const settings = JSON.stringify({ enabledPlugins: { "beta@m2": true, "alpha@m1": true, "off@m1": false, "rel@m1": true, "gone@m": true } });
    expect(enabledPlugins(installed, settings)).toEqual([
      { name: "alpha", installPath: "/p/alpha" },
      { name: "beta", installPath: "/p/beta" },
    ]);
  });
  test("returns nothing for missing or broken files", () => {
    expect(enabledPlugins(undefined, "{}")).toEqual([]);
    expect(enabledPlugins(installed, "not json")).toEqual([]);
  });
});

describe("sandboxSettings", () => {
  test("keeps the kit values, model, and env, and drops hooks and statusLine", () => {
    const host = JSON.stringify({
      model: "opus",
      env: { A: "1", N: 2, CLAUDE_CONFIG_DIR: "/host" },
      hooks: { Stop: [] },
      statusLine: { type: "command" },
      permissions: { allow: ["Bash"] },
    });
    expect(sandboxSettings(host)).toEqual({
      permissions: { defaultMode: "bypassPermissions" },
      skipDangerousModePermissionPrompt: true,
      model: "opus",
      env: { A: "1" },
    });
  });
  test("works without host settings", () => {
    expect(sandboxSettings(undefined)).toEqual({ permissions: { defaultMode: "bypassPermissions" }, skipDangerousModePermissionPrompt: true });
  });
});

describe("syncClaudeState", () => {
  function fixture() {
    const root = tempDir();
    const host = path.join(root, "host");
    const shared = path.join(root, "shared");
    write(path.join(shared, "AGENTS.md"), "# rules\n");
    write(path.join(shared, "skills", "grill", "SKILL.md"), "grill\n");
    write(path.join(shared, "skills", "grill", "ref", "deep.md"), "deep\n");
    mkdirSync(path.join(host, "skills"), { recursive: true });
    symlinkSync(path.join(shared, "AGENTS.md"), path.join(host, "CLAUDE.md"));
    symlinkSync(path.join(shared, "skills", "grill"), path.join(host, "skills", "grill"));
    symlinkSync(path.join(root, "nowhere"), path.join(host, "skills", "dangling"));
    write(path.join(host, "skills", "local", "SKILL.md"), "local\n");
    write(path.join(host, "skills", ".trash", "old", "SKILL.md"), "old\n");
    write(path.join(host, ".credentials.json"), "HOST SECRET");
    const plugin = path.join(root, "cache", "simple", "1.0");
    write(path.join(plugin, ".claude-plugin", "plugin.json"), "{}");
    write(path.join(plugin, "skills", "s", "SKILL.md"), "s\n");
    write(
      path.join(host, "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: {
          "simple@m": [{ scope: "user", installPath: plugin }],
          "lost@m": [{ scope: "user", installPath: path.join(root, "cache", "lost") }],
        },
      }),
    );
    write(
      path.join(host, "settings.json"),
      JSON.stringify({ model: "sonnet", env: { X: "y" }, hooks: { Stop: [] }, enabledPlugins: { "simple@m": true, "lost@m": true } }),
    );
    const state = path.join(root, "state", "sbx", "box", "claude");
    return { root, host, shared, plugin, state };
  }

  test("copies rules, skills, plugins, and settings with links followed", () => {
    const { host, plugin, state } = fixture();
    const result = syncClaudeState(host, state, UID);
    expect(result).toEqual({ pluginDirs: [path.join(state, "plugins-src", "simple")], missingPlugins: ["lost"] });
    expect(statSync(state).mode & 0o777).toBe(0o700);
    expect(lstatSync(path.join(state, "CLAUDE.md")).isSymbolicLink()).toBe(false);
    expect(readFileSync(path.join(state, "CLAUDE.md"), "utf8")).toBe("# rules\n");
    expect(lstatSync(path.join(state, "skills", "grill")).isDirectory()).toBe(true);
    expect(readFileSync(path.join(state, "skills", "grill", "ref", "deep.md"), "utf8")).toBe("deep\n");
    expect(readFileSync(path.join(state, "skills", "local", "SKILL.md"), "utf8")).toBe("local\n");
    expect(existsSync(path.join(state, "skills", ".trash"))).toBe(false);
    expect(existsSync(path.join(state, "skills", "dangling"))).toBe(false);
    expect(readFileSync(path.join(state, "plugins-src", "simple", "skills", "s", "SKILL.md"), "utf8")).toBe("s\n");
    expect(existsSync(path.join(state, "plugins-src", "simple", ".claude-plugin", "plugin.json"))).toBe(true);
    expect(existsSync(plugin)).toBe(true);
    expect(JSON.parse(readFileSync(path.join(state, "settings.json"), "utf8"))).toEqual({
      permissions: { defaultMode: "bypassPermissions" },
      skipDangerousModePermissionPrompt: true,
      model: "sonnet",
      env: { X: "y" },
    });
    expect(existsSync(path.join(state, ".credentials.json"))).toBe(false);
  });

  test("deletes stale entries and keeps the files of Claude Code", () => {
    const { host, state } = fixture();
    syncClaudeState(host, state, UID);
    write(path.join(state, "skills", "stale", "SKILL.md"), "stale\n");
    write(path.join(state, "plugins-src", "old", "x"), "x");
    write(path.join(state, "projects", "p", "s.jsonl"), "{}\n");
    write(path.join(state, ".credentials.json"), "sentinel");
    writeFileSync(path.join(host, "settings.json"), JSON.stringify({ enabledPlugins: {} }));
    syncClaudeState(host, state, UID);
    expect(existsSync(path.join(state, "skills", "stale"))).toBe(false);
    expect(existsSync(path.join(state, "plugins-src", "old"))).toBe(false);
    expect(existsSync(path.join(state, "plugins-src", "simple"))).toBe(false);
    expect(readFileSync(path.join(state, "projects", "p", "s.jsonl"), "utf8")).toBe("{}\n");
    expect(readFileSync(path.join(state, ".credentials.json"), "utf8")).toBe("sentinel");
  });

  test("removes CLAUDE.md and skills when the host has none", () => {
    const root = tempDir();
    const host = path.join(root, "host");
    const state = path.join(root, "state");
    mkdirSync(host);
    write(path.join(state, "CLAUDE.md"), "old");
    write(path.join(state, "skills", "a", "SKILL.md"), "a");
    expect(syncClaudeState(host, state, UID)).toEqual({ pluginDirs: [], missingPlugins: [] });
    expect(existsSync(path.join(state, "CLAUDE.md"))).toBe(false);
    expect(existsSync(path.join(state, "skills", "a"))).toBe(false);
  });
});

describe("claudeCreateArgs and claudeExecArgs", () => {
  test("builds the create command of option D", () => {
    expect(claudeCreateArgs("sbx", "claude-p", "/r/p", "/s/claude")).toEqual([
      "sbx", "create", "--clone", "--skills=off", "--name", "claude-p", "claude", "/r/p", "/s/claude",
    ]);
  });
  test("builds the exec command with the config folder, the sentinel copy, and the plugin folders", () => {
    const args = claudeExecArgs("sbx", "claude-p", "/s/claude", "/r/p/.worktrees/a b", ["/s/claude/plugins-src/x"], ["-p", "it's"]);
    expect(args.slice(0, 7)).toEqual(["sbx", "exec", "-e", "CLAUDE_CONFIG_DIR=/s/claude", "claude-p", "bash", "-lc"]);
    expect(args[7]).toBe(
      `test -f "$CLAUDE_CONFIG_DIR/.credentials.json" || install -m 600 '${KIT_CREDENTIALS}' "$CLAUDE_CONFIG_DIR/.credentials.json"` +
        ` && cd '/r/p/.worktrees/a b' && exec 'claude' '-p' 'it'\\''s' '--plugin-dir' '/s/claude/plugins-src/x'`,
    );
  });
});
