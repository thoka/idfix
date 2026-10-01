import { describe, expect, test } from "bun:test";
import { assertOk, errorMessage, probeServer, requireServer, ServerAuthError, ServerDownError, unwrap, type ServerState } from "../src/client";

describe("unwrap and assertOk", () => {
  test("returns the data when present", () => {
    expect(unwrap({ data: { id: "ses_1" }, error: undefined }, "load")).toEqual({ id: "ses_1" });
  });

  test("throws a readable error from a named error body", () => {
    expect(() =>
      unwrap({ data: undefined, error: { name: "NotFoundError", data: { message: "no such session" } } }, "load session"),
    ).toThrow("load session: no such session");
    expect(() => unwrap({ data: undefined, error: { name: "BadRequest" } }, "do it")).toThrow("do it: BadRequest");
    expect(() => unwrap({ data: undefined, error: "boom" }, "do it")).toThrow("do it: boom");
    expect(() => unwrap({ data: undefined, error: undefined }, "do it")).toThrow("do it: unknown error");
  });

  test("assertOk passes on 204-style empty data and throws on errors", () => {
    expect(() => assertOk({ error: undefined }, "send")).not.toThrow();
    expect(() => assertOk({ error: { name: "BadRequest", data: { message: "bad" } } }, "send")).toThrow("send: bad");
  });
});

describe("errorMessage", () => {
  test("prefers data.message, then name, then the raw string", () => {
    expect(errorMessage({ name: "X", data: { message: "why" } })).toBe("why");
    expect(errorMessage({ name: "X" })).toBe("X");
    expect(errorMessage("plain")).toBe("plain");
    expect(errorMessage(undefined)).toBe("unknown error");
  });
});

describe("probeServer", () => {
  test("is down when nothing listens", async () => {
    expect(await probeServer("http://127.0.0.1:9", {}, 1000)).toEqual({ state: "down" });
  });

  test("is down when the server never answers", async () => {
    let port = 8850;
    for (;;) {
      try {
        const server = Bun.serve({ port, fetch: () => new Promise(() => {}) }); // hangs forever
        try {
          const result = await probeServer(`http://127.0.0.1:${port}`, {}, 300);
          expect(result).toEqual({ state: "down" });
        } finally {
          server.stop(true);
        }
        break;
      } catch {
        port += 1;
        if (port > 8890) throw new Error("no free port for the test server");
      }
    }
  });
});

describe("requireServer", () => {
  /** Build a fake probe from a list of states, counting the calls. */
  function fakeProbe(states: ServerState[]): { probe: (url: string, env: Env, timeoutMs: number) => Promise<ServerState>; calls: () => number } {
    let count = 0;
    return {
      probe: () => {
        const state = states[Math.min(count, states.length - 1)];
        count += 1;
        return Promise.resolve(state);
      },
      calls: () => count,
    };
  }

  test("passes when the server is healthy", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => Response.json({ healthy: true, version: "1.0.0" }),
    });
    try {
      await requireServer(`http://127.0.0.1:${server.port}`, {});
    } finally {
      server.stop(true);
    }
  });

  test("retries a busy server and passes when it comes up", async () => {
    const fake = fakeProbe([{ state: "down" }, { state: "down" }, { state: "up", version: "1.0.0" }]);
    await requireServer("http://127.0.0.1:1", {}, { probe: fake.probe, pauseMs: 0 });
    expect(fake.calls()).toBe(3);
  });

  test("throws ServerDownError after the last down try", async () => {
    const fake = fakeProbe([{ state: "down" }]);
    const error = await requireServer("http://127.0.0.1:1", {}, { probe: fake.probe, pauseMs: 0 }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ServerDownError);
    expect((error as ServerDownError).message).toBe("no server on http://127.0.0.1:1. Start it with: oc-sub up");
    expect(fake.calls()).toBe(3);
  });

  test("throws ServerAuthError at once without retrying", async () => {
    const fake = fakeProbe([{ state: "unauthorized" }]);
    const error = await requireServer("http://127.0.0.1:1", {}, { probe: fake.probe, pauseMs: 0 }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ServerAuthError);
    expect(fake.calls()).toBe(1);
  });
});

describe("refused credentials", () => {
  test("probeServer reports 401 and 403 as unauthorized", async () => {
    for (const status of [401, 403]) {
      const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("", { status }) });
      try {
        expect(await probeServer(`http://127.0.0.1:${server.port}`, {}, 1000)).toEqual({ state: "unauthorized" });
      } finally {
        server.stop(true);
      }
    }
  });

  test("requireServer names the password problem", async () => {
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("", { status: 401 }) });
    const url = `http://127.0.0.1:${server.port}`;
    try {
      const withPassword = await requireServer(url, { OPENCODE_SERVER_PASSWORD: "wrong" }).catch((caught: unknown) => caught);
      expect(withPassword).toBeInstanceOf(ServerAuthError);
      expect((withPassword as Error).message).toBe(`the server on ${url} rejected the password in OPENCODE_SERVER_PASSWORD`);
      const withoutPassword = await requireServer(url, {}).catch((caught: unknown) => caught);
      expect((withoutPassword as Error).message).toBe(`the server on ${url} needs a password. Set OPENCODE_SERVER_PASSWORD`);
    } finally {
      server.stop(true);
    }
  });
});
