import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  addDir,
  legacyStateDir,
  migrateStateDir,
  newStateDir,
  oldStateDir,
  parseDirs,
  readDirs,
  readPid,
  serveDirsPath,
  servePidPath,
  stateDir,
} from "../src/state";

describe("stateDir", () => {
  test("uses XDG_STATE_HOME when it is an absolute path", () => {
    expect(stateDir({ XDG_STATE_HOME: "/s" }, "/home/user")).toBe("/s/idfx");
  });

  test("falls back to ~/.local/state for a missing or relative XDG_STATE_HOME", () => {
    expect(stateDir({}, "/home/user")).toBe("/home/user/.local/state/idfx");
    expect(stateDir({ XDG_STATE_HOME: "rel" }, "/home/user")).toBe("/home/user/.local/state/idfx");
  });

  test("names the new and the old folder whatever is on disk", () => {
    expect(newStateDir({ XDG_STATE_HOME: "/s" })).toBe("/s/idfx");
    expect(oldStateDir({ XDG_STATE_HOME: "/s" })).toBe("/s/oc-sub");
  });

  test("uses the new folder when no old folder exists", () => {
    const base = tempBase();
    expect(stateDir({ XDG_STATE_HOME: base })).toBe(path.join(base, "idfx"));
    expect(legacyStateDir({ XDG_STATE_HOME: base })).toBeNull();
  });

  test("uses the old folder while it is a real folder, also when the new folder exists", () => {
    const base = tempBase();
    mkdirSync(path.join(base, "oc-sub"));
    mkdirSync(path.join(base, "idfx"));
    expect(stateDir({ XDG_STATE_HOME: base })).toBe(path.join(base, "oc-sub"));
    expect(legacyStateDir({ XDG_STATE_HOME: base })).toBe(path.join(base, "oc-sub"));
  });

  test("uses the new folder when the old path is a link", () => {
    const base = tempBase();
    mkdirSync(path.join(base, "idfx"));
    symlinkSync("idfx", path.join(base, "oc-sub"));
    expect(stateDir({ XDG_STATE_HOME: base })).toBe(path.join(base, "idfx"));
    expect(legacyStateDir({ XDG_STATE_HOME: base })).toBeNull();
  });

  test("names the files by port", () => {
    expect(servePidPath({ XDG_STATE_HOME: "/s" }, 8767)).toBe("/s/idfx/serve-8767.pid");
    expect(serveDirsPath({ XDG_STATE_HOME: "/s" }, 8767)).toBe("/s/idfx/serve-8767.dirs");
  });
});

function tempBase(): string {
  return mkdtempSync(path.join(tmpdir(), "idfx-state-base-"));
}

describe("migrateStateDir", () => {
  function oldWith(files: Record<string, string>): { base: string; env: { XDG_STATE_HOME: string } } {
    const base = tempBase();
    mkdirSync(path.join(base, "oc-sub"));
    for (const [name, content] of Object.entries(files)) writeFileSync(path.join(base, "oc-sub", name), content);
    return { base, env: { XDG_STATE_HOME: base } };
  }

  test("moves each entry, removes the old folder, and links the old path to the new one", () => {
    const { base, env } = oldWith({ "serve-8767.pid": "1234\n", "sandbox-repo.json": "{}" });
    mkdirSync(path.join(base, "oc-sub", "runs"));
    writeFileSync(path.join(base, "oc-sub", "runs", "ses_1.json"), "{}");
    mkdirSync(path.join(base, "idfx"));
    writeFileSync(path.join(base, "idfx", "events.jsonl"), "");

    const result = migrateStateDir(env);

    expect(result.ok).toBe(true);
    expect(result.moved).toEqual(["runs", "sandbox-repo.json", "serve-8767.pid"]);
    expect(result.skipped).toEqual([]);
    expect(readdirSync(path.join(base, "idfx")).sort()).toEqual(["events.jsonl", "runs", "sandbox-repo.json", "serve-8767.pid"]);
    expect(readFileSync(path.join(base, "idfx", "runs", "ses_1.json"), "utf8")).toBe("{}");
    expect(lstatSync(path.join(base, "oc-sub")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(path.join(base, "oc-sub"))).toBe("idfx");
    // An older process that reads the old path finds the moved file.
    expect(readFileSync(path.join(base, "oc-sub", "serve-8767.pid"), "utf8")).toBe("1234\n");
    expect(stateDir(env)).toBe(path.join(base, "idfx"));
  });

  test("creates the new folder when it is missing", () => {
    const { base, env } = oldWith({ "serve-8767.log": "x" });
    expect(migrateStateDir(env).ok).toBe(true);
    expect(readFileSync(path.join(base, "idfx", "serve-8767.log"), "utf8")).toBe("x");
  });

  test("skips and names an entry that exists in both folders, and keeps the old folder", () => {
    const { base, env } = oldWith({ "serve-8767.pid": "old", "proxy-8767.log": "p" });
    mkdirSync(path.join(base, "idfx"));
    writeFileSync(path.join(base, "idfx", "serve-8767.pid"), "new");

    const result = migrateStateDir(env);

    expect(result.ok).toBe(false);
    expect(result.moved).toEqual(["proxy-8767.log"]);
    expect(result.skipped).toEqual(["serve-8767.pid"]);
    expect(result.note).toContain("serve-8767.pid");
    expect(readFileSync(path.join(base, "idfx", "serve-8767.pid"), "utf8")).toBe("new");
    expect(readFileSync(path.join(base, "oc-sub", "serve-8767.pid"), "utf8")).toBe("old");
    expect(lstatSync(path.join(base, "oc-sub")).isSymbolicLink()).toBe(false);
  });

  test("stops before it moves anything while a serve lock exists", () => {
    const { base, env } = oldWith({ "serve-8767.pid": "1" });
    mkdirSync(path.join(base, "oc-sub", "serve-8767.lock"));

    const result = migrateStateDir(env);

    expect(result.ok).toBe(false);
    expect(result.moved).toEqual([]);
    expect(result.note).toContain("serve-8767.lock");
    expect(existsSync(path.join(base, "idfx"))).toBe(false);
    expect(readdirSync(path.join(base, "oc-sub")).sort()).toEqual(["serve-8767.lock", "serve-8767.pid"]);
  });

  test("a second run finds the link and changes nothing", () => {
    const { base, env } = oldWith({ "serve-8767.pid": "1" });
    expect(migrateStateDir(env).ok).toBe(true);
    const second = migrateStateDir(env);
    expect(second).toEqual({ ok: true, note: `${path.join(base, "oc-sub")} is a link already`, moved: [], skipped: [] });
    expect(readdirSync(path.join(base, "idfx"))).toEqual(["serve-8767.pid"]);
  });

  test("does nothing without an old folder", () => {
    const base = tempBase();
    expect(migrateStateDir({ XDG_STATE_HOME: base })).toMatchObject({ ok: true, moved: [], skipped: [] });
    expect(existsSync(path.join(base, "idfx"))).toBe(false);
  });

  test("refuses an old path that is a file", () => {
    const base = tempBase();
    writeFileSync(path.join(base, "oc-sub"), "");
    expect(migrateStateDir({ XDG_STATE_HOME: base }).ok).toBe(false);
  });
});

describe("parseDirs", () => {
  test("drops empty lines and duplicates and keeps the order", () => {
    expect(parseDirs("/a\n\n/b\n/a\n  \n")).toEqual(["/a", "/b"]);
  });
});

describe("state files", () => {
  test("readPid, addDir, and readDirs", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "oc-sub-state-"));
    try {
      const pidFile = path.join(dir, "serve.pid");
      expect(await readPid(pidFile)).toBeNull();
      writeFileSync(pidFile, "1234\n");
      expect(await readPid(pidFile)).toBe(1234);
      writeFileSync(pidFile, "garbage");
      expect(await readPid(pidFile)).toBeNull();

      const dirsFile = path.join(dir, "sub", "serve.dirs");
      expect(await readDirs(dirsFile)).toEqual([]);
      await addDir(dirsFile, "/w1");
      await addDir(dirsFile, "/w2");
      await addDir(dirsFile, "/w1");
      expect(await readDirs(dirsFile)).toEqual(["/w1", "/w2"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
