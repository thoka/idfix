import { describe, expect, test } from "bun:test";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Event } from "@opencode-ai/sdk";
import { belongsToSession, eventSessionId, shorten, toolMainArg, watchEventLine } from "../src/events";
import { makeRunRecord, runRecordPath, writeRunRecord } from "../src/runs";

// Events are shaped after the generated SDK types (Event union).

function messageUpdated(sessionID = "ses_1"): Event {
  return {
    type: "message.updated",
    properties: {
      info: {
        id: "msg_1",
        sessionID,
        role: "assistant",
        time: { created: 1 },
        parentID: "msg_0",
        modelID: "m",
        providerID: "p",
        mode: "primary",
        path: { cwd: "/w", root: "/w" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    },
  } as Event;
}

function toolUpdated(callID: string, status: string, extra: Record<string, unknown> = {}, sessionID = "ses_1"): Event {
  return {
    type: "message.part.updated",
    properties: {
      part: {
        id: `part_${callID}`,
        sessionID,
        messageID: "msg_1",
        type: "tool",
        callID,
        tool: "bash",
        state: { status, input: { command: "git status" }, ...extra },
      },
    },
  } as unknown as Event;
}

function textUpdated(
  text: string,
  options: { end?: boolean; id?: string; synthetic?: boolean } = {},
  sessionID = "ses_1",
): Event {
  return {
    type: "message.part.updated",
    properties: {
      part: {
        id: options.id ?? "part_t1",
        sessionID,
        messageID: "msg_1",
        type: "text",
        text,
        synthetic: options.synthetic,
        time: options.end === false ? { start: 1 } : { start: 1, end: 2 },
      },
    },
  } as Event;
}

function sessionIdle(sessionID = "ses_1"): Event {
  return { type: "session.idle", properties: { sessionID } };
}

function sessionError(sessionID?: string): Event {
  return {
    type: "session.error",
    properties: {
      sessionID,
      error: { name: "UnknownError", data: { message: "boom" } },
    },
  } as Event;
}

const fileEdited: Event = { type: "file.edited", properties: { file: "x" } };

describe("eventSessionId", () => {
  test("reads sessionID from the direct, info, and part positions", () => {
    expect(eventSessionId(messageUpdated())).toBe("ses_1");
    expect(eventSessionId(sessionIdle())).toBe("ses_1");
    expect(eventSessionId(toolUpdated("c1", "pending"))).toBe("ses_1");
    expect(eventSessionId(fileEdited)).toBeUndefined();
  });
});

describe("belongsToSession", () => {
  test("matches the session in all positions", () => {
    expect(belongsToSession(messageUpdated(), "ses_1")).toBe(true);
    expect(belongsToSession(messageUpdated(), "ses_2")).toBe(false);
    expect(belongsToSession(toolUpdated("c1", "pending"), "ses_1")).toBe(true);
    expect(belongsToSession(sessionIdle(), "ses_1")).toBe(true);
    expect(belongsToSession(fileEdited, "ses_1")).toBe(false);
  });

  test("session.error counts even when it omits the session ID", () => {
    expect(belongsToSession(sessionError("ses_1"), "ses_1")).toBe(true);
    expect(belongsToSession(sessionError(undefined), "ses_1")).toBe(true);
    expect(belongsToSession(sessionError("ses_2"), "ses_1")).toBe(false);
  });
});

describe("watchEventLine", () => {
  test("prints a tool call once at its first state", () => {
    const seen = new Set<string>();
    expect(watchEventLine(toolUpdated("c1", "pending"), seen)).toEqual({ kind: "tool", line: "tool bash: git status" });
    expect(watchEventLine(toolUpdated("c1", "running"), seen)).toBeNull();
    expect(watchEventLine(toolUpdated("c1", "running"), new Set())).toEqual({
      kind: "tool",
      line: "tool bash: git status",
    });
  });

  test("prints a completed tool call that was never seen (late join)", () => {
    expect(watchEventLine(toolUpdated("c9", "completed"), new Set())?.kind).toBe("tool");
    expect(watchEventLine(toolUpdated("c9", "completed"), new Set())?.line).toBe("tool bash: git status");
  });

  test("prints a line when a tool call fails, even after it started", () => {
    const seen = new Set<string>();
    expect(watchEventLine(toolUpdated("c1", "pending"), seen)).not.toBeNull();
    expect(
      watchEventLine(toolUpdated("c1", "error", { error: "permission denied" }), seen),
    ).toEqual({ kind: "tool-failed", line: "tool bash failed: permission denied" });
    expect(
      watchEventLine(toolUpdated("c1", "error", { error: "permission denied" }), seen),
    ).toBeNull();
  });

  test("prints finished assistant texts once, skipping streaming and synthetic parts", () => {
    const seen = new Set<string>();
    expect(watchEventLine(textUpdated("still going", { end: false }), seen)).toBeNull();
    expect(watchEventLine(textUpdated("hello world"), seen)).toEqual({ kind: "text", line: "assistant: hello world" });
    expect(watchEventLine(textUpdated("hello world"), seen)).toBeNull();
    expect(watchEventLine(textUpdated("synthetic", { id: "part_s", synthetic: true }), new Set())).toBeNull();
    expect(watchEventLine(textUpdated("   ", { id: "part_blank" }), new Set())).toBeNull();
  });

  test("collapses multiline text and shortens long text", () => {
    const line = watchEventLine(textUpdated("a\n\n  b\tc"), new Set());
    expect(line?.line).toBe("assistant: a b c");
    const long = "x".repeat(600);
    const shortened = watchEventLine(textUpdated(long, { id: "part_long" }), new Set());
    expect(shortened?.line).toBe(`assistant: ${"x".repeat(497)}...`);
  });

  test("prints session errors and ignores everything else", () => {
    expect(watchEventLine(sessionError(), new Set())).toEqual({ kind: "error", line: "session error: boom" });
    expect(watchEventLine(fileEdited, new Set())).toBeNull();
    expect(watchEventLine(sessionIdle(), new Set())).toBeNull();
  });
});

describe("toolMainArg", () => {
  test("uses the per-tool key and falls back to the first string", () => {
    expect(toolMainArg("bash", { command: "ls -la", description: "x" })).toBe("ls -la");
    expect(toolMainArg("read", { filePath: "/w/a.ts" })).toBe("/w/a.ts");
    expect(toolMainArg("glob", { pattern: "**/*.ts" })).toBe("**/*.ts");
    expect(toolMainArg("task", { agent: "researcher", prompt: "study" })).toBe("study");
    expect(toolMainArg("unknown", { quux: "main thing", other: 1 })).toBe("main thing");
    expect(toolMainArg("unknown", {})).toBe("");
  });

  test("shorten collapses whitespace and truncates", () => {
    expect(shorten("a\n b")).toBe("a b");
    expect(shorten("x".repeat(200), 10)).toBe("xxxxxxx...");
    expect(shorten("x".repeat(10), 10)).toBe("x".repeat(10));
  });
});

describe("run records", () => {
  test("makeRunRecord fills all fields with an ISO start time", () => {
    const startedAt = new Date("2026-09-27T10:00:00.000Z");
    const record = makeRunRecord({ sessionId: "ses_1", directory: "/w", agent: "researcher", title: "T", startedAt });
    expect(record).toEqual({
      sessionId: "ses_1",
      directory: "/w",
      agent: "researcher",
      title: "T",
      startedAt: "2026-09-27T10:00:00.000Z",
    });
    expect(makeRunRecord({ sessionId: "s", directory: "/w", agent: "a" }).title).toBeNull();
  });

  test("runRecordPath lives under .opencode/runs in the given directory", () => {
    expect(runRecordPath("/x", "ses_1")).toBe(path.join("/x", ".opencode", "runs", "ses_1.json"));
  });

  test("writeRunRecord writes JSON that reads back", async () => {
    const cwd = path.join(tmpdir(), `oc-sub-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(cwd, { recursive: true });
    try {
      const record = makeRunRecord({ sessionId: "ses_w", directory: "/w", agent: "coder" });
      const file = await writeRunRecord(cwd, record);
      expect(file).toBe(runRecordPath(cwd, "ses_w"));
      const parsed = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
      expect(parsed.sessionId).toBe("ses_w");
      expect(parsed.agent).toBe("coder");
      expect(parsed.directory).toBe("/w");
      expect(typeof parsed.startedAt).toBe("string");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
