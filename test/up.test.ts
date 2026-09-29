import { describe, expect, test } from "bun:test";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { PLUGIN_CONFIG_DIR, serveEnv } from "../src/up";

const PLUGIN_DIR = path.resolve(import.meta.dir, "..");

describe("serveEnv", () => {
  test("sets OPENCODE_CONFIG_DIR to the plugin config directory", () => {
    const { env, warning } = serveEnv({ HOME: "/home/u" }, `${PLUGIN_DIR}/opencode`);
    expect(env.OPENCODE_CONFIG_DIR).toBe(`${PLUGIN_DIR}/opencode`);
    expect(env.HOME).toBe("/home/u");
    expect(warning).toBeUndefined();
  });

  test("an existing value stays and gives a warning", () => {
    const { env, warning } = serveEnv({ OPENCODE_CONFIG_DIR: "/my/own/agents" }, `${PLUGIN_DIR}/opencode`);
    expect(env.OPENCODE_CONFIG_DIR).toBe("/my/own/agents");
    expect(warning).toBe("OPENCODE_CONFIG_DIR is already set to /my/own/agents. The research agents of the plugin are not loaded.");
  });

  test("the same value gives no warning", () => {
    const dir = `${PLUGIN_DIR}/opencode`;
    const { env, warning } = serveEnv({ OPENCODE_CONFIG_DIR: dir }, dir);
    expect(env.OPENCODE_CONFIG_DIR).toBe(dir);
    expect(warning).toBeUndefined();
  });

  test("an empty value counts as unset", () => {
    const { env, warning } = serveEnv({ OPENCODE_CONFIG_DIR: "" }, `${PLUGIN_DIR}/opencode`);
    expect(env.OPENCODE_CONFIG_DIR).toBe(`${PLUGIN_DIR}/opencode`);
    expect(warning).toBeUndefined();
  });

  test("the input object stays unchanged", () => {
    const input: Record<string, string | undefined> = { OPENCODE_CONFIG_DIR: "relative/opencode", HOME: "/home/u" };
    serveEnv(input, `${PLUGIN_DIR}/opencode`);
    expect(input.OPENCODE_CONFIG_DIR).toBe("relative/opencode");
    expect(input.HOME).toBe("/home/u");
    expect(Object.keys(input)).toHaveLength(2);
  });

  test("sets OPENCODE_ENABLE_EXA to 1 for the websearch of the researcher", () => {
    const { env } = serveEnv({ HOME: "/home/u" }, `${PLUGIN_DIR}/opencode`);
    expect(env.OPENCODE_ENABLE_EXA).toBe("1");
  });

  test("keeps an existing OPENCODE_ENABLE_EXA, with and without a config dir", () => {
    expect(serveEnv({ OPENCODE_ENABLE_EXA: "0" }, `${PLUGIN_DIR}/opencode`).env.OPENCODE_ENABLE_EXA).toBe("0");
    const { env, warning } = serveEnv(
      { OPENCODE_CONFIG_DIR: "/my/own/agents", OPENCODE_ENABLE_EXA: "0" },
      `${PLUGIN_DIR}/opencode`,
    );
    expect(env.OPENCODE_ENABLE_EXA).toBe("0");
    expect(warning).toBeDefined();
  });
});

describe("plugin config directory", () => {
  test("is opencode/ next to src/ and holds the research agents", () => {
    expect(PLUGIN_CONFIG_DIR).toBe(path.join(PLUGIN_DIR, "opencode"));
    const agentsDir = path.join(PLUGIN_DIR, "opencode", "agents");
    expect(existsSync(agentsDir)).toBe(true);
    expect(existsSync(path.join(agentsDir, "researcher.md"))).toBe(true);
    expect(existsSync(path.join(agentsDir, "reader.md"))).toBe(true);
    const reader = readFileSync(path.join(agentsDir, "reader.md"), "utf8");
    expect(reader).toContain("mode: subagent");
    expect(reader).toContain("hidden: true");
    // A step limit keeps one reader call from crawling a whole site.
    expect(reader).toMatch(/^steps: \d+$/m);
  });
});

describe("plugin routing", () => {
  test("pins GLM to the approved providers without fallback", () => {
    const config = JSON.parse(readFileSync(path.join(PLUGIN_DIR, "opencode", "opencode.json"), "utf8"));
    const routing = config.provider.openrouter.models["z-ai/glm-5.3-flash"].options.provider;
    expect(routing.only).toEqual(["z-ai"]);
    expect(routing.allow_fallbacks).toBe(false);
  });
});
