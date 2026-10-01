/**
 * Tests for the guard detectors in src/detect.ts, with invented events.
 * No server and no clock is involved: the tests pass `nowMs` themselves.
 */
import { describe, expect, test } from "bun:test";
import type { Event } from "@opencode-ai/sdk";
import { createGuard, formatFinding, LOOP_LIMIT, REASONING_LIMIT, REQUEST_STALL_MS, stableStringify, STALL_MS } from "../src/detect";

const SESSION = "ses_1";

let callCounter = 0;

/** A completed tool call part event. */
function toolEvent(sessionId: string, tool: string, input: Record<string, unknown>): Event {
  callCounter += 1;
  return {
    type: "message.part.updated",
    properties: {
      part: {
        id: `part_${callCounter}`,
        sessionID: sessionId,
        messageID: "msg_1",
        type: "tool",
        callID: `call_${callCounter}`,
        tool,
        state: { status: "completed", input, time: { start: 1, end: 2 } },
      },
    },
  } as unknown as Event;
}

/** A step-finish part event with the given reasoning token count. */
function stepFinishEvent(sessionId: string, reasoning: number): Event {
  callCounter += 1;
  return {
    type: "message.part.updated",
    properties: {
      part: {
        id: `part_${callCounter}`,
        sessionID: sessionId,
        messageID: "msg_1",
        type: "step-finish",
        reason: "stop",
        cost: 0,
        tokens: { input: 10, output: 5, reasoning, cache: { read: 0, write: 0 } },
      },
    },
  } as unknown as Event;
}

function otherEvent(sessionId: string): Event {
  return { type: "session.error", properties: { sessionID: sessionId, error: {} } } as unknown as Event;
}

describe("stableStringify", () => {
  test("sorts object keys and keeps arrays in order", () => {
    expect(stableStringify({ b: 1, a: [2, { z: 3, y: 4 }] })).toBe('{"a":[2,{"y":4,"z":3}],"b":1}');
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
  });
});

describe("loop detector", () => {
  test("fires at five identical calls in a row", () => {
    const guard = createGuard();
    const input = { filePath: "/tmp/big.d.ts", limit: 75 };
    for (let i = 0; i < LOOP_LIMIT - 1; i++) {
      expect(guard.feed(toolEvent(SESSION, "read", input), i)).toEqual([]);
    }
    const findings = guard.feed(toolEvent(SESSION, "read", input), LOOP_LIMIT);
    expect(findings).toEqual([
      { kind: "loop", sessionId: SESSION, tool: "read", input: "/tmp/big.d.ts", count: LOOP_LIMIT },
    ]);
  });

  test("compares the input as sorted JSON, so key order does not matter", () => {
    const guard = createGuard();
    for (let i = 0; i < LOOP_LIMIT - 1; i++) {
      expect(guard.feed(toolEvent(SESSION, "read", { limit: 75, filePath: "/tmp/x" }), i)).toEqual([]);
    }
    const findings = guard.feed(toolEvent(SESSION, "read", { filePath: "/tmp/x", limit: 75 }), LOOP_LIMIT);
    expect(findings).toHaveLength(1);
  });

  test("does not fire when another call breaks the row", () => {
    const guard = createGuard();
    for (let i = 0; i < LOOP_LIMIT - 1; i++) {
      guard.feed(toolEvent(SESSION, "read", { filePath: "/tmp/x" }), i);
    }
    guard.feed(toolEvent(SESSION, "bash", { command: "bun test" }), 100);
    expect(guard.feed(toolEvent(SESSION, "read", { filePath: "/tmp/x" }), 101)).toEqual([]);
  });

  test("reports each looping call only once", () => {
    const guard = createGuard();
    const input = { filePath: "/tmp/x" };
    for (let i = 0; i < LOOP_LIMIT; i++) guard.feed(toolEvent(SESSION, "read", input), i);
    expect(guard.feed(toolEvent(SESSION, "read", input), 100)).toEqual([]);
  });

  test("does not count the same call ID twice", () => {
    const guard = createGuard();
    const event = toolEvent(SESSION, "read", { filePath: "/tmp/x" });
    for (let i = 0; i < LOOP_LIMIT; i++) guard.feed(event, i);
    expect(guard.feed(event, 100)).toEqual([]);
  });

  test("tracks sessions separately", () => {
    const guard = createGuard();
    for (let i = 0; i < LOOP_LIMIT - 1; i++) {
      guard.feed(toolEvent("ses_a", "read", { filePath: "/tmp/x" }), i);
    }
    expect(guard.feed(toolEvent("ses_b", "read", { filePath: "/tmp/x" }), 100)).toEqual([]);
    expect(guard.feed(toolEvent("ses_a", "read", { filePath: "/tmp/x" }), 101)).toHaveLength(1);
  });
});

describe("stall detector", () => {
  test("fires when a busy session had no event for the stall time", () => {
    const guard = createGuard();
    guard.feed(otherEvent(SESSION), 0);
    const states = { [SESSION]: { type: "busy" } } as Record<string, { type: string }>;
    expect(guard.checkStalls(states as never, STALL_MS - 1000)).toEqual([]);
    const findings = guard.checkStalls(states as never, STALL_MS);
    expect(findings).toEqual([{ kind: "stall", sessionId: SESSION, seconds: STALL_MS / 1000 }]);
  });

  test("reports a stall only once until a new event arrives", () => {
    const guard = createGuard();
    guard.feed(otherEvent(SESSION), 0);
    const states = { [SESSION]: { type: "busy" } } as Record<string, { type: string }>;
    expect(guard.checkStalls(states as never, STALL_MS)).toHaveLength(1);
    expect(guard.checkStalls(states as never, STALL_MS * 2)).toEqual([]);
    guard.feed(otherEvent(SESSION), STALL_MS * 2);
    expect(guard.checkStalls(states as never, STALL_MS * 3 - 1000)).toEqual([]);
    expect(guard.checkStalls(states as never, STALL_MS * 3)).toHaveLength(1);
  });

  test("ignores sessions that are missing from the status map, so no longer busy", () => {
    const guard = createGuard();
    guard.feed(otherEvent(SESSION), 0);
    expect(guard.checkStalls({}, STALL_MS * 10)).toEqual([]);
  });

  test("ignores sessions that never sent an event and were not touched", () => {
    const guard = createGuard();
    const states = { [SESSION]: { type: "busy" } } as Record<string, { type: string }>;
    expect(guard.checkStalls(states as never, STALL_MS * 10)).toEqual([]);
  });

  test("counts a touched session from the touch time", () => {
    const guard = createGuard();
    guard.touch(SESSION, 0);
    const states = { [SESSION]: { type: "busy" } } as Record<string, { type: string }>;
    expect(guard.checkStalls(states as never, STALL_MS - 1000)).toEqual([]);
    expect(guard.checkStalls(states as never, STALL_MS)).toHaveLength(1);
  });
});

describe("reasoning detector", () => {
  test("fires when one step goes over the reasoning limit", () => {
    const guard = createGuard();
    expect(guard.feed(stepFinishEvent(SESSION, REASONING_LIMIT), 0)).toEqual([]);
    const findings = guard.feed(stepFinishEvent(SESSION, REASONING_LIMIT + 1), 1);
    expect(findings).toEqual([
      { kind: "reasoning", sessionId: SESSION, tokens: REASONING_LIMIT + 1, limit: REASONING_LIMIT },
    ]);
  });

  test("reports each step only once", () => {
    const guard = createGuard();
    const event = stepFinishEvent(SESSION, REASONING_LIMIT + 5000);
    expect(guard.feed(event, 0)).toHaveLength(1);
    expect(guard.feed(event, 1)).toEqual([]);
  });
});

describe("stall detector with an open model request", () => {
  const states = { [SESSION]: { type: "busy" } } as Record<string, { type: string }>;

  test("a young open request suppresses the stall", () => {
    const guard = createGuard();
    guard.feed(otherEvent(SESSION), 0);
    const open = new Map([[SESSION, { startedMs: 1000, upstream: "openrouter" }]]);
    // Long past the stall time, but the request is still young.
    const findings = guard.checkStalls(states as never, 300_000, open);
    expect(findings).toEqual([]);
  });

  test("an old open request gives a slow-request finding instead", () => {
    const guard = createGuard();
    guard.feed(otherEvent(SESSION), 0);
    const open = new Map([[SESSION, { startedMs: 0, upstream: "openrouter" }]]);
    const findings = guard.checkStalls(states as never, REQUEST_STALL_MS, open);
    expect(findings).toEqual([
      { kind: "slow-request", sessionId: SESSION, upstream: "openrouter", seconds: REQUEST_STALL_MS / 1000 },
    ]);
    // Reported only once until a new event arrives.
    expect(guard.checkStalls(states as never, REQUEST_STALL_MS * 2, open)).toEqual([]);
    guard.feed(otherEvent(SESSION), REQUEST_STALL_MS * 2);
    expect(guard.checkStalls(states as never, REQUEST_STALL_MS * 3, open)).toHaveLength(1);
  });

  test("an open request of unknown age suppresses the stall too", () => {
    const guard = createGuard();
    guard.feed(otherEvent(SESSION), 0);
    const open = new Map([[SESSION, { upstream: "openrouter" }]]);
    expect(guard.checkStalls(states as never, STALL_MS * 10, open)).toEqual([]);
  });

  test("no open request keeps the old stall", () => {
    const guard = createGuard();
    guard.feed(otherEvent(SESSION), 0);
    expect(guard.checkStalls(states as never, STALL_MS, new Map())).toEqual([
      { kind: "stall", sessionId: SESSION, seconds: STALL_MS / 1000 },
    ]);
    expect(guard.checkStalls(states as never, STALL_MS, undefined)).toEqual([]);
  });
});

describe("formatFinding", () => {
  test("names the kind, the session, and the details", () => {
    expect(formatFinding({ kind: "loop", sessionId: SESSION, tool: "read", input: "/tmp/x", count: 5 })).toEqual([
      "needs attention: loop",
      `session ${SESSION}`,
      "tool read, 5 calls in a row with the same input: /tmp/x",
    ]);
    expect(formatFinding({ kind: "stall", sessionId: SESSION, seconds: 182 })).toEqual([
      "needs attention: stall",
      `session ${SESSION}`,
      "no event for 182s while the session is busy",
    ]);
    expect(formatFinding({ kind: "reasoning", sessionId: SESSION, tokens: 26210, limit: 16000 })).toEqual([
      "needs attention: reasoning",
      `session ${SESSION}`,
      "one step used 26210 reasoning tokens (limit 16000)",
    ]);
    expect(formatFinding({ kind: "slow-request", sessionId: SESSION, upstream: "openrouter", seconds: 610 })).toEqual([
      "needs attention: slow request",
      `session ${SESSION}`,
      `the model request at openrouter is open for 610s with no event (limit ${REQUEST_STALL_MS / 1000}s)`,
    ]);
  });
});
