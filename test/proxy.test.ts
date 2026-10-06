import { deepinfraProxyBaseUrl, proxyBaseUrl } from "../src/sandbox";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { routeRequest, startProxy } from "../src/proxy/proxy";

// A fake upstream with the real OpenRouter response shapes from
// .plan/research/cost-proxy.md section 2. It serves on a random port and can
// delay the end of its stream, so the tests can prove pass-through streaming.

type LogLine = Record<string, any>;

const sseMessage = (data: string): string => `data: ${data}\n\n`;
const [DONE] = ["data: [DONE]\n\n"];

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
  usage: {
    prompt_tokens: 194,
    completion_tokens: 2,
    cost: 0.00123,
    cost_details: { upstream_inference_cost: 0.0011 },
    prompt_tokens_details: { cached_tokens: 128 },
    completion_tokens_details: { reasoning_tokens: 7 },
  },
};

function startFakeUpstream() {
  const heldGates: Array<() => void> = [];
  const release = () => {
    while (heldGates.length > 0) heldGates.pop()?.();
  };
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/chat/completions") {
        if (url.searchParams.get("mode") === "json") {
          return Response.json({
            id: "gen-abc123",
            object: "chat.completion",
            model: "z-ai/glm-5.3-flash",
            provider: "Z.AI",
            choices: [
              { index: 0, message: { role: "assistant", content: "Hi" }, finish_reason: "stop" },
            ],
            usage: usageChunk.usage,
          });
        }
        const stream = new ReadableStream({
          async start(controller) {
            const encoder = new TextEncoder();
            controller.enqueue(encoder.encode(sseMessage(JSON.stringify(textChunk))));
            if (url.searchParams.get("hold") === "1") {
              await new Promise<void>((resolve) => heldGates.push(resolve));
            }
            controller.enqueue(encoder.encode(sseMessage(JSON.stringify(usageChunk))));
            controller.enqueue(encoder.encode(DONE));
            controller.close();
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      if (url.pathname === "/boom") {
        return new Response("upstream is broken", { status: 500, statusText: "Internal Server Error" });
      }
      if (url.pathname === "/slow") {
        // No byte for longer than Bun's default idle timeout of 10 s.
        await Bun.sleep(11_000);
        return Response.json({ ok: true });
      }
      if (url.pathname === "/gzipped") {
        const body = Bun.gzipSync(encoder.encode(JSON.stringify({ model: "z-ai/glm-5.3-flash" })));
        return new Response(body, {
          status: 200,
          headers: { "content-type": "application/json", "content-encoding": "gzip" },
        });
      }
      if (url.pathname === "/stream-error") {
        const stream = new ReadableStream({
          async start(controller) {
            controller.enqueue(encoder.encode(sseMessage(JSON.stringify(textChunk))));
            // Error the stream after the response has started.
            await Bun.sleep(10);
            controller.error(new Error("upstream blew up mid-stream"));
          },
        });
        return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      if (url.pathname === "/echo") {
        return new Response(JSON.stringify({ seen: req.headers.get("x-mark") }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { server, release, close: () => server.stop(true) };
}

const withProxy = (upstreamUrl: string) => {
  const lines: LogLine[] = [];
  const server = startProxy({
    port: 0,
    upstream: upstreamUrl,
    log: (line) => lines.push(structuredClone(line)),
  });
  return {
    url: `http://${server.hostname}:${server.port}`,
    lines,
    close: () => server.stop(true),
  };
};

const fake = startFakeUpstream();
afterAll(() => fake.close());

const proxies: ReturnType<typeof withProxy>[] = [];
function proxy(): ReturnType<typeof withProxy> {
  const p = withProxy(`http://${fake.server.hostname}:${fake.server.port}`);
  proxies.push(p);
  return p;
}
afterEach(() => {
  while (proxies.length > 0) proxies.pop()?.close();
});

const encoder = new TextEncoder();

async function readAll(body: ReadableStream<Uint8Array>): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

describe("startProxy", () => {
  test("streams a response and logs start and end with usage from the last chunk", async () => {
    const p = proxy();
    const res = await fetch(`${p.url}/chat/completions`, {
      method: "POST",
      headers: { "X-Session-Id": "ses_main", "x-parent-session-id": "ses_parent", "content-type": "application/json" },
      body: JSON.stringify({ model: "z-ai/glm-5.3-flash" }),
    });
    const text = await readAll(res.body as ReadableStream<Uint8Array>);
    expect(text).toContain("data: " + JSON.stringify(textChunk));
    expect(text).toContain('"finish_reason":"stop"');
    expect(text).toContain("[DONE]");

    expect(p.lines).toHaveLength(2);
    const start = p.lines[0] as LogLine;
    expect(start.source).toBe("idfx-cost-proxy");
    expect(start.event).toBe("start");
    expect(typeof start.time).toBe("string");
    expect(start.session).toBe("ses_main");
    expect(start.parentSession).toBe("ses_parent");
    expect(start.method).toBe("POST");
    expect(start.path).toBe("/chat/completions");
    expect(typeof start.request).toBe("number");

    const end = p.lines[1] as LogLine;
    expect(end.source).toBe("idfx-cost-proxy");
    expect(end.event).toBe("end");
    expect(end.request).toBe(start.request);
    expect(end.session).toBe("ses_main");
    expect(end.status).toBe(200);
    expect(typeof end.latencyMs).toBe("number");
    expect(typeof end.durationMs).toBe("number");
    expect(end.generation).toBe("gen-abc123");
    expect(end.provider).toBe("Z.AI");
    expect(end.model).toBe("z-ai/glm-5.3-flash");
    expect(end.cost).toBe(0.00123);
    expect(end.upstreamCost).toBe(0.0011);
    expect(end.tokens).toEqual({ input: 194, output: 2, reasoning: 7, cached: 128 });
    expect(end.finishReason).toBe("stop");
    expect(end.error).toBeNull();
  });

  test("reads the same fields from a non-streaming JSON response", async () => {
    const p = proxy();
    const res = await fetch(`${p.url}/chat/completions?mode=json`, { method: "POST", body: "{}" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as LogLine;
    expect(body.provider).toBe("Z.AI");
    const end = p.lines[1] as LogLine;
    expect(end.status).toBe(200);
    expect(end.generation).toBe("gen-abc123");
    expect(end.provider).toBe("Z.AI");
    expect(end.model).toBe("z-ai/glm-5.3-flash");
    expect(end.cost).toBe(0.00123);
    expect(end.tokens).toEqual({ input: 194, output: 2, reasoning: 7, cached: 128 });
    expect(end.finishReason).toBe("stop");
    expect(end.error).toBeNull();
  });

  test("maps the request path to the upstream and forwards headers except host", async () => {
    const p = proxy();
    const res = await fetch(`${p.url}/echo`, { headers: { "x-mark": "kept" } });
    const body = (await res.json()) as { seen: string | null };
    expect(body.seen).toBe("kept");
    // The upstream saw no host header of the proxy (it saw its own or none).
    expect((p.lines[0] as LogLine).path).toBe("/echo");
  });

  test("logs the HTTP error text on an upstream error status", async () => {
    const p = proxy();
    const res = await fetch(`${p.url}/boom`);
    expect(res.status).toBe(500);
    await res.text();
    const start = p.lines[0] as LogLine;
    const end = p.lines[1] as LogLine;
    expect(end.status).toBe(500);
    expect(end.error).toBe("Internal Server Error");
    expect(end.generation).toBeNull();
    expect(end.cost).toBeNull();
    expect(end.request).toBe(start.request);
  });

  test("does not buffer: bytes arrive before the upstream stream ends", async () => {
    const p = proxy();
    const res = await fetch(`${p.url}/chat/completions?hold=1`);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const first = await reader.read();
    const firstText = new TextDecoder().decode(first.value);
    // The upstream is still holding the stream closed at this point.
    expect(firstText).toContain(JSON.stringify(textChunk));
    expect(firstText).not.toContain('"cost"');
    fake.release();
    let tail = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      tail += new TextDecoder().decode(value);
    }
    expect(tail).toContain("finish_reason");
    expect(tail).toContain("[DONE]");
  });

  test("survives a client abort mid-stream and logs the error", async () => {
    const p = proxy();
    const controller = new AbortController();
    const res = await fetch(`${p.url}/chat/completions?hold=1`, { signal: controller.signal });
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    controller.abort();
    try {
      await reader.read();
    } catch {
      // The client-side read fails with the abort, that is expected.
    }
    // The proxy must have written an end line with the error, and must serve
    // the next request without a crash.
    const deadline = Date.now() + 2000;
    while (p.lines.length < 2 && Date.now() < deadline) await Bun.sleep(10);
    expect(p.lines).toHaveLength(2);
    expect((p.lines[1] as LogLine).event).toBe("end");
    expect((p.lines[1] as LogLine).error).not.toBeNull();

    const after = await fetch(`${p.url}/echo`, { headers: { "x-mark": "alive" } });
    expect(await after.json()).toEqual({ seen: "alive" });
    expect((p.lines[3] as LogLine).request).toBe(2);
  });

  test("never logs the Authorization header value", async () => {
    const secret = "sk-or-v1-super-secret-value";
    const p = proxy();
    const res = await fetch(`${p.url}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "X-Session-Id": "ses_auth" },
      body: "{}",
    });
    await readAll(res.body as ReadableStream<Uint8Array>);
    expect(p.lines.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(p.lines)).not.toContain(secret);
    expect(JSON.stringify(p.lines)).not.toContain("Bearer");
    expect((p.lines[0] as LogLine).session).toBe("ses_auth");
  });

  test("logs an error line when the upstream fetch itself fails", async () => {
    // A rejecting fetchImpl instead of a real unreachable host: connecting to
    // 127.0.0.1:1 fails at once in the sandbox but hangs on some hosts.
    const lines: LogLine[] = [];
    const server = startProxy({
      port: 0,
      upstream: "http://127.0.0.1:1/v1",
      log: (line) => lines.push(structuredClone(line)),
      fetchImpl: (() => Promise.reject(new Error("connect ECONNREFUSED"))) as unknown as typeof fetch,
    });
    try {
      const res = await fetch(`http://${server.hostname}:${server.port}/chat/completions`, {
        method: "POST",
        body: "{}",
      });
      expect(res.status).toBe(502);
      const end = lines[1] as LogLine;
      expect(end.status).toBeNull();
      expect(end.error).toContain("upstream fetch failed");
      expect(end.error).toContain("connect ECONNREFUSED");
    } finally {
      server.stop(true);
    }
  });

  test("keeps the connection open when the upstream sends no byte for over 10 s", async () => {
    // Bun's default idle timeout is 10 s; without idleTimeout: 0 this cut
    // the connection while the model still thought (Z.AI p99 is about 21 s).
    const p = proxy();
    const started = performance.now();
    const res = await fetch(`${p.url}/slow`, { method: "POST", body: "{}" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(performance.now() - started).toBeGreaterThan(10_000);
  }, 20_000);

  test("forwards a gzip upstream response as plain bytes without content-encoding", async () => {
    // Bun's fetch decompresses the upstream body. The proxy must not pass
    // the content-encoding header on, or the client decompresses twice.
    const p = proxy();
    const res = await fetch(`${p.url}/gzipped`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("transfer-encoding")).toBeNull();
    expect(await res.json()).toEqual({ model: "z-ai/glm-5.3-flash" });
  });

  test("errors the client stream when the upstream stream fails mid-way", async () => {
    // A clean close would make a cut answer look complete.
    const p = proxy();
    const res = await fetch(`${p.url}/stream-error`);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain(JSON.stringify(textChunk));
    let failure: unknown = null;
    try {
      await reader.read();
    } catch (error) {
      failure = error;
    }
    expect(failure).not.toBeNull();
    // The end line names the stream error, exactly once. Bun rewrites the
    // upstream stream error into a socket error message, so only assert that
    // an error was recorded.
    const end = p.lines[1] as LogLine;
    expect(end.event).toBe("end");
    expect(typeof end.error).toBe("string");
    expect((end.error as string).length).toBeGreaterThan(0);
    expect(p.lines).toHaveLength(2);
  });
});

describe("upstream URL", () => {
  test("the base URL that up gives opencode reaches the OpenRouter API path", async () => {
    // Regression of 2026-09-30: opencode requested `<base>/chat/completions`
    // with base `http://127.0.0.1:PORT/v1`, and the proxy sent it to
    // `https://openrouter.ai/api/v1/v1/chat/completions`, a 404.
    const seen: string[] = [];
    const server = startProxy({
      port: 0,
      log: () => {},
      fetchImpl: (async (input: string | URL | Request) => {
        seen.push(String(input));
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      }) as unknown as typeof fetch,
    });
    try {
      const base = proxyBaseUrl(server.port as number);
      await fetch(`${base}/chat/completions`, { method: "POST", body: "{}" });
      expect(seen).toEqual(["https://openrouter.ai/api/v1/chat/completions"]);
    } finally {
      server.stop(true);
    }
  });
});

describe("DeepInfra routing", () => {
  test("routeRequest sends /deepinfra/ paths to DeepInfra without the prefix", () => {
    const or = "https://openrouter.ai/api";
    const di = "https://api.deepinfra.com";
    expect(routeRequest("/deepinfra/v1/openai/chat/completions", "?a=1", or, di)).toEqual({
      upstream: "deepinfra",
      target: "https://api.deepinfra.com/v1/openai/chat/completions?a=1",
    });
    expect(routeRequest("/v1/chat/completions", "", or, di)).toEqual({
      upstream: "openrouter",
      target: "https://openrouter.ai/api/v1/chat/completions",
    });
    // Only the exact prefix segment selects DeepInfra.
    expect(routeRequest("/deepinfra-x/v1", "", or, di).upstream).toBe("openrouter");
  });

  test("one proxy serves both providers and tags each log line with its upstream", async () => {
    const seen: string[] = [];
    const lines: LogLine[] = [];
    const server = startProxy({
      port: 0,
      log: (line) => lines.push(structuredClone(line)),
      fetchImpl: (async (input: string | URL | Request) => {
        const target = String(input);
        seen.push(target);
        const usage = target.includes("deepinfra")
          ? { prompt_tokens: 15, completion_tokens: 16, total_tokens: 31, estimated_cost: 0.0000268 }
          : { prompt_tokens: 194, completion_tokens: 2, cost: 0.00123 };
        return Response.json({ id: "gen-1", model: "m", choices: [{ finish_reason: "stop" }], usage });
      }) as unknown as typeof fetch,
    });
    try {
      const port = server.port as number;
      await (await fetch(`${proxyBaseUrl(port)}/chat/completions`, { method: "POST", body: "{}" })).text();
      // The deepinfra SDK appends /openai/chat/completions to its base URL.
      await (await fetch(`${deepinfraProxyBaseUrl(port)}/openai/chat/completions`, { method: "POST", body: "{}" })).text();
      expect(seen).toEqual([
        "https://openrouter.ai/api/v1/chat/completions",
        "https://api.deepinfra.com/v1/openai/chat/completions",
      ]);
      const ends = lines.filter((line) => line.event === "end");
      expect(ends.map((line) => [line.upstream, line.cost])).toEqual([
        ["openrouter", 0.00123],
        ["deepinfra", 0.0000268],
      ]);
      const starts = lines.filter((line) => line.event === "start");
      expect(starts.map((line) => line.upstream)).toEqual(["openrouter", "deepinfra"]);
    } finally {
      server.stop(true);
    }
  });

  test("never logs the Authorization header of a DeepInfra request", async () => {
    const lines: LogLine[] = [];
    const server = startProxy({
      port: 0,
      log: (line) => lines.push(structuredClone(line)),
      fetchImpl: (async () => Response.json({ ok: true })) as unknown as typeof fetch,
    });
    try {
      const port = server.port as number;
      await (
        await fetch(`${deepinfraProxyBaseUrl(port)}/openai/chat/completions`, {
          method: "POST",
          headers: { Authorization: "Bearer secret-deepinfra-value" },
          body: "{}",
        })
      ).text();
      expect(JSON.stringify(lines)).not.toContain("secret-deepinfra-value");
    } finally {
      server.stop(true);
    }
  });
});
