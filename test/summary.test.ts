import { describe, expect, test } from "bun:test";
import type { Message, Part } from "@opencode-ai/sdk";
import {
  addStep,
  countToolCalls,
  emptySummary,
  finalAssistantText,
  formatCost,
  formatDuration,
  formatSummary,
  summarizeMessages,
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

  test("formatDuration renders short and long spans", () => {
    expect(formatDuration(0)).toBe("0m00s");
    expect(formatDuration(65_000)).toBe("1m05s");
    expect(formatDuration(3_723_000)).toBe("1h02m03s");
  });
});
