import { describe, expect, test } from "bun:test";
import {
  answerSchema,
  buildDecisionsRequestBody,
  buildRequestBody,
  decisionsResultLine,
  DEFAULT_DECISIONS_MODEL,
  formatDecisionsResult,
  formatResult,
  probeDecisions,
  probeSlug,
  readKey,
  type ProbeFetch,
  resultLine,
} from "../probe/jev";

const KEY = "sk-or-secret-key-abc123";

/** Narrow an index access on a parsed object; fails the test when the key is missing. */
function field<T>(record: Record<string, T>, key: string): T {
  const value = record[key];
  if (value === undefined) throw new Error(`missing key "${key}"`);
  return value;
}

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
    const fetch: ProbeFetch = async () =>
      new Response(JSON.stringify({ error: { message: "no such model" } }), { status: 404 });
    const result = await probeSlug("bad/slug", KEY, fetch, async () => {});
    expect(result.errorText).toBe("no such model");
    expect(result.status).toBe(404);
    expect(result.content).toBeNull();
  });

  test("a 200 response extracts model, provider, content, usage, and the generation cost", async () => {
    const urls: string[] = [];
    const fetch: ProbeFetch = async (url: string | URL | Request) => {
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
    };
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
    const fetch: ProbeFetch = async (url: string | URL | Request) => {
      if (String(url).includes("/generation")) {
        generationCalls++;
        return new Response(JSON.stringify({ data: { total_cost: 0.0005 } }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ id: "gen-9", choices: [{ message: { content: "{}" } }], usage: {} }),
        { status: 200 },
      );
    };
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
    const fetch: ProbeFetch = async (url: string | URL | Request) => {
      if (String(url).includes("/generation")) {
        generationCalls++;
        return new Response(JSON.stringify({ data: {} }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: "gen-9", choices: [{ message: { content: "{}" } }], usage: {} }), {
        status: 200,
      });
    };
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

describe("probe/jev.ts decisions mode", () => {
  const DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";

  test("buildDecisionsRequestBody uses the default model and the example state and questions", () => {
    expect(DEFAULT_DECISIONS_MODEL).toBe("typesafe/jev-1.13");
    const body = buildDecisionsRequestBody(DEFAULT_DECISIONS_MODEL) as Record<string, unknown>;
    expect(body.model).toBe("typesafe/jev-1.13");
    const state = body.state as Record<string, string>;
    expect(state.tool_call).toContain("ls src");
    expect(state.claim).toContain("only test files");
    const questions = body.questions as Record<string, { type: string; criteria?: unknown }>;
    expect(field(questions, "tag").type).toBe("choice");
    expect(Object.keys(field(questions, "tag").criteria as object)).toEqual(["ok", "wasted", "wrong-tool", "ungrounded-claim"]);
    expect(field(questions, "claim_supported").type).toBe("noul");
  });

  test("probeDecisions sends the request to the decisions URL with the body and no key leak", async () => {
    let url = "";
    let headers: Record<string, string> = {};
    let sentBody = "";
    const fetch: ProbeFetch = async (u: string | URL | Request, init?: RequestInit) => {
      url = String(u);
      headers = (init?.headers ?? {}) as Record<string, string>;
      sentBody = String(init?.body);
      return new Response(
        JSON.stringify({
          id: "gen-dec-1",
          model: "typesafe/jev-1.13-20260917",
          provider: "TypeSafe",
          answers: {
            tag: { type: "choice", choice: "ungrounded-claim", confidence: 0.81, probabilities: { ok: 0.05, wasted: 0.04, "wrong-tool": 0.1, "ungrounded-claim": 0.81 } },
            claim_supported: { type: "noul", noul: 0.12 },
          },
          usage: { input_tokens: 300, output_tokens: 40, cost: 0.0000126 },
        }),
        { status: 200 },
      );
    };
    const result = await probeDecisions(DEFAULT_DECISIONS_MODEL, KEY, fetch);
    expect(url).toBe(DECISIONS_URL);
    expect(headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(sentBody)).toEqual(buildDecisionsRequestBody(DEFAULT_DECISIONS_MODEL));
    expect(result.status).toBe(200);
    expect(result.errorText).toBeNull();
    const body = result.body as { answers: Record<string, { choice?: string; noul?: number }>; usage: { cost: number } };
    expect(field(body.answers, "tag").choice).toBe("ungrounded-claim");
    expect(field(body.answers, "claim_supported").noul).toBe(0.12);
    expect(body.usage.cost).toBeCloseTo(0.0000126, 9);
  });

  test("probeDecisions reports the error text of a 400", async () => {
    const fetch: ProbeFetch = async () =>
      new Response(JSON.stringify({ error: { message: "unknown question type" } }), { status: 400 });
    const result = await probeDecisions(DEFAULT_DECISIONS_MODEL, KEY, fetch);
    expect(result.status).toBe(400);
    expect(result.errorText).toBe("unknown question type");
  });

  test("formatDecisionsResult prints both answers, the usage cost, and never the key", () => {
    const body = {
      model: "typesafe/jev-1.13-20260917",
      provider: "TypeSafe",
      answers: {
        tag: { type: "choice", choice: "ungrounded-claim", confidence: 0.81, probabilities: { ok: 0.05, "ungrounded-claim": 0.81 } },
        claim_supported: { type: "noul", noul: 0.12 },
      },
      usage: { input_tokens: 300, output_tokens: 40, cost: 0.0000126 },
    };
    const output = formatDecisionsResult(DEFAULT_DECISIONS_MODEL, 200, null, body);
    expect(output).toContain("HTTP status: 200");
    expect(output).toContain("Model: typesafe/jev-1.13-20260917");
    expect(output).toContain("Provider: TypeSafe");
    expect(output).toContain("ungrounded-claim");
    expect(output).toContain("0.81");
    expect(output).toContain("noul=0.12");
    expect(output).toContain("Usage:");
    expect(output).toContain("0.0000126");
    expect(output).not.toContain(KEY);
    const error = formatDecisionsResult(DEFAULT_DECISIONS_MODEL, 400, "unknown question type", null);
    expect(error).toContain("Error: unknown question type");
    expect(error).not.toContain(KEY);
  });

  test("decisionsResultLine holds the endpoint, the full request and response, and no key", () => {
    const request = buildDecisionsRequestBody(DEFAULT_DECISIONS_MODEL);
    const response = { model: "typesafe/jev-1.13-20260917", answers: { claim_supported: { type: "noul", noul: 0.12 } } };
    const line = decisionsResultLine(DEFAULT_DECISIONS_MODEL, 200, request, response);
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed.endpoint).toBe("decisions");
    expect(parsed.request).toEqual(request);
    expect(parsed.response).toEqual(response);
    expect(parsed.httpStatus).toBe(200);
    expect(line).not.toContain(KEY);
  });
});
