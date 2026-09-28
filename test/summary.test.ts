import { describe, expect, test } from "bun:test";
import type { Message, Part } from "@opencode-ai/sdk";
import {
  addStep,
  addSummaries,
  countToolCalls,
  emptySummary,
  finalAssistantText,
  formatCost,
  formatDuration,
  formatSummary,
  formatTotals,
  summarizeMessages,
  summarizeTree,
  type UsageSummary,
} from "../src/summary";

function assistant(overrides: Partial<Extract<Message, { role: "assistant" }>> = {}): Extract<Message, { role: "assistant" }> {
  return {
    id: "msg_1",
    sessionID: "ses_1",
    role: "assistant",
    time: { created: 1 },
    parentID: "msg_0",
    modelID: "m",
    providerID: "p",
    mode: "primary",
    path: { cwd: "/x", root: "/x" },
    cost: 0.01,
    tokens: { input: 10, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
    ...overrides,
  };
}

function user(): Extract<Message, { role: "user" }> {
  return {
    id: "msg_0",
    sessionID: "ses_1",
    role: "user",
    time: { created: 0 },
    agent: "tester",
    model: { providerID: "p", modelID: "m" },
  };
}

function textPart(text: string, options: { synthetic?: boolean; ignored?: boolean; messageID?: string } = {}): Part {
  return {
    id: `part_${text.slice(0, 6)}`,
    sessionID: "ses_1",
    messageID: options.messageID ?? "msg_1",
    type: "text",
    text,
    synthetic: options.synthetic,
    ignored: options.ignored,
  };
}

describe("summarizeMessages", () => {
  test("empty session gives zeros", () => {
    const summary = summarizeMessages([]);
    expect(summary.cost).toBe(0);
    expect(summary.steps).toBe(0);
    expect(summary.tokens.input).toBe(0);
  });

  test("sums cost and tokens over assistant messages, ignoring user messages", () => {
    const summary = summarizeMessages([
      { info: user(), parts: [textPart("question")] },
      { info: assistant({ cost: 0.01, tokens: { input: 10, output: 20, reasoning: 1, cache: { read: 2, write: 3 } } }), parts: [] },
      { info: assistant({ id: "msg_2", cost: 0.02, tokens: { input: 100, output: 200, reasoning: 0, cache: { read: 0, write: 0 } } }), parts: [] },
    ]);
    expect(summary.steps).toBe(2);
    expect(summary.cost).toBeCloseTo(0.03, 10);
    expect(summary.tokens.input).toBe(110);
    expect(summary.tokens.output).toBe(220);
    expect(summary.tokens.reasoning).toBe(1);
    expect(summary.tokens.cache.read).toBe(2);
    expect(summary.tokens.cache.write).toBe(3);
  });

  test("addStep folds into an existing summary", () => {
    const summary = addStep(emptySummary(), { cost: 0.5, tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } } });
    expect(summary.cost).toBe(0.5);
    expect(summary.steps).toBe(1);
  });

  test("addSummaries returns the sum of two summaries", () => {
    const sum = addSummaries(
      { cost: 0.01, steps: 1, tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } } },
      { cost: 0.02, steps: 2, tokens: { input: 10, output: 20, reasoning: 30, cache: { read: 40, write: 50 } } },
    );
    expect(sum.cost).toBeCloseTo(0.03, 10);
    expect(sum.steps).toBe(3);
    expect(sum.tokens).toEqual({ input: 11, output: 22, reasoning: 33, cache: { read: 44, write: 55 } });
  });
});

describe("summarizeTree", () => {
  /** A summary with invented numbers, so the sums stay easy to check. */
  function usage(
    cost: number,
    t: { input: number; output: number; reasoning: number; read: number; write: number },
  ): UsageSummary {
    return {
      cost,
      steps: 1,
      tokens: { input: t.input, output: t.output, reasoning: t.reasoning, cache: { read: t.read, write: t.write } },
    };
  }

  test("with no descendants, the total is the main session and there are no subagents", () => {
    const totals = summarizeTree(usage(0.01, { input: 1, output: 2, reasoning: 3, read: 4, write: 5 }), []);
    expect(totals.subagentSessions).toBe(0);
    expect(totals.total.cost).toBeCloseTo(0.01, 10);
    expect(totals.subagents.cost).toBe(0);
    expect(totals.total.tokens.input).toBe(1);
  });

  test("the total adds the cost and tokens of the children, and counts their sessions", () => {
    const totals = summarizeTree(
      usage(0.0151, { input: 1200, output: 300, reasoning: 20, read: 800, write: 40 }),
      [
        usage(0.01, { input: 100, output: 50, reasoning: 5, read: 60, write: 7 }),
        usage(0.02, { input: 200, output: 60, reasoning: 6, read: 70, write: 8 }),
        usage(0.03, { input: 300, output: 70, reasoning: 7, read: 80, write: 9 }),
        usage(0.0065, { input: 400, output: 80, reasoning: 8, read: 90, write: 10 }),
      ],
    );
    expect(totals.subagentSessions).toBe(4);
    expect(totals.subagents.cost).toBeCloseTo(0.0665, 10);
    expect(totals.subagents.tokens.input).toBe(1000);
    expect(totals.subagents.tokens.output).toBe(260);
    expect(totals.total.cost).toBeCloseTo(0.0816, 10);
    expect(totals.total.tokens.input).toBe(2200);
    expect(totals.total.tokens.output).toBe(560);
    expect(totals.total.tokens.reasoning).toBe(46);
    expect(totals.total.tokens.cache.read).toBe(1100);
    expect(totals.total.tokens.cache.write).toBe(74);
  });
});

describe("finalAssistantText", () => {
  test("returns the last assistant text, skipping synthetic parts", () => {
    const messages = [
      { info: user(), parts: [textPart("hello")] },
      { info: assistant(), parts: [textPart("partial", { ignored: true }), textPart("  the answer  ")] },
    ];
    expect(finalAssistantText(messages)).toBe("the answer");
  });

  test("skips an assistant message without text and takes an earlier one", () => {
    const messages = [
      { info: assistant({ id: "msg_1" }), parts: [textPart("earlier")] },
      { info: assistant({ id: "msg_2", error: { name: "MessageAbortedError", data: { message: "aborted" } } }), parts: [] },
    ];
    expect(finalAssistantText(messages)).toBe("earlier");
  });

  test("returns null for a session without assistant text", () => {
    expect(finalAssistantText([{ info: user(), parts: [textPart("hello")] }])).toBeNull();
    expect(finalAssistantText([])).toBeNull();
  });
});

describe("countToolCalls", () => {
  test("counts distinct tool call IDs", () => {
    const tool = (callID: string): Part => ({
      id: `part_${callID}`,
      sessionID: "ses_1",
      messageID: "msg_1",
      type: "tool",
      callID,
      tool: "bash",
      state: { status: "completed", input: {}, output: "", title: "", metadata: {}, time: { start: 0, end: 1 } },
    });
    expect(countToolCalls([{ info: assistant(), parts: [tool("a"), tool("b"), tool("a")] }])).toBe(2);
    expect(countToolCalls([{ info: assistant(), parts: [textPart("no tools")] }])).toBe(0);
  });
});

describe("formatting", () => {
  test("formatCost prints four decimals", () => {
    expect(formatCost(0)).toBe("$0.0000");
    expect(formatCost(0.0123456)).toBe("$0.0123");
    expect(formatCost(1.5)).toBe("$1.5000");
  });

  test("formatSummary lists cost and all token kinds", () => {
    const summary = summarizeMessages([
      { info: assistant({ cost: 0.07, tokens: { input: 1234, output: 567, reasoning: 8, cache: { read: 90, write: 1 } } }), parts: [] },
    ]);
    expect(formatSummary(summary)).toBe(
      "cost $0.0700, tokens in 1234, out 567, reasoning 8, cache read 90, cache write 1",
    );
  });

  test("formatTotals without subagent sessions is the plain summary line", () => {
    const main = summarizeMessages([
      { info: assistant({ cost: 0.07, tokens: { input: 1234, output: 567, reasoning: 8, cache: { read: 90, write: 1 } } }), parts: [] },
    ]);
    expect(formatTotals(summarizeTree(main, []))).toBe(
      "cost $0.0700, tokens in 1234, out 567, reasoning 8, cache read 90, cache write 1",
    );
  });

  test("formatTotals with subagent sessions names their share and count", () => {
    const totals = summarizeTree(
      { cost: 0.0151, steps: 2, tokens: { input: 1200, output: 300, reasoning: 20, cache: { read: 800, write: 40 } } },
      [
        { cost: 0.01, steps: 1, tokens: { input: 100, output: 50, reasoning: 5, cache: { read: 60, write: 7 } } },
        { cost: 0.02, steps: 1, tokens: { input: 200, output: 60, reasoning: 6, cache: { read: 70, write: 8 } } },
        { cost: 0.03, steps: 1, tokens: { input: 300, output: 70, reasoning: 7, cache: { read: 80, write: 9 } } },
        { cost: 0.0065, steps: 1, tokens: { input: 400, output: 80, reasoning: 8, cache: { read: 90, write: 10 } } },
      ],
    );
    expect(formatTotals(totals)).toBe(
      "cost $0.0816 (subagents $0.0665 in 4 sessions), tokens in 2200, out 560, reasoning 46, cache read 1100, cache write 74",
    );
  });

  test("formatTotals with exactly one subagent session reads '1 session'", () => {
    const totals = summarizeTree(
      { cost: 0.01, steps: 1, tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } } },
      [{ cost: 0.05, steps: 1, tokens: { input: 5, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } }],
    );
    expect(formatTotals(totals)).toBe(
      "cost $0.0600 (subagents $0.0500 in 1 session), tokens in 15, out 3, reasoning 0, cache read 0, cache write 0",
    );
  });

  test("formatDuration renders short and long spans", () => {
    expect(formatDuration(0)).toBe("0m00s");
    expect(formatDuration(65_000)).toBe("1m05s");
    expect(formatDuration(3_723_000)).toBe("1h02m03s");
  });
});
