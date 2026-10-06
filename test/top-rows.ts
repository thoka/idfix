/**
 * Invented rows for the tests of `top`: an opencode row and a Claude row
 * with the fields of `src/claude/rows.ts`. No file system, no clock.
 */
import type { ClaudeRow } from "../src/claude/rows";
import type { SessionRow } from "../src/top/model";

/** An opencode row. */
export function openRow(sessionId: string, overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    sessionId,
    server: "http://127.0.0.1:18768",
    directory: "/repo",
    title: `title ${sessionId}`,
    agent: "coder",
    state: "busy",
    startTimeMs: 0,
    elapsedMs: 0,
    msSinceEvent: 0,
    steps: 0,
    toolCalls: 0,
    contextTokens: 0,
    cost: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    reasoningShare: 0,
    lastStepReasoning: 0,
    driver: "opencode",
    costKind: "real",
    ...overrides,
  };
}

/** A Claude row: an interactive session on a known model, with an API price. */
export function claudeRowOf(sessionId: string, overrides: Partial<ClaudeRow> = {}): ClaudeRow {
  return {
    ...openRow(sessionId),
    server: "",
    agent: "",
    driver: "claude",
    costKind: "apiEquivalent",
    model: "claude-opus-5-5",
    contextWindow: 200_000,
    kind: "interactive",
    name: undefined,
    waitingFor: undefined,
    waitingSource: undefined,
    pid: undefined,
    tmux: undefined,
    jobId: undefined,
    lastActivityMs: undefined,
    stateSinceMs: undefined,
    transcriptGrowthMs: undefined,
    apiEquivalentUsd: 0,
    apiErrors: 0,
    lastApiErrorText: undefined,
    lastApiErrorMs: undefined,
    children: [],
    ...overrides,
  };
}
