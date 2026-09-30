/**
 * Detectors for a run that goes wrong: a tool loop, a stalled session, and
 * runaway reasoning. The functions are pure: no I/O, no clock, no server.
 * `oc-sub watch` feeds the events and the status map of the watched session
 * and its descendant sessions. A later live view (`oc-sub top`) and a
 * provider penalty can reuse the same detectors.
 */
import type { Event, SessionStatus } from "@opencode-ai/sdk";
import { eventSessionId, shorten, toolMainArg } from "./events";

/** How many identical tool calls in a row make a loop. */
export const LOOP_LIMIT = 5;
/** How long a busy session without an event is stalled. */
export const STALL_MS = 180_000;
/** How many reasoning tokens in one step are too many. */
export const REASONING_LIMIT = 16_000;

/** One warning from a detector. */
export type Finding =
  | { kind: "loop"; sessionId: string; tool: string; input: string; count: number }
  | { kind: "stall"; sessionId: string; seconds: number }
  | { kind: "reasoning"; sessionId: string; tokens: number; limit: number };

export type GuardOptions = {
  loopLimit?: number;
  stallMs?: number;
  reasoningLimit?: number;
};

type SessionState = {
  /** Arrival time of the last event of the session. The events carry no timestamp. */
  lastEventMs?: number;
  lastLoopKey?: string;
  loopCount: number;
  completedCalls: Set<string>;
  reportedLoops: Set<string>;
  reportedReasoning: Set<string>;
  stallReported: boolean;
};

/**
 * The guard state for a set of sessions. Feed every event of the watched
 * tree, then check the stalls on every status poll. Each finding is reported
 * once, so the caller can print it and stop.
 */
export type Guard = {
  /** Feed one event. Returns the findings that the event triggers. */
  feed(event: Event, nowMs: number): Finding[];
  /** Check for stalls. Call on every status poll with the status map. */
  checkStalls(states: Readonly<Record<string, SessionStatus>>, nowMs: number): Finding[];
  /**
   * Set the arrival time of a session that has not sent an event yet, for
   * example at the start of a watch that joins a running session.
   */
  touch(sessionId: string, nowMs: number): void;
};

/** JSON with sorted object keys, so the same input always compares equal. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/**
 * Message-based loop check over completed tool calls, in order. True when a
 * row of at least `loopLimit` identical calls (same tool, same input) occurs.
 * This is the offline variant of the live loop detector inside `createGuard`
 * and shares `stableStringify` with it, for checks over a finished session.
 */
export function detectLoop(
  calls: ReadonlyArray<{ tool: string; input: unknown }>,
  loopLimit: number = LOOP_LIMIT,
): boolean {
  let lastKey: string | undefined;
  let count = 0;
  for (const call of calls) {
    const key = `${call.tool}\n${stableStringify(call.input)}`;
    count = key === lastKey ? count + 1 : 1;
    lastKey = key;
    if (count >= loopLimit) return true;
  }
  return false;
}

export function createGuard(options: GuardOptions = {}): Guard {
  const loopLimit = options.loopLimit ?? LOOP_LIMIT;
  const stallMs = options.stallMs ?? STALL_MS;
  const reasoningLimit = options.reasoningLimit ?? REASONING_LIMIT;
  const sessions = new Map<string, SessionState>();

  const stateOf = (sessionId: string): SessionState => {
    let state = sessions.get(sessionId);
    if (state === undefined) {
      state = {
        loopCount: 0,
        completedCalls: new Set(),
        reportedLoops: new Set(),
        reportedReasoning: new Set(),
        stallReported: false,
      };
      sessions.set(sessionId, state);
    }
    return state;
  };

  const loopFinding = (sessionId: string, tool: string, input: Record<string, unknown>, count: number): Finding => ({
    kind: "loop",
    sessionId,
    tool,
    input: shorten(toolMainArg(tool, input), 80),
    count,
  });

  return {
    feed(event, nowMs) {
      const sessionId = eventSessionId(event);
      if (sessionId === undefined) return [];
      const state = stateOf(sessionId);
      state.lastEventMs = nowMs;
      state.stallReported = false;
      if (event.type !== "message.part.updated") return [];
      const part = event.properties.part;
      if (part.type === "tool" && part.state.status === "completed") {
        // Each tool call reaches completed once. A repeated event with the
        // same call ID must not count twice.
        if (state.completedCalls.has(part.callID)) return [];
        state.completedCalls.add(part.callID);
        const key = `${part.tool}\n${stableStringify(part.state.input)}`;
        state.loopCount = key === state.lastLoopKey ? state.loopCount + 1 : 1;
        state.lastLoopKey = key;
        if (state.loopCount >= loopLimit && !state.reportedLoops.has(key)) {
          state.reportedLoops.add(key);
          return [loopFinding(sessionId, part.tool, part.state.input, state.loopCount)];
        }
        return [];
      }
      if (part.type === "step-finish" && part.tokens.reasoning > reasoningLimit) {
        if (state.reportedReasoning.has(part.id)) return [];
        state.reportedReasoning.add(part.id);
        return [{ kind: "reasoning", sessionId, tokens: part.tokens.reasoning, limit: reasoningLimit }];
      }
      return [];
    },

    checkStalls(states, nowMs) {
      const findings: Finding[] = [];
      for (const [sessionId, state] of sessions) {
        if (state.lastEventMs === undefined) continue;
        // The status map lists only sessions that are not idle, so a missing
        // entry means the session has ended and cannot stall.
        if (states[sessionId] === undefined) continue;
        const silentMs = nowMs - state.lastEventMs;
        if (silentMs < stallMs || state.stallReported) continue;
        state.stallReported = true;
        findings.push({ kind: "stall", sessionId, seconds: Math.round(silentMs / 1000) });
      }
      return findings;
    },

    touch(sessionId, nowMs) {
      const state = stateOf(sessionId);
      if (state.lastEventMs === undefined) state.lastEventMs = nowMs;
    },
  };
}

/** The warning block for one finding, one line per array element. */
export function formatFinding(finding: Finding): string[] {
  switch (finding.kind) {
    case "loop":
      return [
        "needs attention: loop",
        `session ${finding.sessionId}`,
        `tool ${finding.tool}, ${finding.count} calls in a row with the same input: ${finding.input}`,
      ];
    case "stall":
      return ["needs attention: stall", `session ${finding.sessionId}`, `no event for ${finding.seconds}s while the session is busy`];
    case "reasoning":
      return [
        "needs attention: reasoning",
        `session ${finding.sessionId}`,
        `one step used ${finding.tokens} reasoning tokens (limit ${finding.limit})`,
      ];
  }
}
