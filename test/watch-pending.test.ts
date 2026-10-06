/**
 * Tests for the pending request detection of `oc-sub watch`, against a fake
 * opencode server. No real server and no model is needed: the fake serves the
 * routes that watch calls, including a silent event stream.
 */
import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { watch } from "../src/watch";

const SESSION = "ses_1";

/** A question request as GET /question returns it. */
function questionRequest(sessionID: string) {
  return {
    id: "que_1",
    sessionID,
    questions: [
      {
        question: "Which file should I edit?",
        header: "File",
        options: [
          { label: "Option A", description: "the first file" },
          { label: "Option B", description: "the second file" },
        ],
      },
    ],
  };
}

/** A permission request as GET /permission returns it. */
function permissionRequest(sessionID: string) {
  return { id: "per_1", sessionID, permission: "bash", patterns: ["rm *"] };
}

type FakeServerOptions = {
  questions: ReturnType<typeof questionRequest>[];
  permissions: ReturnType<typeof permissionRequest>[];
  /** The states of the status map. An empty map means no session is busy. */
  states?: Record<string, { type: string }>;
  /** The child sessions that the server lists for the watched session. */
  children?: Array<{ id: string }>;
};

/**
 * A fake opencode server for the routes of `watch`. The event stream stays
 * open for a while and then closes, so the test cannot hang forever.
 */
function startFakeServer(options: FakeServerOptions) {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/global/health") return Response.json({ healthy: true, version: "1.0.0" });
      if (url.pathname === "/event") {
        const stream = new ReadableStream({
          start(controller) {
            // Like the real server, the first event is server.connected.
            const connected = { type: "server.connected", properties: {} };
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(connected)}\n\n`));
            const timer = setTimeout(() => {
              try {
                controller.close();
              } catch {
                // already closed
              }
            }, 15_000);
            timer.unref?.();
          },
        });
        return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
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
      if (url.pathname === "/session/status") return Response.json(options.states ?? {});
      if (url.pathname === "/question") return Response.json(options.questions);
      if (url.pathname === "/permission") return Response.json(options.permissions);
      return new Response(`not found: ${url.pathname}`, { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
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

async function runWatch(server: { url: string; stop: () => void }): Promise<{
  code: number;
  workDir: string;
  logged: string[];
  errors: string[];
}> {
  const workDir = mkdtempSync(path.join(tmpdir(), "oc-sub-watch-q-"));
  const captured = captureConsole();
  try {
    const code = await watch({ url: server.url, session: SESSION, dir: workDir, json: false }, {});
    return { code, workDir, logged: captured.logged, errors: captured.errors };
  } finally {
    captured.restore();
    rmSync(workDir, { recursive: true, force: true });
    server.stop();
  }
}

describe("watch with a pending request", () => {
  test("prints the question block and ends with exit code 3", async () => {
    const server = startFakeServer({
      questions: [questionRequest(SESSION)],
      permissions: [],
      states: { [SESSION]: { type: "busy" } },
    });
    const { code, workDir, logged, errors } = await runWatch(server);
    expect(code).toBe(3);
    expect(logged).toEqual([
      "question que_1 in ses_1",
      "  1. [File] Which file should I edit?",
      "     - Option A: the first file",
      "     - Option B: the second file",
      `answer with: oc-sub answer que_1 --dir ${workDir} "<answer>" (or --reject)`,
      "",
      "The session waits for an answer. After answering, watch again.",
    ]);
    expect(errors).toEqual([]);
  }, 20_000);

  test("prints the permission block with the reply hint and ends with exit code 3", async () => {
    const server = startFakeServer({
      questions: [],
      permissions: [permissionRequest(SESSION)],
      states: { [SESSION]: { type: "busy" } },
    });
    const { code, workDir, logged } = await runWatch(server);
    expect(code).toBe(3);
    expect(logged).toEqual([
      "permission per_1 in ses_1",
      "  bash: rm *",
      `answer with: oc-sub answer per_1 --dir ${workDir} --reply once (or always, or reject)`,
      "",
      "The session waits for an answer. After answering, watch again.",
    ]);
  }, 20_000);

  test("finds an already pending request of a child session", async () => {
    // No event carries the request. The check at the start finds it through
    // the list endpoints, for the descendant session of the watched session.
    const server = startFakeServer({
      questions: [questionRequest("ses_child")],
      permissions: [],
      states: { [SESSION]: { type: "busy" }, ses_child: { type: "busy" } },
      children: [{ id: "ses_child" }],
    });
    const { code, logged } = await runWatch(server);
    expect(code).toBe(3);
    expect(logged[0]).toBe("question que_1 in ses_child");
  }, 20_000);

  test("ignores a pending request of another session and ends with 0", async () => {
    const server = startFakeServer({
      questions: [questionRequest("ses_other")],
      permissions: [permissionRequest("ses_other")],
      // No busy session, and the main session has a finished assistant
      // message, so the watch ends at once.
      states: {},
    });
    const { code, logged } = await runWatch(server);
    expect(code).toBe(0);
    expect(logged.some((line) => line.startsWith("question que_1"))).toBe(false);
    expect(logged.some((line) => line.startsWith("permission per_1"))).toBe(false);
    expect(logged.some((line) => line.startsWith("idle after"))).toBe(true);
  }, 20_000);
});
