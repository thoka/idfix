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
