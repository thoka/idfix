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

/** Sum of two summaries, as a new summary. */
export function addSummaries(a: UsageSummary, b: UsageSummary): UsageSummary {
  return {
    cost: a.cost + b.cost,
    steps: a.steps + b.steps,
    tokens: {
      input: a.tokens.input + b.tokens.input,
      output: a.tokens.output + b.tokens.output,
      reasoning: a.tokens.reasoning + b.tokens.reasoning,
      cache: { read: a.tokens.cache.read + b.tokens.cache.read, write: a.tokens.cache.write + b.tokens.cache.write },
    },
  };
}

/** Cost and token totals over one session tree. */
export type UsageTotals = {
  /** The main session and all descendant sessions together. */
  total: UsageSummary;
  /** The part of the descendant sessions (the subagents). */
  subagents: UsageSummary;
  /** Number of descendant sessions. */
  subagentSessions: number;
};

/** Totals over a main session and its descendant sessions. */
export function summarizeTree(main: UsageSummary, descendants: readonly UsageSummary[]): UsageTotals {
  const subagents = descendants.reduce((acc, next) => addSummaries(acc, next), emptySummary());
  return { total: addSummaries(main, subagents), subagents, subagentSessions: descendants.length };
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

/** The token part of a summary line. */
function tokensLine(t: TokenUsage): string {
  return `tokens in ${t.input}, out ${t.output}, reasoning ${t.reasoning}, cache read ${t.cache.read}, cache write ${t.cache.write}`;
}

/** One-line summary: "cost $0.0123, tokens in 1234, out 567, ...". */
export function formatSummary(summary: UsageSummary): string {
  return `cost ${formatCost(summary.cost)}, ${tokensLine(summary.tokens)}`;
}

/**
 * One-line summary of a session tree. With at least one descendant session,
 * the cost part also names the subagent share, for example:
 * "cost $0.0816 (subagents $0.0665 in 4 sessions), tokens in ...".
 */
export function formatTotals(totals: UsageTotals): string {
  if (totals.subagentSessions === 0) return formatSummary(totals.total);
  const count = totals.subagentSessions === 1 ? "1 session" : `${totals.subagentSessions} sessions`;
  return (
    `cost ${formatCost(totals.total.cost)} (subagents ${formatCost(totals.subagents.cost)} in ${count}), ` +
    tokensLine(totals.total.tokens)
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
