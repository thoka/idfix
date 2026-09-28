import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { addDir, parseDirs, readDirs, readPid, serveDirsPath, servePidPath, stateDir } from "../src/state";

describe("stateDir", () => {
  test("uses XDG_STATE_HOME when it is an absolute path", () => {
    expect(stateDir({ XDG_STATE_HOME: "/s" }, "/home/u")).toBe("/s/oc-sub");
  });

  test("falls back to ~/.local/state for a missing or relative XDG_STATE_HOME", () => {
    expect(stateDir({}, "/home/u")).toBe("/home/u/.local/state/oc-sub");
    expect(stateDir({ XDG_STATE_HOME: "rel" }, "/home/u")).toBe("/home/u/.local/state/oc-sub");
  });

  test("names the files by port", () => {
    expect(servePidPath({ XDG_STATE_HOME: "/s" }, 8767)).toBe("/s/oc-sub/serve-8767.pid");
    expect(serveDirsPath({ XDG_STATE_HOME: "/s" }, 8767)).toBe("/s/oc-sub/serve-8767.dirs");
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
