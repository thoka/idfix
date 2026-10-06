import { describe, expect, test } from "bun:test";
import {
  apiErrorReason,
  conditionKey,
  emptyState,
  openCount,
  evaluate,
  MESSAGE_LENGTH,
  nameFollowsRule,
  REASON_NAME_OFF_RULE,
  REASON_NO_NAME,
  restoreState,
  STALL_THRESHOLD_MS,
  WAIT_THRESHOLD_MS,
  waitKind,
  waitKindOfMessage,
  waitReason,
  type ConditionType,
  type Edge,
  type HandoverCheck,
  type WatchRow,
  type WatchState,
} from "../src/watch/conditions";

const T0 = Date.parse("2026-10-06T10:00:00.000Z");
const MIN = 60_000;
const ID = "14930230-7d4a-43c8-8d36-3498b1e09305";

function row(overrides: Partial<WatchRow> = {}): WatchRow {
  return {
    sessionId: ID,
    name: "meta",
    directory: "/home/u/dv/meta",
    project: "meta",
    kind: "interactive",
    state: "idle",
    live: true,
    waitingFor: undefined,
    waitingSource: undefined,
    stateSinceMs: T0,
    lastActivityMs: T0,
    transcriptGrowthMs: T0,
    contextTokens: 1000,
    contextWindow: 200_000,
    apiErrors: 0,
    lastApiErrorText: undefined,
    lastApiErrorMs: undefined,
    ...overrides,
  };
}

const noCheck: HandoverCheck = () => {
  throw new Error("handover check must not run");
};

/** Runs the polls in order and returns the edges of each poll. */
function polls(
  steps: Array<{ atMs: number; rows: WatchRow[] }>,
  options: { state?: WatchState; check?: HandoverCheck } = {},
): { edges: Edge[][]; state: WatchState } {
  let state = options.state ?? emptyState(T0);
  const all: Edge[][] = [];
  for (const step of steps) {
    const result = evaluate(state, step.rows, step.atMs, options.check ?? noCheck);
    state = result.state;
    all.push(result.edges);
  }
  return { edges: all, state };
}

const summary = (edges: Edge[]) => edges.map((edge) => [edge.condition, edge.status, edge.reason]);
const only = (edges: Edge[], condition: ConditionType) => edges.filter((edge) => edge.condition === condition);

describe("SessionWaitsForUser", () => {
  const waiting = row({ state: "waiting", waitingFor: "Bash permission", waitingSource: "session" });

  test("True after 10 minutes, no event while it stays true, False when the wait ends", () => {
    const { edges } = polls([
      { atMs: T0 + WAIT_THRESHOLD_MS, rows: [waiting] },
      { atMs: T0 + WAIT_THRESHOLD_MS + 1, rows: [waiting] },
      { atMs: T0 + 30 * MIN, rows: [waiting] },
      { atMs: T0 + 31 * MIN, rows: [row({ state: "busy", stateSinceMs: T0 + 31 * MIN, transcriptGrowthMs: T0 + 31 * MIN })] },
    ]);
    expect(edges[0]).toEqual([]);
    expect(summary(edges[1] ?? [])).toEqual([["SessionWaitsForUser", "True", "input_required"]]);
    expect(edges[1]?.[0]).toMatchObject({
      severity: { text: "WARN", number: 13 },
      subject: "meta",
      session: ID,
      cwd: "/home/u/dv/meta",
      message: "permission dialog: Bash permission, waits for the user since 10 min",
    });
    expect(edges[2]).toEqual([]);
    expect(summary(edges[3] ?? [])).toEqual([["SessionWaitsForUser", "False", "Cleared"]]);
    expect(edges[3]?.[0]?.severity).toEqual({ text: "INFO", number: 9 });
  });

  test("the reasons of protocol v0: input_required for every wait without a login text", () => {
    for (const waitingFor of ["Bash permission", "Allow edit of src/a.ts?", "Allow edit of src/login.ts?", "input needed", "Dialog open", "sandbox request", " worker request ", "", undefined]) {
      expect(waitReason({ waitingFor, waitingSource: "session" })).toBe("input_required");
    }
    expect(waitReason({ waitingFor: "approve the push", waitingSource: "job" })).toBe("input_required");
  });

  test("the reason auth_required for a login or a key text", () => {
    for (const waitingFor of [
      "Invalid API key · Please run /login",
      "API Error: 401 Unauthorized",
      "OAuth token has expired",
      "Authentication failed",
      "not logged in",
      "login required",
      "expired key",
    ]) {
      expect(waitReason({ waitingFor, waitingSource: "session" })).toBe("auth_required");
    }
    expect(waitReason({ waitingFor: "API Error: 401", waitingSource: "job" })).toBe("auth_required");
  });

  test("the kind of wait for humans", () => {
    expect(waitKind({ waitingFor: "Bash permission", waitingSource: "session" })).toBe("permission dialog: Bash permission");
    expect(waitKind({ waitingFor: "Dialog open", waitingSource: "session" })).toBe("dialog open");
    expect(waitKind({ waitingFor: " worker request ", waitingSource: "session" })).toBe("worker request");
    expect(waitKind({ waitingFor: "approve the push", waitingSource: "job" })).toBe("blocked job: approve the push");
    expect(waitKind({ waitingFor: undefined, waitingSource: "job" })).toBe("blocked job");
    expect(waitKind({ waitingFor: "", waitingSource: "session" })).toBe("unknown wait");
    expect(waitKind({ waitingFor: "Please run /login", waitingSource: "session" })).toBe("login needed: Please run /login");
    expect(waitKindOfMessage("dialog open, waits for the user since 12 min")).toBe("dialog open");
    expect(waitKindOfMessage("other text")).toBe("other text");
  });

  test("a long title is cut, and the message keeps its suffix", () => {
    const long = row({ state: "waiting", waitingFor: "x".repeat(400), waitingSource: "session" });
    const { edges } = polls([{ atMs: T0 + 11 * MIN, rows: [long] }]);
    const message = edges[0]?.[0]?.message ?? "";
    expect(message.length).toBeLessThanOrEqual(200);
    expect(message).toEndWith(", waits for the user since 11 min");
  });

  test("the message holds the waiting text cut to 200 characters", () => {
    const long = row({ state: "waiting", waitingFor: "x".repeat(400), waitingSource: "job" });
    const { edges } = polls([{ atMs: T0 + 20 * MIN, rows: [long] }]);
    expect(edges[0]?.[0]?.message.length).toBe(200);
  });
});

describe("SessionStalled", () => {
  test("True when busy and the transcript did not grow for 15 minutes, False when it grows", () => {
    const busy = row({ state: "busy" });
    const { edges } = polls([
      { atMs: T0 + STALL_THRESHOLD_MS, rows: [busy] },
      { atMs: T0 + STALL_THRESHOLD_MS + 1, rows: [busy] },
      { atMs: T0 + 20 * MIN, rows: [busy] },
      { atMs: T0 + 21 * MIN, rows: [row({ state: "busy", transcriptGrowthMs: T0 + 21 * MIN })] },
    ]);
    expect(edges[0]).toEqual([]);
    expect(summary(edges[1] ?? [])).toEqual([["SessionStalled", "True", "NoTranscriptGrowth"]]);
    expect(edges[1]?.[0]?.message).toBe("no transcript growth for 15 min");
    expect(edges[2]).toEqual([]);
    expect(summary(edges[3] ?? [])).toEqual([["SessionStalled", "False", "Cleared"]]);
  });

  test("an idle session does not stall", () => {
    const { edges } = polls([{ atMs: T0 + 60 * MIN, rows: [row({ state: "idle" })] }]);
    expect(only(edges[0] ?? [], "SessionStalled")).toEqual([]);
  });
});

describe("ContextHigh", () => {
  test("True over 50% of the window, no event while it stays, False when it drops", () => {
    const { edges } = polls([
      { atMs: T0, rows: [row({ contextTokens: 100_000 })] },
      { atMs: T0 + MIN, rows: [row({ contextTokens: 108_000 })] },
      { atMs: T0 + 2 * MIN, rows: [row({ contextTokens: 120_000 })] },
      { atMs: T0 + 3 * MIN, rows: [row({ contextTokens: 20_000 })] },
    ]);
    expect(edges[0]).toEqual([]);
    expect(summary(edges[1] ?? [])).toEqual([["ContextHigh", "True", "OverHalfWindow"]]);
    expect(edges[1]?.[0]?.message).toBe("context 54% of 200000 tokens");
    expect(edges[2]).toEqual([]);
    expect(summary(edges[3] ?? [])).toEqual([["ContextHigh", "False", "Cleared"]]);
  });

  test("no window, no condition", () => {
    const { edges } = polls([{ atMs: T0, rows: [row({ contextTokens: 900_000, contextWindow: undefined })] }]);
    expect(edges[0]).toEqual([]);
  });
});

describe("HandoverFailed", () => {
  const failing: HandoverCheck = () => ({ code: 1, firstLine: "handover: not pushed" });

  test("runs handover check once at the edge to ended, and a failure gives a True event", () => {
    const calls: string[] = [];
    const check: HandoverCheck = (cwd) => {
      calls.push(cwd);
      return failing(cwd);
    };
    const ended = row({ state: "ended", live: false, lastActivityMs: T0 + MIN });
    const { edges } = polls(
      [
        { atMs: T0 + MIN, rows: [row({ state: "busy", transcriptGrowthMs: T0 + MIN })] },
        { atMs: T0 + 2 * MIN, rows: [ended] },
        { atMs: T0 + 3 * MIN, rows: [ended] },
      ],
      { check },
    );
    expect(calls).toEqual(["/home/u/dv/meta"]);
    expect(summary(edges[1] ?? [])).toEqual([["HandoverFailed", "True", "HandoverCheckFailed"]]);
    expect(edges[1]?.[0]?.message).toBe("handover: not pushed");
    expect(edges[2]).toEqual([]);
  });

  test("exit code 2 gives no event, and exit code 0 gives none either", () => {
    for (const code of [0, 2]) {
      const { edges } = polls(
        [
          { atMs: T0 + MIN, rows: [row({ state: "busy", transcriptGrowthMs: T0 + MIN })] },
          { atMs: T0 + 2 * MIN, rows: [row({ state: "ended", live: false })] },
        ],
        { check: () => ({ code, firstLine: undefined }) },
      );
      expect(edges[1]).toEqual([]);
    }
  });

  test("a session that ended before the watermark gives no check at the first poll", () => {
    const { edges } = polls([{ atMs: T0 + 5 * MIN, rows: [row({ state: "ended", live: false, lastActivityMs: T0 - MIN })] }]);
    expect(edges[0]).toEqual([]);
  });

  test("a session that ended after the watermark, while the watcher was down, gets the check", () => {
    const { edges } = polls(
      [{ atMs: T0 + 5 * MIN, rows: [row({ state: "ended", live: false, lastActivityMs: T0 + MIN })] }],
      { check: failing },
    );
    expect(summary(edges[0] ?? [])).toEqual([["HandoverFailed", "True", "HandoverCheckFailed"]]);
  });

  test("False when the session leaves the source", () => {
    const { edges } = polls(
      [
        { atMs: T0 + MIN, rows: [row({ state: "busy", transcriptGrowthMs: T0 + MIN })] },
        { atMs: T0 + 2 * MIN, rows: [row({ state: "ended", live: false })] },
        { atMs: T0 + 70 * MIN, rows: [] },
      ],
      { check: failing },
    );
    expect(summary(edges[2] ?? [])).toEqual([["HandoverFailed", "False", "SessionGone"]]);
  });
});

describe("ApiError", () => {
  test("a new error line gives one True event with severity ERROR, and the next poll without one gives False", () => {
    const { edges } = polls([
      { atMs: T0 + MIN, rows: [row()] },
      {
        atMs: T0 + 2 * MIN,
        rows: [row({ apiErrors: 1, lastApiErrorText: "429 rate limit reached", lastApiErrorMs: T0 + 90_000 })],
      },
      {
        atMs: T0 + 3 * MIN,
        rows: [row({ apiErrors: 1, lastApiErrorText: "429 rate limit reached", lastApiErrorMs: T0 + 90_000 })],
      },
    ]);
    expect(summary(edges[1] ?? [])).toEqual([["ApiError", "True", "UsageLimit"]]);
    expect(edges[1]?.[0]).toMatchObject({ severity: { text: "ERROR", number: 17 }, message: "429 rate limit reached" });
    expect(summary(edges[2] ?? [])).toEqual([["ApiError", "False", "Cleared"]]);
  });

  test("at the first sight of a session, only an error after the watermark is new", () => {
    const old = polls([{ atMs: T0 + MIN, rows: [row({ apiErrors: 3, lastApiErrorText: "x", lastApiErrorMs: T0 - MIN })] }]);
    expect(old.edges[0]).toEqual([]);
    const fresh = polls([{ atMs: T0 + MIN, rows: [row({ apiErrors: 3, lastApiErrorText: "x", lastApiErrorMs: T0 + 1 })] }]);
    expect(summary(fresh.edges[0] ?? [])).toEqual([["ApiError", "True", "ApiError"]]);
  });

  test("the waiting text of a blocked job with API Error is True while the job waits", () => {
    const blocked = row({
      state: "waiting",
      live: false,
      waitingSource: "job",
      waitingFor: "login required · API Error: 403 Key limit exceeded",
      stateSinceMs: T0 + MIN,
    });
    const { edges } = polls([
      { atMs: T0 + 2 * MIN, rows: [blocked] },
      { atMs: T0 + 3 * MIN, rows: [blocked] },
    ]);
    expect(summary(only(edges[0] ?? [], "ApiError"))).toEqual([["ApiError", "True", "AuthError"]]);
    expect(edges[1]).toEqual([]);
  });

  test("the reasons come from the error text", () => {
    expect(apiErrorReason("You have hit your usage limit")).toBe("UsageLimit");
    expect(apiErrorReason("429 rate limit")).toBe("UsageLimit");
    expect(apiErrorReason("401 OAuth access token is invalid.")).toBe("AuthError");
    expect(apiErrorReason("authentication_error")).toBe("AuthError");
    expect(apiErrorReason("please run /login")).toBe("AuthError");
    expect(apiErrorReason("529 overloaded")).toBe("ApiError");
  });
});

describe("SessionUnnamed", () => {
  test("a live session without a name is True with severity INFO, a name makes it False", () => {
    const { edges } = polls([
      { atMs: T0, rows: [row({ name: undefined })] },
      { atMs: T0 + MIN, rows: [row({ name: undefined })] },
      { atMs: T0 + 2 * MIN, rows: [row({ name: "meta" })] },
    ]);
    expect(summary(edges[0] ?? [])).toEqual([["SessionUnnamed", "True", "NoName"]]);
    expect(edges[0]?.[0]).toMatchObject({ subject: ID.slice(0, 8), severity: { text: "INFO", number: 9 } });
    expect(edges[1]).toEqual([]);
    expect(summary(edges[2] ?? [])).toEqual([["SessionUnnamed", "False", "Cleared"]]);
    expect(edges[2]?.[0]?.subject).toBe("meta");
  });

  test("a session without a process is not unnamed", () => {
    const { edges } = polls([{ atMs: T0, rows: [row({ name: undefined, live: false, state: "ended", lastActivityMs: T0 - MIN })] }]);
    expect(edges[0]).toEqual([]);
  });

  test("the project name and <project>-<step> follow the rule", () => {
    for (const name of ["meta", "meta-36", "meta-25g-watch"]) {
      const { edges } = polls([{ atMs: T0, rows: [row({ name })] }]);
      expect(only(edges[0] ?? [], "SessionUnnamed")).toEqual([]);
    }
  });

  test("the name supervisor is valid in every folder", () => {
    const { edges } = polls([{ atMs: T0, rows: [row({ name: "supervisor", directory: "/home/u/dv", project: "dv" })] }]);
    expect(only(edges[0] ?? [], "SessionUnnamed")).toEqual([]);
    expect(nameFollowsRule("supervisor", "idfix")).toBe(true);
  });

  test("a name off the rule is True with reason NameOffRule and the expected form", () => {
    for (const name of ["Step 7c", "glm-3a-start-hook", "meta-"]) {
      const { edges } = polls([{ atMs: T0, rows: [row({ name })] }]);
      const unnamedEdges = only(edges[0] ?? [], "SessionUnnamed");
      expect(summary(unnamedEdges)).toEqual([["SessionUnnamed", "True", REASON_NAME_OFF_RULE]]);
      expect(unnamedEdges[0]?.message).toBe('expected "meta" or "meta-<step>"');
      expect(unnamedEdges[0]?.severity.text).toBe("INFO");
    }
  });

  test("the message stays within MESSAGE_LENGTH for a long project name", () => {
    const project = "p".repeat(300);
    const { edges } = polls([{ atMs: T0, rows: [row({ name: "x", project })] }]);
    expect(only(edges[0] ?? [], "SessionUnnamed")[0]?.message.length).toBeLessThanOrEqual(MESSAGE_LENGTH);
  });

  test("a rename from a name off the rule to a valid name gives False Cleared", () => {
    const { edges } = polls([
      { atMs: T0, rows: [row({ name: "Step 7c" })] },
      { atMs: T0 + MIN, rows: [row({ name: "meta-7c" })] },
    ]);
    expect(summary(only(edges[0] ?? [], "SessionUnnamed"))).toEqual([["SessionUnnamed", "True", REASON_NAME_OFF_RULE]]);
    expect(summary(only(edges[1] ?? [], "SessionUnnamed"))).toEqual([["SessionUnnamed", "False", "Cleared"]]);
  });

  test("an ended session with a name off the rule gives no event", () => {
    const { edges } = polls([{ atMs: T0, rows: [row({ name: "Step 7c", live: false, state: "ended", lastActivityMs: T0 - MIN })] }]);
    expect(edges[0]).toEqual([]);
  });

  test("nameFollowsRule", () => {
    expect(nameFollowsRule("idfix", "idfix")).toBe(true);
    expect(nameFollowsRule("idfix-36", "idfix")).toBe(true);
    expect(nameFollowsRule("idfix-", "idfix")).toBe(false);
    expect(nameFollowsRule("idfix36", "idfix")).toBe(false);
    expect(nameFollowsRule("pac-review", "podcast-autocutter")).toBe(false);
    expect(nameFollowsRule("", "idfix")).toBe(false);
    expect(REASON_NO_NAME).toBe("NoName");
  });
});

describe("SessionHandedOff", () => {
  const HASH_A = "1111111111111111111111111111111111111111";
  const HASH_B = "2222222222222222222222222222222222222222";
  const clean: HandoverCheck = () => ({ code: 0, firstLine: undefined });
  const busy = (atMs: number) => row({ state: "busy", transcriptGrowthMs: atMs, lastActivityMs: atMs });
  const idle = (atMs: number) => row({ state: "idle", lastActivityMs: atMs });
  const ended = (atMs: number) => row({ state: "ended", live: false, lastActivityMs: atMs });

  /** Polls with a counted check and a counted plan commit reader. */
  function run(
    steps: Array<{ atMs: number; rows: WatchRow[] }>,
    options: { check?: HandoverCheck; hash?: () => string | undefined; state?: WatchState } = {},
  ) {
    const checks: string[] = [];
    const reads: string[] = [];
    let state = options.state ?? emptyState(T0);
    const edges: Edge[][] = [];
    for (const step of steps) {
      const result = evaluate(
        state,
        step.rows,
        step.atMs,
        (cwd) => {
          checks.push(cwd);
          return (options.check ?? clean)(cwd);
        },
        (cwd) => {
          reads.push(cwd);
          return (options.hash ?? (() => HASH_A))();
        },
      );
      state = result.state;
      edges.push(result.edges);
    }
    return { edges, checks, reads, state };
  }

  test("the edge from busy to idle with exit code 0 gives one True event with severity INFO and the plan commit", () => {
    const { edges, checks, reads } = run([
      { atMs: T0 + MIN, rows: [busy(T0 + MIN)] },
      { atMs: T0 + 2 * MIN, rows: [idle(T0 + 2 * MIN)] },
      { atMs: T0 + 3 * MIN, rows: [idle(T0 + 2 * MIN)] },
    ]);
    expect(checks).toEqual(["/home/u/dv/meta"]);
    expect(reads).toEqual(["/home/u/dv/meta"]);
    expect(summary(edges[1] ?? [])).toEqual([["SessionHandedOff", "True", "HandoverCheckPassed"]]);
    expect(edges[1]?.[0]).toMatchObject({
      severity: { text: "INFO", number: 9 },
      planCommit: HASH_A,
      message: "handover check passed, plan commit 111111111111",
      subject: "meta",
    });
    expect(edges[2]).toEqual([]);
  });

  test("the edges from waiting to idle and from busy to ended count too; idle to ended does not", () => {
    const waiting = row({ state: "waiting", waitingFor: "input needed", stateSinceMs: T0 + MIN });
    const fromWaiting = run([
      { atMs: T0 + MIN, rows: [waiting] },
      { atMs: T0 + 2 * MIN, rows: [idle(T0 + 2 * MIN)] },
    ]);
    expect(summary(fromWaiting.edges[1] ?? [])).toEqual([["SessionHandedOff", "True", "HandoverCheckPassed"]]);
    const toEnded = run([
      { atMs: T0 + MIN, rows: [busy(T0 + MIN)] },
      { atMs: T0 + 2 * MIN, rows: [ended(T0 + 2 * MIN)] },
    ]);
    expect(summary(toEnded.edges[1] ?? [])).toEqual([["SessionHandedOff", "True", "HandoverCheckPassed"]]);
    // One check for both HandoverFailed and SessionHandedOff.
    expect(toEnded.checks).toHaveLength(1);
    const idleToEnded = run(
      [
        { atMs: T0 + MIN, rows: [idle(T0 - MIN)] },
        { atMs: T0 + 2 * MIN, rows: [ended(T0 - MIN)] },
      ],
      { check: () => ({ code: 1, firstLine: "handover: not pushed" }) },
    );
    // The edge to ended runs the check for HandoverFailed, but it is no SessionHandedOff edge.
    expect(idleToEnded.checks).toHaveLength(1);
    expect(summary(idleToEnded.edges[1] ?? [])).toEqual([["HandoverFailed", "True", "HandoverCheckFailed"]]);
    const idleToEndedClean = run([
      { atMs: T0 + MIN, rows: [idle(T0 - MIN)] },
      { atMs: T0 + 2 * MIN, rows: [ended(T0 - MIN)] },
    ]);
    expect(idleToEndedClean.edges[1]).toEqual([]);
    expect(idleToEndedClean.reads).toEqual([]);
  });

  test("exit code 1 gives no SessionHandedOff and no HandoverFailed at an idle edge; exit code 2 gives nothing", () => {
    for (const code of [1, 2]) {
      const { edges, reads } = run(
        [
          { atMs: T0 + MIN, rows: [busy(T0 + MIN)] },
          { atMs: T0 + 2 * MIN, rows: [idle(T0 + 2 * MIN)] },
        ],
        { check: () => ({ code, firstLine: "handover: not pushed" }) },
      );
      expect(edges[1]).toEqual([]);
      expect(reads).toEqual([]);
    }
  });

  test("exit code 1 at the edge to ended keeps HandoverFailed and gives no SessionHandedOff", () => {
    const { edges } = run(
      [
        { atMs: T0 + MIN, rows: [busy(T0 + MIN)] },
        { atMs: T0 + 2 * MIN, rows: [ended(T0 + 2 * MIN)] },
      ],
      { check: () => ({ code: 1, firstLine: "handover: not pushed" }) },
    );
    expect(summary(edges[1] ?? [])).toEqual([["HandoverFailed", "True", "HandoverCheckFailed"]]);
  });

  test("the same plan commit gives no second event; a new commit gives one, without a False event in between", () => {
    let count = 0;
    const { edges, state } = run(
      [
        { atMs: T0 + MIN, rows: [busy(T0 + MIN)] },
        { atMs: T0 + 2 * MIN, rows: [idle(T0 + 2 * MIN)] },
        { atMs: T0 + 3 * MIN, rows: [busy(T0 + 3 * MIN)] },
        { atMs: T0 + 4 * MIN, rows: [idle(T0 + 4 * MIN)] },
        { atMs: T0 + 5 * MIN, rows: [busy(T0 + 5 * MIN)] },
        { atMs: T0 + 6 * MIN, rows: [idle(T0 + 6 * MIN)] },
      ],
      // The plan gets a new commit before the third turn ends.
      { hash: () => (++count <= 2 ? HASH_A : HASH_B) },
    );
    expect(only(edges.flat(), "SessionHandedOff").map((edge) => [edge.status, edge.planCommit])).toEqual([
      ["True", HASH_A],
      ["True", HASH_B],
    ]);
    expect(edges[3]).toEqual([]);
    // A one-shot condition is never open.
    expect(openCount(state)).toBe(0);
  });

  test("no plan commit (git fails, or no commit changed the plan) gives no event", () => {
    const { edges } = run(
      [
        { atMs: T0 + MIN, rows: [busy(T0 + MIN)] },
        { atMs: T0 + 2 * MIN, rows: [idle(T0 + 2 * MIN)] },
      ],
      { hash: () => undefined },
    );
    expect(edges[1]).toEqual([]);
  });

  test("a session seen first after a restart: only activity after the watermark is an edge", () => {
    const before = run([{ atMs: T0 + 5 * MIN, rows: [idle(T0 - MIN)] }]);
    expect(before.checks).toEqual([]);
    const after = run([{ atMs: T0 + 5 * MIN, rows: [idle(T0 + MIN)] }]);
    expect(summary(after.edges[0] ?? [])).toEqual([["SessionHandedOff", "True", "HandoverCheckPassed"]]);
  });

  test("a restored record keeps its plan commit, so the same commit gives no event after a restart", () => {
    const record = {
      condition: "SessionHandedOff" as const,
      status: "True" as const,
      reason: "HandoverCheckPassed",
      message: "handover check passed, plan commit 111111111111",
      lastTransitionMs: T0 - 10 * MIN,
      session: ID,
      subject: "meta",
      cwd: "/home/u/dv/meta",
      kind: "interactive",
      planCommit: HASH_A,
    };
    const same = run([{ atMs: T0 + 5 * MIN, rows: [idle(T0 + MIN)] }], { state: restoreState([record], T0) });
    expect(same.checks).toHaveLength(1);
    expect(same.edges[0]).toEqual([]);
    const fresh = run([{ atMs: T0 + 5 * MIN, rows: [idle(T0 + MIN)] }], { state: restoreState([record], T0), hash: () => HASH_B });
    expect(fresh.edges[0]?.map((edge) => edge.planCommit)).toEqual([HASH_B]);
  });

  test("no False event when the session leaves the source, and the record stays as memory", () => {
    const { edges, state } = run([
      { atMs: T0 + MIN, rows: [busy(T0 + MIN)] },
      { atMs: T0 + 2 * MIN, rows: [idle(T0 + 2 * MIN)] },
      { atMs: T0 + 70 * MIN, rows: [] },
    ]);
    expect(edges[2]).toEqual([]);
    expect(state.conditions.get(conditionKey("SessionHandedOff", ID))?.planCommit).toBe(HASH_A);
  });
});

describe("restart and disappearance", () => {
  test("a restored True condition that is still true gives no second event", () => {
    const state = restoreState(
      [
        {
          condition: "ContextHigh",
          status: "True",
          reason: "OverHalfWindow",
          message: "context 54% of 200000 tokens",
          lastTransitionMs: T0 - 10 * MIN,
          session: ID,
          subject: "meta",
          cwd: "/home/u/dv/meta",
          kind: "interactive",
        },
      ],
      T0 - MIN,
    );
    // The row is new to the watcher and active after the watermark, so the hand-off check runs; it finds no plan commit.
    const { edges } = polls([{ atMs: T0, rows: [row({ contextTokens: 150_000 })] }], { state, check: () => ({ code: 0, firstLine: undefined }) });
    expect(edges[0]).toEqual([]);
  });

  test("a restored True condition that cleared while the watcher was down gives a False event", () => {
    const state = restoreState(
      [
        {
          condition: "SessionWaitsForUser",
          status: "True",
          reason: "input_required",
          message: "blocked job, waits for the user since 12 min",
          lastTransitionMs: T0 - 10 * MIN,
          session: "gone-session-id",
          subject: "gone",
          cwd: "/w",
          kind: "background",
        },
      ],
      T0 - MIN,
    );
    const { edges, state: after } = polls([{ atMs: T0, rows: [] }], { state });
    expect(summary(edges[0] ?? [])).toEqual([["SessionWaitsForUser", "False", "SessionGone"]]);
    expect(after.conditions.size).toBe(0);
  });

  test("evaluate does not change the old state", () => {
    const state = emptyState(T0);
    evaluate(state, [row({ name: undefined })], T0, noCheck);
    expect(state.conditions.size).toBe(0);
    expect(state.sessions.size).toBe(0);
  });
});
