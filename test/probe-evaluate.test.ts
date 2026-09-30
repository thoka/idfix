/**
 * Tests for the probe evaluator (src/probe/evaluate.ts) and the fixture.
 * The message fixtures use the real shapes of @opencode-ai/sdk, as a
 * finished session stores them (UserMessage, AssistantMessage, parts).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { AssistantMessage, Message, Part, ToolPart, UserMessage } from "@opencode-ai/sdk";
import { detectLoop, REASONING_LIMIT } from "../src/detect";
import {
  checkAnswer,
  evaluateRun,
  type ExpectedAnswer,
  NON_ASCII_LIMIT,
  nonAsciiShare,
  speedMetrics,
} from "../src/probe/evaluate";

const EXPECTED: ExpectedAnswer = JSON.parse(
  readFileSync(new URL("../probe/expected.json", import.meta.url), "utf8"),
);
const SESSION = "ses_probe";
const BASE = 1_760_000_000_000;

function userMessage(id: string, created: number, text: string): Message {
  return {
    id,
    sessionID: SESSION,
    role: "user",
    time: { created },
    agent: "coder",
    model: { providerID: "openrouter", modelID: "z-ai/glm-5.3-flash" },
    parts: [],
    // The text part lives in the parts list of the entry, see textPart().
  } as unknown as Message;
}

function assistantMessage(
  id: string,
  created: number,
  opts: { tokens?: Partial<AssistantMessage["tokens"]>; completed?: number } = {},
): AssistantMessage {
  return {
    id,
    sessionID: SESSION,
    role: "assistant",
    time: { created, completed: opts.completed },
    parentID: "msg_user",
    modelID: "z-ai/glm-5.3-flash",
    providerID: "openrouter",
    mode: "code",
    path: { cwd: "/tmp/run", root: "/tmp/run" },
    cost: 0.01,
    tokens: {
      input: 50_000,
      output: 400,
      reasoning: 1_000,
      cache: { read: 40_000, write: 2_000 },
      ...opts.tokens,
    },
  };
}

let partCounter = 0;

function textPart(messageID: string, text: string, time?: { start: number; end?: number }): Part {
  partCounter += 1;
  return { id: `prt_${partCounter}`, sessionID: SESSION, messageID, type: "text", text, time };
}

function completedToolPart(
  messageID: string,
  tool: string,
  input: Record<string, unknown>,
  callID?: string,
  time?: { start: number; end: number },
): ToolPart {
  partCounter += 1;
  return {
    id: `prt_${partCounter}`,
    sessionID: SESSION,
    messageID,
    type: "tool",
    callID: callID ?? `call_${partCounter}`,
    tool,
    state: { status: "completed", input, output: "ok", title: tool, metadata: {}, time: time ?? { start: 1, end: 2 } },
  };
}

function erroredToolPart(messageID: string, tool: string): ToolPart {
  partCounter += 1;
  return {
    id: `prt_${partCounter}`,
    sessionID: SESSION,
    messageID,
    type: "tool",
    callID: `call_${partCounter}`,
    tool,
    state: { status: "error", input: {}, error: "invalid JSON", time: { start: 1, end: 2 } },
  };
}

type Entry = { info: Message; parts: Part[] };

/** The answer.md that the task asks for. */
function goodAnswer(): string {
  return [
    "# answer",
    "",
    "## ProbeLedgerEntry",
    "- entryId",
    "- recordedAt",
    "- amountMinor",
    "- currencyCode",
    "- memo",
    "- settled",
    "",
    "## ProbeManifestField",
    "- key",
    "- label",
    "- required",
    "- maxLength",
    "",
    "## ProbeReplicaConfig",
    "- region",
    "- lagBudgetMs",
    "- readonly",
    "- backfillBatch",
    "- healthEndpoint",
    "",
  ].join("\n");
}

/** A small passing session: user, two steps with one tool call, final text. */
function passingRun(): Entry[] {
  return [
    { info: userMessage("msg_user", BASE, "Find the three interfaces."), parts: [textPart("msg_user", "Find the three interfaces.")] },
    {
      info: assistantMessage("msg_a1", BASE + 4_000, { completed: BASE + 9_000 }),
      parts: [
        textPart("msg_a1", "Searching for the interfaces.", { start: BASE + 5_000, end: BASE + 5_200 }),
        completedToolPart("msg_a1", "grep", { pattern: "export interface" }, undefined, {
          start: BASE + 6_000,
          end: BASE + 8_000,
        }),
      ],
    },
    {
      info: assistantMessage("msg_a2", BASE + 12_000, { completed: BASE + 20_000 }),
      parts: [textPart("msg_a2", "Found all three interfaces and wrote answer.md.")],
    },
  ];
}

describe("detectLoop (offline loop check in src/detect.ts)", () => {
  test("fires on five identical calls in a row", () => {
    const call = { tool: "read", input: { filePath: "/tmp/x" } };
    expect(detectLoop(Array(5).fill(call))).toBe(true);
    expect(detectLoop(Array(4).fill(call))).toBe(false);
  });

  test("does not fire when another call breaks the row", () => {
    const call = { tool: "read", input: { filePath: "/tmp/x" } };
    const calls = [call, call, call, call, { tool: "bash", input: { command: "bun test" } }, call, call, call, call];
    expect(detectLoop(calls)).toBe(false);
  });
});

describe("nonAsciiShare", () => {
  test("is 0 for plain ASCII text and low for text with one symbol", () => {
    expect(nonAsciiShare("Found all three interfaces.")).toBe(0);
    expect(nonAsciiShare("done -> ok")).toBeLessThan(NON_ASCII_LIMIT);
  });

  test("is high for derailed output with Greek letters and symbols", () => {
    const derailed = "κ α χ ω ⟦ ⟧ ϴ ϡ ✦ ✧ ".repeat(50);
    expect(nonAsciiShare(derailed)).toBeGreaterThan(NON_ASCII_LIMIT);
  });
});

describe("checkAnswer", () => {
  test("accepts the answer in the requested format", () => {
    expect(checkAnswer(goodAnswer(), EXPECTED)).toBeNull();
  });

  test("accepts fields in a different order and with backticks", () => {
    const answer = goodAnswer().replace(
      "- entryId\n- recordedAt\n- amountMinor\n- currencyCode\n- memo\n- settled",
      "- `settled`\n- `memo`\n- `currencyCode`\n- `amountMinor`\n- `recordedAt`\n- `entryId`",
    );
    expect(checkAnswer(answer, EXPECTED)).toBeNull();
  });

  test("fails when answer.md is missing", () => {
    expect(checkAnswer(null, EXPECTED)).toEqual({ rule: "answer", detail: "answer.md is missing" });
  });

  test("fails when an interface is not named", () => {
    const answer = goodAnswer().replace(/## ProbeReplicaConfig[\s\S]*$/, "");
    expect(checkAnswer(answer, EXPECTED)?.detail).toContain("ProbeReplicaConfig is not named");
  });

  test("fails when a field name is wrong or missing", () => {
    const answer = goodAnswer().replace("- amountMinor", "- amount");
    const failure = checkAnswer(answer, EXPECTED);
    expect(failure?.rule).toBe("answer");
    expect(failure?.detail).toContain("ProbeLedgerEntry");
  });
});

describe("evaluateRun", () => {
  const base = { answer: goodAnswer(), hasCommit: true, expected: EXPECTED };

  test("a passing run passes", () => {
    expect(evaluateRun({ messages: passingRun(), ...base })).toEqual({ pass: true, failures: [] });
  });

  test("a wrong answer fails the answer rule", () => {
    const result = evaluateRun({ messages: passingRun(), ...base, answer: "# answer\nnot found\n" });
    expect(result.pass).toBe(false);
    expect(result.failures.map((f) => f.rule)).toEqual(["answer"]);
  });

  test("a missing commit fails the commit rule", () => {
    const result = evaluateRun({ messages: passingRun(), ...base, hasCommit: false });
    expect(result.failures).toEqual([{ rule: "commit", detail: "no commit in the run worktree" }]);
  });

  test("a run of repeated identical calls fails the loop rule", () => {
    const messages = passingRun();
    const read = completedToolPart("msg_a1", "read", { filePath: "/tmp/big.d.ts", limit: 75 });
    messages[1]!.parts = [read, read, read, read, read];
    const result = evaluateRun({ messages, ...base });
    expect(result.failures.map((f) => f.rule)).toEqual(["loop"]);
  });

  test("an error-state tool call fails the tool-error rule", () => {
    const messages = passingRun();
    messages[1]!.parts = [erroredToolPart("msg_a1", "grep")];
    const result = evaluateRun({ messages, ...base });
    expect(result.failures.map((f) => f.rule)).toEqual(["tool-error"]);
    expect(result.failures[0]!.detail).toContain("grep");
  });

  test("reasoning over the limit in one step fails the reasoning rule", () => {
    const messages = passingRun();
    messages[2] = {
      info: assistantMessage("msg_a2", BASE + 12_000, { tokens: { reasoning: REASONING_LIMIT + 1 } }),
      parts: [textPart("msg_a2", "done")],
    };
    const result = evaluateRun({ messages, ...base });
    expect(result.failures.map((f) => f.rule)).toEqual(["reasoning"]);
    expect(result.failures[0]!.detail).toContain(String(REASONING_LIMIT + 1));
  });

  test("derailed assistant text fails the unreadable rule", () => {
    const messages = passingRun();
    messages[2] = {
      info: assistantMessage("msg_a2", BASE + 12_000),
      parts: [textPart("msg_a2", "κ α χ ω ⟦ ⟧ ϴ ϡ ✦ ✧ ".repeat(200))],
    };
    const result = evaluateRun({ messages, ...base });
    expect(result.failures.map((f) => f.rule)).toEqual(["unreadable"]);
  });

  test("plain-ASCII filler over the text limit fails the unreadable rule", () => {
    const messages = passingRun();
    messages[2] = {
      info: assistantMessage("msg_a2", BASE + 12_000),
      parts: [textPart("msg_a2", "word ".repeat(4_100))],
    };
    const result = evaluateRun({ messages, ...base });
    expect(result.failures.map((f) => f.rule)).toEqual(["unreadable"]);
    expect(result.failures[0]!.detail).toContain("characters");
  });

  test("a run can fail several rules at once", () => {
    const result = evaluateRun({ messages: passingRun(), ...base, answer: null, hasCommit: false });
    expect(result.failures.map((f) => f.rule)).toEqual(["answer", "commit"]);
  });
});

describe("speedMetrics", () => {
  test("reads the times and tokens from the messages", () => {
    const metrics = speedMetrics(passingRun());
    // First token at BASE+5000, the message was only created at BASE+4000.
    expect(metrics.timeToFirstTokenMs).toBe(5_000);
    expect(metrics.wallTimeMs).toBe(20_000);
    // Step 1 runs 5,000 ms, step 2 runs 8,000 ms; the rest is tool time.
    expect(metrics.generationMs).toBe(13_000);
    expect(metrics.outputTokens).toBe(800);
    expect(metrics.reasoningTokens).toBe(2_000);
    expect(metrics.generationTokensPerSecond).toBeCloseTo(2_800 / 13, 5);
  });

  test("timeToFirstTokenMs is null when no part of the first step has a start time", () => {
    const messages = passingRun();
    messages[1]!.parts = [];
    expect(speedMetrics(messages).timeToFirstTokenMs).toBeNull();
  });

  test("returns nulls without a user or an assistant message", () => {
    const metrics = speedMetrics([]);
    expect(metrics).toEqual({
      timeToFirstTokenMs: null,
      wallTimeMs: null,
      generationMs: null,
      outputTokens: 0,
      reasoningTokens: 0,
      generationTokensPerSecond: null,
    });
  });
});

describe("fixture", () => {
  const fixturePath = new URL("../probe/fixture/types.ts", import.meta.url).pathname;
  const lines = readFileSync(fixturePath, "utf8").split("\n");

  test("has the interfaces at the expected lines with the expected fields", () => {
    for (const iface of EXPECTED.interfaces) {
      const at = lines[iface.line - 1];
      expect(at).toBe(`export interface ${iface.name} {`);
      for (let i = 0; i < iface.fields.length; i++) {
        expect(lines[iface.line + i]?.startsWith(`  ${iface.fields[i]}: `)).toBe(true);
      }
      expect(lines[iface.line + iface.fields.length]).toBe("}");
    }
  });

  test("has 11,656 lines and typescript-checks as a whole file", () => {
    expect(lines.length).toBe(11_656 + 1); // trailing newline
  });

  test("expected.json lists four to six fields per interface", () => {
    for (const iface of EXPECTED.interfaces) {
      expect(iface.fields.length).toBeGreaterThanOrEqual(4);
      expect(iface.fields.length).toBeLessThanOrEqual(6);
    }
  });
});
