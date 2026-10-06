import { describe, expect, test } from "bun:test";
import {
  answerHint,
  filterRequests,
  formatRequest,
  listPendingRequests,
  rejectQuestion,
  replyPermission,
  replyQuestion,
  type PendingRequest,
} from "../src/requests";

const QUESTION: PendingRequest = {
  kind: "question",
  request: {
    id: "que_1",
    sessionID: "ses_1",
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
  },
};

const PERMISSION: PendingRequest = {
  kind: "permission",
  request: { id: "per_1", sessionID: "ses_2", permission: "bash", patterns: ["rm *", "git push*"] },
};

describe("filterRequests", () => {
  test("keeps only the requests of the given sessions, in order", () => {
    const other: PendingRequest = {
      kind: "question",
      request: { id: "que_2", sessionID: "ses_other", questions: [] },
    };
    const sessions = new Set(["ses_1", "ses_2"]);
    expect(filterRequests([QUESTION, other, PERMISSION], sessions)).toEqual([QUESTION, PERMISSION]);
  });

  test("returns an empty list for no match and for no input", () => {
    expect(filterRequests([QUESTION], new Set(["ses_x"]))).toEqual([]);
    expect(filterRequests([], new Set(["ses_1"]))).toEqual([]);
  });
});

describe("formatRequest", () => {
  test("prints a question with each question and its options", () => {
    expect(formatRequest(QUESTION)).toEqual([
      "question que_1 in ses_1",
      "  1. [File] Which file should I edit?",
      "     - Option A: the first file",
      "     - Option B: the second file",
    ]);
  });

  test("prints several questions with their number", () => {
    const pending: PendingRequest = {
      kind: "question",
      request: {
        id: "que_3",
        sessionID: "ses_1",
        questions: [
          { question: "First?", header: "One", options: [] },
          { question: "Second?", header: "Two", options: [] },
        ],
      },
    };
    expect(formatRequest(pending)).toEqual([
      "question que_3 in ses_1",
      "  1. [One] First?",
      "  2. [Two] Second?",
    ]);
  });

  test("prints a permission with its type and patterns", () => {
    expect(formatRequest(PERMISSION)).toEqual(["permission per_1 in ses_2", "  bash: rm *, git push*"]);
  });

  test("prints a permission without patterns as the bare type", () => {
    const pending: PendingRequest = {
      kind: "permission",
      request: { id: "per_2", sessionID: "ses_1", permission: "doom_loop", patterns: [] },
    };
    expect(formatRequest(pending)).toEqual(["permission per_2 in ses_1", "  doom_loop"]);
  });
});

describe("answerHint", () => {
  test("names one answer placeholder per question", () => {
    expect(answerHint(QUESTION, "/w")).toBe(
      'answer with: idfx answer que_1 --dir /w "<answer>" (or --reject)',
    );
  });

  test("names a placeholder for each of several questions", () => {
    const pending: PendingRequest = {
      kind: "question",
      request: {
        id: "que_3",
        sessionID: "ses_1",
        questions: [
          { question: "First?", header: "One", options: [] },
          { question: "Second?", header: "Two", options: [] },
        ],
      },
    };
    expect(answerHint(pending, "/w")).toBe(
      'answer with: idfx answer que_3 --dir /w "<answer>" "<answer>" (or --reject)',
    );
  });

  test("names the reply flag for a permission", () => {
    expect(answerHint(PERMISSION, "/w")).toBe(
      "answer with: idfx answer per_1 --dir /w --reply once (or always, or reject)",
    );
  });
});

describe("listPendingRequests", () => {
  function startCaptureServer(respond: (method: string, path: string) => Response | undefined): {
    url: string;
    requests: string[];
    authHeaders: string[];
    stop: () => void;
  } {
    const requests: string[] = [];
    const authHeaders: string[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (request) => {
        const url = new URL(request.url);
        const line = `${request.method} ${url.pathname}${url.search}`;
        requests.push(line);
        authHeaders.push(request.headers.get("Authorization") ?? "");
        const response = respond(request.method, `${url.pathname}${url.search}`);
        return response ?? new Response("not found", { status: 404 });
      },
    });
    return {
      url: `http://127.0.0.1:${server.port}`,
      requests,
      authHeaders,
      stop: () => server.stop(true),
    };
  }

  test("fetches both lists with the directory query and the auth header", async () => {
    const server = startCaptureServer((method, path) => {
      if (method === "GET" && path === "/question?directory=%2Fw") {
        return Response.json([{ id: "que_1", sessionID: "ses_1", questions: [] }]);
      }
      if (method === "GET" && path === "/permission?directory=%2Fw") {
        return Response.json([{ id: "per_1", sessionID: "ses_2", permission: "bash", patterns: ["rm *"] }]);
      }
      return undefined;
    });
    try {
      const pending = await listPendingRequests(server.url, "/w", { OPENCODE_SERVER_PASSWORD: "secret" });
      // The two lists load in parallel, so the arrival order can differ.
      expect([...server.requests].sort()).toEqual([
        "GET /permission?directory=%2Fw",
        "GET /question?directory=%2Fw",
      ]);
      expect(server.authHeaders.every((header) => header.startsWith("Basic "))).toBe(true);
      expect(pending).toEqual([
        { kind: "question", request: { id: "que_1", sessionID: "ses_1", questions: [] } },
        { kind: "permission", request: { id: "per_1", sessionID: "ses_2", permission: "bash", patterns: ["rm *"] } },
      ]);
    } finally {
      server.stop();
    }
  });

  test("turns an error response with a message into a readable error", async () => {
    const server = startCaptureServer((method, path) => {
      if (path.startsWith("/question")) return Response.json({ message: "broken config" }, { status: 500 });
      return Response.json([]);
    });
    try {
      const error = await listPendingRequests(server.url, "/w", {}).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("list questions: HTTP 500: broken config");
    } finally {
      server.stop();
    }
  });
});

describe("reply and reject", () => {
  function startCaptureServer(): {
    url: string;
    calls: Array<{ method: string; path: string; body: unknown }>;
    stop: () => void;
  } {
    const calls: Array<{ method: string; path: string; body: unknown }> = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (request) => {
        const url = new URL(request.url);
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

  test("replyQuestion posts the answers array", async () => {
    const server = startCaptureServer();
    try {
      const ok = await replyQuestion(server.url, "/w", "que_1", [["Option A"], ["free text"]], {});
      expect(ok).toBe(true);
      expect(server.calls).toEqual([
        {
          method: "POST",
          path: "/question/que_1/reply?directory=%2Fw",
          body: { answers: [["Option A"], ["free text"]] },
        },
      ]);
    } finally {
      server.stop();
    }
  });

  test("rejectQuestion posts no body", async () => {
    const server = startCaptureServer();
    try {
      const ok = await rejectQuestion(server.url, "/w", "que_1", {});
      expect(ok).toBe(true);
      expect(server.calls).toEqual([{ method: "POST", path: "/question/que_1/reject?directory=%2Fw", body: undefined }]);
    } finally {
      server.stop();
    }
  });

  test("replyPermission posts the reply value", async () => {
    const server = startCaptureServer();
    try {
      const ok = await replyPermission(server.url, "/w", "per_1", "always", {});
      expect(ok).toBe(true);
      expect(server.calls).toEqual([
        { method: "POST", path: "/permission/per_1/reply?directory=%2Fw", body: { reply: "always" } },
      ]);
    } finally {
      server.stop();
    }
  });
});
