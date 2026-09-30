/**
 * Tests for the data fetch of `oc-sub top`: two fake servers (a host server
 * and a sandbox server through a state file), like the two-server test of
 * test/status.test.ts. The message JSON follows the real opencode output of
 * `GET /session/{id}/message`, with the long texts removed.
 */
import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Message, Part, Session } from "@opencode-ai/sdk";
import { top } from "../src/top/load";
import type { MessageEntry } from "../src/summary";
import type { StatusDeps } from "../src/status";

type FakeSession = { id: string; directory: string; title: string; updated: number; parentID?: string };

type FakeServer = { url: string; port: number; stop: () => void };

const HOST_DIR = "/hostproj";
const SBX_DIR = "/sbxproj";
const MINUTE = 60 * 1000;

/** A fake opencode server for the routes that `top --once` reads. */
function startFakeServer(options: {
  sessions?: FakeSession[];
  states?: Record<string, { type: string }>;
  projects?: Array<{ id: string; worktree: string }>;
  questions?: Array<Record<string, unknown>>;
  permissions?: Array<Record<string, unknown>>;
  messages?: Record<string, MessageEntry[]>;
}): FakeServer {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => {
      const url = new URL(request.url);
      const directory = url.searchParams.get("directory") ?? "";
      if (url.pathname === "/global/health") return Response.json({ healthy: true, version: "1.0.0" });
      if (url.pathname === "/project") return Response.json(options.projects ?? []);
      if (url.pathname === "/question") return Response.json(options.questions ?? []);
      if (url.pathname === "/permission") return Response.json(options.permissions ?? []);
      const messageMatch = /^\/session\/([^/]+)\/message$/.exec(url.pathname);
      if (messageMatch !== null) {
        return Response.json(options.messages?.[messageMatch[1] as string] ?? []);
      }
      if (url.pathname === "/session") {
        return Response.json(
          options.sessions?.filter((session) => session.directory === directory).map(sessionOf) ?? [],
        );
      }
      if (url.pathname === "/session/status") {
        const map: Record<string, unknown> = {};
        for (const session of options.sessions ?? []) {
          const state = options.states?.[session.id];
          if (session.directory === directory && state !== undefined) map[session.id] = state;
        }
        return Response.json(map);
      }
      return new Response("not found", { status: 404 });
    },
  });
  const url = `http://127.0.0.1:${server.port}`;
  return { url, port: Number(new URL(url).port), stop: () => server.stop(true) };
}

function sessionOf(options: FakeSession): Session {
  return {
    id: options.id,
    projectID: "proj",
    directory: options.directory,
    title: options.title,
    version: "1.18.32",
    time: { created: options.updated - MINUTE, updated: options.updated },
    ...(options.parentID === undefined ? {} : { parentID: options.parentID }),
  } as Session;
}

let counter = 0;

function userMessage(sessionId: string, directory: string): MessageEntry {
  const info = {
    id: `msg_user_${++counter}`,
    sessionID: sessionId,
    role: "user",
    time: { created: 1 },
    summary: { diffs: [] },
    agent: "coder",
    model: { providerID: "openrouter", modelID: "z-ai/glm-5.3-flash" },
  } as unknown as Message;
  const part = {
    id: `prt_user_${counter}`,
    sessionID: sessionId,
    messageID: info.id,
    type: "text",
    text: "Do the work.",
  } as unknown as Part;
  return { info, parts: [part] };
}

function assistantMessage(sessionId: string, directory: string, cost: number): MessageEntry {
  const info = {
    id: `msg_asst_${++counter}`,
    sessionID: sessionId,
    role: "assistant",
    time: { created: 2, completed: 3 },
    parentID: `msg_user_${counter - 1}`,
    modelID: "z-ai/glm-5.3-flash",
    providerID: "openrouter",
    mode: "coder",
    agent: "coder",
    path: { cwd: directory, root: directory },
    cost,
    tokens: { total: 6405, input: 4605, output: 65, reasoning: 7, cache: { read: 1728, write: 0 } },
    finish: "tool-calls",
  } as unknown as Message;
  const toolPart = {
    id: `prt_tool_${counter}`,
    sessionID: sessionId,
    messageID: info.id,
    type: "tool",
    callID: `call_${counter}`,
    tool: "read",
    state: { status: "completed", input: { filePath: "/x" }, time: { start: 1, end: 2 } },
  } as unknown as Part;
  const stepFinish = {
    id: `prt_step_${counter}`,
    sessionID: sessionId,
    messageID: info.id,
    type: "step-finish",
    reason: "tool-calls",
    cost,
    tokens: { total: 6405, input: 4605, output: 65, reasoning: 7, cache: { read: 1728, write: 0 } },
  } as unknown as Part;
  return { info, parts: [toolPart, stepFinish] };
}

function messagesOf(sessionId: string, directory: string, cost: number): MessageEntry[] {
  return [userMessage(sessionId, directory), assistantMessage(sessionId, directory, cost)];
}

const testDeps: StatusDeps = { worktreesOf: (directory) => [directory], exists: () => true };

function captureLog(): { lines: string[]; errors: string[]; restore: () => void } {
  const lines: string[] = [];
  const errors: string[] = [];
  const logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map((part) => String(part)).join(" "));
  });
  const errorSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.map((part) => String(part)).join(" "));
  });
  return { lines, errors, restore: () => { logSpy.mockRestore(); errorSpy.mockRestore(); } };
}

/** An empty state home, so `listServers` never reads the real sandbox state files. */
function emptyStateHome(): string {
  return mkdtempSync(path.join(tmpdir(), "oc-sub-top-state-"));
}

describe("top", () => {
  test("--once --json loads both servers, counts the child in its parent, and keeps the pending requests of the tree", async () => {
    const now = Date.now();
    const stateHome = mkdtempSync(path.join(tmpdir(), "oc-sub-top-state-"));
    const host = startFakeServer({
      sessions: [
        { id: "ses_parent", directory: HOST_DIR, title: "Parent run", updated: now - 5 * MINUTE },
        { id: "ses_child", directory: HOST_DIR, title: "Child run", updated: now - 4 * MINUTE, parentID: "ses_parent" },
        { id: "ses_old", directory: HOST_DIR, title: "Old idle run", updated: now - 90 * MINUTE },
      ],
      states: { ses_parent: { type: "busy" }, ses_child: { type: "busy" } },
      projects: [{ id: "p1", worktree: HOST_DIR }],
      questions: [
        {
          id: "que_1",
          sessionID: "ses_parent",
          questions: [{ question: "Delete build/tmp.txt?", header: "Delete file", options: [] }],
        },
      ],
      permissions: [{ id: "per_1", sessionID: "ses_child", permission: "bash", patterns: ["rm -rf build"] }],
      messages: {
        ses_parent: messagesOf("ses_parent", HOST_DIR, 0.004),
        ses_child: messagesOf("ses_child", HOST_DIR, 0.006),
        ses_old: messagesOf("ses_old", HOST_DIR, 0.001),
      },
    });
    const sandbox = startFakeServer({
      sessions: [{ id: "ses_sbx", directory: SBX_DIR, title: "Sandbox run", updated: now - 2 * MINUTE }],
      states: { ses_sbx: { type: "busy" } },
      projects: [{ id: "p2", worktree: SBX_DIR }],
      messages: { ses_sbx: messagesOf("ses_sbx", SBX_DIR, 0.002) },
    });
    try {
      const stateFile = path.join(stateHome, "oc-sub", "sandbox-sbx.json");
      mkdirSync(path.dirname(stateFile), { recursive: true });
      writeFileSync(stateFile, JSON.stringify({ name: "oc-sub-sbx", root: SBX_DIR, port: sandbox.port }));
      const captured = captureLog();
      try {
        const code = await top(
          { all: true, once: true, json: true },
          { XDG_STATE_HOME: stateHome, OC_SUB_URL: host.url },
          testDeps,
        );
        expect(code).toBe(0);
        expect(captured.lines).toHaveLength(1);
        const rows = JSON.parse(captured.lines[0] as string) as Array<{
          sessionId: string;
          directory: string;
          state: string;
          steps: number;
          toolCalls: number;
          cost: number;
          pending: Array<{ kind: string; request: { id: string } }>;
        }>;
        // The old idle session is gone; the parent, its child (hidden in the
        // parent row), and the sandbox session stay.
        expect(rows.map((row) => row.sessionId).sort()).toEqual(["ses_parent", "ses_sbx"]);
        const parent = rows.find((row) => row.sessionId === "ses_parent");
        expect(parent?.directory).toBe(HOST_DIR);
        expect(parent?.state).toBe("waiting");
        expect(parent?.steps).toBe(2);
        expect(parent?.toolCalls).toBe(2);
        expect(parent?.cost).toBeCloseTo(0.01, 3);
        // The row shows the requests of the whole tree: its own question and
        // the permission request of its child session.
        expect(parent?.pending.map((pending) => pending.request.id)).toEqual(["que_1", "per_1"]);
        expect(parent?.pending[0]?.kind).toBe("question");
        expect(parent?.pending[1]?.kind).toBe("permission");
        const sbx = rows.find((row) => row.sessionId === "ses_sbx");
        expect(sbx?.directory).toBe(SBX_DIR);
        expect(sbx?.state).toBe("busy");
        expect(sbx?.cost).toBeCloseTo(0.002, 3);
        expect(captured.errors).toEqual([]);
      } finally {
        captured.restore();
      }
    } finally {
      host.stop();
      sandbox.stop();
      rmSync(stateHome, { recursive: true, force: true });
    }
  });

  test("--once prints a padded table with the pending request lines", async () => {
    const now = Date.now();
    const stateHome = emptyStateHome();
    const host = startFakeServer({
      sessions: [
        { id: "ses_parent", directory: HOST_DIR, title: "Parent run", updated: now - 5 * MINUTE },
        { id: "ses_child", directory: HOST_DIR, title: "Child run", updated: now - 4 * MINUTE, parentID: "ses_parent" },
      ],
      states: { ses_parent: { type: "busy" }, ses_child: { type: "busy" } },
      projects: [{ id: "p1", worktree: HOST_DIR }],
      questions: [
        {
          id: "que_2",
          sessionID: "ses_parent",
          questions: [{ question: "Delete build/tmp.txt?", header: "Delete file", options: [] }],
        },
      ],
      messages: {
        ses_parent: messagesOf("ses_parent", HOST_DIR, 0.004),
        ses_child: messagesOf("ses_child", HOST_DIR, 0.006),
      },
    });
    try {
      const captured = captureLog();
      try {
        const code = await top(
          { all: true, once: true, json: false },
          { XDG_STATE_HOME: stateHome, OC_SUB_URL: host.url },
          testDeps,
        );
        expect(code).toBe(0);
        expect(captured.lines[0]).toMatch(/^session +folder +agent +state +elapsed +last +steps +tools +ctx +cost +reason +title$/);
        expect(captured.lines).toContainEqual(expect.stringContaining("ses_parent"));
        const requestLines = captured.lines.filter((line) => line.startsWith("  "));
        expect(requestLines).toEqual([
          "  question que_2 in ses_parent",
          "    1. [Delete file] Delete build/tmp.txt?",
        ]);
        // Every non-request line starts in the first column, like the header.
        for (const line of captured.lines.slice(1)) {
          if (!line.startsWith(" ")) expect(line.split(/\s{2,}/)[0]).toMatch(/^ses_/);
        }
      } finally {
        captured.restore();
      }
    } finally {
      host.stop();
      rmSync(stateHome, { recursive: true, force: true });
    }
  });

  test("--once prints no sessions when nothing matches", async () => {
    const now = Date.now();
    const stateHome = emptyStateHome();
    const host = startFakeServer({
      sessions: [{ id: "ses_old", directory: HOST_DIR, title: "Old idle run", updated: now - 90 * MINUTE }],
      projects: [{ id: "p1", worktree: HOST_DIR }],
      messages: { ses_old: messagesOf("ses_old", HOST_DIR, 0.001) },
    });
    try {
      const captured = captureLog();
      try {
        const code = await top(
          { all: true, once: true, json: false },
          { XDG_STATE_HOME: stateHome, OC_SUB_URL: host.url },
          testDeps,
        );
        expect(code).toBe(0);
        expect(captured.lines).toEqual(["no sessions"]);
      } finally {
        captured.restore();
      }
    } finally {
      host.stop();
      rmSync(stateHome, { recursive: true, force: true });
    }
  });

  test("--once prints no server and exits with 0 when nothing answers", async () => {
    const stateHome = emptyStateHome();
    const captured = captureLog();
    try {
      const code = await top(
        { all: true, once: true, json: false },
        { XDG_STATE_HOME: stateHome, OC_SUB_URL: "http://127.0.0.1:9" },
        testDeps,
      );
      expect(code).toBe(0);
      expect(captured.lines).toEqual(["no server on http://127.0.0.1:9"]);
    } finally {
      captured.restore();
      rmSync(stateHome, { recursive: true, force: true });
    }
  });

  test("without --once it prints a hint and exits with 2", async () => {
    const stateHome = emptyStateHome();
    const captured = captureLog();
    try {
      const code = await top(
        { all: false, once: false, json: false },
        { XDG_STATE_HOME: stateHome, OC_SUB_URL: "http://127.0.0.1:9" },
        testDeps,
      );
      expect(code).toBe(2);
      expect(captured.errors).toEqual(["oc-sub top: the live view comes in a later step, use --once"]);
      expect(captured.lines).toEqual([]);
    } finally {
      captured.restore();
      rmSync(stateHome, { recursive: true, force: true });
    }
  });
});
