/** Tests for stage two: the Jev tagging of trace steps through the decisions endpoint. */
import { describe, expect, spyOn, test } from "bun:test";
import type { MessageEntry, Part } from "@opencode-ai/sdk";
import {
  DEFAULT_MAX_STEPS,
  JEV_MODEL,
  JEV_QUESTIONS_VERSION,
  JEV_STATE_LIMIT,
  TAG_CRITERIA,
  buildDecisionsRequestBody,
  costEstimate,
  jevState,
  sendDecisionsRequest,
  tagSteps,
} from "../src/jev";
import type { TraceStep } from "../src/trace";
import { trace, traceSession } from "../src/trace";

let nextId = 0;
const id = (prefix: string) => `${prefix}_${(nextId++).toString().padStart(3, "0")}`;

function assistant(parts: Part[], over: Record<string, unknown> = {}): MessageEntry {
  return {
    info: {
      id: id("msg"),
      sessionID: "ses_1",
      role: "assistant",
      time: { created: 1 },
      modelID: "m",
      providerID: "p",
      mode: "build",
      agent: "researcher",
      path: { cwd: "/w", root: "/w" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      ...over,
    } as MessageEntry["info"],
    parts,
  };
}

function part(type: Part["type"], over: Record<string, unknown> = {}): Part {
  return { id: id("prt"), sessionID: "ses_1", messageID: "msg_0", type, ...over } as Part;
}

function tool(name: string, input: Record<string, unknown>, status: "completed" | "error" = "completed"): Part {
  return part("tool", {
    callID: id("call"),
    tool: name,
    state: { status, input, ...(status === "error" ? { error: "boom" } : { output: "ok" }), time: { start: 1, end: 2 } },
  });
}

/** One finished step with one completed tool call, like stage one produces. */
function oneStep(): TraceStep {
  const messages = [
    assistant([part("step-start"), part("text", { text: "I list the folder" }), tool("bash", { command: "ls src" }), part("step-finish", { reason: "stop", cost: 0, tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } } })]),
  ];
  return traceSession(messages, null)[0] as TraceStep;
}

const OK_BODY = {
  model: "typesafe/jev-1.13-20260917",
  answers: {
    tag: { type: "choice", choice: "ok", confidence: 0.8, probabilities: { ok: 0.8 } },
    severity: { type: "score", score: 0.1 },
    step_honest: { type: "noul", noul: 0.96 },
  },
  usage: { input_tokens: 476, output_tokens: 70, cost: 0.000019992 },
};

/** A fake fetch that answers every decisions request with the given body and status. */
function fakeFetch(respond: (body: unknown) => { status: number; body: unknown }): {
  fetch: (input: string | URL, init?: RequestInit) => Promise<Response>;
  calls: Array<{ url: string; init: RequestInit | undefined }>;
} {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  return {
    calls,
    fetch: async (input, init) => {
      calls.push({ url: String(input), init });
      const request = init?.body === undefined ? null : (JSON.parse(String(init.body)) as unknown);
      const { status, body } = respond(request);
      return Response.json(body as object, { status });
    },
  };
}

const KEY = "sk-or-v1-secret-key-value";

describe("buildDecisionsRequestBody", () => {
  test("carries the pinned model, the three questions, and the state fields", () => {
    const body = buildDecisionsRequestBody(oneStep());
    expect(body.model).toBe(JEV_MODEL);
    const questions = body.questions as Record<string, { type: string; criteria: unknown }>;
    expect(questions.tag?.type).toBe("choice");
    expect(Object.keys(questions.tag?.criteria as object).sort()).toEqual(Object.keys(TAG_CRITERIA).sort());
    expect(questions.severity?.type).toBe("score");
    expect(questions.severity?.criteria).toHaveLength(4);
    expect(questions.step_honest?.type).toBe("noul");
    const state = body.state as Record<string, unknown>;
    expect(Object.keys(state).sort()).toEqual(["reasoning", "text", "tools"]);
  });

  test("keeps the state under 4000 characters and cuts long fields", () => {
    const step = oneStep();
    step.text = "X".repeat(5000);
    step.reasoningExcerpt = "R".repeat(5000);
    const state = jevState(step);
    expect(JSON.stringify(state).length).toBeLessThanOrEqual(JEV_STATE_LIMIT);
    expect(String(state.text).length).toBeLessThanOrEqual(1200);
    expect(String(state.reasoning).length).toBeLessThanOrEqual(400);
    // Many tool calls get cut too.
    const stepMany = oneStep();
    stepMany.tools = Array.from({ length: 30 }, (_, i) => ({ tool: "read", arg: `/f${i}.ts`, status: "completed" as const, failed: false }));
    stepMany.text = "";
    stepMany.reasoningExcerpt = "";
    expect(jevState(stepMany).tools).toHaveLength(10);
  });
});

describe("sendDecisionsRequest", () => {
  test("sends one POST with the key in the header only", async () => {
    const fake = fakeFetch(() => ({ status: 200, body: OK_BODY }));
    const { status } = await sendDecisionsRequest({ model: JEV_MODEL }, KEY, fake.fetch);
    expect(status).toBe(200);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.url).toContain("/api/alpha/decisions");
    const headers = fake.calls[0]?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${KEY}`);
  });

  test("retries once on 429 after the sleep, and answers with the retry", async () => {
    const slept: number[] = [];
    let first = true;
    const fake = fakeFetch(() => {
      if (first) {
        first = false;
        return { status: 429, body: { error: { message: "rate limited" } } };
      }
      return { status: 200, body: OK_BODY };
    });
    const { status } = await sendDecisionsRequest({ model: JEV_MODEL }, KEY, fake.fetch, (ms) => {
      slept.push(ms);
      return Promise.resolve();
    });
    expect(status).toBe(200);
    expect(fake.calls).toHaveLength(2);
    expect(slept).toEqual([2000]);
  });

  test("retries once on 5xx and keeps the failing status when the retry fails too", async () => {
    const fake = fakeFetch(() => ({ status: 502, body: { error: { message: "bad gateway" } } }));
    const { status } = await sendDecisionsRequest({ model: JEV_MODEL }, KEY, fake.fetch, () => Promise.resolve());
    expect(status).toBe(502);
    expect(fake.calls).toHaveLength(2);
  });

  test("does not retry on other 4xx", async () => {
    const fake = fakeFetch(() => ({ status: 400, body: { error: { message: "bad request" } } }));
    const { status } = await sendDecisionsRequest({ model: JEV_MODEL }, KEY, fake.fetch);
    expect(status).toBe(400);
    expect(fake.calls).toHaveLength(1);
  });
});

describe("tagSteps", () => {
  function steps(n: number): TraceStep[] {
    return Array.from({ length: n }, () => oneStep());
  }

  test("a 200 response puts the answers, the model, and the cost into the record", async () => {
    const fake = fakeFetch(() => ({ status: 200, body: OK_BODY }));
    const [step] = steps(1);
    const total = await tagSteps([step as TraceStep], KEY, { doFetch: fake.fetch });
    const jev = step.jev as { answers?: unknown; model?: string; cost?: number | null };
    expect(jev.answers).toEqual(OK_BODY.answers);
    expect(jev.model).toBe("typesafe/jev-1.13-20260917");
    expect(jev.cost).toBeCloseTo(0.000019992);
    expect(total).toBeCloseTo(0.000019992);
  });

  test("a 400 response puts the error into the record and the run goes on", async () => {
    let n = 0;
    const fake = fakeFetch(() => {
      n++;
      return n === 1 ? { status: 400, body: { error: { message: "bad state" } } } : { status: 200, body: OK_BODY };
    });
    const list = steps(2);
    const total = await tagSteps(list, KEY, { doFetch: fake.fetch });
    expect(list[0]?.jev).toEqual({ error: "bad state" });
    expect((list[1]?.jev as { answers?: unknown }).answers).toEqual(OK_BODY.answers);
    expect(total).toBeCloseTo(0.000019992);
  });

  test("five failures in a row stop the tagging", async () => {
    const fake = fakeFetch(() => ({ status: 400, body: { error: { message: "server error" } } }));
    const list = steps(8);
    const errors: string[] = [];
    const total = await tagSteps(list, KEY, { doFetch: fake.fetch, log: (line) => errors.push(line) });
    expect(fake.calls).toHaveLength(5);
    for (const step of list.slice(0, 5)) expect(step.jev).toEqual({ error: "server error" });
    for (const step of list.slice(5)) expect(step.jev).toBeUndefined();
    expect(total).toBe(0);
    expect(errors.some((line) => line.includes("5 failures in a row"))).toBe(true);
  });

  test("a success resets the failure counter", async () => {
    let n = 0;
    const fake = fakeFetch(() => {
      n++;
      return n % 2 === 1 ? { status: 400, body: { error: { message: "flaky" } } } : { status: 200, body: OK_BODY };
    });
    const list = steps(4);
    const total = await tagSteps(list, KEY, { doFetch: fake.fetch });
    expect(fake.calls).toHaveLength(4);
    expect(total).toBeCloseTo(0.000039984);
  });

  test("--max-steps limits the number of tagged steps", async () => {
    const fake = fakeFetch(() => ({ status: 200, body: OK_BODY }));
    const list = steps(5);
    await tagSteps(list, KEY, { maxSteps: 2, doFetch: fake.fetch });
    expect(fake.calls).toHaveLength(2);
    expect(list[1]?.jev).toBeDefined();
    expect(list[2]?.jev).toBeUndefined();
  });

  test("maxSteps defaults to 200", () => {
    expect(DEFAULT_MAX_STEPS).toBe(200);
  });

  test("the key never appears in the records, the stderr lines, or the request URL", async () => {
    const fake = fakeFetch(() => ({ status: 200, body: OK_BODY }));
    const list = steps(1);
    const logged: string[] = [];
    await tagSteps(list, KEY, { doFetch: fake.fetch, log: (line) => logged.push(line) });
    const record = JSON.stringify(list[0]);
    expect(record).not.toContain(KEY);
    expect(logged.join("\n")).not.toContain(KEY);
    expect(fake.calls[0]?.url).not.toContain(KEY);
  });
});

describe("cost lines", () => {
  test("the estimate multiplies steps by 2000 input tokens at $0.042/MTok", () => {
    expect(costEstimate(10)).toContain("tagging 10 steps");
    expect(costEstimate(10)).toContain("$0.000840");
    expect(costEstimate(10)).toContain("20000 tokens");
  });
});

describe("trace command with --tag", () => {
  function startFakeServer(): { url: string; stop: () => void } {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (request) => {
        const url = new URL(request.url);
        if (url.pathname === "/global/health") return Response.json({ healthy: true, version: "1.0.0" });
        if (url.pathname === "/session/ses_1/children") return Response.json([]);
        if (url.pathname === "/session/ses_1") return Response.json({ id: "ses_1", parentID: undefined, title: "main" });
        if (url.pathname === "/session/ses_1/message") {
          const entry = assistant([part("step-start"), part("text", { text: "step text" }), part("step-finish", { reason: "stop", cost: 0, tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } } })]);
          return Response.json([{ info: entry.info, parts: entry.parts }]);
        }
        return new Response(null, { status: 404 });
      },
    });
    return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
  }

  test("tagging runs through the injected fetch and writes jev into the records", async () => {
    const server = startFakeServer();
    const fake = fakeFetch(() => ({ status: 200, body: OK_BODY }));
    const writeSpy = spyOn(Bun, "write").mockImplementation(async () => 0);
    const errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const code = await trace({ url: server.url, session: "ses_1", dir: "/w", out: "trace.jsonl", tag: true }, { OPENROUTER_API_KEY: "env-key" }, { doFetch: fake.fetch });
      expect(code).toBe(0);
      expect(fake.calls).toHaveLength(1);
      expect(fake.calls[0]?.url).toContain("/api/alpha/decisions");
      const [file, content] = writeSpy.mock.calls[0] as unknown as [string, string];
      expect(String(file)).toBe("trace.jsonl");
      const step = JSON.parse(String(content).split("\n")[0] ?? "{}") as { jev?: { answers?: unknown }; jevQuestionsVersion?: string };
      expect(step.jev?.answers).toEqual(OK_BODY.answers);
      expect(step.jevQuestionsVersion).toBe(JEV_QUESTIONS_VERSION);
    } finally {
      writeSpy.mockRestore();
      errorSpy.mockRestore();
      server.stop();
    }
  });

  test("trace --tag without a key exits 2 with a message and makes no paid call", async () => {
    const server = startFakeServer();
    const fake = fakeFetch(() => ({ status: 200, body: OK_BODY }));
    const errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const code = await trace({ url: server.url, session: "ses_1", dir: "/w", out: "trace.jsonl", tag: true }, {}, { doFetch: fake.fetch });
      expect(code).toBe(2);
      expect(fake.calls).toHaveLength(0);
      expect(errorSpy.mock.calls.flat().join("\n")).toContain("no key");
    } finally {
      errorSpy.mockRestore();
      server.stop();
    }
  });

  test("trace without --tag makes no fetch to the decisions endpoint", async () => {
    const server = startFakeServer();
    const fetchSpy = spyOn(globalThis, "fetch");
    const writeSpy = spyOn(Bun, "write").mockImplementation(async () => 0);
    try {
      const code = await trace({ url: server.url, session: "ses_1", dir: "/w", out: "trace.jsonl" }, { OPENROUTER_API_KEY: "env-key" });
      expect(code).toBe(0);
      const calledUrls = (fetchSpy.mock.calls as unknown as Array<[string | URL]>).map((call) => String(call[0]));
      expect(calledUrls.some((url) => url.includes("openrouter.ai"))).toBe(false);
    } finally {
      fetchSpy.mockRestore();
      writeSpy.mockRestore();
      server.stop();
    }
  });
});
