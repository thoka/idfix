import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { listServers } from "../src/servers";
import { DEFAULT_SERVER_URL } from "../src/config";

function tempStateHome(): string {
  return mkdtempSync(path.join(tmpdir(), "oc-sub-servers-"));
}

function writeState(stateHome: string, project: string, port: number): string {
  const file = path.join(stateHome, "oc-sub", `sandbox-${project}.json`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ name: `oc-sub-${project}`, root: `/repo-${project}`, port }));
  return file;
}

describe("listServers", () => {
  test("returns only the host server without a state folder", () => {
    const stateHome = tempStateHome();
    try {
      expect(listServers({ XDG_STATE_HOME: stateHome })).toEqual([
        { project: null, url: DEFAULT_SERVER_URL, sandbox: false },
      ]);
    } finally {
      rmSync(stateHome, { recursive: true, force: true });
    }
  });

  test("lists the host server first, then the sandbox servers sorted by project", () => {
    const stateHome = tempStateHome();
    try {
      writeState(stateHome, "beta", 18769);
      writeState(stateHome, "alpha", 18768);
      expect(listServers({ XDG_STATE_HOME: stateHome })).toEqual([
        { project: null, url: DEFAULT_SERVER_URL, sandbox: false },
        { project: "alpha", url: "http://127.0.0.1:18768", sandbox: true },
        { project: "beta", url: "http://127.0.0.1:18769", sandbox: true },
      ]);
    } finally {
      rmSync(stateHome, { recursive: true, force: true });
    }
  });

  test("skips a missing, unreadable, or invalid state file", () => {
    const stateHome = tempStateHome();
    try {
      const dir = path.join(stateHome, "oc-sub");
      mkdirSync(dir, { recursive: true });
      writeState(stateHome, "good", 18768);
      writeFileSync(path.join(dir, "sandbox-broken.json"), "{ not json");
      writeFileSync(path.join(dir, "sandbox-badport.json"), JSON.stringify({ name: "x", root: "/r", port: 0 }));
      expect(listServers({ XDG_STATE_HOME: stateHome })).toEqual([
        { project: null, url: DEFAULT_SERVER_URL, sandbox: false },
        { project: "good", url: "http://127.0.0.1:18768", sandbox: true },
      ]);
    } finally {
      rmSync(stateHome, { recursive: true, force: true });
    }
  });

  test("returns only the server of the --url flag", () => {
    const stateHome = tempStateHome();
    try {
      writeState(stateHome, "alpha", 18768);
      expect(listServers({ XDG_STATE_HOME: stateHome }, "http://127.0.0.1:9999")).toEqual([
        { project: null, url: "http://127.0.0.1:9999", sandbox: false },
      ]);
    } finally {
      rmSync(stateHome, { recursive: true, force: true });
    }
  });

  test("uses OC_SUB_URL for the host server", () => {
    const stateHome = tempStateHome();
    try {
      expect(listServers({ XDG_STATE_HOME: stateHome, OC_SUB_URL: "http://127.0.0.1:9000" })).toEqual([
        { project: null, url: "http://127.0.0.1:9000", sandbox: false },
      ]);
    } finally {
      rmSync(stateHome, { recursive: true, force: true });
    }
  });

  test("lists a sandbox URL that equals the host URL once", () => {
    const stateHome = tempStateHome();
    try {
      const hostPort = Number(new URL(DEFAULT_SERVER_URL).port);
      writeState(stateHome, "host", hostPort);
      expect(listServers({ XDG_STATE_HOME: stateHome })).toEqual([
        { project: null, url: DEFAULT_SERVER_URL, sandbox: false },
      ]);
    } finally {
      rmSync(stateHome, { recursive: true, force: true });
    }
  });
});
