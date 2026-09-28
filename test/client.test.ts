import { describe, expect, test } from "bun:test";
import { assertOk, errorMessage, fetchHealth, requireServer, ServerDownError, unwrap } from "../src/client";

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

describe("fetchHealth", () => {
  test("returns null when nothing listens", async () => {
    expect(await fetchHealth("http://127.0.0.1:9", {}, 1000)).toBeNull();
  });

  test("returns null when the server never answers", async () => {
    let port = 8850;
    for (;;) {
      try {
        const server = Bun.serve({ port, fetch: () => new Promise(() => {}) }); // hangs forever
        try {
          const result = await fetchHealth(`http://127.0.0.1:${port}`, {}, 300);
          expect(result).toBeNull();
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
  test("throws ServerDownError with the URL when nothing answers", async () => {
    // Reserve a port, then free it, so that nothing listens there.
    const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
    const url = `http://127.0.0.1:${probe.port}`;
    probe.stop(true);
    const error = await requireServer(url, {}).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ServerDownError);
    expect((error as ServerDownError).message).toBe(`no server on ${url}. Start it with: oc-sub up`);
  });

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
});
