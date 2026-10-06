/** Tests for `idfx answer`, against a fake opencode server. */
import { describe, expect, spyOn, test } from "bun:test";
import { parseArgs } from "../src/args";
import { answer } from "../src/answer";

type Call = { method: string; path: string; body: unknown };

/** A fake opencode server: the two pending lists plus the reply routes. */
function startFakeServer(options: {
  questions?: Array<Record<string, unknown>>;
  permissions?: Array<Record<string, unknown>>;
  /** Fail the list calls (for the error tests). */
  listStatus?: number;
}): { url: string; calls: Call[]; stop: () => void } {
  const calls: Call[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/global/health") return Response.json({ healthy: true, version: "1.0.0" });
      if (options.listStatus !== undefined && (url.pathname === "/question" || url.pathname === "/permission")) {
        return Response.json({ message: "nope" }, { status: options.listStatus });
      }
      if (url.pathname === "/question") return Response.json(options.questions ?? []);
      if (url.pathname === "/permission") return Response.json(options.permissions ?? []);
      const body = await request.text().catch(() => "");
      calls.push({
        method: request.method,
        path: `${url.pathname}${url.search}`,
        body: body.length > 0 ? JSON.parse(body) : undefined,
      });
      return Response.json(true);
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, calls, stop: () => server.stop(true) };
}

const QUESTION = {
  id: "que_1",
  sessionID: "ses_1",
  questions: [
    { question: "Which file?", header: "File", options: [{ label: "Option A", description: "first" }] },
    { question: "Which directory?", header: "Dir", options: [] },
  ],
};

const PERMISSION = { id: "per_1", sessionID: "ses_1", permission: "bash", patterns: ["rm *"] };

function captureConsole(): { logged: string[]; restore: () => void } {
  const logged: string[] = [];
  const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logged.push(args.map((part) => String(part)).join(" "));
  });
  return { logged, restore: () => spy.mockRestore() };
}

async function runAnswer(server: { url: string }, argv: string[]): Promise<{
  code: number;
  logged: string[];
  error?: Error;
}> {
  const captured = captureConsole();
  try {
    // Parse the command line the way cli.ts does, then override the URL.
    const parsed = parseArgs(["answer", ...argv]);
    if (parsed.command !== "answer") throw new Error("expected an answer command");
    const code = await answer({ ...parsed, url: server.url }, {});
    return { code, logged: captured.logged };
  } catch (error) {
    return { code: -1, logged: captured.logged, error: error instanceof Error ? error : new Error(String(error)) };
  } finally {
    captured.restore();
  }
}

describe("answer", () => {
  test("answers a question with one answer per question", async () => {
    const server = startFakeServer({ questions: [QUESTION] });
    try {
      const { code, logged, error } = await runAnswer(server, ["que_1", "Option A", "the src folder"]);
      expect(error).toBeUndefined();
      expect(code).toBe(0);
      expect(server.calls).toEqual([
        {
          method: "POST",
          path: `/question/que_1/reply?directory=${encodeURIComponent(process.cwd())}`,
          body: { answers: [["Option A"], ["the src folder"]] },
        },
      ]);
      expect(logged).toEqual([
        "question que_1 in ses_1 answered",
        "watch the session again to follow the rest of the run",
      ]);
    } finally {
      server.stop();
    }
  });

  test("rejects a question with --reject", async () => {
    const server = startFakeServer({ questions: [QUESTION] });
    try {
      const { code, logged, error } = await runAnswer(server, ["que_1", "--reject", "--dir", "/w"]);
      expect(error).toBeUndefined();
      expect(code).toBe(0);
      expect(server.calls).toEqual([{ method: "POST", path: "/question/que_1/reject?directory=%2Fw", body: undefined }]);
      expect(logged[0]).toBe("question que_1 in ses_1 rejected");
    } finally {
      server.stop();
    }
  });

  test("replies to a permission request", async () => {
    const server = startFakeServer({ permissions: [PERMISSION] });
    try {
      const { code, logged, error } = await runAnswer(server, ["per_1", "--reply", "always", "--dir", "/w"]);
      expect(error).toBeUndefined();
      expect(code).toBe(0);
      expect(server.calls).toEqual([
        { method: "POST", path: "/permission/per_1/reply?directory=%2Fw", body: { reply: "always" } },
      ]);
      expect(logged[0]).toBe("permission per_1 in ses_1: always");
    } finally {
      server.stop();
    }
  });

  test("passes --message with a rejection and prints the follow-up hint", async () => {
    const server = startFakeServer({ permissions: [PERMISSION] });
    try {
      const { code, logged, error } = await runAnswer(server, [
        "per_1",
        "--reply",
        "reject",
        "--message",
        "no, use rg instead",
        "--dir",
        "/w",
      ]);
      expect(error).toBeUndefined();
      expect(code).toBe(0);
      expect(server.calls).toEqual([
        {
          method: "POST",
          path: "/permission/per_1/reply?directory=%2Fw",
          body: { reply: "reject", message: "no, use rg instead" },
        },
      ]);
      expect(logged).toEqual([
        "permission per_1 in ses_1: reject",
        "a rejected permission request ends the turn of the agent. Send a follow-up message to continue:",
        `  idfx say ses_1 --dir /w "<what the agent should do instead>"`,
        "watch the session again to follow the rest of the run",
      ]);
    } finally {
      server.stop();
    }
  });

  test("sends a permission reply without a message when --message is absent", async () => {
    const server = startFakeServer({ permissions: [PERMISSION] });
    try {
      const { error } = await runAnswer(server, ["per_1", "--reply", "reject", "--dir", "/w"]);
      expect(error).toBeUndefined();
      expect(server.calls).toEqual([
        { method: "POST", path: "/permission/per_1/reply?directory=%2Fw", body: { reply: "reject" } },
      ]);
    } finally {
      server.stop();
    }
  });

  test("stops with an error when the ID is in neither list", async () => {
    const server = startFakeServer({});
    try {
      const { error } = await runAnswer(server, ["que_missing", "--reject"]);
      expect(error?.message).toContain("no pending request que_missing");
      expect(server.calls).toEqual([]);
    } finally {
      server.stop();
    }
  });

  test("tells the caller when a permission request needs --reply", async () => {
    const server = startFakeServer({ permissions: [PERMISSION] });
    try {
      const { error } = await runAnswer(server, ["per_1", "--reject"]);
      expect(error?.message).toBe(
        "request per_1 is a permission request. Give --reply once, --reply always, or --reply reject",
      );
      expect(server.calls).toEqual([]);
    } finally {
      server.stop();
    }
  });

  test("tells the caller when --reply is used on a question", async () => {
    const server = startFakeServer({ questions: [QUESTION] });
    try {
      const { error } = await runAnswer(server, ["que_1", "--reply", "once"]);
      expect(error?.message).toBe("request que_1 is a question. Give one answer per question, or --reject");
      expect(server.calls).toEqual([]);
    } finally {
      server.stop();
    }
  });

  test("stops with an error when the answer count does not match the questions", async () => {
    const server = startFakeServer({ questions: [QUESTION] });
    try {
      const { error } = await runAnswer(server, ["que_1", "Option A"]);
      expect(error?.message).toContain("request que_1 asks 2 question(s), got 1 answer(s)");
      expect(error?.message).toContain("1. [File] Which file?");
      expect(error?.message).toContain("2. [Dir] Which directory?");
      expect(server.calls).toEqual([]);
    } finally {
      server.stop();
    }
  });

  test("turns a failed list call into a readable error", async () => {
    const server = startFakeServer({ listStatus: 500 });
    try {
      const { error } = await runAnswer(server, ["que_1", "--reject"]);
      expect(error?.message).toContain("list questions: HTTP 500: nope");
    } finally {
      server.stop();
    }
  });
});
