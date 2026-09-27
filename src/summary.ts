/** Cost and token accounting, aggregated from opencode messages. */
import type { Message, Part } from "@opencode-ai/sdk";

export type TokenUsage = {
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
};

export type UsageSummary = {
  cost: number;
  steps: number;
  tokens: TokenUsage;
};

export type MessageEntry = { info: Message; parts: Part[] };

export function emptySummary(): UsageSummary {
  return {
    cost: 0,
    steps: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
}

/** Fold one step (one assistant message) into the summary. */
export function addStep(summary: UsageSummary, step: { cost: number; tokens: TokenUsage }): UsageSummary {
  summary.cost += step.cost;
  summary.steps += 1;
  summary.tokens.input += step.tokens.input;
  summary.tokens.output += step.tokens.output;
  summary.tokens.reasoning += step.tokens.reasoning;
  summary.tokens.cache.read += step.tokens.cache.read;
  summary.tokens.cache.write += step.tokens.cache.write;
  return summary;
}

/** Cost and tokens of a whole session, summed over its assistant messages. */
export function summarizeMessages(messages: readonly MessageEntry[]): UsageSummary {
  const summary = emptySummary();
  for (const { info } of messages) {
    if (info.role === "assistant") {
      addStep(summary, { cost: info.cost, tokens: info.tokens });
    }
  }
  return summary;
}

/** Number of distinct tool calls in a session. */
export function countToolCalls(messages: readonly MessageEntry[]): number {
  const ids = new Set<string>();
  for (const { parts } of messages) {
    for (const part of parts) {
      if (part.type === "tool") {
        ids.add(part.callID);
      }
    }
  }
  return ids.size;
}

/** The text of the last assistant message that has visible text, or null. */
export function finalAssistantText(messages: readonly MessageEntry[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const entry = messages[i];
    if (!entry || entry.info.role !== "assistant") continue;
    const text = entry.parts
      .filter(
        (part): part is Extract<Part, { type: "text" }> =>
          part.type === "text" && part.synthetic !== true && part.ignored !== true,
      )
      .map((part) => part.text.trim())
      .filter((line) => line.length > 0)
      .join("\n\n");
    if (text.length > 0) return text;
  }
  return null;
}

export function formatCost(cost: number): string {
  return `$${cost.toFixed(4)}`;
}

/** One-line summary: "cost $0.0123, tokens in 1234, out 567, ...". */
export function formatSummary(summary: UsageSummary): string {
  const t = summary.tokens;
  return (
    `cost ${formatCost(summary.cost)}, tokens in ${t.input}, out ${t.output}, reasoning ${t.reasoning}, ` +
    `cache read ${t.cache.read}, cache write ${t.cache.write}`
  );
}

/** Duration as "1m05s" or "1h02m03s". */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return hours > 0 ? `${hours}h${pad(minutes)}m${pad(seconds)}s` : `${minutes}m${pad(seconds)}s`;
}
