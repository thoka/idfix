/**
 * Pure collectors for the fields of an OpenRouter or DeepInfra response. The proxy uses
 * them while the response bytes pass through, without buffering.
 *
 * Facts from .plan/research/cost-proxy.md section 2: every SSE chunk carries a
 * top-level `provider`, and the last chunk carries the `usage` object with
 * `cost` and the token counts. The generation id is the top-level `id`.
 *
 * DeepInfra uses the same OpenAI chunk shape, but its `usage` carries the
 * real cost in USD as `estimated_cost` instead of `cost`, and its chunks
 * carry no `provider` (.plan/research/deepinfra.md section 4). The tap reads
 * `estimated_cost` into the same `cost` field when `cost` is absent.
 */
import { createParser } from "eventsource-parser";

/** Token counts and costs in the shape of the `end` log line. */
export interface Usage {
  cost: number | null;
  upstreamCost: number | null;
  input: number | null;
  output: number | null;
  reasoning: number | null;
  cached: number | null;
}

/** What the proxy extracts from one response. */
export interface TapResult {
  generation: string | null;
  provider: string | null;
  model: string | null;
  usage: Usage;
  finishReason: string | null;
  /** The message of a top-level `error` object of an OpenRouter chunk. */
  error: string | null;
}

const EMPTY_USAGE: Usage = {
  cost: null,
  upstreamCost: null,
  input: null,
  output: null,
  reasoning: null,
  cached: null,
};

export function emptyResult(): TapResult {
  return {
    generation: null,
    provider: null,
    model: null,
    usage: { ...EMPTY_USAGE },
    finishReason: null,
    error: null,
  };
}

function num(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * Reads the fields of one `usage` object. The cost is OpenRouter's `cost`,
 * else DeepInfra's `estimated_cost`, else null.
 */
export function usageOf(value: unknown): Usage {
  if (value === null || typeof value !== "object") return { ...EMPTY_USAGE };
  const usage = value as Record<string, unknown>;
  const details = typeof usage.cost_details === "object" && usage.cost_details !== null
    ? (usage.cost_details as Record<string, unknown>)
    : {};
  const completionDetails = typeof usage.completion_tokens_details === "object" && usage.completion_tokens_details !== null
    ? (usage.completion_tokens_details as Record<string, unknown>)
    : {};
  const promptDetails = typeof usage.prompt_tokens_details === "object" && usage.prompt_tokens_details !== null
    ? (usage.prompt_tokens_details as Record<string, unknown>)
    : {};
  return {
    cost: num(usage.cost) ?? num(usage.estimated_cost),
    upstreamCost: num(details.upstream_inference_cost),
    input: num(usage.prompt_tokens),
    output: num(usage.completion_tokens),
    reasoning: num(completionDetails.reasoning_tokens),
    cached: num(promptDetails.cached_tokens),
  };
}

/** Applies one OpenRouter chunk (SSE `data` object or JSON body) to the result. */
export function applyChunk(state: TapResult, chunk: unknown): void {
  if (chunk === null || typeof chunk !== "object") return;
  const data = chunk as Record<string, unknown>;
  const generation = str(data.id);
  if (generation !== null) state.generation = generation;
  const provider = str(data.provider);
  if (provider !== null) state.provider = provider;
  const model = str(data.model);
  if (model !== null) state.model = model;
  if (data.usage !== undefined) state.usage = usageOf(data.usage);
  if (Array.isArray(data.choices)) {
    const choice = data.choices[0];
    if (choice !== null && typeof choice === "object") {
      const finishReason = str((choice as Record<string, unknown>).finish_reason);
      if (finishReason !== null) state.finishReason = finishReason;
    }
  }
  if (typeof data.error === "object" && data.error !== null) {
    const message = str((data.error as Record<string, unknown>).message);
    if (message !== null) state.error = message;
  } else if (typeof data.error === "string") {
    state.error = data.error;
  }
}

/**
 * A tap for a streamed OpenRouter response. Feed every SSE text chunk into
 * `push`; the feed parses the events and applies each `data` object. The
 * result is complete when the stream ends.
 */
export interface SseTap {
  push(chunk: string): void;
  result(): TapResult;
}

export function createSseTap(): SseTap {
  const state = emptyResult();
  const parser = createParser({
    onEvent(event) {
      const data = event.data;
      if (data === "" || data === "[DONE]") return;
      try {
        applyChunk(state, JSON.parse(data));
      } catch {
        // A malformed data line passes through untouched and is not logged.
      }
    },
  });
  return {
    push(chunk: string): void {
      parser.feed(chunk);
    },
    result: () => state,
  };
}
