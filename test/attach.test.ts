import { describe, expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import path from "node:path";
import { attach, matchingRuns, nextWatchState, normalizeCode, type AttachDeps, type SpawnHandle } from "../src/attach";
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

function makeDeps(
  records: RunRecord[],
  options: {
    check?: AttachDeps["checkSession"];
    /** When true, the child only exits when killed or via resolveChild(). */
    hangs?: boolean;
  } = {},
): {
  deps: AttachDeps;
  spawned: string[][];
  killed: { value: boolean };
  /** Resolves the child exit with code 7, for a hung child. */
  resolveChild: () => void;
} {
  const spawned: string[][] = [];
  const killed = { value: false };
  let resolveExited: (code: number) => void = () => {};
  const deps: AttachDeps = {
    loadRecords: async () => records,
    spawn: (cmd) => {
      spawned.push(cmd);
      if (options.hangs) {
        const exited = new Promise<number>((resolve) => (resolveExited = resolve));
        return {
          exited,
          kill: () => {
            killed.value = true;
            resolveExited(0);
          },
        };
      }
      return { exited: Promise.resolve(7), kill: () => (killed.value = true) };
    },
    checkSession: options.check ?? (async () => "present"),
    pollMs: 0,
    sleep: async () => {},
    cwd: BASE,
  };
  return { deps, spawned, killed, resolveChild: () => resolveExited(7) };
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

describe("normalizeCode", () => {
  test("strips the agent icon and spaces from a pasted top line", () => {
    expect(normalizeCode("🔧3NcXxn")).toBe("3NcXxn");
    expect(normalizeCode("🔎 3NcXxn")).toBe("3NcXxn");
    expect(normalizeCode("3NcXxn")).toBe("3NcXxn");
    expect(normalizeCode("a-b c")).toBe("abc");
  });

  test("nothing usable left", () => {
    expect(normalizeCode("🔧")).toBe("");
  });
});

describe("nextWatchState", () => {
  test("a deleted session ends at once", () => {
    expect(nextWatchState(0, "deleted")).toEqual({ misses: 0, end: "deleted" });
    expect(nextWatchState(2, "deleted")).toEqual({ misses: 0, end: "deleted" });
  });

  test("three misses in a row end", () => {
    expect(nextWatchState(0, "unreachable")).toEqual({ misses: 1 });
    expect(nextWatchState(1, "unreachable")).toEqual({ misses: 2 });
    expect(nextWatchState(2, "unreachable")).toEqual({ misses: 3, end: "gone" });
  });

  test("a present session resets the count", () => {
    expect(nextWatchState(2, "present")).toEqual({ misses: 0 });
  });
});

describe("oc-sub attach", () => {
  test("no match exits 1 with an error", async () => {    const { deps } = makeDeps([record("ses_abc123", "/a")]);
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

  test("a code with only an icon exits 1 with an error", async () => {
    const { deps } = makeDeps([record("ses_abc123", "/a")]);
    const captured = capture();
    try {
      const code = await attach({ code: "🔧" }, ENV, deps);
      expect(code).toBe(1);
      expect(captured.errors.join("\n")).toContain("holds no usable part");
    } finally {
      captured.restore();
    }
  });

  test("a pasted code with agent icon matches like the plain code", async () => {
    const { deps, spawned } = makeDeps([record("ses_abc123", "/a")]);
    const code = await attach({ code: "🔧 abc123" }, ENV, deps);
    expect(code).toBe(7);
    expect(spawned[0]).toContain("ses_abc123");
  });

  test("a deleted session kills the child and returns 0", async () => {
    const { deps, spawned, killed } = makeDeps([record("ses_abc123", "/a")], {
      check: async () => "deleted",
      hangs: true,
    });
    const captured = capture();
    try {
      const code = await attach({ code: "abc123" }, ENV, deps);
      expect(code).toBe(0);
      expect(killed.value).toBe(true);
      expect(captured.errors.join("\n")).toContain("attach ended: session ses_abc123 was deleted");
    } finally {
      captured.restore();
    }
    expect(spawned).toHaveLength(1);
  });

  test("the server being unreachable three times kills the child and returns 0", async () => {
    let polls = 0;
    const { deps, killed } = makeDeps([record("ses_abc123", "/a")], {
      check: async () => {
        polls += 1;
        return "unreachable";
      },
      hangs: true,
    });
    const captured = capture();
    try {
      const code = await attach({ code: "abc123" }, ENV, deps);
      expect(code).toBe(0);
      expect(polls).toBe(3);
      expect(killed.value).toBe(true);
      expect(captured.errors.join("\n")).toContain("does not answer");
    } finally {
      captured.restore();
    }
  });

  test("two misses then present keep the child alive, and it exits on its own", async () => {
    let polls = 0;
    const child = { resolve: () => {} };
    const { deps, killed, resolveChild } = makeDeps([record("ses_abc123", "/a")], {
      check: async () => {
        polls += 1;
        if (polls >= 4) child.resolve();
        return polls <= 2 ? "unreachable" : "present";
      },
      hangs: true,
    });
    child.resolve = resolveChild;
    const code = await attach({ code: "abc123" }, ENV, deps);
    expect(code).toBe(7);
    expect(killed.value).toBe(false);
    expect(polls).toBeGreaterThan(2);
  });

  test("a child that exits first returns its own exit code without a kill", async () => {
    const { deps, killed } = makeDeps([record("ses_abc123", "/a")], {
      check: async () => "unreachable",
    });
    const code = await attach({ code: "abc123" }, ENV, deps);
    expect(code).toBe(7);
    expect(killed.value).toBe(false);
  });
});
