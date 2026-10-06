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
 *
 * Claude Code calls the Anthropic shape (`POST /v1/messages`). Its events
 * carry a `type`: `message_start` holds `message.id`, `message.model` and the
 * first `usage`, `message_delta` holds `delta.stop_reason` and the final
 * `usage`, and `error` holds `error.message`. OpenRouter adds `cost` and
 * `cost_details` to the `usage` of the last event (.plan/research/
 * driver-interface.md section 6.5). A non-streaming body has `type: "message"`.
 * The tap maps these events into the same `TapResult` as the OpenAI chunks.
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

/** The raw token counts of an Anthropic `usage` object, before the merge. */
type AnthropicCounts = {
  input: number | null;
  cacheRead: number | null;
  cacheCreation: number | null;
  output: number | null;
  cost: number | null;
  upstreamCost: number | null;
};

/**
 * The Anthropic counts seen so far for each result. `message_delta` repeats
 * only some counts, so the tap keeps the counts of `message_start` here and
 * merges each later usage into them. A WeakMap keeps `TapResult` unchanged.
 */
const anthropicCounts = new WeakMap<TapResult, AnthropicCounts>();

function objectOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

/**
 * Merges one Anthropic `usage` object into the counts of the result and
 * writes the merged usage. A field that the new object lacks keeps its old
 * value. The input count is the sum of `input_tokens`,
 * `cache_read_input_tokens`, and `cache_creation_input_tokens`, because
 * Anthropic counts the cache tokens apart, while OpenAI `prompt_tokens`
 * includes them. So `input` means the whole prompt on both paths, and
 * `cached` (the cache read) is a part of it.
 */
function mergeAnthropicUsage(state: TapResult, value: unknown): void {
  const usage = objectOf(value);
  if (usage === null) return;
  const details = objectOf(usage.cost_details) ?? {};
  const old = anthropicCounts.get(state) ?? {
    input: null,
    cacheRead: null,
    cacheCreation: null,
    output: null,
    cost: null,
    upstreamCost: null,
  };
  const counts: AnthropicCounts = {
    input: num(usage.input_tokens) ?? old.input,
    cacheRead: num(usage.cache_read_input_tokens) ?? old.cacheRead,
    cacheCreation: num(usage.cache_creation_input_tokens) ?? old.cacheCreation,
    output: num(usage.output_tokens) ?? old.output,
    cost: num(usage.cost) ?? old.cost,
    upstreamCost: num(details.upstream_inference_cost) ?? old.upstreamCost,
  };
  anthropicCounts.set(state, counts);
  const parts = [counts.input, counts.cacheRead, counts.cacheCreation];
  state.usage = {
    cost: counts.cost,
    upstreamCost: counts.upstreamCost,
    input: parts.every((part) => part === null) ? null : parts.reduce<number>((sum, part) => sum + (part ?? 0), 0),
    output: counts.output,
    reasoning: null,
    cached: counts.cacheRead,
  };
}

/** Takes the id, the model, the provider, and the stop reason of an Anthropic message object. */
function applyAnthropicMessage(state: TapResult, message: Record<string, unknown>): void {
  const generation = str(message.id);
  if (generation !== null) state.generation = generation;
  const model = str(message.model);
  if (model !== null) state.model = model;
  const provider = str(message.provider);
  if (provider !== null) state.provider = provider;
  const stopReason = str(message.stop_reason);
  if (stopReason !== null) state.finishReason = stopReason;
  if (message.usage !== undefined) mergeAnthropicUsage(state, message.usage);
}

/**
 * Applies one Anthropic event or body. Returns false when the object is not
 * of the Anthropic shape, so that the OpenAI path handles it.
 */
function applyAnthropic(state: TapResult, data: Record<string, unknown>): boolean {
  switch (data.type) {
    case "message":
      applyAnthropicMessage(state, data);
      break;
    case "message_start": {
      const message = objectOf(data.message);
      if (message !== null) applyAnthropicMessage(state, message);
      break;
    }
    case "message_delta": {
      const stopReason = str(objectOf(data.delta)?.stop_reason);
      if (stopReason !== null) state.finishReason = stopReason;
      if (data.usage !== undefined) mergeAnthropicUsage(state, data.usage);
      break;
    }
    case "error": {
      const message = str(objectOf(data.error)?.message);
      state.error = message ?? "upstream error event";
      break;
    }
    case "message_stop":
    case "content_block_start":
    case "content_block_delta":
    case "content_block_stop":
    case "ping":
      break;
    default:
      return false;
  }
  const provider = str(data.provider);
  if (provider !== null) state.provider = provider;
  return true;
}

/**
 * Applies one chunk to the result: an OpenAI chunk of OpenRouter or
 * DeepInfra, or an Anthropic event (SSE `data` object or JSON body).
 */
export function applyChunk(state: TapResult, chunk: unknown): void {
  if (chunk === null || typeof chunk !== "object") return;
  const data = chunk as Record<string, unknown>;
  if (typeof data.type === "string" && applyAnthropic(state, data)) return;
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
