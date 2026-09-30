import { describe, expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import path from "node:path";
import { attach, matchingRuns, type AttachDeps } from "../src/attach";
import type { RunRecord } from "../src/runs";

const BASE = "/tmp/opencode/attach-cmd-test";
const ENV = { XDG_STATE_HOME: path.join(BASE, "state") };

function record(sessionId: string, directory: string, title?: string): RunRecord {
  return {
    sessionId,
    directory,
    agent: "coder",
    title: title ?? null,
    startedAt: new Date().toISOString(),
  };
}

function makeDeps(records: RunRecord[]): {
  deps: AttachDeps;
  spawned: string[][];
  exitCode: number;
} {
  const spawned: string[][] = [];
  const deps: AttachDeps = {
    loadRecords: async () => records,
    spawn: async (cmd) => {
      spawned.push(cmd);
      return 7;
    },
    cwd: BASE,
  };
  return { deps, spawned, exitCode: 7 };
}

function capture(): { errors: string[]; restore: () => void } {
  const errors: string[] = [];
  const err = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.map((part) => String(part)).join(" "));
  });
  return { errors, restore: () => err.mockRestore() };
}

describe("matchingRuns", () => {
  test("matches a case-sensitive substring of the session ID", () => {
    const records = [record("ses_abc123", "/a"), record("ses_xyz123", "/b")];
    expect(matchingRuns(records, "abc").map((r) => r.sessionId)).toEqual(["ses_abc123"]);
    expect(matchingRuns(records, "123").map((r) => r.sessionId)).toEqual(["ses_abc123", "ses_xyz123"]);
    expect(matchingRuns(records, "ABC")).toEqual([]);
  });
});

describe("oc-sub attach", () => {
  test("no match exits 1 with an error", async () => {
    const { deps } = makeDeps([record("ses_abc123", "/a")]);
    const captured = capture();
    try {
      const code = await attach({ code: "zzz" }, ENV, deps);
      expect(code).toBe(1);
      expect(captured.errors.join("\n")).toContain('error: no run matches "zzz"');
    } finally {
      captured.restore();
    }
  });

  test("several matches exit 1 and list session ID, title, and directory", async () => {
    const { deps } = makeDeps([
      record("ses_abc111", "/a", "first"),
      record("ses_abc222", "/b", "second"),
    ]);
    const captured = capture();
    try {
      const code = await attach({ code: "abc" }, ENV, deps);
      expect(code).toBe(1);
      const text = captured.errors.join("\n");
      expect(text).toContain('error: "abc" matches 2 runs:');
      expect(text).toContain("ses_abc111");
      expect(text).toContain("first");
      expect(text).toContain("/a");
      expect(text).toContain("ses_abc222");
      expect(text).toContain("second");
      expect(text).toContain("/b");
      expect(text).toContain("longer part");
    } finally {
      captured.restore();
    }
  });

  test("one match spawns opencode attach and returns its exit code", async () => {
    const { deps, spawned } = makeDeps([record("ses_abc123", "/a", "only")]);
    const code = await attach({ code: "abc123" }, ENV, deps);
    expect(code).toBe(7);
    expect(spawned).toEqual([["opencode", "attach", "http://127.0.0.1:8767", "--dir", "/a", "--session", "ses_abc123"]]);
  });

  test("--url wins over the sandbox state", async () => {
    const { deps, spawned } = makeDeps([record("ses_abc123", "/a")]);
    await attach({ code: "abc123", url: "http://127.0.0.1:9999" }, ENV, deps);
    expect(spawned[0]).toEqual([
      "opencode",
      "attach",
      "http://127.0.0.1:9999",
      "--dir",
      "/a",
      "--session",
      "ses_abc123",
    ]);
  });

  test("loads the records from the state folder with loadAllRunRecords", async () => {
    const { deps, spawned } = makeDeps([]);
    const realDeps: AttachDeps = { ...deps, loadRecords: (await import("../src/runs")).loadAllRunRecords };
    await attach({ code: "abc123" }, ENV, realDeps);
    expect(spawned).toEqual([]);
  });

  test("starts a session that exists in both record folders once", async () => {
    const { writeRunRecord, writeStateRunRecord } = await import("../src/runs");
    rmSync(BASE, { recursive: true, force: true });
    const rec = record("ses_dedupe1", "/a", "both");
    await writeStateRunRecord(ENV, rec);
    await writeRunRecord(BASE, rec);
    const { deps, spawned } = makeDeps([]);
    const realDeps: AttachDeps = { ...deps, loadRecords: (await import("../src/runs")).loadAllRunRecords };
    const captured = capture();
    try {
      const code = await attach({ code: "dedupe1" }, ENV, realDeps);
      expect(code).toBe(7);
      expect(spawned).toHaveLength(1);
      expect(spawned[0]).toContain("ses_dedupe1");
      expect(captured.errors.join("\n")).not.toContain("matches 2 runs");
    } finally {
      captured.restore();
    }
  });
});
