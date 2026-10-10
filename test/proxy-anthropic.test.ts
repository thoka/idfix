import { afterEach, describe, expect, test } from "bun:test";
import { bodySessionId, isHelloProbe, mayCarryBodySession, startProxy } from "../src/proxy/proxy";
import requests from "./fixtures/anthropic-requests/claude-code-2.1.285.json";

// Claude Code requests through the cost proxy (step 25c). The requests come
// from the fixture of spike 25b. A fake upstream answers with the Anthropic
// SSE shape plus the `cost` of OpenRouter (.plan/research/driver-interface.md
// section 6.5), so no test calls a paid API.

type LogLine = Record<string, any>;
type Captured = {
  method: string;
  path: string;
  query: string;
  headers: Record<string, string>;
  body: { model: string; stream: boolean; metadata: { user_id: string } };
};
const fixture = requests as unknown as Captured[];

// Secret-like values that must never reach the log. They replace the
// harmless values of the fixture, so a leak shows as a match.
const TOKEN = "sk-or-v1-hygiene-token-0123456789abcdef";
const API_KEY = "sk-ant-api03-hygiene-key-fedcba9876543210";
const DEVICE_ID = "d3v1ce5ecret0d3v1ce5ecret0d3v1ce5ecret0d3v1ce5ecret0d3v1ce5ecr";
const ACCOUNT_UUID = "acc0un75-ecre-4000-8000-acc0un75ecre";

const anthropicSse = (...events: Array<Record<string, unknown>>): string =>
  events.map((data) => `event: ${String(data.type)}\ndata: ${JSON.stringify(data)}\n\n`).join("");

const upstreamStream = anthropicSse(
  {
    type: "message_start",
    message: {
      id: "gen-claude-1",
      type: "message",
      role: "assistant",
      model: "z-ai/glm-5.3-flash",
      content: [],
      stop_reason: null,
      usage: { input_tokens: 20, cache_read_input_tokens: 300, cache_creation_input_tokens: 0, output_tokens: 1 },
    },
  },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } },
  { type: "content_block_stop", index: 0 },
  {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 7, cost: 0.00042, cost_details: { upstream_inference_cost: 0.0004 } },
  },
  { type: "message_stop" },
);

type Seen = { target: string; method: string; headers: Headers; body: string };

function startAnthropicProxy() {
  const lines: LogLine[] = [];
  const seen: Seen[] = [];
  const server = startProxy({
    port: 0,
    log: (line) => lines.push(structuredClone(line)),
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const body = init?.body === undefined || init.body === null ? "" : await new Response(init.body).text();
      seen.push({ target: String(input), method: String(init?.method), headers: new Headers(init?.headers), body });
      return new Response(upstreamStream, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch,
  });
  return { url: `http://${server.hostname}:${server.port}`, lines, seen, close: () => server.stop(true) };
}

const proxies: Array<ReturnType<typeof startAnthropicProxy>> = [];
function proxy(): ReturnType<typeof startAnthropicProxy> {
  const p = startAnthropicProxy();
  proxies.push(p);
  return p;
}
afterEach(() => {
  while (proxies.length > 0) proxies.pop()?.close();
});

/** The headers of a fixture request, with the secrets of this test and without the hop headers. */
function fixtureHeaders(r: Captured, drop: string[] = []): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(r.headers)) {
    if (["host", "connection", "content-length", "accept-encoding", ...drop].includes(name)) continue;
    headers.set(name, value);
  }
  headers.set("authorization", `Bearer ${TOKEN}`);
  headers.set("x-api-key", API_KEY);
  return headers;
}

/** A full request body with a full metadata blob, in the shape of the fixture. */
function fixtureBody(r: Captured): string {
  const userId = JSON.parse(r.body.metadata.user_id) as Record<string, string>;
  return JSON.stringify({
    model: r.body.model,
    messages: [{ role: "user", content: [{ type: "text", text: "Say hi." }] }],
    system: [{ type: "text", text: "You are Claude Code." }],
    tools: [],
    metadata: {
      user_id: JSON.stringify({ device_id: DEVICE_ID, account_uuid: ACCOUNT_UUID, session_id: userId.session_id }),
    },
    max_tokens: 32000,
    stream: r.body.stream,
  });
}

async function send(p: ReturnType<typeof startAnthropicProxy>, r: Captured, drop: string[] = []): Promise<string> {
  const res = await fetch(`${p.url}${r.path}${r.query}`, {
    method: r.method,
    headers: fixtureHeaders(r, drop),
    body: fixtureBody(r),
  });
  expect(res.status).toBe(200);
  return await res.text();
}

const sessionOf = (r: Captured): string => (JSON.parse(r.body.metadata.user_id) as { session_id: string }).session_id;
const [mainRequest, subRequest] = fixture as [Captured, Captured];

describe("key hygiene with the Claude Code fixture", () => {
  for (const drop of [[], ["x-claude-code-session-id"]]) {
    const label = drop.length === 0 ? "with the session header" : "with the session only in the body";
    test(`no log line holds the token, the api key, device_id, or account_uuid (${label})`, async () => {
      const p = proxy();
      for (const r of fixture) await send(p, r, drop);
      expect(p.lines).toHaveLength(fixture.length * 2);
      const all = p.lines.map((line) => JSON.stringify(line)).join("\n");
      for (const secret of [TOKEN, API_KEY, DEVICE_ID, ACCOUNT_UUID, "Bearer", "device_id", "account_uuid", "user_id"]) {
        expect(all).not.toContain(secret);
      }
      // The session and the agent ids are logged as expected.
      const starts = p.lines.filter((line) => line.event === "start");
      const ends = p.lines.filter((line) => line.event === "end");
      expect(starts.map((line) => line.session)).toEqual(fixture.map(sessionOf));
      expect(ends.map((line) => line.session)).toEqual(fixture.map(sessionOf));
      expect(starts.map((line) => line.agent)).toEqual([null, subRequest.headers["x-claude-code-agent-id"]]);
      expect(ends.map((line) => line.agent)).toEqual([null, subRequest.headers["x-claude-code-agent-id"]]);
    });
  }

  test("the upstream gets the same body bytes and the auth headers", async () => {
    for (const drop of [[], ["x-claude-code-session-id"]]) {
      const p = proxy();
      await send(p, mainRequest, drop);
      expect(p.seen).toHaveLength(1);
      const seen = p.seen[0] as Seen;
      expect(seen.target).toBe("https://openrouter.ai/api/v1/messages?beta=true");
      expect(seen.method).toBe("POST");
      expect(seen.body).toBe(fixtureBody(mainRequest));
      expect(seen.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
      expect(seen.headers.get("x-api-key")).toBe(API_KEY);
    }
  });
});

describe("Claude Code requests", () => {
  test("streams the answer and logs cost, tokens, and the idfx headers", async () => {
    const p = proxy();
    const text = await send(p, mainRequest);
    expect(text).toBe(upstreamStream);
    const [start, end] = p.lines as [LogLine, LogLine];
    expect(start.event).toBe("start");
    expect(start.session).toBe(sessionOf(mainRequest));
    expect(start.parentSession).toBeNull();
    expect(start.agent).toBeNull();
    expect(start.idfxRun).toBe("spike-run-1");
    expect(start.idfxProject).toBe("idfix");
    expect(start.path).toBe("/v1/messages?beta=true");
    expect(end.event).toBe("end");
    expect(end.idfxRun).toBe("spike-run-1");
    expect(end.idfxProject).toBe("idfix");
    expect(end.generation).toBe("gen-claude-1");
    expect(end.model).toBe("z-ai/glm-5.3-flash");
    expect(end.cost).toBe(0.00042);
    expect(end.upstreamCost).toBe(0.0004);
    expect(end.tokens).toEqual({ input: 320, output: 7, reasoning: null, cached: 300 });
    expect(end.finishReason).toBe("end_turn");
    expect(end.error).toBeNull();
  });

  test("X-Session-Id wins over the Claude Code header", async () => {
    const p = proxy();
    const res = await fetch(`${p.url}/v1/messages`, {
      method: "POST",
      headers: { "X-Session-Id": "ses_opencode", "x-claude-code-session-id": "claude-session" },
      body: fixtureBody(mainRequest),
    });
    await res.text();
    expect((p.lines[0] as LogLine).session).toBe("ses_opencode");
  });

  test("a body without metadata gives a null session and still reaches the upstream", async () => {
    const p = proxy();
    const res = await fetch(`${p.url}/v1/messages`, { method: "POST", body: "not json" });
    await res.text();
    expect((p.lines[0] as LogLine).session).toBeNull();
    expect((p.seen[0] as Seen).body).toBe("not json");
  });

  test("the new fields are null without their headers", async () => {
    const p = proxy();
    const res = await fetch(`${p.url}/v1/chat/completions`, { method: "POST", body: "{}" });
    await res.text();
    for (const line of p.lines) {
      expect(line.agent).toBeNull();
      expect(line.idfxRun).toBeNull();
      expect(line.idfxProject).toBeNull();
      expect(line.session).toBeNull();
    }
    // Only a POST to .../messages reads the body.
    expect((p.seen[0] as Seen).body).toBe("{}");
  });
});

describe("HEAD /api/hello", () => {
  test("answers 200 with an empty body, without an upstream call or a log line", async () => {
    const p = proxy();
    const res = await fetch(`${p.url}/api/hello`, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect(p.seen).toHaveLength(0);
    expect(p.lines).toHaveLength(0);
  });

  test("other methods on /api/hello still go upstream", async () => {
    const p = proxy();
    await (await fetch(`${p.url}/api/hello`)).text();
    expect(p.seen).toHaveLength(1);
  });
});

describe("pure helpers", () => {
  test("bodySessionId reads only session_id from metadata.user_id", () => {
    const body = JSON.stringify({
      metadata: { user_id: JSON.stringify({ device_id: DEVICE_ID, account_uuid: ACCOUNT_UUID, session_id: "s-1" }) },
    });
    expect(bodySessionId(body)).toBe("s-1");
    expect(bodySessionId("{}")).toBeNull();
    expect(bodySessionId("not json")).toBeNull();
    expect(bodySessionId(JSON.stringify({ metadata: { user_id: "user_abc" } }))).toBeNull();
    expect(bodySessionId(JSON.stringify({ metadata: { user_id: JSON.stringify({ session_id: "" }) } }))).toBeNull();
    expect(bodySessionId("null")).toBeNull();
  });

  test("isHelloProbe and mayCarryBodySession", () => {
    expect(isHelloProbe("HEAD", "/api/hello")).toBe(true);
    expect(isHelloProbe("GET", "/api/hello")).toBe(false);
    expect(mayCarryBodySession("POST", "/v1/messages")).toBe(true);
    expect(mayCarryBodySession("POST", "/v1/chat/completions")).toBe(false);
    expect(mayCarryBodySession("GET", "/v1/messages")).toBe(false);
  });
});

describe("refusal of Anthropic models (step 25h)", () => {
  const post = (url: string, path: string, model: string) =>
    fetch(url + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, messages: [] }),
    });

  for (const path of ["/v1/chat/completions", "/v1/messages"]) {
    for (const model of ["anthropic/claude-opus-5-5", "~anthropic/opus", "z-ai/claude-like"]) {
      test(`${path} refuses ${model}`, async () => {
        const p = proxy();
        const res = await post(p.url, path, model);
        expect(res.status).toBe(403);
        expect(((await res.json()) as any).error.message).toContain(model);
        expect(p.seen).toHaveLength(0);
        const refused = p.lines.filter((l) => l.event === "refused");
        expect(refused).toHaveLength(1);
        expect(refused[0].model).toBe(model);
        expect(refused[0].status).toBe(403);
      });
    }
    test(`${path} forwards z-ai/glm-5.3-flash`, async () => {
      const p = proxy();
      const res = await post(p.url, path, "z-ai/glm-5.3-flash");
      expect(res.status).toBe(200);
      expect(p.seen).toHaveLength(1);
      expect(p.seen[0].body).toContain("z-ai/glm-5.3-flash");
      expect(p.lines.some((l) => l.event === "refused")).toBe(false);
    });
  }
});
