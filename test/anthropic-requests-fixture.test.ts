import { describe, expect, test } from "bun:test";
import requests from "./fixtures/anthropic-requests/claude-code-2.1.285.json";

// Requests that Claude Code 2.1.285 sent to a local mock endpoint (spike 25b).
// Step 25c attributes proxy requests to sessions from these shapes.

type Captured = {
  path: string;
  query: string;
  headers: Record<string, string>;
  body: { model: string; stream: boolean; metadata: { user_id: string } };
};
const all = requests as unknown as Captured[];

describe("Claude Code request fixture", () => {
  test("the session header equals the session_id in metadata.user_id", () => {
    for (const r of all) {
      const userId = JSON.parse(r.body.metadata.user_id) as Record<string, string>;
      expect(Object.keys(userId).sort()).toEqual(["account_uuid", "device_id", "session_id"]);
      expect(r.headers["x-claude-code-session-id"]).toBe(userId.session_id);
    }
  });

  test("a subagent request carries its agent id, a main request does not", () => {
    const [main, sub] = all as [Captured, Captured];
    expect(main.headers["x-claude-code-agent-id"]).toBeUndefined();
    expect(sub.headers["x-claude-code-agent-id"]).toMatch(/^[0-9a-f]{17}$/);
  });

  test("ANTHROPIC_CUSTOM_HEADERS reach the endpoint", () => {
    expect(all[0]!.headers["x-idfx-run"]).toBe("spike-run-1");
    expect(all[0]!.headers["x-idfx-project"]).toBe("idfix");
  });

  test("the path is /v1/messages with ?beta=true, and the stream is on", () => {
    for (const r of all) {
      expect(r.path).toBe("/v1/messages");
      expect(r.query).toBe("?beta=true");
      expect(r.body.stream).toBe(true);
    }
  });

  test("the fixture holds no real credential", () => {
    for (const r of all) {
      expect(r.headers.authorization).toBe("Bearer FIXTURE-TOKEN-NOT-A-SECRET");
      expect(r.headers["x-api-key"]).toBeUndefined();
      expect(JSON.parse(r.body.metadata.user_id).device_id).toMatch(/^0{64}$/);
    }
  });
});
