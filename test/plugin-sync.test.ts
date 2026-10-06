import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pluginDataDir, pluginDigest, proxyBundleIn, syncPluginDir, OPENCODE_GITIGNORE } from "../src/plugin-sync";

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "oc-sub-plugin-sync-"));
}

/** A small plugin folder like `opencode/` of the repository. */
function makePlugin(): string {
  const dir = tempDir();
  mkdirSync(path.join(dir, "agents"));
  mkdirSync(path.join(dir, "cost-proxy"));
  writeFileSync(path.join(dir, "agents", "coder.md"), "coder v1\n");
  writeFileSync(path.join(dir, "agents", "reader.md"), "reader v1\n");
  writeFileSync(path.join(dir, "cost-proxy", "cost-proxy.js"), "// bundle v1\n");
  writeFileSync(path.join(dir, "opencode.json"), "{}\n");
  return dir;
}

describe("pluginDataDir", () => {
  test("uses XDG_DATA_HOME when it is absolute", () => {
    expect(pluginDataDir({ XDG_DATA_HOME: "/data" })).toBe("/data/oc-sub/opencode");
  });

  test("falls back to HOME/.local/share", () => {
    expect(pluginDataDir({ HOME: "/home/user" })).toBe("/home/user/.local/share/oc-sub/opencode");
    expect(pluginDataDir({ HOME: "/home/user", XDG_DATA_HOME: "relative" })).toBe("/home/user/.local/share/oc-sub/opencode");
  });

  test("proxyBundleIn names the bundle inside the folder", () => {
    expect(proxyBundleIn("/d/opencode")).toBe("/d/opencode/cost-proxy/cost-proxy.js");
  });
});

describe("pluginDigest", () => {
  test("is null for a missing folder", () => {
    expect(pluginDigest(path.join(tempDir(), "missing"))).toBeNull();
  });

  test("is equal for equal content in different folders", () => {
    const a = makePlugin();
    const b = makePlugin();
    expect(pluginDigest(a)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(pluginDigest(a)).toBe(pluginDigest(b));
  });

  test("changes with the content, a new file, and a rename", () => {
    const dir = makePlugin();
    const before = pluginDigest(dir);
    writeFileSync(path.join(dir, "agents", "coder.md"), "coder v2\n");
    const edited = pluginDigest(dir);
    expect(edited).not.toBe(before);
    writeFileSync(path.join(dir, "agents", "new.md"), "x");
    expect(pluginDigest(dir)).not.toBe(edited);
  });

  test("ignores the files that opencode writes into a config folder", () => {
    const dir = makePlugin();
    const before = pluginDigest(dir);
    writeFileSync(path.join(dir, "package.json"), "{}");
    writeFileSync(path.join(dir, ".gitignore"), "node_modules\n");
    mkdirSync(path.join(dir, "node_modules", "x"), { recursive: true });
    writeFileSync(path.join(dir, "node_modules", "x", "index.js"), "1");
    expect(pluginDigest(dir)).toBe(before);
  });
});

describe("syncPluginDir", () => {
  test("creates the folder and copies the plugin", () => {
    const src = makePlugin();
    const dest = path.join(tempDir(), "oc-sub", "opencode");
    const result = syncPluginDir(src, dest);
    expect(result.changed).toBe(true);
    expect(result.digest).toBe(pluginDigest(src) as string);
    expect(readFileSync(path.join(dest, "agents", "coder.md"), "utf8")).toBe("coder v1\n");
    expect(pluginDigest(dest)).toBe(pluginDigest(src));
  });

  test("writes nothing when the content already matches", () => {
    const src = makePlugin();
    const dest = path.join(tempDir(), "opencode");
    syncPluginDir(src, dest);
    const mtime = statSync(path.join(dest, "agents", "coder.md")).mtimeMs;
    const again = syncPluginDir(src, dest);
    expect(again.changed).toBe(false);
    expect(statSync(path.join(dest, "agents", "coder.md")).mtimeMs).toBe(mtime);
  });

  test("updates changed files, removes dropped ones, and keeps the folder itself", () => {
    const src = makePlugin();
    const dest = path.join(tempDir(), "opencode");
    syncPluginDir(src, dest);
    const folderIno = statSync(dest).ino;
    writeFileSync(path.join(src, "agents", "coder.md"), "coder v2\n");
    // A dropped file, and a folder that turns into a file.
    Bun.spawnSync(["rm", "-rf", path.join(src, "agents", "reader.md"), path.join(src, "cost-proxy")]);
    writeFileSync(path.join(src, "cost-proxy"), "now a file\n");
    const result = syncPluginDir(src, dest);
    expect(result.changed).toBe(true);
    expect(statSync(dest).ino).toBe(folderIno);
    expect(readFileSync(path.join(dest, "agents", "coder.md"), "utf8")).toBe("coder v2\n");
    expect(existsSync(path.join(dest, "agents", "reader.md"))).toBe(false);
    expect(readFileSync(path.join(dest, "cost-proxy"), "utf8")).toBe("now a file\n");
    expect(pluginDigest(dest)).toBe(pluginDigest(src));
  });

  test("keeps the opencode install in the folder and does not copy the one of the source", () => {
    const src = makePlugin();
    mkdirSync(path.join(src, "node_modules", "big"), { recursive: true });
    writeFileSync(path.join(src, "node_modules", "big", "index.js"), "source install");
    const dest = path.join(tempDir(), "opencode");
    mkdirSync(path.join(dest, "node_modules", "own"), { recursive: true });
    writeFileSync(path.join(dest, "package.json"), "own");
    syncPluginDir(src, dest);
    expect(existsSync(path.join(dest, "node_modules", "big"))).toBe(false);
    expect(existsSync(path.join(dest, "node_modules", "own"))).toBe(true);
    expect(readFileSync(path.join(dest, "package.json"), "utf8")).toBe("own");
  });

  test("copies a symlink as a symlink", () => {
    const src = makePlugin();
    symlinkSync("agents/coder.md", path.join(src, "link.md"));
    const dest = path.join(tempDir(), "opencode");
    syncPluginDir(src, dest);
    expect(readlinkSync(path.join(dest, "link.md"))).toBe("agents/coder.md");
    symlinkSync("agents/reader.md", path.join(src, "link2.md"));
    Bun.spawnSync(["ln", "-sfn", "agents/reader.md", path.join(src, "link.md")]);
    syncPluginDir(src, dest);
    expect(readlinkSync(path.join(dest, "link.md"))).toBe("agents/reader.md");
  });

  test("fails for a missing source and leaves the destination alone", () => {
    const dest = path.join(tempDir(), "opencode");
    expect(() => syncPluginDir(path.join(tempDir(), "missing"), dest)).toThrow("does not exist");
    expect(existsSync(dest)).toBe(false);
  });

  test("writes the expected .gitignore into a new dest", () => {
    const src = makePlugin();
    const dest = path.join(tempDir(), "opencode");
    syncPluginDir(src, dest);
    expect(readFileSync(path.join(dest, ".gitignore"), "utf8")).toBe(OPENCODE_GITIGNORE);
  });

  test("writes a missing .gitignore even when the digests already match", () => {
    const src = makePlugin();
    const dest = path.join(tempDir(), "opencode");
    syncPluginDir(src, dest);
    rmSync(path.join(dest, ".gitignore"));
    const again = syncPluginDir(src, dest);
    expect(again.changed).toBe(false);
    expect(readFileSync(path.join(dest, ".gitignore"), "utf8")).toBe(OPENCODE_GITIGNORE);
  });

  test("never overwrites an existing .gitignore", () => {
    const src = makePlugin();
    const dest = path.join(tempDir(), "opencode");
    mkdirSync(dest, { recursive: true });
    writeFileSync(path.join(dest, ".gitignore"), "custom\n");
    syncPluginDir(src, dest);
    syncPluginDir(src, dest);
    expect(readFileSync(path.join(dest, ".gitignore"), "utf8")).toBe("custom\n");
  });

  test("the digest is the same with and without .gitignore", () => {
    const dir = makePlugin();
    const without = pluginDigest(dir);
    writeFileSync(path.join(dir, ".gitignore"), OPENCODE_GITIGNORE);
    expect(pluginDigest(dir)).toBe(without);
  });
});
