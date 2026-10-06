/**
 * Tests for the top model in src/top/model.ts, with invented events as plain
 * SDK objects. No server and no clock: the tests pass `nowMs` themselves.
 */
import { describe, expect, test } from "bun:test";
import type { Event, Message, Part, Session, SessionStatus } from "@opencode-ai/sdk";
import { createTopModel, type SeedInput, type SessionRow } from "../src/top/model";
import type { PendingRequest, QuestionRequest } from "../src/requests";
import { STALL_MS } from "../src/detect";
import type { MessageEntry } from "../src/summary";

const SERVER = "http://127.0.0.1:8767";
const DIR = "/proj/worktree";
const NOW = 1_000_000;

let counter = 0;

function sessionInfo(overrides: Partial<Session> & { id: string }): Session {
  return {
    projectID: "proj",
    directory: DIR,
    title: `session ${overrides.id}`,
    version: "1.18.32",
    time: { created: 900_000, updated: 900_000 },
    ...overrides,
  } as Session;
}

function sessionEvent(type: string, info: Session): Event {
  return { type, properties: { info } } as unknown as Event;
}

function statusEvent(sessionId: string, status: SessionStatus): Event {
  return { type: "session.status", properties: { sessionID: sessionId, status } } as unknown as Event;
}

function userMessage(sessionId: string, agent: string): Message {
  return {
    id: `msg_user_${++counter}`,
    sessionID: sessionId,
    role: "user",
    time: { created: 900_000 },
    agent,
    model: { providerID: "openrouter", modelID: "z-ai/glm-5.3-flash" },
  } as unknown as Message;
}

function assistantMessage(
  sessionId: string,
  mode: string,
  cost: number,
  tokens: { input: number; output: number; reasoning: number } = { input: 0, output: 0, reasoning: 0 },
): Message {
  return {
    id: `msg_asst_${++counter}`,
    sessionID: sessionId,
    role: "assistant",
    time: { created: 900_000, completed: 901_000 },
    parentID: "msg_user",
    modelID: "glm-5.3-flash",
    providerID: "openrouter",
    mode,
    path: { cwd: DIR, root: DIR },
    cost,
    tokens: { ...tokens, cache: { read: 0, write: 0 } },
  } as unknown as Message;
}

function entry(info: Message, parts: Part[] = []): MessageEntry {
  return { info, parts };
}

function stepFinishPart(sessionId: string, tokens: {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
}, cost: number): Part {
  return {
    id: `part_step_${++counter}`,
    sessionID: sessionId,
    messageID: "msg_asst",
    type: "step-finish",
    reason: "stop",
    cost,
    tokens: { ...tokens, cache: { read: tokens.cacheRead, write: 0 } },
  } as unknown as Part;
}

function partEvent(sessionId: string, part: Part): Event {
  return { type: "message.part.updated", properties: { part } } as unknown as Event;
}

function stepFinishEvent(sessionId: string, tokens: {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
}, cost: number): Event {
  return partEvent(sessionId, stepFinishPart(sessionId, tokens, cost));
}

function toolEvent(sessionId: string, tool: string, input: Record<string, unknown>, status = "completed"): Event {
  return partEvent(sessionId, {
    id: `part_tool_${++counter}`,
    sessionID: sessionId,
    messageID: "msg_asst",
    type: "tool",
    callID: `call_${counter}`,
    tool,
    state: { status, input, time: { start: 1, end: 2 } },
  } as unknown as Part);
}

function askEvent(type: string, sessionId: string, requestId: string): Event {
  return { type, properties: { sessionID: sessionId, id: requestId, title: "Allow rm?" } } as unknown as Event;
}

function replyEvent(type: string, sessionId: string, requestId: string): Event {
  return { type, properties: { sessionID: sessionId, requestID: requestId } } as unknown as Event;
}

function questionRequest(id: string, sessionId: string): PendingRequest {
  return {
    kind: "question",
    request: { id, sessionID: sessionId, questions: [] } as QuestionRequest,
  };
}

function seedOf(
  session: Session,
  messages: MessageEntry[],
  status?: SessionStatus,
  pending: PendingRequest[] = [],
): SeedInput {
  return { session, status, messages, pending };
}

function rowOf(rows: SessionRow[], id: string): SessionRow {
  const row = rows.find((r) => r.sessionId === id);
  if (row === undefined) throw new Error(`no row for ${id}`);
  return row;
}

describe("seed", () => {
  test("computes steps, tool calls, tokens, cost, agent, and context from the messages", () => {
    const model = createTopModel();
    model.seed(SERVER, {
      session: sessionInfo({ id: "ses_main" }),
      messages: [
        entry(userMessage("ses_main", "coder")),
        entry(assistantMessage("ses_main", "build", 0.01, { input: 1000, output: 200, reasoning: 50 }), [
          stepFinishPart("ses_main", { input: 1000, output: 200, reasoning: 50, cacheRead: 400 }, 0.004),
        ]),
        entry(assistantMessage("ses_main", "build", 0.02, { input: 1200, output: 300, reasoning: 80 }), [
          stepFinishPart("ses_main", { input: 1200, output: 300, reasoning: 80, cacheRead: 600 }, 0.006),
        ]),
      ],
      pending: [],
    }, NOW);
    const row = rowOf(model.rows(NOW), "ses_main");
    expect(row.steps).toBe(2);
    expect(row.toolCalls).toBe(0);
    expect(row.cost).toBeCloseTo(0.03);
    expect(row.contextTokens).toBe(1200 + 600);
    expect(row.lastStepReasoning).toBe(80);
    expect(row.agent).toBe("coder");
    expect(row.outputTokens).toBe(500);
    expect(row.reasoningTokens).toBe(130);
    expect(row.state).toBe("idle");
    // A row of a running server always has a process.
    expect(row.active).toBe(true);
    // The last event is the newest message (completed at 901_000), not the
    // seed time and not the older `time.updated`.
    expect(row.msSinceEvent).toBe(NOW - 901_000);
    // An idle session stops its elapsed time at its last event.
    expect(row.elapsedMs).toBe(1_000);
  });

  test("without messages, the elapsed time of an idle session stops at time.updated", () => {
    const model = createTopModel();
    model.seed(SERVER, {
      session: sessionInfo({ id: "ses_idle_el", time: { created: 500_000, updated: 900_000 } }),
      messages: [],
      pending: [],
    }, NOW);
    const row = rowOf(model.rows(NOW), "ses_idle_el");
    expect(row.state).toBe("idle");
    expect(row.elapsedMs).toBe(400_000);
    expect(row.msSinceEvent).toBe(NOW - 900_000);
    // The elapsed time does not grow with nowMs.
    expect(model.rows(NOW + 50_000).find((r) => r.sessionId === "ses_idle_el")?.elapsedMs).toBe(400_000);
  });

  test("a busy session counts its elapsed time until nowMs", () => {
    const model = createTopModel();
    model.seed(SERVER, {
      session: sessionInfo({ id: "ses_busy_el", time: { created: 500_000, updated: 900_000 } }),
      messages: [],
      status: { type: "busy" },
      pending: [],
    }, NOW);
    const row = rowOf(model.rows(NOW), "ses_busy_el");
    expect(row.elapsedMs).toBe(NOW - 500_000);
    expect(model.rows(NOW + 50_000).find((r) => r.sessionId === "ses_busy_el")?.elapsedMs).toBe(NOW + 50_000 - 500_000);
  });

  test("takes the agent from the assistant mode when no user message exists", () => {
    const model = createTopModel();
    model.seed(SERVER, {
      session: sessionInfo({ id: "ses_a" }),
      messages: [entry(assistantMessage("ses_a", "build", 0))],
      pending: [],
    }, NOW);
    expect(rowOf(model.rows(NOW), "ses_a").agent).toBe("build");
  });

  test("keeps the seeded pending requests", () => {
    const model = createTopModel();
    const pending = [questionRequest("qre_seed_1", "ses_p"), questionRequest("qre_seed_2", "ses_p")];
    model.seed(SERVER, {
      session: sessionInfo({ id: "ses_p" }),
      messages: [entry(userMessage("ses_p", "coder"))],
      pending,
    }, NOW);
    const detail = model.session("ses_p");
    expect(detail?.pending).toEqual(pending);
    expect(rowOf(model.rows(NOW), "ses_p").state).toBe("waiting");
  });

  test("a seeded busy session that stays silent can stall from the seed time", () => {
    const model = createTopModel();
    model.seed(SERVER, {
      session: sessionInfo({ id: "ses_seed_stall" }),
      messages: [],
      status: { type: "busy" },
      pending: [],
    }, 0);
    expect(model.tick(STALL_MS - 1000)).toEqual([]);
    expect(rowOf(model.rows(STALL_MS - 1000), "ses_seed_stall").state).toBe("busy");
    expect(model.tick(STALL_MS).some((f) => f.kind === "stall")).toBe(true);
    expect(rowOf(model.rows(STALL_MS), "ses_seed_stall").state).toBe("stalled");
  });

  test("ignores a seeded pending request of another session", () => {
    const model = createTopModel();
    model.seed(SERVER, {
      session: sessionInfo({ id: "ses_own" }),
      messages: [],
      pending: [questionRequest("qre_other", "ses_other")],
    }, NOW);
    expect(model.session("ses_own")?.pending).toEqual([]);
    expect(rowOf(model.rows(NOW), "ses_own").state).toBe("idle");
  });
});

describe("apply", () => {
  test("counts a duplicated step-finish part once and dedupes tool calls", () => {
    const model = createTopModel();
    const step = stepFinishEvent("ses_dup", { input: 10, output: 5, reasoning: 1, cacheRead: 20 }, 0.001);
    model.apply(SERVER, DIR, sessionEvent("session.created", sessionInfo({ id: "ses_dup" })), NOW);
    model.apply(SERVER, DIR, step, NOW);
    model.apply(SERVER, DIR, step, NOW);
    // The first appearance of a call counts, in any state; a later
    // completed event with the same call ID must not count again.
    const running = toolEvent("ses_dup", "read", { filePath: "/x" }, "running");
    const completed = { ...running, properties: { part: { ...(running.properties as { part: { callID: string } }).part, id: "part_tool_later", state: { status: "completed", input: { filePath: "/x" }, time: { start: 1, end: 2 } } } } };
    model.apply(SERVER, DIR, running, NOW);
    model.apply(SERVER, DIR, completed as unknown as Event, NOW);
    const row = rowOf(model.rows(NOW), "ses_dup");
    expect(row.steps).toBe(1);
    expect(row.toolCalls).toBe(1);
    expect(row.cost).toBeCloseTo(0.001);
  });

  test("turns the state to looping after five identical tool calls", () => {
    const model = createTopModel();
    model.apply(SERVER, DIR, sessionEvent("session.created", sessionInfo({ id: "ses_loop" })), NOW);
    model.apply(SERVER, DIR, statusEvent("ses_loop", { type: "busy" }), NOW);
    for (let i = 0; i < 4; i++) {
      model.apply(SERVER, DIR, toolEvent("ses_loop", "read", { filePath: "/x" }), NOW + i);
      expect(model.rows(NOW).find((r) => r.sessionId === "ses_loop")?.state).toBe("busy");
    }
    const findings = model.apply(SERVER, DIR, toolEvent("ses_loop", "read", { filePath: "/x" }), NOW + 4);
    expect(findings.some((f) => f.kind === "loop")).toBe(true);
    expect(rowOf(model.rows(NOW), "ses_loop").state).toBe("looping");
  });

  test("clears the looping state on the next user message", () => {
    const model = createTopModel();
    model.apply(SERVER, DIR, sessionEvent("session.created", sessionInfo({ id: "ses_loop2" })), NOW);
    for (let i = 0; i < 5; i++) model.apply(SERVER, DIR, toolEvent("ses_loop2", "read", { filePath: "/x" }), NOW + i);
    expect(rowOf(model.rows(NOW), "ses_loop2").state).toBe("looping");
    model.apply(SERVER, DIR, { type: "message.updated", properties: { info: userMessage("ses_loop2", "coder") } } as unknown as Event, NOW + 5);
    expect(rowOf(model.rows(NOW), "ses_loop2").state).toBe("idle");
  });

  test("a question turns the state to waiting, and the reply turns it back", () => {
    const model = createTopModel();
    model.apply(SERVER, DIR, sessionEvent("session.created", sessionInfo({ id: "ses_q" })), NOW);
    model.apply(SERVER, DIR, statusEvent("ses_q", { type: "busy" }), NOW);
    model.apply(SERVER, DIR, askEvent("question.asked", "ses_q", "qre_1"), NOW);
    expect(rowOf(model.rows(NOW), "ses_q").state).toBe("waiting");
    expect(model.session("ses_q")?.pending[0]?.kind).toBe("question");
    expect(model.session("ses_q")?.pending[0]?.request.id).toBe("qre_1");
    model.apply(SERVER, DIR, replyEvent("question.replied", "ses_q", "qre_1"), NOW);
    expect(rowOf(model.rows(NOW), "ses_q").state).toBe("busy");
    expect(model.session("ses_q")?.pending).toEqual([]);
  });

  test("a permission request ends on permission.replied", () => {
    const model = createTopModel();
    model.apply(SERVER, DIR, sessionEvent("session.created", sessionInfo({ id: "ses_perm" })), NOW);
    model.apply(SERVER, DIR, askEvent("permission.asked", "ses_perm", "req_1"), NOW);
    expect(rowOf(model.rows(NOW), "ses_perm").state).toBe("waiting");
    expect(model.session("ses_perm")?.pending[0]?.kind).toBe("permission");
    model.apply(SERVER, DIR, replyEvent("permission.replied", "ses_perm", "req_1"), NOW);
    expect(rowOf(model.rows(NOW), "ses_perm").state).toBe("idle");
  });

  test("session.status sets retry and session.idle sets idle", () => {
    const model = createTopModel();
    model.apply(SERVER, DIR, sessionEvent("session.created", sessionInfo({ id: "ses_st" })), NOW);
    model.apply(SERVER, DIR, statusEvent("ses_st", { type: "retry", attempt: 2, message: "rate limit", next: NOW }), NOW);
    expect(rowOf(model.rows(NOW), "ses_st").state).toBe("retry");
    model.apply(SERVER, DIR, { type: "session.idle", properties: { sessionID: "ses_st" } } as unknown as Event, NOW);
    expect(rowOf(model.rows(NOW), "ses_st").state).toBe("idle");
  });

  test("a busy session with too many reasoning tokens in its last step is reasoning", () => {
    const model = createTopModel({ reasoningLimit: 100 });
    model.apply(SERVER, DIR, sessionEvent("session.created", sessionInfo({ id: "ses_r" })), NOW);
    model.apply(SERVER, DIR, statusEvent("ses_r", { type: "busy" }), NOW);
    model.apply(SERVER, DIR, stepFinishEvent("ses_r", { input: 10, output: 5, reasoning: 101, cacheRead: 0 }, 0.001), NOW);
    expect(rowOf(model.rows(NOW), "ses_r").state).toBe("reasoning");
    // A later step under the limit ends the state.
    model.apply(SERVER, DIR, stepFinishEvent("ses_r", { input: 10, output: 5, reasoning: 100, cacheRead: 0 }, 0.001), NOW);
    expect(rowOf(model.rows(NOW), "ses_r").state).toBe("busy");
    model.apply(SERVER, DIR, stepFinishEvent("ses_r", { input: 10, output: 5, reasoning: 500, cacheRead: 0 }, 0.001), NOW);
    // An idle session has finished its step, so it is not reasoning.
    model.apply(SERVER, DIR, { type: "session.idle", properties: { sessionID: "ses_r" } } as unknown as Event, NOW);
    expect(rowOf(model.rows(NOW), "ses_r").state).toBe("idle");
  });

  test("session.deleted removes the row", () => {
    const model = createTopModel();
    model.apply(SERVER, DIR, sessionEvent("session.created", sessionInfo({ id: "ses_del" })), NOW);
    expect(model.rows(NOW)).toHaveLength(1);
    model.apply(SERVER, DIR, sessionEvent("session.deleted", sessionInfo({ id: "ses_del" })), NOW);
    expect(model.rows(NOW)).toHaveLength(0);
  });

  test("ignores an unknown event without an error", () => {
    const model = createTopModel();
    expect(() => model.apply(SERVER, DIR, { type: "file.watcher.updated", properties: { file: "/x", event: "add" } } as unknown as Event, NOW)).not.toThrow();
    expect(() => model.apply(SERVER, DIR, { type: "totally.unknown", properties: {} } as unknown as Event, NOW)).not.toThrow();
    expect(model.rows(NOW)).toHaveLength(0);
  });
});

describe("tick", () => {
  test("marks a busy session as stalled after the stall time", () => {
    const model = createTopModel();
    model.apply(SERVER, DIR, sessionEvent("session.created", sessionInfo({ id: "ses_stall" })), 0);
    model.apply(SERVER, DIR, statusEvent("ses_stall", { type: "busy" }), 0);
    model.apply(SERVER, DIR, toolEvent("ses_stall", "read", { filePath: "/x" }), 0);
    expect(model.tick(STALL_MS - 1000)).toEqual([]);
    expect(rowOf(model.rows(STALL_MS - 1000), "ses_stall").state).toBe("busy");
    const findings = model.tick(STALL_MS);
    expect(findings.some((f) => f.kind === "stall")).toBe(true);
    expect(rowOf(model.rows(STALL_MS), "ses_stall").state).toBe("stalled");
  });

  test("clears the stall when a new event arrives", () => {
    const model = createTopModel();
    model.apply(SERVER, DIR, sessionEvent("session.created", sessionInfo({ id: "ses_stall2" })), 0);
    model.apply(SERVER, DIR, statusEvent("ses_stall2", { type: "busy" }), 0);
    model.apply(SERVER, DIR, toolEvent("ses_stall2", "read", { filePath: "/x" }), 0);
    model.tick(STALL_MS);
    model.apply(SERVER, DIR, toolEvent("ses_stall2", "read", { filePath: "/y" }), STALL_MS);
    expect(rowOf(model.rows(STALL_MS), "ses_stall2").state).toBe("busy");
  });
});

describe("rows", () => {
  test("counts the child session in the parent row, but shows no row for the child", () => {
    const model = createTopModel();
    model.seed(SERVER, {
      session: sessionInfo({ id: "ses_parent" }),
      messages: [
        entry(userMessage("ses_parent", "researcher")),
        entry(assistantMessage("ses_parent", "build", 0.01, { input: 100, output: 10, reasoning: 5 }), [
          stepFinishPart("ses_parent", { input: 100, output: 10, reasoning: 5, cacheRead: 0 }, 0.004),
        ]),
      ],
      pending: [],
    }, NOW);
    model.apply(SERVER, DIR, sessionEvent("session.created", sessionInfo({ id: "ses_child", parentID: "ses_parent" })), NOW);
    model.apply(SERVER, DIR, stepFinishEvent("ses_child", { input: 0, output: 20, reasoning: 10, cacheRead: 0 }, 0.006), NOW);

    const rows = model.rows(NOW);
    expect(rows).toHaveLength(1);
    const row = rowOf(rows, "ses_parent");
    expect(row.steps).toBe(2);
    expect(row.cost).toBeCloseTo(0.016, 3);
    expect(row.outputTokens).toBe(30);
    expect(row.reasoningTokens).toBe(15);
    expect(row.contextTokens).toBe(100);
    expect(row.lastStepReasoning).toBe(5);
    expect(row.reasoningShare).toBeCloseTo(15 / 45);
    expect(row.agent).toBe("researcher");
    expect(row.server).toBe(SERVER);
    expect(row.directory).toBe(DIR);
    const child = model.session("ses_parent")?.children[0];
    expect(child?.sessionId).toBe("ses_child");
    expect(child?.cost).toBeCloseTo(0.006);
  });

  test("orders the rows newest first", () => {
    const model = createTopModel();
    model.apply(SERVER, DIR, sessionEvent("session.created", sessionInfo({ id: "ses_old", time: { created: 100, updated: 100 } })), NOW);
    model.apply(SERVER, DIR, sessionEvent("session.created", sessionInfo({ id: "ses_new", time: { created: 200, updated: 200 } })), NOW);
    expect(model.rows(NOW).map((r) => r.sessionId)).toEqual(["ses_new", "ses_old"]);
  });
});

describe("session", () => {
  test("returns undefined for an unknown session", () => {
    const model = createTopModel();
    expect(model.session("ses_nope")).toBeUndefined();
  });

  test("returns the log lines oldest first and keeps only the last ones", () => {
    const model = createTopModel({ logLines: 3 });
    model.apply(SERVER, DIR, sessionEvent("session.created", sessionInfo({ id: "ses_log" })), NOW);
    for (let i = 0; i < 5; i++) {
      model.apply(SERVER, DIR, toolEvent("ses_log", "read", { filePath: `/f${i}` }), NOW + i);
    }
    const detail = model.session("ses_log");
    expect(detail?.log).toHaveLength(3);
    expect(detail?.log.map((line) => line.line)).toEqual([
      "tool read: /f2",
      "tool read: /f3",
      "tool read: /f4",
    ]);
  });

  test("puts a descendant loop on the parent row and shows the child in the tree", () => {
    const model = createTopModel();
    model.apply(SERVER, DIR, sessionEvent("session.created", sessionInfo({ id: "ses_top" })), NOW);
    model.apply(SERVER, DIR, sessionEvent("session.created", sessionInfo({ id: "ses_kid", parentID: "ses_top" })), NOW);
    for (let i = 0; i < 5; i++) {
      model.apply(SERVER, DIR, toolEvent("ses_kid", "bash", { command: "bun test" }), NOW + i);
    }
    expect(rowOf(model.rows(NOW), "ses_top").state).toBe("looping");
    const detail = model.session("ses_top");
    expect(detail?.children.map((c) => c.sessionId)).toEqual(["ses_kid"]);
    expect(model.session("ses_kid")).toBeDefined();
  });

  test("a waiting child session makes the parent wait", () => {
    const model = createTopModel();
    model.apply(SERVER, DIR, sessionEvent("session.created", sessionInfo({ id: "ses_top2" })), NOW);
    model.apply(SERVER, DIR, sessionEvent("session.created", sessionInfo({ id: "ses_kid2", parentID: "ses_top2" })), NOW);
    model.apply(SERVER, DIR, askEvent("question.asked", "ses_kid2", "qre_2"), NOW);
    expect(rowOf(model.rows(NOW), "ses_top2").state).toBe("waiting");
  });

  test("keeps the tool call IDs of the seed, so later repeated events do not count twice", () => {
    const model = createTopModel();
    const toolPart = {
      id: "part_seed_tool",
      sessionID: "ses_seed",
      messageID: "msg_seed",
      type: "tool",
      callID: "call_seed",
      tool: "read",
      state: { status: "completed", input: { filePath: "/x" }, time: { start: 1, end: 2 } },
    } as unknown as Part;
    model.seed(SERVER, {
      session: sessionInfo({ id: "ses_seed" }),
      messages: [entry(assistantMessage("ses_seed", "build", 0), [toolPart])],
      pending: [],
    }, NOW);
    expect(rowOf(model.rows(NOW), "ses_seed").toolCalls).toBe(1);
    // A late replay of the same call through the event stream stays at one.
    model.apply(SERVER, DIR, partEvent("ses_seed", toolPart), NOW);
    expect(rowOf(model.rows(NOW), "ses_seed").toolCalls).toBe(1);
  });
});
