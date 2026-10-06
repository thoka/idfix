/** Tests for `idfx say`, against a fake opencode server. */
import { describe, expect, spyOn, test } from "bun:test";
import { parseArgs } from "../src/args";
import { say } from "../src/say";

type Call = { method: string; path: string; body: unknown };

/** A fake opencode server: the message list, the async prompt, and the pending request routes. */
function startFakeServer(options: {
  messages?: Array<Record<string, unknown>>;
  children?: string[];
  questions?: Array<Record<string, unknown>> | "fail";
  permissions?: Array<Record<string, unknown>>;
}): {
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
      if (url.pathname.endsWith("/children")) return Response.json((options.children ?? []).map((id) => ({ id })));
      if (url.pathname === "/question") {
        if (options.questions === "fail") return Response.json({ message: "list broken" }, { status: 500 });
        return Response.json(options.questions ?? []);
      }
      if (url.pathname === "/permission") return Response.json(options.permissions ?? []);
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
  errors: string[];
  error?: Error;
}> {
  const logged: string[] = [];
  const errors: string[] = [];
  const logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logged.push(args.map((part) => String(part)).join(" "));
  });
  const errorSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.map((part) => String(part)).join(" "));
  });
  try {
    // Parse the command line the way cli.ts does, then override the URL.
    const parsed = parseArgs(["say", ...argv]);
    if (parsed.command !== "say") throw new Error("expected a say command");
    const code = await say({ ...parsed, url: server.url }, {});
    return { code, logged, errors };
  } catch (error) {
    return { code: -1, logged, errors, error: error instanceof Error ? error : new Error(String(error)) };
  } finally {
    logSpy.mockRestore();
    errorSpy.mockRestore();
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
        "sent to ses_1 (agent coder). Watch it with: idfx watch ses_1 --dir /w",
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
      const { code, logged, error } = await runSay(server, ["ses_1", "continue"]);
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

  test("warns about a pending question of the session and still sends", async () => {
    const server = startFakeServer({
      messages: [userMessage("coder")],
      questions: [{ id: "que_1", sessionID: "ses_1", questions: [{ question: "Go on?", header: "Go", options: [] }] }],
    });
    try {
      const { code, logged, errors, error } = await runSay(server, ["ses_1", "--dir", "/w", "continue"]);
      expect(error).toBeUndefined();
      expect(code).toBe(0);
      expect(logged[0]).toContain("sent to ses_1");
      expect(errors).toEqual([
        "session ses_1 waits for an answer. The message stays queued until the request has an answer.",
        "  question que_1 in ses_1",
        "    1. [Go] Go on?",
        '  answer with: idfx answer que_1 --dir /w "<answer>" (or --reject)',
      ]);
    } finally {
      server.stop();
    }
  });

  test("prints no warning for a pending request of another session", async () => {
    const server = startFakeServer({
      messages: [userMessage("coder")],
      questions: [{ id: "que_2", sessionID: "ses_other", questions: [] }],
    });
    try {
      const { code, errors, error } = await runSay(server, ["ses_1", "--dir", "/w", "continue"]);
      expect(error).toBeUndefined();
      expect(code).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      server.stop();
    }
  });

  test("warns about a pending request of a subagent session", async () => {
    const server = startFakeServer({
      messages: [userMessage("coder")],
      children: ["ses_2"],
      permissions: [{ id: "per_1", sessionID: "ses_2", permission: "bash", patterns: ["rm *"] }],
    });
    try {
      const { code, errors, error } = await runSay(server, ["ses_1", "--dir", "/w", "continue"]);
      expect(error).toBeUndefined();
      expect(code).toBe(0);
      expect(errors).toEqual([
        "session ses_1 waits for an answer. The message stays queued until the request has an answer.",
        "  permission per_1 in ses_2",
        "    bash: rm *",
        "  answer with: idfx answer per_1 --dir /w --reply once (or always, or reject)",
      ]);
    } finally {
      server.stop();
    }
  });

  test("a failing list call prints no warning and still sends", async () => {
    const server = startFakeServer({ messages: [userMessage("coder")], questions: "fail" });
    try {
      const { code, logged, errors, error } = await runSay(server, ["ses_1", "--dir", "/w", "continue"]);
      expect(error).toBeUndefined();
      expect(code).toBe(0);
      expect(errors).toEqual([]);
      expect(logged[0]).toContain("sent to ses_1");
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
