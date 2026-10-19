/**
 * The inference guard of the test preload (test/setup.ts). No test may cause
 * inference costs. So a test child never reaches the real `claude`,
 * `claude-glm`, or `opencode run`, never gets a key variable, and never sees
 * the real home folder, its login, or its git config.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { GUARD_BIN, GUARD_MESSAGE, TEST_HOME, isKeyVariable, isProviderUrl } from "./setup";

/** Whether `file` lies inside the run folder of this test run. */
function inRunFolder(file: string | undefined): boolean {
  return file !== undefined && !path.relative(tmpdir(), file).startsWith("..");
}

function run(cmd: string[]): { code: number; out: string; err: string } {
  const proc = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  return { code: proc.exitCode ?? -1, out: proc.stdout.toString(), err: proc.stderr.toString() };
}

describe("the inference guard", () => {
  for (const cli of ["claude", "claude-glm"]) {
    test(`a child that runs ${cli} hits the fake, which fails loudly`, () => {
      const res = run(["sh", "-c", `${cli} -p "say hi"`]);
      expect(res.code).not.toBe(0);
      expect(res.err).toContain(GUARD_MESSAGE);
      expect(res.out).toBe("");
    });
  }

  test("a child that runs `opencode run` hits the guard", () => {
    const res = run(["sh", "-c", 'opencode run "say hi"']);
    expect(res.code).not.toBe(0);
    expect(res.err).toContain(GUARD_MESSAGE);
  });

  test("the fake folder is first on PATH and lies in the run folder", () => {
    expect(process.env.PATH?.split(":")[0]).toBe(GUARD_BIN);
    expect(inRunFolder(GUARD_BIN)).toBe(true);
    expect(Bun.which("claude")).toBe(path.join(GUARD_BIN, "claude"));
    expect(Bun.which("claude-glm")).toBe(path.join(GUARD_BIN, "claude-glm"));
  });

  test("no key variable reaches the test or a child", () => {
    const names = Object.keys(process.env).filter(isKeyVariable);
    expect(names).toEqual([]);
    for (const name of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "OPENROUTER_API_KEY", "DEEPINFRA_API_KEY"]) {
      expect(run(["sh", "-c", `printf %s "\${${name}-unset}"`]).out).toBe("unset");
    }
  });

  test("the key pattern names the provider keys and nothing else", () => {
    for (const name of [
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "OPENROUTER_API_KEY",
      "ZAI_API_KEY",
      "Z_AI_API_KEY",
      "OPENAI_API_KEY",
      "GEMINI_API_KEY",
      "DEEPINFRA_API_KEY",
      "GH_TOKEN",
      "AWS_SECRET_ACCESS_KEY",
    ]) {
      expect(isKeyVariable(name)).toBe(true);
    }
    for (const name of ["HOME", "PATH", "TMPDIR", "IDFX_OWNER", "OPENCODE_SERVER_PASSWORD"]) {
      expect(isKeyVariable(name)).toBe(false);
    }
  });

  test("HOME and the config folders of a child lie in the run folder", () => {
    expect(process.env.HOME).toBe(TEST_HOME);
    expect(run(["sh", "-c", 'printf %s "$HOME"']).out).toBe(TEST_HOME);
    for (const name of ["XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME", "CLAUDE_CONFIG_DIR"]) {
      expect(inRunFolder(process.env[name])).toBe(true);
      expect(existsSync(process.env[name] ?? "")).toBe(true);
    }
  });

  test("git in a child has a test identity from a git config in the run folder", () => {
    expect(inRunFolder(process.env.GIT_CONFIG_GLOBAL)).toBe(true);
    expect(readFileSync(process.env.GIT_CONFIG_GLOBAL ?? "", "utf8")).toContain("[user]");
    expect(run(["git", "config", "--global", "user.email"]).out.trim()).toBe("idfx-test@example.invalid");
    expect(run(["git", "config", "--show-origin", "--global", "--list"]).out).not.toContain(".gitconfig");
  });

  test("the bun install cache stays the shared cache outside the run folder", () => {
    expect(process.env.BUN_INSTALL_CACHE_DIR).toBeDefined();
    expect(inRunFolder(process.env.BUN_INSTALL_CACHE_DIR)).toBe(false);
  });

  test("a fetch of the test process to a model provider throws", async () => {
    await expect(fetch("https://api.anthropic.com/v1/messages", { method: "POST", body: "{}" })).rejects.toThrow(
      GUARD_MESSAGE,
    );
    await expect(fetch(new URL("https://openrouter.ai/api/v1/chat/completions"))).rejects.toThrow(GUARD_MESSAGE);
  });

  test("the provider pattern matches the model hosts and not localhost", () => {
    expect(isProviderUrl("https://api.anthropic.com/v1/messages")).toBe(true);
    expect(isProviderUrl("https://openrouter.ai/api/v1/key")).toBe(true);
    expect(isProviderUrl("https://api.deepinfra.com/v1/openai")).toBe(true);
    expect(isProviderUrl("https://api.z.ai/api/anthropic")).toBe(true);
    expect(isProviderUrl("http://127.0.0.1:8790/chat/completions")).toBe(false);
    expect(isProviderUrl("http://localhost:4096/global/health")).toBe(false);
    expect(isProviderUrl("not a url")).toBe(false);
  });
});
