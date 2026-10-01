/** Tests for `oc-sub say`, against a fake opencode server. */
import { describe, expect, spyOn, test } from "bun:test";
import { parseArgs } from "../src/args";
import { say } from "../src/say";

type Call = { method: string; path: string; body: unknown };

/** A fake opencode server: the message list and the async prompt route. */
function startFakeServer(options: { messages?: Array<Record<string, unknown>> }): {
  url: string;
  calls: Call[];
  stop: () => void;
} {
  const calls: Call[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/global/health") return Response.json({ healthy: true, version: "1.0.0" });
      if (url.pathname === "/session/ses_1/message") return Response.json(options.messages ?? []);
      const body = await request.text().catch(() => "");
      calls.push({
        method: request.method,
        path: `${url.pathname}${url.search}`,
        body: body.length > 0 ? JSON.parse(body) : undefined,
      });
      return new Response(null, { status: 204 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, calls, stop: () => server.stop(true) };
}

function userMessage(agent: string, model?: { providerID: string; modelID: string }): Record<string, unknown> {
  return {
    info: { role: "user", agent, sessionID: "ses_1", id: "msg_1", time: { created: 1 }, ...(model === undefined ? {} : { model }) },
    parts: [],
  };
}

function assistantMessage(): Record<string, unknown> {
  return { info: { role: "assistant", sessionID: "ses_1", id: "msg_2", time: { created: 2 } }, parts: [] };
}

async function runSay(server: { url: string }, argv: string[]): Promise<{
  code: number;
  logged: string[];
  error?: Error;
}> {
  const logged: string[] = [];
  const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logged.push(args.map((part) => String(part)).join(" "));
  });
  try {
    // Parse the command line the way cli.ts does, then override the URL.
    const parsed = parseArgs(["say", ...argv]);
    if (parsed.command !== "say") throw new Error("expected a say command");
    const code = await say({ ...parsed, url: server.url }, {});
    return { code, logged };
  } catch (error) {
    return { code: -1, logged, error: error instanceof Error ? error : new Error(String(error)) };
  } finally {
    spy.mockRestore();
  }
}

describe("say", () => {
  test("takes the agent from the last user message and sends asynchronously", async () => {
    const server = startFakeServer({ messages: [userMessage("researcher"), assistantMessage(), userMessage("coder")] });
    try {
      const { code, logged, error } = await runSay(server, ["ses_1", "--dir", "/w", "continue with the tests"]);
      expect(error).toBeUndefined();
      expect(code).toBe(0);
      expect(server.calls).toEqual([
        {
          method: "POST",
          path: "/session/ses_1/prompt_async?directory=%2Fw",
          body: { agent: "coder", parts: [{ type: "text", text: "continue with the tests" }] },
        },
      ]);
      expect(logged).toEqual([
        "sent to ses_1 (agent coder). Watch it with: oc-sub watch ses_1 --dir /w",
      ]);
    } finally {
      server.stop();
    }
  });

  test("uses --agent and takes the model from the message list", async () => {
    const server = startFakeServer({ messages: [userMessage("researcher")] });
    try {
      const { logged, error } = await runSay(server, ["ses_1", "--agent", "researcher", "answer the question"]);
      expect(error).toBeUndefined();
      expect(server.calls).toHaveLength(1);
      expect(server.calls[0]?.body).toEqual({
        agent: "researcher",
        parts: [{ type: "text", text: "answer the question" }],
      });
      expect(logged[0]).toContain("(agent researcher)");
    } finally {
      server.stop();
    }
  });

  test("stops with an error when the session has no user message", async () => {
    const server = startFakeServer({ messages: [assistantMessage()] });
    try {
      const { error } = await runSay(server, ["ses_1", "continue"]);
      expect(error?.message).toBe("session ses_1 has no user message. Give --agent NAME");
      expect(server.calls).toEqual([]);
    } finally {
      server.stop();
    }
  });

  test("sends the model of the last user message", async () => {
    const server = startFakeServer({
      messages: [userMessage("coder", { providerID: "deepinfra", modelID: "zai-org/GLM-5.3-Flash" })],
    });
    try {
      const { code, logged, error } = await runSay(server, ["ses_1", "continue"]);
      expect(error).toBeUndefined();
      expect(code).toBe(0);
      expect(server.calls[0]?.body).toEqual({
        agent: "coder",
        parts: [{ type: "text", text: "continue" }],
        model: { providerID: "deepinfra", modelID: "zai-org/GLM-5.3-Flash" },
      });
      expect(logged[0]).toContain("(agent coder, model deepinfra/zai-org/GLM-5.3-Flash)");
    } finally {
      server.stop();
    }
  });

  test("also reads the message list with --agent, to get the model", async () => {
    const server = startFakeServer({
      messages: [userMessage("coder", { providerID: "deepinfra", modelID: "zai-org/GLM-5.3-Flash" })],
    });
    try {
      const { error } = await runSay(server, ["ses_1", "--agent", "researcher", "continue"]);
      expect(error).toBeUndefined();
      expect(server.calls).toHaveLength(1);
      expect(server.calls[0]?.body).toEqual({
        agent: "researcher",
        parts: [{ type: "text", text: "continue" }],
        model: { providerID: "deepinfra", modelID: "zai-org/GLM-5.3-Flash" },
      });
    } finally {
      server.stop();
    }
  });

  test("--model wins over the model of the last user message", async () => {
    const server = startFakeServer({
      messages: [userMessage("coder", { providerID: "deepinfra", modelID: "zai-org/GLM-5.3-Flash" })],
    });
    try {
      const { logged, error } = await runSay(server, ["ses_1", "--model", "openrouter/z-ai/glm-5.3-flash", "continue"]);
      expect(error).toBeUndefined();
      expect(server.calls[0]?.body).toEqual({
        agent: "coder",
        parts: [{ type: "text", text: "continue" }],
        model: { providerID: "openrouter", modelID: "z-ai/glm-5.3-flash" },
      });
      expect(logged[0]).toContain("(agent coder, model openrouter/z-ai/glm-5.3-flash)");
    } finally {
      server.stop();
    }
  });

  test("a last user message without a model sends no model", async () => {
    const server = startFakeServer({ messages: [userMessage("coder")] });
    try {
      const { error } = await runSay(server, ["ses_1", "continue"]);
      expect(error).toBeUndefined();
      expect(server.calls[0]?.body).toEqual({
        agent: "coder",
        parts: [{ type: "text", text: "continue" }],
      });
    } finally {
      server.stop();
    }
  });

  test("parseArgs takes --model for say and rejects a value without a slash", () => {
    const parsed = parseArgs(["say", "ses_1", "--model", "openrouter/z-ai/glm-5.3-flash", "hi"]);
    if (parsed.command !== "say") throw new Error("expected a say command");
    expect(parsed.model).toBe("openrouter/z-ai/glm-5.3-flash");
    expect(() => parseArgs(["say", "ses_1", "--model", "nopath", "hi"])).toThrow(
      '--model must be PROVIDER/MODEL, got "nopath"',
    );
  });
  test("--agent works on a session without a user message, and sends no model", async () => {
    const server = startFakeServer({ messages: [] });
    try {
      const { error } = await runSay(server, ["ses_1", "--agent", "researcher", "start"]);
      expect(error).toBeUndefined();
      expect(server.calls[0]?.body).toEqual({
        agent: "researcher",
        parts: [{ type: "text", text: "start" }],
      });
    } finally {
      server.stop();
    }
  });
});
