/** Tests for `oc-sub trace`: the step cut, the signals, and the command. */
import { describe, expect, spyOn, test } from "bun:test";
import { parseArgs } from "../src/args";
import type { MessageEntry } from "../src/summary";
import type { Part } from "@opencode-ai/sdk";
import { cutSteps, REASONING_EXCERPT_LIMIT, TEXT_EXCERPT_LIMIT, trace, traceSession } from "../src/trace";
import { REASONING_LIMIT } from "../src/detect";

let nextId = 0;
const id = (prefix: string) => `${prefix}_${(nextId++).toString().padStart(3, "0")}`;

function assistant(parts: Part[], over: Record<string, unknown> = {}): MessageEntry {
  return {
    info: {
      id: id("msg"),
      sessionID: "ses_1",
      role: "assistant",
      time: { created: 1 },
      parentID: "msg_0",
      modelID: "zai-org/GLM-5.3-Flash",
      providerID: "deepinfra",
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

const stepStart = () => part("step-start");
const stepFinish = (opts: { reasoning?: number; cacheRead?: number } = {}) =>
  part("step-finish", {
    reason: "stop",
    cost: 0,
    tokens: { input: 10, output: 20, reasoning: opts.reasoning ?? 100, cache: { read: opts.cacheRead ?? 5, write: 0 } },
  });

function tool(name: string, input: Record<string, unknown>, status: "completed" | "error" = "completed", callID = id("call")): Part {
  const base = { callID, tool: name, state: { status, input, ...(status === "error" ? { error: "boom" } : { output: "ok", title: name, metadata: {} }) } };
  (base.state as Record<string, unknown>).time = { start: 1000, end: 1500 };
  return part("tool", base);
}

describe("cutSteps", () => {
  test("cuts one step-start..step-finish span with the parts in between", () => {
    const parts = [stepStart(), part("reasoning", { text: "think", time: { start: 1 } }), tool("read", { filePath: "/a.ts" }), stepFinish(), part("text", { text: "after" })];
    const steps = cutSteps([assistant(parts)]);
    expect(steps).toHaveLength(1);
    expect(steps[0]?.parts).toHaveLength(4);
    expect(steps[0]?.finish?.type).toBe("step-finish");
    // The text after step-finish belongs to no step.
    expect(steps[0]?.parts.some((p) => p.id === parts[4]?.id)).toBe(false);
  });

  test("splits several spans of one message and keeps an open span unfinished", () => {
    const parts = [stepStart(), stepFinish(), stepStart(), part("text", { text: "cut off" })];
    const steps = cutSteps([assistant(parts)]);
    expect(steps).toHaveLength(2);
    expect(steps[0]?.finish).toBeDefined();
    expect(steps[1]?.finish).toBeUndefined();
    expect(steps[1]?.parts).toHaveLength(2);
  });

  test("ignores user messages", () => {
    const entry: MessageEntry = { info: { id: "msg_u", sessionID: "ses_1", role: "user", time: { created: 0 } } as MessageEntry["info"], parts: [] };
    expect(cutSteps([entry])).toEqual([]);
  });
});

describe("traceSession signals", () => {
  test("fills IDs, agent, model, tokens, and excerpts", () => {
    const messages = [
      assistant([
        stepStart(),
        part("reasoning", { text: "R".repeat(400), time: { start: 1 } }),
        part("text", { text: "T".repeat(600) }),
        stepFinish({ reasoning: 120, cacheRead: 7 }),
      ]),
    ];
    const [step] = traceSession(messages, "ses_parent");
    expect(step).toBeDefined();
    expect(step?.parentSessionID).toBe("ses_parent");
    expect(step?.messageID).toBe(messages[0]?.info.id);
    expect(step?.stepIndex).toBe(0);
    expect(step?.agent).toBe("researcher");
    expect(step?.model).toBe("deepinfra/zai-org/GLM-5.3-Flash");
    expect(step?.tokens).toEqual({ input: 10, output: 20, reasoning: 120, cacheRead: 7 });
    expect(step?.text).toHaveLength(TEXT_EXCERPT_LIMIT);
    expect(step?.reasoningExcerpt).toHaveLength(REASONING_EXCERPT_LIMIT);
    expect(step?.finished).toBe(true);
    expect(step?.durationMs).toBeUndefined();
  });

  test("agent falls back to empty when the message carries none", () => {
    const messages = [assistant([stepStart(), stepFinish()], { agent: undefined })];
    expect(traceSession(messages, null)[0]?.agent).toBe("");
  });

  test("toolError marks a step with a failed tool call", () => {
    const messages = [assistant([stepStart(), tool("bash", { command: "ls" }, "error"), stepFinish()])];
    const step = traceSession(messages, null)[0];
    expect(step?.toolError).toBe(true);
    expect(step?.tools[0]).toMatchObject({ tool: "bash", arg: "ls", status: "error", failed: true });
  });

  test("duplicateCall fires on the same tool and main argument, not on a different one", () => {
    const messages = [
      assistant([stepStart(), tool("read", { filePath: "/a.ts" }), stepFinish()]),
      assistant([stepStart(), tool("read", { filePath: "/a.ts" }), stepFinish()]),
      assistant([stepStart(), tool("read", { filePath: "/b.ts" }), stepFinish()]),
    ];
    const steps = traceSession(messages, null);
    expect(steps[0]?.duplicateCall).toBe(false);
    expect(steps[1]?.duplicateCall).toBe(true);
    expect(steps[2]?.duplicateCall).toBe(false);
  });

  test("rereadFile fires on a second read and clears after an edit", () => {
    const messages = [
      assistant([stepStart(), tool("read", { filePath: "/a.ts" }), stepFinish()]),
      assistant([stepStart(), tool("read", { filePath: "/a.ts" }), stepFinish()]),
      assistant([stepStart(), tool("edit", { filePath: "/a.ts" }), stepFinish()]),
      assistant([stepStart(), tool("read", { filePath: "/a.ts" }), stepFinish()]),
    ];
    const steps = traceSession(messages, null);
    expect(steps[0]?.rereadFile).toBe(false);
    expect(steps[1]?.rereadFile).toBe(true);
    // The edit made the file dirty, so the next read is not a reread.
    expect(steps[3]?.rereadFile).toBe(false);
    expect(steps[2]?.reeditFile).toBe(false);
  });

  test("reeditFile fires on a second edit of the same file", () => {
    const messages = [
      assistant([stepStart(), tool("edit", { filePath: "/a.ts" }), stepFinish()]),
      assistant([stepStart(), tool("edit", { filePath: "/a.ts" }), stepFinish()]),
      assistant([stepStart(), tool("edit", { filePath: "/b.ts" }), stepFinish()]),
    ];
    const steps = traceSession(messages, null);
    expect(steps[0]?.reeditFile).toBe(false);
    expect(steps[1]?.reeditFile).toBe(true);
    expect(steps[2]?.reeditFile).toBe(false);
  });

  test("longReasoning fires above REASONING_LIMIT only", () => {
    const messages = [
      assistant([stepStart(), stepFinish({ reasoning: REASONING_LIMIT })]),
      assistant([stepStart(), stepFinish({ reasoning: REASONING_LIMIT + 1 })]),
    ];
    const steps = traceSession(messages, null);
    expect(steps[0]?.longReasoning).toBe(false);
    expect(steps[1]?.longReasoning).toBe(true);
  });

  test("duration comes from the tool times of the step", () => {
    const messages = [assistant([stepStart(), tool("read", { filePath: "/a.ts" }), stepFinish()])];
    expect(traceSession(messages, null)[0]?.durationMs).toBe(500);
  });

  test("an unfinished step has zero tokens and finished false", () => {
    const messages = [assistant([stepStart(), part("text", { text: "halfway" })])];
    const step = traceSession(messages, null)[0];
    expect(step?.finished).toBe(false);
    expect(step?.tokens).toEqual({ input: 0, output: 0, reasoning: 0, cacheRead: 0 });
    expect(step?.text).toBe("halfway");
  });

  test("the step index runs over the whole session", () => {
    const messages = [
      assistant([stepStart(), stepFinish()]),
      assistant([stepStart(), stepFinish()]),
    ];
    expect(traceSession(messages, null).map((step) => step.stepIndex)).toEqual([0, 1]);
  });
});

describe("trace command", () => {
  function startFakeServer(): { url: string; stop: () => void } {
    const subStep = assistant([stepStart(), stepFinish()], { sessionID: "ses_2", id: "msg_s" });
    (subStep.info as Record<string, unknown>).agent = "researcher";
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (request) => {
        const url = new URL(request.url);
        if (url.pathname === "/global/health") return Response.json({ healthy: true, version: "1.0.0" });
        if (url.pathname === "/session/ses_1/children") return Response.json([{ id: "ses_2" }]);
        if (url.pathname === "/session/ses_2/children") return Response.json([]);
        if (url.pathname === "/session/ses_1") return Response.json({ id: "ses_1", parentID: undefined, title: "main" });
        if (url.pathname === "/session/ses_2") return Response.json({ id: "ses_2", parentID: "ses_1", title: "sub" });
        if (url.pathname === "/session/ses_1/message") {
          return Response.json([
            {
              info: { ...assistant([stepStart(), stepFinish()], { id: "msg_m" }).info, agent: "coder" },
              parts: assistant([stepStart(), stepFinish()], { id: "msg_m" }).parts,
            },
          ]);
        }
        if (url.pathname === "/session/ses_2/message") return Response.json([subStep]);
        return new Response(null, { status: 404 });
      },
    });
    return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
  }

  test("writes one JSON line per step to --out, with the subagent parent ID", async () => {
    const server = startFakeServer();
    const writeSpy = spyOn(Bun, "write").mockImplementation(async () => 0);
    try {
      const parsed = parseArgs(["trace", "ses_1", "--dir", "/w", "--out", "trace.jsonl"]);
      if (parsed.command !== "trace") throw new Error("expected a trace command");
      const code = await trace({ ...parsed, url: server.url }, {});
      expect(code).toBe(0);
      expect(writeSpy).toHaveBeenCalled();
      const [file, content] = writeSpy.mock.calls[0] as unknown as [string, string];
      expect(String(file)).toBe("trace.jsonl");
      const lines = String(content).split("\n").filter((line) => line.length > 0);
      expect(lines).toHaveLength(2);
      const first = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
      expect(first.sessionID).toBe("ses_1");
      expect(first.parentSessionID).toBe(null);
      expect(first.agent).toBe("coder");
      const second = JSON.parse(lines[1] ?? "{}") as Record<string, unknown>;
      expect(second.sessionID).toBe("ses_2");
      expect(second.parentSessionID).toBe("ses_1");
      expect(second.agent).toBe("researcher");
    } finally {
      writeSpy.mockRestore();
      server.stop();
    }
  });

  test("parseArgs takes --out for trace", () => {
    const parsed = parseArgs(["trace", "ses_1", "--out", "trace.jsonl"]);
    if (parsed.command !== "trace") throw new Error("expected a trace command");
    expect(parsed.out).toBe("trace.jsonl");
    expect(parsed.session).toBe("ses_1");
  });
});
