/**
 * Pure evaluator for one provider-probe run. The input is the message list of
 * a finished session (the `MessageEntry` type of src/summary.ts), the content
 * of `answer.md` or null, and whether a commit exists. The output is a pass
 * flag with one entry per failed rule, plus speed metrics from the same
 * messages. No I/O and no clock: the caller reads the session.
 */
import type { Message, Part } from "@opencode-ai/sdk";
import { detectLoop, REASONING_LIMIT } from "../detect";
import type { MessageEntry } from "../summary";

/** One expected interface from probe/expected.json. */
export type ExpectedInterface = {
  name: string;
  line: number;
  fields: string[];
};

export type ExpectedAnswer = {
  interfaces: ExpectedInterface[];
};

/** The rules that can fail, one entry per failed rule in the result. */
export type RuleName = "answer" | "commit" | "loop" | "unreadable" | "reasoning" | "tool-error";

export type RuleFailure = {
  rule: RuleName;
  detail: string;
};

export type ProbeResult = {
  pass: boolean;
  failures: RuleFailure[];
};

/**
 * Readability heuristic 1: the share of non-ASCII characters among all
 * non-whitespace characters of the assistant text. The derailed runs of
 * 2026-09-28 (.plan/EXPERIENCE.md) produced text with unrelated words,
 * symbols, and Greek letters, while normal answers of this task are prose and
 * code in plain ASCII. Non-ASCII prose, emoji, or one stray arrow stay far
 * below the limit; derailed output crosses it. The limit of 5 percent keeps
 * false positives away from normal text with a rare Unicode character.
 */
export const NON_ASCII_LIMIT = 0.05;

/**
 * Readability heuristic 2: the assistant text of this task is short (an
 * answer of three short sections plus a few progress lines), so a total
 * assistant text over TEXT_LIMIT characters means the run wrote filler and
 * fails the unreadable rule too. Gap: meaningless text in plain ASCII under
 * the limit passes both heuristics.
 */
export const TEXT_LIMIT = 20_000;

export function nonAsciiShare(text: string): number {
  const chars = [...text].filter((c) => !/\s/.test(c));
  if (chars.length === 0) return 0;
  const nonAscii = chars.filter((c) => c.codePointAt(0)! > 127).length;
  return nonAscii / chars.length;
}

/**
 * The field-name tokens of one answer section: the lines after the first line
 * that names the interface, up to the line that names another expected
 * interface. Bullets, backticks, and headings are stripped; only
 * identifier-like tokens count, so the sections must hold field names and no
 * prose (probe/task.md asks for exactly that format).
 */
function sectionFields(answer: string, name: string, otherNames: string[]): string[] | null {
  const lines = answer.split("\n");
  const start = lines.findIndex((line) => line.toLowerCase().includes(name.toLowerCase()));
  if (start === -1) return null;
  const fields: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    const stops = otherNames.some((other) => line.toLowerCase().includes(other.toLowerCase()));
    if (stops) break;
    const tokens = line.replace(/[`*_#>\-:]/g, " ").match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
    fields.push(...tokens.filter((token) => token.toLowerCase() !== name.toLowerCase()));
  }
  return fields;
}

/** Set equality that also rejects duplicates in the answer. */
function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (new Set(a).size !== a.length) return false;
  return [...a].sort().join("\n") === [...b].sort().join("\n");
}

/** Check the answer against the expected field names. Returns null on success. */
export function checkAnswer(answer: string | null, expected: ExpectedAnswer): RuleFailure | null {
  if (answer === null || answer.trim().length === 0) {
    return { rule: "answer", detail: "answer.md is missing" };
  }
  const names = expected.interfaces.map((i) => i.name);
  for (const iface of expected.interfaces) {
    const fields = sectionFields(answer, iface.name, names.filter((n) => n !== iface.name));
    if (fields === null) {
      return { rule: "answer", detail: `interface ${iface.name} is not named in answer.md` };
    }
    if (!sameSet(fields, iface.fields)) {
      return {
        rule: "answer",
        detail: `fields of ${iface.name} are [${fields.join(", ")}], expected [${iface.fields.join(", ")}]`,
      };
    }
  }
  return null;
}

/** Visible assistant text parts of the messages, in order. */
function assistantText(messages: readonly MessageEntry[]): string {
  return messages
    .filter((entry) => entry.info.role === "assistant")
    .flatMap((entry) => entry.parts)
    .filter((part): part is Extract<Part, { type: "text" }> => part.type === "text" && part.synthetic !== true)
    .map((part) => part.text)
    .join("\n");
}

/** Evaluate all pass rules of one probe run. */
export function evaluateRun(input: {
  messages: readonly MessageEntry[];
  answer: string | null;
  hasCommit: boolean;
  expected: ExpectedAnswer;
}): ProbeResult {
  const failures: RuleFailure[] = [];
  const answerFailure = checkAnswer(input.answer, input.expected);
  if (answerFailure) failures.push(answerFailure);
  if (!input.hasCommit) failures.push({ rule: "commit", detail: "no commit in the run worktree" });

  const toolParts = input.messages.flatMap((entry) => entry.parts).filter((part): part is Extract<Part, { type: "tool" }> => part.type === "tool");
  const completed = toolParts
    .filter((part) => part.state.status === "completed")
    .map((part) => ({ tool: part.tool, input: part.state.input }));
  if (detectLoop(completed)) {
    failures.push({ rule: "loop", detail: "the session repeated identical tool calls" });
  }
  const errored = toolParts.find((part) => part.state.status === "error");
  if (errored) {
    failures.push({ rule: "tool-error", detail: `tool ${errored.tool} ended in an error state` });
  }

  for (const entry of input.messages) {
    if (entry.info.role === "assistant" && entry.info.tokens.reasoning > REASONING_LIMIT) {
      failures.push({
        rule: "reasoning",
        detail: `message ${entry.info.id} used ${entry.info.tokens.reasoning} reasoning tokens (limit ${REASONING_LIMIT})`,
      });
      break;
    }
  }

  const text = assistantText(input.messages);
  const share = nonAsciiShare(text);
  if (share > NON_ASCII_LIMIT) {
    failures.push({ rule: "unreadable", detail: `${(share * 100).toFixed(1)}% non-ASCII characters in the assistant text` });
  }
  if (text.length > TEXT_LIMIT) {
    failures.push({ rule: "unreadable", detail: `assistant text has ${text.length} characters (limit ${TEXT_LIMIT})` });
  }

  return { pass: failures.length === 0, failures };
}

/** Speed and token metrics of one run, read from the message times and tokens. */
export type SpeedMetrics = {
  /**
   * Time to the first token: from the first user message to the earliest
   * part start (text, reasoning, or tool) of the first assistant message.
   * The assistant message itself is created when the request starts, so its
   * creation time measures only the queueing, not the model.
   */
  timeToFirstTokenMs: number | null;
  /** From the first user message to the last assistant message end (or creation time). */
  wallTimeMs: number | null;
  /**
   * Sum over the assistant messages of the time each model call took
   * (time.completed minus time.created). This leaves out the tool time
   * between the steps.
   */
  generationMs: number | null;
  outputTokens: number;
  reasoningTokens: number;
  /** Output plus reasoning tokens per second of generation time. */
  generationTokensPerSecond: number | null;
};

export function speedMetrics(messages: readonly MessageEntry[]): SpeedMetrics {
  const firstUser = messages.find((entry) => entry.info.role === "user")?.info as Message | undefined;
  const assistants = messages.filter((entry) => entry.info.role === "assistant");
  const outputTokens = assistants.reduce((sum, entry) => sum + (entry.info as Extract<Message, { role: "assistant" }>).tokens.output, 0);
  const reasoningTokens = assistants.reduce((sum, entry) => sum + (entry.info as Extract<Message, { role: "assistant" }>).tokens.reasoning, 0);
  if (!firstUser || assistants.length === 0) {
    return {
      timeToFirstTokenMs: null,
      wallTimeMs: null,
      generationMs: null,
      outputTokens,
      reasoningTokens,
      generationTokensPerSecond: null,
    };
  }
  const first = assistants[0]!.info as Extract<Message, { role: "assistant" }>;
  const last = assistants[assistants.length - 1]!.info as Extract<Message, { role: "assistant" }>;
  // The earliest start time among the visible parts of the first step: the
  // first text, reasoning, or tool part marks the first model output. Tool
  // parts keep their time inside the tool state.
  const partStarts = assistants[0]!.parts
    .map((part) => {
      if (part.type === "tool") return part.state.status === "pending" ? undefined : part.state.time?.start;
      if ("time" in part && part.time && "start" in part.time) return part.time.start;
      return undefined;
    })
    .filter((start): start is number => typeof start === "number");
  const timeToFirstTokenMs = partStarts.length > 0 ? Math.min(...partStarts) - firstUser.time.created : null;
  const wallTimeMs = (last.time.completed ?? last.time.created) - firstUser.time.created;
  const generationMs = assistants.reduce((sum, entry) => {
    const info = entry.info as Extract<Message, { role: "assistant" }>;
    return sum + Math.max(0, (info.time.completed ?? info.time.created) - info.time.created);
  }, 0);
  const seconds = generationMs / 1000;
  return {
    timeToFirstTokenMs,
    wallTimeMs,
    generationMs,
    outputTokens,
    reasoningTokens,
    generationTokensPerSecond: seconds > 0 ? (outputTokens + reasoningTokens) / seconds : null,
  };
}
