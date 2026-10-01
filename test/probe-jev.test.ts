import { describe, expect, test } from "bun:test";
import {
  answerSchema,
  buildRequestBody,
  formatResult,
  probeSlug,
  readKey,
  resultLine,
} from "../probe/jev";

const KEY = "sk-or-secret-key-abc123";

describe("probe/jev.ts", () => {
  test("buildRequestBody holds the model, max_tokens, and the schema", () => {
    const body = buildRequestBody("typesafe/jev-router") as Record<string, unknown>;
    expect(body.model).toBe("typesafe/jev-router");
    expect(body.max_tokens).toBe(200);
    expect(body.response_format).toEqual(answerSchema());
    const schema = (body.response_format as { json_schema: { schema: Record<string, unknown> } }).json_schema.schema;
    expect(schema.required).toEqual(["tag", "claim_supported"]);
    const content = (body.messages as Array<{ content: string }>)[0]!.content;
    expect(content).toContain("bash ls src");
    expect(content).toContain("I listed the folder");
    expect(content).toContain("Choice: which tag fits the step");
    expect(content).toContain("Noul: does the result support the claim");
  });

  test("readKey prefers the environment variable, then the project key file", () => {
    expect(readKey({ OPENROUTER_API_KEY: "  env-key  " }, () => "file-key")).toBe("env-key");
    expect(readKey({ OPENROUTER_API_KEY: "" }, () => "file-key")).toBe("file-key");
    expect(readKey({}, () => null)).toBeNull();
  });

  test("a 404 prints the error and the key never appears", async () => {
    const fetch = (async () =>
      new Response(JSON.stringify({ error: { message: "no such model" } }), { status: 404 })) as typeof fetch;
    const result = await probeSlug("bad/slug", KEY, fetch, async () => {});
    expect(result.errorText).toBe("no such model");
    expect(result.status).toBe(404);
    expect(result.content).toBeNull();
  });

  test("a 200 response extracts model, provider, content, usage, and the generation cost", async () => {
    const urls: string[] = [];
    const fetch = (async (url: string | URL | Request) => {
      urls.push(String(url));
      if (String(url).includes("/generation")) {
        return new Response(JSON.stringify({ data: { total_cost: 0.0012 } }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          id: "gen-123",
          model: "typesafe/jev-router",
          provider: "Typesafe",
          choices: [{ message: { content: '{"tag":"ok","claim_supported":"yes"}' } }],
          usage: { prompt_tokens: 120, completion_tokens: 20 },
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    const result = await probeSlug("typesafe/jev-router", KEY, fetch, async () => {});
    expect(result.model).toBe("typesafe/jev-router");
    expect(result.provider).toBe("Typesafe");
    expect(result.content).toBe('{"tag":"ok","claim_supported":"yes"}');
    expect(result.generationCost).toBe(0.0012);
    expect(urls[0]).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(urls[1]).toBe("https://openrouter.ai/api/v1/generation?id=gen-123");
  });

  test("the generation lookup retries three times when OpenRouter counts late", async () => {
    let generationCalls = 0;
    const fetch = (async (url: string | URL | Request) => {
      if (String(url).includes("/generation")) {
        generationCalls++;
        return new Response(JSON.stringify({ data: { total_cost: 0.0005 } }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ id: "gen-9", choices: [{ message: { content: "{}" } }], usage: {} }),
        { status: 200 },
      );
    }) as typeof fetch;
    const sleeps: number[] = [];
    const result = await probeSlug("m", KEY, fetch, async (ms) => {
      sleeps.push(ms);
    });
    // First try succeeds without a wait.
    expect(generationCalls).toBe(1);
    expect(sleeps).toEqual([]);
    expect(result.generationCost).toBe(0.0005);
  });

  test("the generation lookup stops after three tries without a cost", async () => {
    let generationCalls = 0;
    const fetch = (async (url: string | URL | Request) => {
      if (String(url).includes("/generation")) {
        generationCalls++;
        return new Response(JSON.stringify({ data: {} }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: "gen-9", choices: [{ message: { content: "{}" } }], usage: {} }), {
        status: 200,
      });
    }) as typeof fetch;
    const result = await probeSlug("m", KEY, fetch, async () => {});
    expect(generationCalls).toBe(3);
    expect(result.generationCost).toBeNull();
  });

  test("resultLine holds no key and truncates the content to 1000 characters", () => {
    const line = resultLine("typesafe/jev-router", 200, "typesafe/jev-router", "Typesafe", "x".repeat(1500), { prompt_tokens: 1 }, 0.01);
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed.slug).toBe("typesafe/jev-router");
    expect(parsed.httpStatus).toBe(200);
    expect(parsed.generationCost).toBe(0.01);
    expect((parsed.content as string).length).toBe(1000);
    expect(line).not.toContain(KEY);
  });

  test("formatResult prints the status, error, model, provider, content, usage, and cost, and never the key", () => {
    const output = formatResult("bad/slug", 404, "no such model", null, null, null, null, null);
    expect(output).toContain("HTTP status: 404");
    expect(output).toContain("Error: no such model");
    expect(output).not.toContain(KEY);
    const ok = formatResult("m", 200, null, "m", "P", "hi", { prompt_tokens: 2 }, 0.0042);
    expect(ok).toContain("Model: m");
    expect(ok).toContain("Provider: P");
    expect(ok).toContain("Content: hi");
    expect(ok).toContain("Generation cost: $0.004200");
    expect(ok).not.toContain(KEY);
  });
});
