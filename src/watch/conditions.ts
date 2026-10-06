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
 * `SessionHandedOff` is a one-shot condition (`ONE_SHOT_CONDITIONS`): each
 * new commit of `docs/PLAN.md` after a clean `handover check` gives one True
 * event, and the condition never gives a False event. Its record keeps the
 * plan commit, so the same commit gives no second event, also after a
 * restart.
 *
 * Privacy: `message` holds only the waiting reason text, the cut error text,
 * the first problem line of `handover check`, a commit hash, or numbers. It
 * never holds a prompt.
 */
import type { SessionRowState } from "../top/model";

/** The seven condition types. */
export type ConditionType =
  | "SessionWaitsForUser"
  | "SessionStalled"
  | "ContextHigh"
  | "HandoverFailed"
  | "ApiError"
  | "SessionUnnamed"
  | "SessionHandedOff";

export const CONDITION_TYPES: readonly ConditionType[] = [
  "SessionWaitsForUser",
  "SessionStalled",
  "ContextHigh",
  "HandoverFailed",
  "ApiError",
  "SessionUnnamed",
  "SessionHandedOff",
];

/**
 * The one-shot conditions. Each True event reports one new fact (for
 * `SessionHandedOff`: one new plan commit after a clean hand-off). Such a
 * condition gives no False event: not when it stops being true, and not
 * when its session leaves the source. Its record stays in the state as the
 * memory of the last fact. It does not count as an open condition.
 */
export const ONE_SHOT_CONDITIONS: ReadonlySet<ConditionType> = new Set<ConditionType>(["SessionHandedOff"]);

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
  SessionHandedOff: INFO,
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
/** The reason of a True event of `SessionHandedOff`. */
export const REASON_HANDED_OFF = "HandoverCheckPassed";
/** The file whose last commit marks a new hand-off. */
export const PLAN_FILE = "docs/PLAN.md";
/** The reason of `SessionUnnamed` for a live session without a name. */
export const REASON_NO_NAME = "NoName";
/** The reason of `SessionUnnamed` for a live session whose name breaks the naming rule. */
export const REASON_NAME_OFF_RULE = "NameOffRule";
/** The name that is valid in every folder (`~/dv/AGENTS.md`). */
export const SUPERVISOR_NAME = "supervisor";

/** The fields of one Claude row that the conditions read. `ClaudeRow` of `src/claude/rows.ts` has them all. */
export type WatchRow = {
  sessionId: string;
  name: string | undefined;
  directory: string;
  /** The project of the folder, from `projectNameOfRun`. */
  project: string;
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
  /** `SessionHandedOff` only: the hash of the last commit of `docs/PLAN.md` at the True event. */
  planCommit?: string;
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

/**
 * The hash of the last commit that changed `docs/PLAN.md` in a folder
 * (`git log -1 --format=%H -- docs/PLAN.md`), or undefined when git fails or
 * no commit changed the file.
 */
export type PlanCommitReader = (cwd: string) => string | undefined;

/** A reader that never finds a plan commit, so `SessionHandedOff` stays silent. */
export const noPlanCommit: PlanCommitReader = () => undefined;

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
type Wanted = { status: "True"; reason: string; message: string; planCommit?: string } | { status: "False" };

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

/**
 * The naming rule of the user (idfix plan, step 36): a session name is its
 * project, or `<project>-<step>` with a non-empty step. The name
 * `supervisor` is valid in every folder.
 */
export function nameFollowsRule(name: string, project: string): boolean {
  if (name === SUPERVISOR_NAME || name === project) return true;
  const prefix = `${project}-`;
  return name.startsWith(prefix) && name.length > prefix.length;
}

function unnamed(row: WatchRow): Wanted {
  if (!row.live) return FALSE;
  if (row.name === undefined) return { status: "True", reason: REASON_NO_NAME, message: "" };
  if (nameFollowsRule(row.name, row.project)) return FALSE;
  return { status: "True", reason: REASON_NAME_OFF_RULE, message: cut(`expected "${row.project}" or "${row.project}-<step>"`) };
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
  check: () => HandoverResult,
): Wanted | undefined {
  if (row.state !== "ended") return FALSE;
  const edge =
    seen === undefined
      ? row.lastActivityMs !== undefined && row.lastActivityMs > watermarkMs
      : seen.state !== "ended";
  if (!edge) return undefined;
  const result = check();
  if (result.code === 1) {
    return { status: "True", reason: "HandoverCheckFailed", message: cut(result.firstLine ?? "handover check failed") };
  }
  if (result.code === 0 && old?.status === "True") return FALSE;
  return undefined;
}

/** The states in which a session works on a turn. */
const WORKING: ReadonlySet<SessionRowState> = new Set<SessionRowState>(["busy", "waiting"]);
/** The states in which a session has no turn: at its prompt, or without a process. */
const RESTING: ReadonlySet<SessionRowState> = new Set<SessionRowState>(["idle", "ended"]);

/**
 * `SessionHandedOff`: at the edge of a session from `busy` or `waiting` to
 * `idle` or `ended`, `handover check` must exit with 0. Then the last commit
 * of `docs/PLAN.md` must differ from `planCommit` of the old record. A
 * session that the watcher sees for the first time has the edge when it
 * rests and its last activity is after the watermark (it ended a turn while
 * the watcher was down). Exit code 1 here gives no event: a session that
 * waits at its prompt in the middle of a step is not a failure, and
 * `HandoverFailed` keeps its edge to `ended`. Without the edge, or without
 * a new commit, nothing changes (undefined).
 */
function handedOff(
  row: WatchRow,
  seen: SeenSession | undefined,
  old: ConditionRecord | undefined,
  watermarkMs: number,
  check: () => HandoverResult,
  planCommit: PlanCommitReader,
): Wanted | undefined {
  if (!RESTING.has(row.state)) return undefined;
  const edge =
    seen === undefined
      ? row.lastActivityMs !== undefined && row.lastActivityMs > watermarkMs
      : WORKING.has(seen.state);
  if (!edge) return undefined;
  if (check().code !== 0) return undefined;
  const hash = planCommit(row.directory);
  if (hash === undefined || hash.length === 0 || hash === old?.planCommit) return undefined;
  return {
    status: "True",
    reason: REASON_HANDED_OFF,
    message: `handover check passed, plan commit ${hash.slice(0, 12)}`,
    planCommit: hash,
  };
}

/**
 * One poll: the new state and the edges, in the order of the rows and then
 * of `CONDITION_TYPES`. `check` runs `handover check`. It runs at most once
 * per session and poll, and only at the edge to `ended` (`HandoverFailed`)
 * or from `busy` or `waiting` to `idle` or `ended` (`SessionHandedOff`).
 * `planCommit` reads the last commit of `docs/PLAN.md`, only after a clean
 * check at such an edge. The old state is not changed.
 */
export function evaluate(
  old: WatchState,
  rows: readonly WatchRow[],
  nowMs: number,
  check: HandoverCheck,
  planCommit: PlanCommitReader = noPlanCommit,
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
      // A one-shot condition gives an event for each new fact; its function returns True only then.
      if (before?.status === "True" && !ONE_SHOT_CONDITIONS.has(condition)) {
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
        ...(wanted.planCommit === undefined ? {} : { planCommit: wanted.planCommit }),
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
    const oldHandedOff = conditions.get(conditionKey("SessionHandedOff", row.sessionId));
    // One `handover check` per session and poll, shared by both conditions.
    let result: HandoverResult | undefined;
    const checkOnce = (): HandoverResult => (result ??= check(row.directory));
    apply(row, "SessionWaitsForUser", waitsForUser(row, nowMs));
    apply(row, "SessionStalled", stalled(row, nowMs));
    apply(row, "ContextHigh", contextHigh(row));
    apply(row, "HandoverFailed", handoverFailed(row, seen, oldHandover, old.watermarkMs, checkOnce));
    apply(row, "ApiError", apiError(row, seen, old.watermarkMs));
    apply(row, "SessionUnnamed", unnamed(row));
    apply(row, "SessionHandedOff", handedOff(row, seen, oldHandedOff, old.watermarkMs, checkOnce, planCommit));
    sessions.set(row.sessionId, { state: row.state, apiErrors: row.apiErrors });
  }

  // A session that left the source sets its open conditions to False and is forgotten.
  // A one-shot record stays without an event: it is the memory of the last plan commit.
  for (const [key, record] of [...conditions]) {
    if (present.has(record.session)) continue;
    if (ONE_SHOT_CONDITIONS.has(record.condition)) continue;
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

/** The count of True conditions in a state. A one-shot condition is never open. */
export function openCount(state: WatchState): number {
  let count = 0;
  for (const record of state.conditions.values()) {
    if (record.status === "True" && !ONE_SHOT_CONDITIONS.has(record.condition)) count += 1;
  }
  return count;
}
