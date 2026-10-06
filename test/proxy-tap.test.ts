import { describe, expect, test } from "bun:test";
import { applyChunk, createSseTap, usageOf } from "../src/proxy/tap";

// Real OpenRouter chunk shapes from .plan/research/cost-proxy.md section 2 and
// https://openrouter.ai/docs/api-reference/streaming.

const sse = (...dataLines: string[]): string =>
  dataLines.map((data) => `data: ${data}\n\n`).join("") + "data: [DONE]\n\n";

const finalUsage = {
  prompt_tokens: 194,
  completion_tokens: 2,
  total_tokens: 196,
  cost: 0.00123,
  cost_details: { upstream_inference_cost: 0.0011 },
  prompt_tokens_details: { cached_tokens: 128 },
  completion_tokens_details: { reasoning_tokens: 7 },
};

const textChunk = {
  id: "gen-abc123",
  object: "chat.completion.chunk",
  created: 1727686800,
  model: "z-ai/glm-5.3-flash",
  provider: "Z.AI",
  choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: null }],
};

const usageChunk = {
  id: "gen-abc123",
  object: "chat.completion.chunk",
  created: 1727686800,
  model: "z-ai/glm-5.3-flash",
  provider: "Z.AI",
  choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  usage: finalUsage,
};

describe("createSseTap", () => {
  test("collects generation, provider, model, usage and finish reason from a stream", () => {
    const tap = createSseTap();
    tap.push(sse(JSON.stringify(textChunk), JSON.stringify(usageChunk)));
    const result = tap.result();
    expect(result.generation).toBe("gen-abc123");
    expect(result.provider).toBe("Z.AI");
    expect(result.model).toBe("z-ai/glm-5.3-flash");
    expect(result.finishReason).toBe("stop");
    expect(result.error).toBeNull();
    expect(result.usage).toEqual({
      cost: 0.00123,
      upstreamCost: 0.0011,
      input: 194,
      output: 2,
      reasoning: 7,
      cached: 128,
    });
  });

  test("takes the provider from any chunk, not only the last one", () => {
    const tap = createSseTap();
    const first = { ...textChunk, provider: "Parasail" };
    const last = { ...usageChunk, provider: undefined };
    tap.push(sse(JSON.stringify(first), JSON.stringify(last)));
    expect(tap.result().provider).toBe("Parasail");
  });

  test("keeps the usage of the last chunk that carries one", () => {
    const tap = createSseTap();
    const early = { ...textChunk, usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.01 } };
    tap.push(sse(JSON.stringify(early), JSON.stringify(usageChunk)));
    expect(tap.result().usage.cost).toBe(0.00123);
    expect(tap.result().usage.input).toBe(194);
  });

  test("feeds a stream in arbitrary split pieces across feed calls", () => {
    const tap = createSseTap();
    const whole = sse(JSON.stringify(textChunk), JSON.stringify(usageChunk));
    for (let i = 0; i < whole.length; i += 7) tap.push(whole.slice(i, i + 7));
    tap.push(whole.slice(whole.length - (whole.length % 7)));
    expect(tap.result().generation).toBe("gen-abc123");
    expect(tap.result().usage.cost).toBe(0.00123);
  });

  test("ignores [DONE], empty lines and malformed data", () => {
    const tap = createSseTap();
    tap.push("data: [DONE]\n\ndata: {broken\n\n");
    expect(tap.result().generation).toBeNull();
    expect(tap.result().usage.cost).toBeNull();
  });

  test("records the message of a top-level error chunk", () => {
    const tap = createSseTap();
    tap.push(
      sse(
        JSON.stringify({
          error: { code: 429, message: "Rate limit exceeded" },
          provider: "Z.AI",
        }),
      ),
    );
    expect(tap.result().error).toBe("Rate limit exceeded");
    expect(tap.result().provider).toBe("Z.AI");
  });

  test("starts empty", () => {
    const result = createSseTap().result();
    expect(result).toEqual({
      generation: null,
      provider: null,
      model: null,
      usage: {
        cost: null,
        upstreamCost: null,
        input: null,
        output: null,
        reasoning: null,
        cached: null,
      },
      finishReason: null,
      error: null,
    });
  });
});

describe("applyChunk", () => {
  test("reads a non-streaming JSON body", () => {
    const state = createSseTap().result();
    applyChunk(state, {
      id: "gen-xyz",
      object: "chat.completion",
      model: "z-ai/glm-5.3-flash",
      provider: "Z.AI",
      choices: [{ index: 0, message: { role: "assistant", content: "Hi" }, finish_reason: "stop" }],
      usage: finalUsage,
    });
    expect(state.generation).toBe("gen-xyz");
    expect(state.provider).toBe("Z.AI");
    expect(state.model).toBe("z-ai/glm-5.3-flash");
    expect(state.finishReason).toBe("stop");
    expect(state.usage.input).toBe(194);
  });

  test("tolerates null and missing fields", () => {
    const state = createSseTap().result();
    applyChunk(state, { usage: null, choices: [] });
    expect(state.usage).toEqual(usageOf(null));
  });
});

describe("usageOf", () => {
  test("reads only the documented fields", () => {
    expect(usageOf(finalUsage)).toEqual({
      cost: 0.00123,
      upstreamCost: 0.0011,
      input: 194,
      output: 2,
      reasoning: 7,
      cached: 128,
    });
  });

  test("returns nulls for a usage object without cost details", () => {
    expect(usageOf({ prompt_tokens: 3, completion_tokens: 4 })).toEqual({
      cost: null,
      upstreamCost: null,
      input: 3,
      output: 4,
      reasoning: null,
      cached: null,
    });
  });
});

describe("usageOf with a DeepInfra usage object", () => {
  test("reads estimated_cost into cost when cost is absent", () => {
    expect(usageOf({ prompt_tokens: 15, completion_tokens: 16, total_tokens: 31, estimated_cost: 0.0000268 }).cost).toBe(
      0.0000268,
    );
  });

  test("prefers cost over estimated_cost", () => {
    expect(usageOf({ cost: 0.5, estimated_cost: 0.1 }).cost).toBe(0.5);
  });

  test("reads estimated_cost from the last chunk of a DeepInfra stream", () => {
    const tap = createSseTap();
    tap.push(`data: ${JSON.stringify({ id: "chatcmpl-1", model: "zai-org/GLM-5.3-Flash", choices: [{ delta: { content: "Hi" } }] })}\n\n`);
    tap.push(
      `data: ${JSON.stringify({
        id: "chatcmpl-1",
        model: "zai-org/GLM-5.3-Flash",
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 15, completion_tokens: 16, estimated_cost: 0.0000268 },
      })}\n\ndata: [DONE]\n\n`,
    );
    const result = tap.result();
    expect(result.usage.cost).toBe(0.0000268);
    expect(result.provider).toBeNull();
    expect(result.model).toBe("zai-org/GLM-5.3-Flash");
  });
});

// The Anthropic Messages shape that Claude Code reads (`POST /v1/messages`),
// with the `cost` that OpenRouter adds to the usage of the last event
// (.plan/research/driver-interface.md section 6.5).
const anthropicSse = (...events: Array<Record<string, unknown>>): string =>
  events.map((data) => `event: ${String(data.type)}\ndata: ${JSON.stringify(data)}\n\n`).join("");

const messageStart = {
  type: "message_start",
  message: {
    id: "gen-anthropic-1",
    type: "message",
    role: "assistant",
    model: "z-ai/glm-5.3-flash",
    content: [],
    stop_reason: null,
    usage: { input_tokens: 25, cache_read_input_tokens: 100, cache_creation_input_tokens: 10, output_tokens: 1 },
  },
};

const messageDelta = {
  type: "message_delta",
  delta: { stop_reason: "end_turn", stop_sequence: null },
  usage: { output_tokens: 42, cost: 0.0021, cost_details: { upstream_inference_cost: 0.002 } },
};

describe("createSseTap with the Anthropic shape", () => {
  test("maps message_start and message_delta into the result", () => {
    const tap = createSseTap();
    tap.push(
      anthropicSse(
        messageStart,
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "ping" },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } },
        { type: "content_block_stop", index: 0 },
        messageDelta,
        { type: "message_stop" },
      ),
    );
    expect(tap.result()).toEqual({
      generation: "gen-anthropic-1",
      provider: null,
      model: "z-ai/glm-5.3-flash",
      usage: { cost: 0.0021, upstreamCost: 0.002, input: 135, output: 42, reasoning: null, cached: 100 },
      finishReason: "end_turn",
      error: null,
    });
  });

  test("message_delta keeps the input counts of message_start", () => {
    const tap = createSseTap();
    tap.push(
      anthropicSse(messageStart, { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } }),
    );
    const usage = tap.result().usage;
    expect(usage.input).toBe(135);
    expect(usage.cached).toBe(100);
    expect(usage.output).toBe(9);
    expect(usage.cost).toBeNull();
    expect(tap.result().finishReason).toBe("tool_use");
  });

  test("message_delta with full counts replaces the counts of message_start", () => {
    const tap = createSseTap();
    tap.push(
      anthropicSse(messageStart, {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { input_tokens: 30, cache_read_input_tokens: 0, output_tokens: 5, cost: 0.5 },
      }),
    );
    const usage = tap.result().usage;
    // 30 input + 0 cache read + 10 cache creation of message_start.
    expect(usage.input).toBe(40);
    expect(usage.cached).toBe(0);
    expect(usage.output).toBe(5);
    expect(usage.cost).toBe(0.5);
  });

  test("input is null when no input count came", () => {
    const tap = createSseTap();
    tap.push(anthropicSse({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } }));
    expect(tap.result().usage.input).toBeNull();
    expect(tap.result().usage.output).toBe(3);
  });

  test("records the message of an error event", () => {
    const tap = createSseTap();
    tap.push(anthropicSse(messageStart, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }));
    expect(tap.result().error).toBe("Overloaded");
    expect(tap.result().generation).toBe("gen-anthropic-1");
  });

  test("feeds an Anthropic stream in split pieces", () => {
    const tap = createSseTap();
    const whole = anthropicSse(messageStart, messageDelta, { type: "message_stop" });
    for (let i = 0; i < whole.length; i += 5) tap.push(whole.slice(i, i + 5));
    expect(tap.result().usage.cost).toBe(0.0021);
    expect(tap.result().usage.input).toBe(135);
  });

  test("two taps do not share their counts", () => {
    const first = createSseTap();
    const second = createSseTap();
    first.push(anthropicSse(messageStart));
    second.push(anthropicSse({ type: "message_delta", delta: {}, usage: { output_tokens: 1 } }));
    expect(second.result().usage.input).toBeNull();
    expect(first.result().usage.input).toBe(135);
  });
});

describe("applyChunk with an Anthropic JSON body", () => {
  test("reads a non-streaming message", () => {
    const state = createSseTap().result();
    applyChunk(state, {
      id: "gen-anthropic-2",
      type: "message",
      role: "assistant",
      model: "z-ai/glm-5.3-flash",
      content: [{ type: "text", text: "Hi" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 12, output_tokens: 4, cost: 0.0003 },
    });
    expect(state.generation).toBe("gen-anthropic-2");
    expect(state.model).toBe("z-ai/glm-5.3-flash");
    expect(state.finishReason).toBe("end_turn");
    expect(state.usage).toEqual({ cost: 0.0003, upstreamCost: null, input: 12, output: 4, reasoning: null, cached: null });
  });

  test("reads an Anthropic error body", () => {
    const state = createSseTap().result();
    applyChunk(state, { type: "error", error: { type: "invalid_request_error", message: "bad beta header" } });
    expect(state.error).toBe("bad beta header");
  });

  test("an object with an unknown type still goes the OpenAI way", () => {
    const state = createSseTap().result();
    applyChunk(state, { type: "something", id: "gen-x", usage: { prompt_tokens: 2, completion_tokens: 1 } });
    expect(state.generation).toBe("gen-x");
    expect(state.usage.input).toBe(2);
  });
});
