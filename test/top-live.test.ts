/**
 * Tests for the live event stream of `oc-sub top`. The fake server serves
 * `/global/event` as Server-Sent Events in the real wire format, captured
 * on 2026-09-30 from opencode 1.18.32 (`GET /global/event`):
 *
 *     data: {"directory":"<dir>","project":"global","payload":{"id":"evt_...",
 *     "type":"session.created","properties":{"sessionID":"ses_...","info":{...}}}}
 *
 * The v2 bridge duplicates every event as a `type: "sync"` item, and
 * `server.connected` arrives without a `directory`. The clock and the
 * timers are fake: `fire()` runs all pending timer handlers at once and
 * `sleep` resolves immediately, so no test waits for real seconds.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Stopping the live view aborts the SSE fetch, and the retry helper of the
// SDK rejects with an `AbortError` that no one can handle (it escapes from
// `void reader.cancel()` inside the generated SDK client). The tests filter
// exactly this noise out; every other unhandled rejection stays an error.
process.on("unhandledRejection", (reason) => {
  if ((reason as Error | undefined)?.name === "AbortError") return;
  throw reason;
});
import type { Message, Part, Session } from "@opencode-ai/sdk";
import type { LiveHandle } from "../src/top/live";
import { startLive } from "../src/top/live";
import type { MessageEntry } from "../src/summary";
import type { StatusDeps } from "../src/status";

const HOST_DIR = "/hostproj";
const OTHER_DIR = "/otherproj";
const MINUTE = 60 * 1000;

type FakeSession = { id: string; directory: string; title: string; updated: number };

type FakeServer = {
  url: string;
  port: number;
  /** The mutable session list that the REST routes serve. */
  sessions: FakeSession[];
  /** Send one GlobalEvent to every open stream. */
  push: (event: unknown) => void;
  /** End every open stream, like a server restart. */
  closeStreams: () => void;
  stop: () => void;
};

/** A fake opencode server with SSE support for `/global/event`. */
function startFakeServer(options: {
  port?: number;
  sessions?: FakeSession[];
  states?: Record<string, { type: string }>;
  projects?: Array<{ id: string; worktree: string }>;
  messages?: Record<string, MessageEntry[]>;
}): FakeServer {
  const encoder = new TextEncoder();
  const controllers: Array<ReadableStreamDefaultController<Uint8Array>> = [];
  const sessions: FakeSession[] = options.sessions ?? [];
  const server = Bun.serve({
    port: options.port ?? 0,
    hostname: "127.0.0.1",
    fetch: (request) => {
      const url = new URL(request.url);
      const directory = url.searchParams.get("directory") ?? "";
      if (url.pathname === "/global/health") return Response.json({ healthy: true, version: "1.0.0" });
      if (url.pathname === "/project") return Response.json(options.projects ?? []);
      if (url.pathname === "/question") return Response.json([]);
      if (url.pathname === "/permission") return Response.json([]);
      const messageMatch = /^\/session\/([^/]+)\/message$/.exec(url.pathname);
      if (messageMatch !== null) {
        return Response.json(options.messages?.[messageMatch[1] as string] ?? []);
      }
      if (url.pathname === "/session") {
        return Response.json(
          sessions.filter((session) => session.directory === directory).map(sessionOf) ?? [],
        );
      }
      if (url.pathname === "/session/status") {
        const map: Record<string, unknown> = {};
        for (const session of sessions) {
          const state = options.states?.[session.id];
          if (session.directory === directory && state !== undefined) map[session.id] = state;
        }
        return Response.json(map);
      }
      if (url.pathname === "/global/event") {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controllers.push(controller);
          },
        });
        return new Response(stream, {
          headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  const url = `http://127.0.0.1:${server.port}`;
  return {
    url,
    port: Number(new URL(url).port),
    sessions,
    push: (event) => {
      const data = encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
      for (const controller of controllers) {
        try {
          controller.enqueue(data);
        } catch {
          // The stream was closed; the next reconnect reopens it.
        }
      }
    },
    closeStreams: () => {
      while (controllers.length > 0) {
        try {
          controllers.pop()?.close();
        } catch {
          // Already closed.
        }
      }
    },
    stop: () => {
      for (const controller of controllers.splice(0)) {
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      }
      server.stop(true);
    },
  };
}

function sessionOf(options: FakeSession): Session {
  return {
    id: options.id,
    projectID: "proj",
    directory: options.directory,
    title: options.title,
    version: "1.18.32",
    time: { created: options.updated - MINUTE, updated: options.updated },
  } as Session;
}

let counter = 0;

/** The real `session.created` item of the global stream, captured on the wire. */
function sessionCreated(id: string, directory: string, title: string): unknown {
  return {
    directory,
    project: "global",
    payload: {
      id: `evt_created_${++counter}`,
      type: "session.created",
      properties: {
        sessionID: id,
        info: {
          id,
          slug: `slug-${counter}`,
          projectID: "global",
          directory,
          path: "",
          title,
          version: "1.18.32",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 1790743719468, updated: 1790743719468 },
        },
      },
    },
  };
}

/** The real `message.part.updated` item with a step-finish part, shortened. */
function stepFinish(id: string, directory: string, cost: number): unknown {
  return {
    directory,
    project: "global",
    payload: {
      id: `evt_step_${++counter}`,
      type: "message.part.updated",
      properties: {
        sessionID: id,
        part: {
          id: `prt_step_${counter}`,
          sessionID: id,
          messageID: `msg_${counter}`,
          type: "step-finish",
          reason: "tool-calls",
          cost,
          tokens: { total: 6405, input: 4605, output: 65, reasoning: 7, cache: { read: 1728, write: 0 } },
        },
      },
    },
  };
}

/** The duplicate `sync` copy that the v2 bridge sends after every event. */
function syncCopy(event: unknown): unknown {
  const item = event as { payload: { id: string } };
  return { directory: (event as { directory: string }).directory, payload: { type: "sync", syncEvent: item.payload, id: item.payload.id } };
}

/** The fake server of the "appears later" test, bound to an exact port. */
function startServerOnPort(port: number, clock: FakeClock): FakeServer {
  return startFakeServer({
    port,
    sessions: [session("ses_late", HOST_DIR, clock.now() - MINUTE)],
    states: { ses_late: { type: "busy" } },
    projects: [{ id: "p1", worktree: HOST_DIR }],
    messages: { ses_late: messagesOf("ses_late", 0.004) },
  });
}

function session(id: string, directory: string, updated: number): FakeSession {
  return { id, directory, title: `Session ${id}`, updated };
}

function messagesOf(sessionId: string, cost: number): MessageEntry[] {
  const info = {
    id: `msg_asst_${++counter}`,
    sessionID: sessionId,
    role: "assistant",
    time: { created: 2, completed: 3 },
    modelID: "z-ai/glm-5.3-flash",
    providerID: "openrouter",
    mode: "coder",
    agent: "coder",
    cost,
    tokens: { total: 10, input: 5, output: 3, reasoning: 1, cache: { read: 1, write: 0 } },
    finish: "tool-calls",
  } as unknown as Message;
  return [{ info, parts: [] as Part[] }];
}

const testDeps: StatusDeps = {
  worktreesOf: (directory) => [directory],
  exists: () => true,
  cloneDirectoriesOf: () => [],
};

type FakeClock = {
  now: () => number;
  bump: (ms: number) => void;
  fire: () => void;
  /** The number of running timers. */
  timerCount: () => number;
  /** Resolve all pending reconnect sleeps. */
  flushSleeps: () => void;
  deps: import("../src/top/live").LiveDeps;
};

/** A fake clock: timers collect in a map and run together on `fire()`. */
function fakeClock(): FakeClock {
  let now = 1_000_000;
  // Each started timer gets its own handle, so a handler that starts a
  // second timer shows up as two timers.
  const timers = new Map<number, () => void>();
  let nextHandle = 0;
  const sleeps: Array<() => void> = [];
  const deps: import("../src/top/live").LiveDeps = {
    nowMs: () => now,
    sleep: () =>
      new Promise<void>((resolve) => {
        sleeps.push(resolve);
      }),
    startTimer: (handler) => {
      nextHandle += 1;
      timers.set(nextHandle, handler);
      return nextHandle;
    },
    stopTimer: (handle) => {
      timers.delete(handle as number);
    },
  };
  return {
    now: () => now,
    bump: (ms) => {
      now += ms;
    },
    fire: () => {
      for (const handler of [...timers.values()]) handler();
    },
    timerCount: () => timers.size,
    flushSleeps: () => {
      while (sleeps.length > 0) sleeps.shift()?.();
    },
    deps,
  };
}

/** Wait until the condition holds, or fail after a bounded number of turns. */
async function until(condition: () => boolean): Promise<void> {
  // Up to about 5 seconds: a full parallel test run can be slow.
  for (let i = 0; i < 1000; i++) {
    // Sleep first: the SSE fetch of the live view starts asynchronously, so
    // a check right after `startLive` would run too early.
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    if (condition()) return;
  }
  expect(condition()).toBe(true);
}

const emptyStateHome = () => mkdtempSync(path.join(tmpdir(), "oc-sub-top-live-"));

/**
 * Stop the live view without the abort noise of the SDK: the server ends
 * the streams first, so the generators finish before `stop()` aborts the
 * controllers (aborting a stream mid-read makes the generated SDK client
 * reject an `AbortError` that no one can handle).
 */
async function stopLive(live: LiveHandle, host: FakeServer): Promise<void> {
  host.closeStreams();
  await until(() => live.servers().every((server) => server.state !== "up"));
  live.stop();
}

describe("top live", () => {
  test("an event of the stream changes a row, the sync copy is skipped", async () => {
    const clock = fakeClock();
    const stateHome = emptyStateHome();
    const host = startFakeServer({
      sessions: [session("ses_a", HOST_DIR, clock.now() - MINUTE)],
      states: { ses_a: { type: "busy" } },
      projects: [{ id: "p1", worktree: HOST_DIR }],
      messages: { ses_a: messagesOf("ses_a", 0.004) },
    });
    let live: LiveHandle | undefined;
    try {
      live = await startLive({ all: true }, { XDG_STATE_HOME: stateHome, OC_SUB_URL: host.url }, testDeps, clock.deps);
      await until(() => live!.model.rows(clock.now()).some((row) => row.sessionId === "ses_a"));
      const seeded = live.model.rows(clock.now()).find((row) => row.sessionId === "ses_a");
      expect(seeded?.cost).toBeCloseTo(0.004, 5);

      let changes = 0;
      live.onChange(() => {
        changes++;
      });
      const before = changes;
      const step = stepFinish("ses_a", HOST_DIR, 0.5);
      host.push(step);
      await until(() => changes > before);
      // The sync copy of the same step must not change the numbers again.
      host.push(syncCopy(step));
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      const row = live.model.rows(clock.now()).find((entry) => entry.sessionId === "ses_a");
      expect(row?.cost).toBeCloseTo(0.504, 3);
      // One seeded step (the assistant message) plus one from the event.
      expect(row?.steps).toBe(2);
      // The tick also notifies the listeners.
      clock.bump(2000);
      const tickBefore = changes;
      clock.fire();
      await until(() => changes > tickBefore);
    } finally {
      if (live) await stopLive(live, host);
      host.stop();
      rmSync(stateHome, { recursive: true, force: true });
    }
  });

  test("an event outside the scope is dropped, an event without a directory too", async () => {
    const clock = fakeClock();
    const stateHome = emptyStateHome();
    const host = startFakeServer({});
    let live: LiveHandle | undefined;
    try {
      live = await startLive(
        { all: false, dir: HOST_DIR },
        { XDG_STATE_HOME: stateHome, OC_SUB_URL: host.url },
        testDeps,
        clock.deps,
      );
      await until(() => live!.servers().length === 1 && live!.servers()[0]?.state === "up");
      host.push(sessionCreated("ses_out", OTHER_DIR, "Outside"));
      host.push({ payload: { id: "evt_conn", type: "server.connected", properties: {} } });
      host.push(sessionCreated("ses_in", HOST_DIR, "Inside"));
      await until(() => live!.model.rows(clock.now()).some((row) => row.sessionId === "ses_in"));
      expect(live.model.rows(clock.now()).some((row) => row.sessionId === "ses_out")).toBe(false);
    } finally {
      if (live) await stopLive(live, host);
      host.stop();
      rmSync(stateHome, { recursive: true, force: true });
    }
  });

  test("a failed stream reconnects and seeds the server again", async () => {
    const clock = fakeClock();
    const stateHome = emptyStateHome();
    const host = startFakeServer({
      sessions: [session("ses_a", HOST_DIR, clock.now() - MINUTE)],
      states: { ses_a: { type: "busy" } },
      projects: [{ id: "p1", worktree: HOST_DIR }],
      messages: { ses_a: messagesOf("ses_a", 0.004) },
    });
    let live: LiveHandle | undefined;
    try {
      live = await startLive({ all: true }, { XDG_STATE_HOME: stateHome, OC_SUB_URL: host.url }, testDeps, clock.deps);
      await until(() => live!.servers()[0]?.state === "up");

      // The stream ends, like after a server restart. While it is down, a
      // new session appears on the server, so the reseed can prove itself.
      host.closeStreams();
      await until(() => live!.servers()[0]?.state === "reconnecting");
      host.sessions.push(session("ses_new", HOST_DIR, clock.now()));

      // The backoff resolves; the loop probes the server, seeds it again
      // (and finds the new session), and opens a new stream.
      clock.flushSleeps();
      await until(() => live!.model.rows(clock.now()).some((row) => row.sessionId === "ses_new"));
      expect(live.servers()[0]?.state).toBe("up");
    } finally {
      if (live) await stopLive(live, host);
      host.stop();
      rmSync(stateHome, { recursive: true, force: true });
    }
  });

  test("a server that is down at the start appears later through the probe", async () => {
    const clock = fakeClock();
    const stateHome = emptyStateHome();
    // A fixed port that nothing listens on yet; the live view starts with
    // this server as down.
    const port = 18971;
    const url = `http://127.0.0.1:${port}`;
    let host: FakeServer | undefined;
    const live = await startLive({ all: true }, { XDG_STATE_HOME: stateHome, OC_SUB_URL: url }, testDeps, clock.deps);
    try {
      expect(live.servers()).toEqual([{ project: null, url, sandbox: false, state: "down" }]);

      // The server comes up (a sandbox restarted), but the live view only
      // notices at the next 30-second probe.
      host = startServerOnPort(port, clock);
      clock.bump(30_000);
      clock.fire();
      await until(() => live.servers()[0]?.state === "up");
      expect(live.model.rows(clock.now()).some((row) => row.sessionId === "ses_late")).toBe(true);
    } finally {
      if (host) await stopLive(live, host);
      else live.stop();
      host?.stop();
      rmSync(stateHome, { recursive: true, force: true });
    }
  });

  test("stop() closes the streams and the timers", async () => {
    const clock = fakeClock();
    const stateHome = emptyStateHome();
    const host = startFakeServer({
      sessions: [session("ses_a", HOST_DIR, clock.now() - MINUTE)],
      states: { ses_a: { type: "busy" } },
      projects: [{ id: "p1", worktree: HOST_DIR }],
      messages: { ses_a: messagesOf("ses_a", 0.004) },
    });
    const live = await startLive(
      { all: true },
      { XDG_STATE_HOME: stateHome, OC_SUB_URL: host.url },
      testDeps,
      clock.deps,
    );
    try {
      await until(() => live.servers()[0]?.state === "up");
      let changes = 0;
      live.onChange(() => {
        changes++;
      });
      // While the view runs, events and ticks notify the listeners.
      host.push(stepFinish("ses_a", HOST_DIR, 0.5));
      await until(() => changes > 0);
      clock.bump(2000);
      clock.fire();
      await until(() => changes > 1);
      // Two repeating timers run: the tick and the probe. A tick must not
      // start another timer.
      expect(clock.timerCount()).toBe(2);
      clock.fire();
      clock.fire();
      expect(clock.timerCount()).toBe(2);

      // stop() ends everything: further events and ticks reach nobody.
      await stopLive(live, host);
      const before = changes;
      host.push(stepFinish("ses_a", HOST_DIR, 0.5));
      clock.bump(2000);
      clock.fire();
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      expect(changes).toBe(before);
      expect(clock.timerCount()).toBe(0);
      expect(live.model.rows(clock.now()).find((row) => row.sessionId === "ses_a")?.cost).toBeCloseTo(0.504, 3);
    } finally {
      live.stop();
      host.stop();
      rmSync(stateHome, { recursive: true, force: true });
    }
  });
});
