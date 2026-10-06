/**
 * Tests for the guards of `oc-sub watch` and for the false idle report,
 * against a fake opencode server whose event stream can deliver invented
 * events. No real server and no model is needed.
 */
import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { watch, WATCH_ATTENTION_EXIT } from "../src/watch";

const SESSION = "ses_1";
const CHILD = "ses_child";

/** A completed tool call event as the event stream delivers it. */
function toolEvent(sessionID: string, tool: string, input: Record<string, unknown>) {
  return {
    type: "message.part.updated",
    properties: {
      part: {
        id: `part_${Math.random().toString(36).slice(2)}`,
        sessionID,
        messageID: "msg_1",
        callID: `call_${Math.random().toString(36).slice(2)}`,
        type: "tool",
        tool,
        state: { status: "completed", input, time: { start: 1, end: 2 } },
      },
    },
  };
}

function permissionRequest(sessionID: string) {
  return { id: "per_1", sessionID, permission: "bash", patterns: ["rm *"] };
}

type FakeServerOptions = {
  permissions?: ReturnType<typeof permissionRequest>[];
  /** The states of the status map. An empty map means no session is busy. */
  states?: Record<string, { type: string }>;
  children?: Array<{ id: string }>;
};

/**
 * A fake opencode server for the routes of `watch`. The event stream stays
 * open, and the test pushes events with `push`. `waitStatuses` resolves when
 * the watch has done its first status check, so no event is sent too early.
 */
function startFakeServer(options: FakeServerOptions) {
  const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
  const encoder = new TextEncoder();
  let statusHits = 0;
  /** The order of the stream opens and the status checks, for the tests. */
  const order: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/global/health") return Response.json({ healthy: true, version: "1.0.0" });
      if (url.pathname === "/event") {
        order.push("event");
        const stream = new ReadableStream({
          start(controller) {
            controllers.push(controller);
            // Like the real server, the first event is server.connected.
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "server.connected", properties: {} })}\n\n`));
          },
        });
        return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
      }
      if (url.pathname === "/session/status") {
        statusHits += 1;
        order.push("status");
        return Response.json(options.states ?? {});
      }
      if (url.pathname === `/session/${SESSION}`) {
        return Response.json({ id: SESSION, title: "Test run", time: { created: 1, updated: 2 } });
      }
      if (url.pathname === `/session/${SESSION}/children`) return Response.json(options.children ?? []);
      if (url.pathname.startsWith("/session/") && url.pathname.endsWith("/children")) return Response.json([]);
      if (url.pathname === `/session/${SESSION}/message`) {
        return Response.json([
          {
            info: {
              id: "msg_1",
              sessionID: SESSION,
              role: "assistant",
              time: { created: 1, completed: 2 },
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            },
            parts: [],
          },
        ]);
      }
      if (url.pathname === "/question") return Response.json([]);
      if (url.pathname === "/permission") return Response.json(options.permissions ?? []);
      return new Response(`not found: ${url.pathname}`, { status: 404 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    order,
    push: (event: unknown) => {
      for (const controller of controllers) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
    },
    waitStatuses: async (count = 1) => {
      for (let i = 0; i < 100 && statusHits < count; i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      if (statusHits < count) throw new Error(`fake server saw only ${statusHits} status checks`);
    },
    stop: () => server.stop(true),
  };
}

function captureConsole(): { logged: string[]; errors: string[]; restore: () => void } {
  const logged: string[] = [];
  const errors: string[] = [];
  const logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logged.push(args.map((part) => String(part)).join(" "));
  });
  const errorSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.map((part) => String(part)).join(" "));
  });
  return {
    logged,
    errors,
    restore: () => {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    },
  };
}

async function runWatch(
  server: ReturnType<typeof startFakeServer>,
  body?: (server: ReturnType<typeof startFakeServer>) => Promise<void>,
): Promise<{ code: number; logged: string[]; errors: string[] }> {
  const workDir = mkdtempSync(path.join(tmpdir(), "oc-sub-watch-g-"));
  const captured = captureConsole();
  try {
    const run = watch({ url: server.url, session: SESSION, dir: workDir, json: false }, {});
    if (body !== undefined) await body(server);
    const code = await run;
    return { code, logged: captured.logged, errors: captured.errors };
  } finally {
    captured.restore();
    rmSync(workDir, { recursive: true, force: true });
    server.stop();
  }
}

describe("watch with a guard finding", () => {
  test("ends with exit code 4 on five identical tool calls", async () => {
    const server = startFakeServer({ states: { [SESSION]: { type: "busy" } } });
    const { code, logged } = await runWatch(server, async (s) => {
      await s.waitStatuses();
      const input = { filePath: "/repo/sdk.gen.d.ts", limit: 75 };
      for (let i = 0; i < 4; i++) s.push(toolEvent(SESSION, "read", input));
      // The fifth identical call is the finding. A different call before it
      // would reset the row.
      s.push(toolEvent(SESSION, "read", input));
    });
    expect(code).toBe(4);
    expect(logged).toContain("needs attention: loop");
    expect(logged).toContain(`session ${SESSION}`);
    expect(logged.some((line) => line.includes("tool read, 5 calls in a row with the same input"))).toBe(true);
    expect(logged.some((line) => line.includes("The run keeps running"))).toBe(true);
    // The run keeps running, so there is no idle summary.
    expect(logged.some((line) => line.startsWith("idle after"))).toBe(false);
  }, 20_000);

  test("also counts the tool calls of a descendant session", async () => {
    const server = startFakeServer({
      states: { [SESSION]: { type: "busy" }, [CHILD]: { type: "busy" } },
      children: [{ id: CHILD }],
    });
    const { code, logged } = await runWatch(server, async (s) => {
      await s.waitStatuses();
      for (let i = 0; i < 5; i++) s.push(toolEvent(CHILD, "bash", { command: "rg TODO" }));
    });
    expect(code).toBe(4);
    expect(logged).toContain(`session ${CHILD}`);
  }, 20_000);

  test("reports a loop only once when the identical calls continue", async () => {
    const server = startFakeServer({ states: { [SESSION]: { type: "busy" } } });
    const { logged } = await runWatch(server, async (s) => {
      await s.waitStatuses();
      const input = { filePath: "/repo/x.ts" };
      for (let i = 0; i < 7; i++) s.push(toolEvent(SESSION, "read", input));
    });
    expect(logged.filter((line) => line === "needs attention: loop")).toHaveLength(1);
  }, 20_000);
});

describe("watch opens the event stream first", () => {
  test("the stream is connected before the first status check", async () => {
    // Events that the server sends between the subscribe call and the open
    // stream are lost. The first status check must therefore come after the
    // stream has delivered server.connected, else the watch misses tool calls
    // and hangs until a status poll ends it.
    const server = startFakeServer({ states: {} });
    let orderAtFirstStatus: string[] = [];
    await runWatch(server, async (s) => {
      await s.waitStatuses();
      orderAtFirstStatus = [...s.order];
    });
    expect(orderAtFirstStatus.indexOf("event")).toBeGreaterThanOrEqual(0);
    expect(orderAtFirstStatus.indexOf("event")).toBeLessThan(orderAtFirstStatus.indexOf("status"));
  }, 20_000);
});

describe("watch does not report idle while a request waits", () => {
  test("ends with exit code 3 instead of an idle summary", async () => {
    // The status check ran in the gap after one answer and before the next
    // request: the status map showed the session as idle, but a new
    // permission request waited. The watch must not end as idle then.
    const server = startFakeServer({
      states: {},
      permissions: [permissionRequest(SESSION)],
    });
    const { code, logged } = await runWatch(server);
    expect(code).toBe(3);
    expect(logged.some((line) => line.startsWith("permission per_1"))).toBe(true);
    expect(logged.some((line) => line.startsWith("idle after"))).toBe(false);
  }, 20_000);
});
