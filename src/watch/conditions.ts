/**
 * The conditions of `idfx watch --all`. Design: docs/design/idfx-watch.md,
 * section 3.
 *
 * This module is pure. From the rows of one poll, the clock, and the state of
 * the poll before, `evaluate` computes the new state and the edges: each
 * condition of a session that changed between True and False. The watcher
 * writes one event for each edge, not one for each poll.
 *
 * The state is keyed by condition and full session ID, so two sessions with
 * the same name stay apart. The `subject` of an event is the session name, or
 * the first 8 characters of the session ID.
 *
 * Privacy: `message` holds only the waiting reason text, the cut error text,
 * the first problem line of `handover check`, or numbers. It never holds a
 * prompt.
 */
import type { SessionRowState } from "../top/model";

/** The six condition types. */
export type ConditionType =
  | "SessionWaitsForUser"
  | "SessionStalled"
  | "ContextHigh"
  | "HandoverFailed"
  | "ApiError"
  | "SessionUnnamed";

export const CONDITION_TYPES: readonly ConditionType[] = [
  "SessionWaitsForUser",
  "SessionStalled",
  "ContextHigh",
  "HandoverFailed",
  "ApiError",
  "SessionUnnamed",
];

export type SeverityText = "INFO" | "WARN" | "ERROR";

/** The severity of an event, in the OpenTelemetry numbers. */
export type Severity = { text: SeverityText; number: number };

export const INFO: Severity = { text: "INFO", number: 9 };
export const WARN: Severity = { text: "WARN", number: 13 };
export const ERROR: Severity = { text: "ERROR", number: 17 };

/** The severity of the True event of each condition. A False event is always INFO. */
export const TRUE_SEVERITY: Record<ConditionType, Severity> = {
  SessionWaitsForUser: WARN,
  SessionStalled: WARN,
  ContextHigh: WARN,
  HandoverFailed: WARN,
  ApiError: ERROR,
  SessionUnnamed: INFO,
};

/** A waiting session gives an event after this time. */
export const WAIT_THRESHOLD_MS = 10 * 60 * 1000;
/** A busy session without transcript growth gives an event after this time. */
export const STALL_THRESHOLD_MS = 15 * 60 * 1000;
/** The share of the model window above which the context is high. */
export const CONTEXT_THRESHOLD = 0.5;
/** The longest text in `message`. */
export const MESSAGE_LENGTH = 200;

/** The reason of a False event while the session still shows. */
export const REASON_CLEARED = "Cleared";
/** The reason of a False event when the session left the source. */
export const REASON_GONE = "SessionGone";

/** The fields of one Claude row that the conditions read. `ClaudeRow` of `src/claude/rows.ts` has them all. */
export type WatchRow = {
  sessionId: string;
  name: string | undefined;
  directory: string;
  kind: string;
  state: SessionRowState;
  /** Whether a live process belongs to the session. */
  live: boolean;
  waitingFor: string | undefined;
  waitingSource: "session" | "job" | undefined;
  stateSinceMs: number | undefined;
  lastActivityMs: number | undefined;
  transcriptGrowthMs: number | undefined;
  contextTokens: number;
  contextWindow: number | undefined;
  apiErrors: number;
  lastApiErrorText: string | undefined;
  lastApiErrorMs: number | undefined;
};

/** The last known value of one condition of one session. */
export type ConditionRecord = {
  condition: ConditionType;
  status: "True" | "False";
  reason: string;
  message: string;
  /** The time of the last change of `status`, in ms. */
  lastTransitionMs: number;
  session: string;
  subject: string;
  cwd: string;
  kind: string;
};

/** One change of a condition. The watcher writes one event for it. */
export type Edge = ConditionRecord & { severity: Severity };

/** What the watcher remembers of a session from the poll before. */
type SeenSession = { state: SessionRowState; apiErrors: number };

export type WatchState = {
  /** The records by `conditionKey`. */
  conditions: Map<string, ConditionRecord>;
  /** The sessions of the poll before. Empty after a restart. */
  sessions: Map<string, SeenSession>;
  /**
   * The time up to which the watcher saw the files: the time of the poll
   * before, or after a restart the time of the last event in the log. An
   * error line or an end of a session after it is new.
   */
  watermarkMs: number;
};

/** The result of `handover check <cwd>`: the exit code and the first problem line. */
export type HandoverResult = { code: number; firstLine: string | undefined };

export type HandoverCheck = (cwd: string) => HandoverResult;

export const conditionKey = (condition: ConditionType, session: string): string => `${condition}\u0000${session}`;

/** The subject of a session: its name, else the first 8 characters of its ID. */
export function subjectOf(row: { name: string | undefined; sessionId: string }): string {
  return row.name ?? row.sessionId.slice(0, 8);
}

/** A new state, for example at the first start. */
export function emptyState(watermarkMs: number): WatchState {
  return { conditions: new Map(), sessions: new Map(), watermarkMs };
}

/** The state after a restart: the last record of each condition and session from the log, and the time of the last event. */
export function restoreState(records: readonly ConditionRecord[], watermarkMs: number): WatchState {
  const state = emptyState(watermarkMs);
  for (const record of records) state.conditions.set(conditionKey(record.condition, record.session), record);
  return state;
}

const cut = (text: string): string => text.trim().slice(0, MESSAGE_LENGTH);

const minutes = (ms: number): number => Math.floor(ms / 60_000);

/** The reason of a wait that the user ends with an answer, a choice, or an approval (MCP task status, A2A `TASK_STATE_INPUT_REQUIRED`). */
export const INPUT_REQUIRED = "input_required";
/** The reason of a wait for a login or a new key (A2A `TASK_STATE_AUTH_REQUIRED`). */
export const AUTH_REQUIRED = "auth_required";

/** The two reasons of `SessionWaitsForUser`, from tool protocol v0 (meta `docs/research/tool-protocol.md`, section 1). */
export type WaitReason = typeof INPUT_REQUIRED | typeof AUTH_REQUIRED;

/**
 * The fixed `waitingFor` texts of an interactive session. Claude Code
 * 2.1.285 sets `waitingFor` to one of these, or to the title of a
 * permission dialog (research `docs/research/claude-session-sources.md`,
 * section 2). All of them are `input_required`; the text goes into the
 * message as the kind of wait.
 */
export const FIXED_WAIT_TEXTS: readonly string[] = ["input needed", "dialog open", "sandbox request", "worker request"];

/**
 * A text that asks for a login or a new key. The research names no
 * `waitingFor` value for a login, so no fixed text means `auth_required`.
 * We match the text instead: an HTTP 401, the `/login` command, a failed or
 * required authentication, or an invalid or expired key or token. The words
 * must stand as a phrase, so a permission dialog for a file `login.ts` does
 * not match.
 */
export const AUTH_TEXT =
  /\b401\b|(^|\s)\/login\b|\bnot logged in\b|\blog ?in (is )?(required|needed)\b|\bauthentication (failed|required|error)\b|\b(invalid|expired) (api |oauth )?(key|token)\b|\b(key|token) (has )?expired\b/i;

/** The suffix of the message of `SessionWaitsForUser`, after the kind of wait. */
const waitSuffix = (min: number): string => `, waits for the user since ${min} min`;

/**
 * The reason of a wait: `auth_required` when the waiting text asks for a
 * login or a key (`AUTH_TEXT`), else `input_required`. This covers a
 * permission dialog, a question, the fixed texts, a blocked job, and a wait
 * without a text.
 */
export function waitReason(row: Pick<WatchRow, "waitingFor" | "waitingSource">): WaitReason {
  return AUTH_TEXT.test(row.waitingFor ?? "") ? AUTH_REQUIRED : INPUT_REQUIRED;
}

/**
 * The kind of a wait for humans, the first part of the message. For
 * example `permission dialog: Bash permission`, `input needed`,
 * `blocked job: approve the push`, `login needed: Please run /login`, or
 * `unknown wait`.
 */
export function waitKind(row: Pick<WatchRow, "waitingFor" | "waitingSource">): string {
  const text = (row.waitingFor ?? "").trim();
  if (row.waitingSource === "job") return text.length === 0 ? "blocked job" : `blocked job: ${text}`;
  if (text.length === 0) return "unknown wait";
  if (AUTH_TEXT.test(text)) return `login needed: ${text}`;
  if (FIXED_WAIT_TEXTS.includes(text.toLowerCase())) return text.toLowerCase();
  return `permission dialog: ${text}`;
}

/**
 * The kind of wait from a message of `SessionWaitsForUser`: the message
 * without its suffix. A message in another form comes back whole.
 */
export function waitKindOfMessage(message: string): string {
  return message.replace(/, waits for the user since \d+ min$/, "");
}

/** The reason of an API error from its text (design section 3). */
export function apiErrorReason(text: string): string {
  if (/usage limit|rate limit/i.test(text)) return "UsageLimit";
  if (/\b401\b|\b403\b|login|authentication/i.test(text)) return "AuthError";
  return "ApiError";
}

/** A wanted value of a condition: True with a reason and a message, or False. */
type Wanted = { status: "True"; reason: string; message: string } | { status: "False" };

const FALSE: Wanted = { status: "False" };

function waitsForUser(row: WatchRow, nowMs: number): Wanted {
  if (row.state !== "waiting") return FALSE;
  const since = row.stateSinceMs ?? row.lastActivityMs;
  if (since === undefined || nowMs - since <= WAIT_THRESHOLD_MS) return FALSE;
  const suffix = waitSuffix(minutes(nowMs - since));
  const kind = cut(waitKind(row)).slice(0, MESSAGE_LENGTH - suffix.length).trim();
  return { status: "True", reason: waitReason(row), message: `${kind}${suffix}` };
}

function stalled(row: WatchRow, nowMs: number): Wanted {
  if (row.state !== "busy") return FALSE;
  const since = row.transcriptGrowthMs ?? row.stateSinceMs;
  if (since === undefined || nowMs - since <= STALL_THRESHOLD_MS) return FALSE;
  return { status: "True", reason: "NoTranscriptGrowth", message: `no transcript growth for ${minutes(nowMs - since)} min` };
}

function contextHigh(row: WatchRow): Wanted {
  if (row.state === "ended") return FALSE;
  const window = row.contextWindow;
  if (window === undefined || window <= 0) return FALSE;
  const share = row.contextTokens / window;
  if (share <= CONTEXT_THRESHOLD) return FALSE;
  return {
    status: "True",
    reason: "OverHalfWindow",
    message: `context ${Math.round(share * 100)}% of ${window} tokens`,
  };
}

function apiError(row: WatchRow, seen: SeenSession | undefined, watermarkMs: number): Wanted {
  const newLine =
    seen === undefined
      ? row.lastApiErrorMs !== undefined && row.lastApiErrorMs > watermarkMs
      : row.apiErrors > seen.apiErrors;
  if (newLine) {
    const text = row.lastApiErrorText ?? "API error";
    return { status: "True", reason: apiErrorReason(text), message: cut(text) };
  }
  if (row.state === "waiting" && row.waitingFor !== undefined && /API Error/i.test(row.waitingFor)) {
    return { status: "True", reason: apiErrorReason(row.waitingFor), message: cut(row.waitingFor) };
  }
  return FALSE;
}

function unnamed(row: WatchRow): Wanted {
  if (!row.live || row.name !== undefined) return FALSE;
  return { status: "True", reason: "NoName", message: "" };
}

/**
 * `HandoverFailed`: `handover check` runs only at the edge to `ended`. A
 * session that the watcher saw before and that was not ended has the edge.
 * A session that it sees for the first time has the edge when its last
 * activity is after the watermark (it ended while the watcher was down).
 * Without the edge, the old value stays. Exit code 2 (or another code)
 * gives no change.
 */
function handoverFailed(
  row: WatchRow,
  seen: SeenSession | undefined,
  old: ConditionRecord | undefined,
  watermarkMs: number,
  check: HandoverCheck,
): Wanted | undefined {
  if (row.state !== "ended") return FALSE;
  const edge =
    seen === undefined
      ? row.lastActivityMs !== undefined && row.lastActivityMs > watermarkMs
      : seen.state !== "ended";
  if (!edge) return undefined;
  const result = check(row.directory);
  if (result.code === 1) {
    return { status: "True", reason: "HandoverCheckFailed", message: cut(result.firstLine ?? "handover check failed") };
  }
  if (result.code === 0 && old?.status === "True") return FALSE;
  return undefined;
}

/**
 * One poll: the new state and the edges, in the order of the rows and then
 * of `CONDITION_TYPES`. `check` runs `handover check` and is only called at
 * the edge of a session to `ended`. The old state is not changed.
 */
export function evaluate(
  old: WatchState,
  rows: readonly WatchRow[],
  nowMs: number,
  check: HandoverCheck,
): { state: WatchState; edges: Edge[] } {
  const conditions = new Map(old.conditions);
  const sessions = new Map<string, SeenSession>();
  const edges: Edge[] = [];
  const present = new Set<string>();

  const apply = (row: WatchRow, condition: ConditionType, wanted: Wanted | undefined): void => {
    const key = conditionKey(condition, row.sessionId);
    const before = conditions.get(key);
    if (wanted === undefined) return;
    const subject = subjectOf(row);
    if (wanted.status === "True") {
      // A True condition that stays True gives no event. It keeps its old message.
      if (before?.status === "True") {
        conditions.set(key, { ...before, subject, cwd: row.directory, kind: row.kind });
        return;
      }
      const record: ConditionRecord = {
        condition,
        status: "True",
        reason: wanted.reason,
        message: wanted.message,
        lastTransitionMs: nowMs,
        session: row.sessionId,
        subject,
        cwd: row.directory,
        kind: row.kind,
      };
      conditions.set(key, record);
      edges.push({ ...record, severity: TRUE_SEVERITY[condition] });
      return;
    }
    if (before?.status !== "True") return;
    const record: ConditionRecord = {
      ...before,
      status: "False",
      reason: REASON_CLEARED,
      message: "",
      lastTransitionMs: nowMs,
      subject,
      cwd: row.directory,
      kind: row.kind,
    };
    conditions.set(key, record);
    edges.push({ ...record, severity: INFO });
  };

  for (const row of rows) {
    if (present.has(row.sessionId)) continue;
    present.add(row.sessionId);
    const seen = old.sessions.get(row.sessionId);
    const oldHandover = conditions.get(conditionKey("HandoverFailed", row.sessionId));
    apply(row, "SessionWaitsForUser", waitsForUser(row, nowMs));
    apply(row, "SessionStalled", stalled(row, nowMs));
    apply(row, "ContextHigh", contextHigh(row));
    apply(row, "HandoverFailed", handoverFailed(row, seen, oldHandover, old.watermarkMs, check));
    apply(row, "ApiError", apiError(row, seen, old.watermarkMs));
    apply(row, "SessionUnnamed", unnamed(row));
    sessions.set(row.sessionId, { state: row.state, apiErrors: row.apiErrors });
  }

  // A session that left the source sets its open conditions to False and is forgotten.
  for (const [key, record] of [...conditions]) {
    if (present.has(record.session)) continue;
    conditions.delete(key);
    if (record.status !== "True") continue;
    edges.push({
      ...record,
      status: "False",
      reason: REASON_GONE,
      message: "",
      lastTransitionMs: nowMs,
      severity: INFO,
    });
  }

  return { state: { conditions, sessions, watermarkMs: nowMs }, edges };
}

/** The count of True conditions in a state. */
export function openCount(state: WatchState): number {
  let count = 0;
  for (const record of state.conditions.values()) if (record.status === "True") count += 1;
  return count;
}
