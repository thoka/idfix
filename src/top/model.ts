/**
 * The model of `idfx top`: a pure reducer that turns server events into
 * one row per session. No UI, no network, no clock: the caller passes
 * `nowMs` with every call, and the events come in as plain SDK objects.
 *
 * Data flow. The data fetch (also of `top --once`) seeds the model once per
 * server with `seed` from the REST data (session, status map, messages,
 * pending requests) and then feeds every `{ directory, payload }` of
 * `GET /global/event` into `apply`. A timer calls `tick` for the stall
 * check, and the view reads `rows` and `session`. `session` has
 * no `nowMs` of its own; it reuses the last `nowMs` that `apply`, `tick`,
 * or `rows` received.
 *
 * The loop, stall, and reasoning findings come from the guard of
 * `src/detect.ts`, which this module feeds with the same events; the logic
 * is not copied here. The cost and token numbers come from the functions of
 * `src/summary.ts`, and the log lines from `watchEventLine` of
 * `src/events.ts`.
 */
import type { Event, Message, Part, Session, SessionStatus } from "@opencode-ai/sdk";
import { createGuard, REASONING_LIMIT, type Finding, type GuardOptions } from "../detect";
import { eventSessionId, watchEventLine, type WatchLine } from "../events";
import type { PendingRequest, PermissionRequest, QuestionRequest } from "../requests";
import {
  addStep,
  addSummaries,
  emptySummary,
  summarizeMessages,
  type MessageEntry,
  type UsageSummary,
} from "../summary";

/**
 * The state of a session, in priority order. `reasoning` means a busy
 * session whose last step used more reasoning tokens than the limit of the
 * guard (`REASONING_LIMIT` of `src/detect.ts`, or `reasoningLimit`).
 */
export type SessionRowState = "waiting" | "looping" | "stalled" | "reasoning" | "retry" | "busy" | "idle" | "ended";

/** The agent program behind a row: an opencode session or a Claude Code session. */
export type SessionDriver = "opencode" | "claude";

/**
 * What the cost of a row means. `real`: the money that the provider charged
 * (opencode). `apiEquivalent`: the API price of the same tokens, not a real
 * charge (a Claude session on a plan). `none`: no price is known for the
 * model, so the cost cell stays empty and `cost` is 0.
 */
export type CostKind = "real" | "apiEquivalent" | "none";

/** One line of the session table: the session and all of its descendants. */
export type SessionRow = {
  sessionId: string;
  server: string;
  directory: string;
  title: string;
  agent: string;
  state: SessionRowState;
  /**
   * Whether a process belongs to the session. An opencode row comes from a
   * running server, so it is active unless it ended. A Claude row is active
   * when its session has a live process (`ClaudeSession.live`). An inactive
   * row only has its description left: a job file or a transcript. `top`
   * sorts the inactive rows last, shows them dim, and can hide them.
   */
  active: boolean;
  /** `time.created` of the session, in ms, or undefined when unknown. */
  startTimeMs: number | undefined;
  elapsedMs: number;
  /** Ms since the last event of the session itself; 0 when unknown. */
  msSinceEvent: number;
  /** Steps, tool calls, tokens, and cost over the session and its descendants. */
  steps: number;
  toolCalls: number;
  /** Input plus cache-read tokens of the last step of the session itself. */
  contextTokens: number;
  cost: number;
  outputTokens: number;
  reasoningTokens: number;
  /** Reasoning divided by output plus reasoning; 0 when both are 0. */
  reasoningShare: number;
  /** Reasoning tokens of the last step of the session itself. */
  lastStepReasoning: number;
  /** The agent program of the session. */
  driver: SessionDriver;
  /** The model id of the last step, when known. */
  model?: string;
  /** The context window of the model in tokens, when known. */
  contextWindow?: number;
  /** What `cost` means. */
  costKind: CostKind;
  /**
   * What a waiting Claude session waits for: `waitingFor` of its session
   * file, or `needs` of its blocked job. It shows as a pending line under
   * the row. Opencode rows keep their pending requests in `SessionDetail`.
   */
  waitingFor?: string;
  /** The kind of a Claude session: started in a terminal, or a background job. */
  kind?: "interactive" | "background";
};

/**
 * Whether a process belongs to the row. A row in the state `ended` is
 * never active, whatever its `active` field says.
 */
export function isActive(row: Pick<SessionRow, "active" | "state">): boolean {
  return row.active && row.state !== "ended";
}

/** One session with its log, its pending requests, and its child sessions. */
export type SessionDetail = SessionRow & {
  log: WatchLine[];
  pending: PendingRequest[];
  children: SessionDetail[];
};

/** The input of `seed`, as the REST endpoints of a server return it. */
export type SeedInput = {
  session: Session;
  /** The entry of the status map, or undefined for an idle session. */
  status?: SessionStatus;
  messages: readonly MessageEntry[];
  /** The pending question and permission requests, from `listPendingRequests`. */
  pending: PendingRequest[];
};

export type TopModelOptions = GuardOptions & {
  /** How many log lines a session detail keeps. Default 20. */
  logLines?: number;
};

type SessionRecord = {
  info: Session | null;
  server: string;
  status: SessionStatus | undefined;
  agent: string | undefined;
  summary: UsageSummary;
  toolCallIds: Set<string>;
  stepPartIds: Set<string>;
  contextTokens: number;
  lastStepReasoning: number;
  lastEventMs: number | undefined;
  looping: boolean;
  stalled: boolean;
  pending: PendingRequest[];
  seen: Set<string>;
  log: WatchLine[];
};

const emptyRecord = (server: string): SessionRecord => ({
  info: null,
  server,
  status: undefined,
  agent: undefined,
  summary: emptySummary(),
  toolCallIds: new Set(),
  stepPartIds: new Set(),
  contextTokens: 0,
  lastStepReasoning: 0,
  lastEventMs: undefined,
  looping: false,
  stalled: false,
  pending: [],
  seen: new Set(),
  log: [],
});

/** The ID that an event carries, either directly or in its `info`. */
function eventId(event: Event): string | undefined {
  const direct = eventSessionId(event);
  if (direct !== undefined) return direct;
  const info = (event.properties as Record<string, unknown> | undefined)?.info as
    | { id?: unknown }
    | undefined;
  return typeof info?.id === "string" ? info.id : undefined;
}

/** The time of the newest message of a session, or its `time.updated` without messages. */
export function lastActivityMs(session: Session, messages: readonly MessageEntry[]): number {
  let latest = session.time.updated;
  for (const { info } of messages) {
    const time = info.role === "assistant" ? (info.time.completed ?? info.time.created) : info.time.created;
    if (time > latest) latest = time;
  }
  return latest;
}

/** The request ID that a replied or rejected event names. */
function requestIdOf(properties: Record<string, unknown>): string {
  for (const key of ["requestID", "permissionID", "id"] as const) {
    const value = properties[key];
    if (typeof value === "string") return value;
  }
  return "";
}

export type TopModel = {
  /**
   * Set or replace one session from the REST data at startup. `nowMs` is
   * the time of the seed; a seeded busy session that stays silent can
   * stall from it.
   */
  seed(server: string, input: SeedInput, nowMs: number): void;
  /** Update the model from one event of the global stream. */
  apply(server: string, directory: string, event: Event, nowMs: number): Finding[];
  /** Run the stall check of the guard over the busy sessions. */
  tick(nowMs: number): Finding[];
  /** The top-level sessions, newest first. */
  rows(nowMs: number): SessionRow[];
  /** One session with its log, its pending requests, and its child tree. */
  session(id: string): SessionDetail | undefined;
};

export function createTopModel(options: TopModelOptions = {}): TopModel {
  const logLines = options.logLines ?? 20;
  const reasoningLimit = options.reasoningLimit ?? REASONING_LIMIT;
  const guard = createGuard(options);
  const sessions = new Map<string, SessionRecord>();
  let lastNowMs = 0;

  const recordOf = (id: string, server: string): SessionRecord => {
    let record = sessions.get(id);
    if (record === undefined) {
      record = emptyRecord(server);
      sessions.set(id, record);
    }
    return record;
  };

  const childrenOf = (id: string): string[] => {
    const children: string[] = [];
    for (const [sessionId, record] of sessions) {
      if (record.info?.parentID === id) children.push(sessionId);
    }
    return children;
  };

  const markLooping = (finding: Finding): void => {
    if (finding.kind !== "loop") return;
    const record = sessions.get(finding.sessionId);
    if (record !== undefined) record.looping = true;
  };

  const markStalled = (finding: Finding): void => {
    if (finding.kind !== "stall") return;
    const record = sessions.get(finding.sessionId);
    if (record !== undefined) record.stalled = true;
  };

  type TreeFlags = { pending: boolean; looping: boolean; stalled: boolean; reasoning: boolean };

  /** Pending, looping, stalled, and reasoning over one session and its descendants. */
  const treeFlags = (id: string): TreeFlags => {
    const record = sessions.get(id);
    if (record === undefined) return { pending: false, looping: false, stalled: false, reasoning: false };
    const working = record.status?.type === "busy" || record.status?.type === "retry";
    const flags = {
      pending: record.pending.length > 0,
      looping: record.looping,
      stalled: record.stalled,
      // Only a working session reasons; an idle one has finished its step.
      reasoning: working && record.lastStepReasoning > reasoningLimit,
    };
    for (const child of childrenOf(id)) {
      const next = treeFlags(child);
      flags.pending ||= next.pending;
      flags.looping ||= next.looping;
      flags.stalled ||= next.stalled;
      flags.reasoning ||= next.reasoning;
    }
    return flags;
  };

  const stateOf = (id: string, status: SessionStatus | undefined): SessionRowState => {
    const flags = treeFlags(id);
    if (flags.pending) return "waiting";
    if (flags.looping) return "looping";
    if (flags.stalled) return "stalled";
    if (flags.reasoning) return "reasoning";
    if (status?.type === "retry") return "retry";
    if (status?.type === "busy") return "busy";
    return "idle";
  };

  /** Steps, tool calls, tokens, and cost over one session and its tree. */
  const treeUsage = (id: string): { summary: UsageSummary; toolCalls: number } => {
    const record = sessions.get(id);
    if (record === undefined) return { summary: emptySummary(), toolCalls: 0 };
    const usage = { summary: { ...record.summary }, toolCalls: record.toolCallIds.size };
    for (const child of childrenOf(id)) {
      const next = treeUsage(child);
      usage.summary = addSummaries(usage.summary, next.summary);
      usage.toolCalls += next.toolCalls;
    }
    return usage;
  };

  const rowOf = (id: string, nowMs: number): SessionRow | undefined => {
    const record = sessions.get(id);
    if (record === undefined) return undefined;
    const startTimeMs = record.info?.time.created;
    const state = stateOf(id, record.status);
    // An idle session no longer works, so its elapsed time stops at its
    // last event. Every other state runs until `nowMs`.
    const lastEvent = record.lastEventMs;
    const elapsedMs =
      state === "idle" && startTimeMs !== undefined && lastEvent !== undefined
        ? Math.max(0, lastEvent - startTimeMs)
        : startTimeMs === undefined
          ? 0
          : Math.max(0, nowMs - startTimeMs);
    const usage = treeUsage(id);
    const output = usage.summary.tokens.output;
    const reasoning = usage.summary.tokens.reasoning;
    return {
      sessionId: id,
      server: record.server,
      directory: record.info?.directory ?? "",
      title: record.info?.title ?? "",
      agent: record.agent ?? "",
      state,
      // The row comes from a running server, so a process belongs to it.
      active: state !== "ended",
      startTimeMs,
      elapsedMs,
      msSinceEvent: record.lastEventMs === undefined ? 0 : Math.max(0, nowMs - record.lastEventMs),
      steps: usage.summary.steps,
      toolCalls: usage.toolCalls,
      contextTokens: record.contextTokens,
      cost: usage.summary.cost,
      outputTokens: output,
      reasoningTokens: reasoning,
      reasoningShare: output + reasoning > 0 ? reasoning / (output + reasoning) : 0,
      lastStepReasoning: record.lastStepReasoning,
      driver: "opencode",
      costKind: "real",
    };
  };

  /** One session with its log, its pending requests, and its child tree. */
  const detailOf = (id: string, nowMs: number): SessionDetail | undefined => {
    const record = sessions.get(id);
    if (record === undefined) return undefined;
    const row = rowOf(id, nowMs);
    if (row === undefined) return undefined;
    return {
      ...row,
      log: [...record.log],
      pending: [...record.pending],
      children: childrenOf(id)
        .map((child) => detailOf(child, nowMs))
        .filter((child): child is SessionDetail => child !== undefined),
    };
  };

  const pushLog = (record: SessionRecord, event: Event): void => {
    const line = watchEventLine(event, record.seen);
    if (line === null) return;
    record.log.push(line);
    if (record.log.length > logLines) record.log.splice(0, record.log.length - logLines);
  };

  const dropPending = (record: SessionRecord, requestId: string): void => {
    const index = record.pending.findIndex((pending) => pending.request.id === requestId);
    if (index >= 0) record.pending.splice(index, 1);
  };

  const applyEvent = (record: SessionRecord, id: string, event: Event, directory: string): void => {
    const properties = event.properties as Record<string, unknown>;
    switch (event.type as string) {
      case "session.created":
      case "session.updated": {
        const info = properties.info as Session | undefined;
        if (info !== undefined) record.info = info;
        break;
      }
      case "session.deleted": {
        sessions.delete(id);
        break;
      }
      case "session.status": {
        const status = properties.status as SessionStatus | undefined;
        if (status !== undefined) record.status = status;
        break;
      }
      case "session.idle": {
        record.status = { type: "idle" };
        break;
      }
      case "message.updated": {
        const message = properties.info as Message | undefined;
        if (message?.role === "user") {
          record.agent = message.agent;
          record.looping = false;
        } else if (message?.role === "assistant" && record.agent === undefined) {
          record.agent = message.mode;
        }
        break;
      }
      case "message.part.updated": {
        const part = properties.part as Part | undefined;
        if (part?.type === "step-finish") {
          // The same part can arrive several times; count each once.
          if (record.stepPartIds.has(part.id)) break;
          record.stepPartIds.add(part.id);
          addStep(record.summary, part);
          record.contextTokens = part.tokens.input + part.tokens.cache.read;
          record.lastStepReasoning = part.tokens.reasoning;
        } else if (part?.type === "tool") {
          // Count each call at its first appearance, in any state, by its
          // call ID. The same rule as `countToolCalls` in src/summary.ts.
          if (!record.toolCallIds.has(part.callID)) record.toolCallIds.add(part.callID);
        }
        break;
      }
      case "question.asked":
      case "permission.asked": {
        // The properties of the asked events are the request itself.
        const request = properties as unknown as QuestionRequest | PermissionRequest;
        const pending: PendingRequest =
          (event.type as string) === "question.asked"
            ? { kind: "question", request: request as QuestionRequest }
            : { kind: "permission", request: request as PermissionRequest };
        record.pending.push(pending);
        break;
      }
      case "question.replied":
      case "question.rejected":
      case "permission.replied": {
        const requestId = requestIdOf(properties);
        dropPending(record, requestId);
        break;
      }
      default:
        break;
    }
  };

  return {
    seed(server, input, nowMs) {
      lastNowMs = nowMs;
      const record = recordOf(input.session.id, server);
      record.info = input.session;
      record.status = input.status;
      record.summary = summarizeMessages(input.messages);
      for (const { parts } of input.messages) {
        for (const part of parts) {
          if (part.type === "tool") record.toolCallIds.add(part.callID);
          if (part.type === "step-finish") {
            record.stepPartIds.add(part.id);
            record.contextTokens = part.tokens.input + part.tokens.cache.read;
            record.lastStepReasoning = part.tokens.reasoning;
          }
        }
      }
      // The agent of the last user message wins; otherwise the mode of the
      // last assistant message.
      for (let i = input.messages.length - 1; i >= 0; i--) {
        const message = input.messages[i]?.info;
        if (message?.role === "user") {
          record.agent = message.agent;
          break;
        }
      }
      if (record.agent === undefined) {
        for (let i = input.messages.length - 1; i >= 0; i--) {
          const message = input.messages[i]?.info;
          if (message?.role === "assistant") {
            record.agent = message.mode;
            break;
          }
        }
      }
      record.pending = input.pending.filter((pending) => pending.request.sessionID === input.session.id);
      // A seeded busy session that stays silent can stall from the seed time.
      if (input.status?.type === "busy" || input.status?.type === "retry") {
        guard.touch(input.session.id, nowMs);
      }
      // The seed is not an event. The last activity of the session is its
      // newest message: `time.updated` of the session changes only with the
      // session object (for example the title), not with every message.
      record.lastEventMs = lastActivityMs(input.session, input.messages);
    },

    apply(server, directory, event, nowMs) {
      lastNowMs = nowMs;
      const id = eventId(event);
      if (id === undefined) return [];
      const record = recordOf(id, server);
      // A part or status event can arrive before its session.created; keep
      // the directory so the row still shows the project.
      record.info ??= {
        id,
        directory,
        projectID: "",
        title: "",
        version: "",
        time: { created: 0, updated: 0 },
      } as Session;
      record.lastEventMs = nowMs;
      record.stalled = false;

      if (event.type === "session.deleted") {
        sessions.delete(id);
        return [];
      }
      applyEvent(record, id, event, directory);

      pushLog(record, event);
      const findings = guard.feed(event, nowMs);
      for (const finding of findings) markLooping(finding);
      return findings;
    },

    tick(nowMs) {
      lastNowMs = nowMs;
      const states: Record<string, SessionStatus> = {};
      for (const [id, record] of sessions) {
        if (record.status?.type === "busy" || record.status?.type === "retry") {
          states[id] = record.status;
        }
      }
      const findings = guard.checkStalls(states, nowMs);
      for (const finding of findings) markStalled(finding);
      return findings;
    },

    rows(nowMs) {
      lastNowMs = nowMs;
      const rows: SessionRow[] = [];
      for (const [id, record] of sessions) {
        const parent = record.info?.parentID;
        if (parent !== undefined && sessions.has(parent)) continue;
        const row = rowOf(id, nowMs);
        if (row !== undefined) rows.push(row);
      }
      return rows.sort((a, b) => (b.startTimeMs ?? 0) - (a.startTimeMs ?? 0));
    },

    session(id) {
      return detailOf(id, lastNowMs);
    },
  };
}
