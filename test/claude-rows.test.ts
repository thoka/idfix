import { describe, expect, test } from "bun:test";
import { appendFileSync, cpSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parsePriceFile } from "../src/claude/prices";
import {
  claudeRow,
  createClaudeSource,
  ENDED_VISIBLE_MS,
  inScope,
  loadClaudeRows,
  sessionTitle,
  turnOf,
  type ClaudeSession,
} from "../src/claude/rows";
import { summarizeTranscript } from "../src/claude/transcript";
import { claudeStatusRow } from "../src/status";
import { transcriptOf, turnLines as L } from "./claude-turn-lines";
import { FIXTURE_DIR, FIXTURE_ROOT, fixtureFs, MINUTE, NOW, S1, S2, S5, S6, S7, S8 } from "./claude-fixture";

const prices = parsePriceFile(readFileSync(path.join(FIXTURE_DIR, "litellm-prices.json"), "utf8"));

const OPUS_COST = 15 * 4e-6 + 80 * 2e-5 + 1000 * 2e-7 + 200 * 5e-6 + 1000 * 8e-6;
const SONNET_COST = 100 * 2e-6 + 10 * 1e-5;

async function rowsAt(nowMs: number, options: { prices?: boolean } = {}) {
  return loadClaudeRows({
    source: createClaudeSource(FIXTURE_ROOT, fixtureFs()),
    nowMs,
    loadPrices: async () => (options.prices === false ? undefined : prices),
  });
}

describe("which sessions show", () => {
  test("live, waiting, and recently ended sessions show, in the order waiting, live, ended", async () => {
    const rows = await rowsAt(NOW);
    expect(rows.map((row) => [row.sessionId, row.state])).toEqual([
      [S1, "waiting"],
      [S5, "waiting"],
      [S2, "busy"],
      [S7, "ended"],
    ]);
  });

  test("an ended transcript shows for 60 minutes after its last change", async () => {
    // S7 changed 10 minutes before NOW; 51 minutes later it is 61 minutes old.
    const later = await rowsAt(NOW + ENDED_VISIBLE_MS - 9 * MINUTE);
    expect(later.map((row) => row.sessionId)).not.toContain(S7);
    // S8 changed 120 minutes before NOW, so it showed 61 minutes earlier.
    const earlier = await rowsAt(NOW - 61 * MINUTE);
    expect(earlier.find((row) => row.sessionId === S8)?.state).toBe("ended");
  });

  test("a done job shows as ended for 60 minutes after its update", async () => {
    // The job S6 was updated at 08:00.
    const rows = await rowsAt(Date.parse("2026-10-06T08:30:00.000Z"));
    const row = rows.find((r) => r.sessionId === S6);
    expect(row).toMatchObject({ state: "ended", kind: "background", name: "done-job" });
    expect((await rowsAt(NOW)).some((r) => r.sessionId === S6)).toBe(false);
  });

  test("a blocked job without a process waits, whatever its age, and names what it needs", async () => {
    const row = (await rowsAt(NOW)).find((r) => r.sessionId === S5);
    expect(row).toMatchObject({ state: "waiting", waitingFor: "approve the push", kind: "background", directory: "/home/user/src/other" });
  });

  test("a row is active only when a live process belongs to it", async () => {
    const rows = await rowsAt(NOW);
    expect(rows.map((row) => [row.sessionId, row.active])).toEqual([
      [S1, true],
      // S5 is a blocked job without a process: only its job file is left.
      [S5, false],
      [S2, true],
      [S7, false],
    ]);
  });

  test("a dead pid and a reused pid do not show", async () => {
    const ids = (await rowsAt(NOW)).map((row) => row.sessionId);
    expect(ids).not.toContain("33333333-0000-4000-8000-000000000003");
    expect(ids).not.toContain("44444444-0000-4000-8000-000000000004");
  });

  test("without any session, the prices never load", async () => {
    let loaded = false;
    const empty = mkdtempSync(path.join(tmpdir(), "idfix-claude-empty-"));
    const rows = await loadClaudeRows({
      source: createClaudeSource(empty, fixtureFs()),
      nowMs: NOW,
      loadPrices: async () => {
        loaded = true;
        return prices;
      },
    });
    expect(rows).toEqual([]);
    expect(loaded).toBe(false);
  });
});

describe("the row of a session", () => {
  test("an interactive session sums itself and its subagent", async () => {
    const row = (await rowsAt(NOW)).find((r) => r.sessionId === S1);
    expect(row).toMatchObject({
      driver: "claude",
      kind: "interactive",
      title: "fixture-title",
      name: "proj",
      directory: "/home/user/src/proj",
      agent: "",
      server: "",
      state: "waiting",
      waitingFor: "Bash permission",
      tmux: "5:@5.%40",
      pid: 1001,
      model: "claude-opus-5-5",
      contextTokens: 1205,
      contextWindow: 1_000_000,
      costKind: "apiEquivalent",
      steps: 3,
      toolCalls: 2,
      apiErrors: 1,
      startTimeMs: 1791280000000,
      lastActivityMs: 1791284100000,
    });
    expect(row?.cost).toBeCloseTo(OPUS_COST + SONNET_COST, 12);
    expect(row?.apiEquivalentUsd).toBeCloseTo(OPUS_COST + SONNET_COST, 12);
    // Output 80 + 10 tokens, of which 20 are thinking.
    expect(row?.outputTokens).toBe(70);
    expect(row?.reasoningTokens).toBe(20);
    expect(row?.msSinceEvent).toBe(NOW - 1791284100000);
  });

  test("the watch fields: the state time, the transcript growth with the subagents, and the last API error", async () => {
    const rows = await rowsAt(NOW);
    const s1 = rows.find((r) => r.sessionId === S1);
    // statusUpdatedAt of the session file.
    expect(s1?.stateSinceMs).toBe(1791284100000);
    // The main transcript changed 1 minute before NOW; the subagent file has the default age.
    expect(s1?.transcriptGrowthMs).toBe(NOW - 1 * MINUTE);
    expect(s1?.lastApiErrorText).toBe("529 overloaded");
    expect(s1?.lastApiErrorMs).toBe(Date.parse("2026-10-06T10:01:10.000Z"));
    // A blocked job without a process: updatedAt of the job.
    expect(rows.find((r) => r.sessionId === S5)?.stateSinceMs).toBe(Date.parse("2026-10-03T09:00:00.000Z"));
    expect(s1?.waitingSource).toBe("session");
    expect(rows.find((r) => r.sessionId === S5)?.waitingSource).toBe("job");
  });

  test("a subagent becomes a child row with its own numbers and the icon of its agent type", async () => {
    const row = (await rowsAt(NOW)).find((r) => r.sessionId === S1);
    expect(row?.children).toHaveLength(1);
    expect(row?.children[0]).toMatchObject({
      sessionId: "a1",
      title: "Find files",
      agent: "Explore",
      model: "claude-sonnet-5-5",
      steps: 1,
      toolCalls: 1,
      contextTokens: 100,
      driver: "claude",
    });
    expect(row?.children[0]?.cost).toBeCloseTo(SONNET_COST, 12);
  });

  test("a background session in a worktree takes the folder of its session file", async () => {
    const row = (await rowsAt(NOW)).find((r) => r.sessionId === S2);
    expect(row).toMatchObject({ kind: "background", jobId: "22222222", directory: "/home/user/src/proj/.worktrees/w2", contextTokens: 5003 });
  });

  test("a model without a price has no cost and no window, not a zero price", async () => {
    const row = (await rowsAt(NOW)).find((r) => r.sessionId === S7);
    expect(row).toMatchObject({ model: "z-ai/glm-5.3-flash", costKind: "none", cost: 0, apiEquivalentUsd: undefined, contextWindow: undefined });
    // No title line and no name: the folder name.
    expect(row?.title).toBe("proj");
  });

  test("without the price file, no row has a cost", async () => {
    const rows = await rowsAt(NOW, { prices: false });
    expect(rows.every((row) => row.costKind === "none" && row.apiEquivalentUsd === undefined)).toBe(true);
  });

  test("the elapsed time of an ended session stops at its last activity", async () => {
    const row = (await rowsAt(NOW)).find((r) => r.sessionId === S7);
    expect(row?.elapsedMs).toBe(0);
  });
});

describe("incremental polls", () => {
  test("a second poll reads only the new lines of a transcript", () => {
    const root = mkdtempSync(path.join(tmpdir(), "idfix-claude-poll-"));
    cpSync(FIXTURE_ROOT, root, { recursive: true });
    const source = createClaudeSource(root, fixtureFs());
    const first = source.sessions(NOW).find((s) => s.sessionId === S1);
    expect(first?.summary?.steps).toBe(2);
    const transcript = path.join(root, "projects", "-home-user-src-proj", `${S1}.jsonl`);
    appendFileSync(
      transcript,
      `${JSON.stringify({
        type: "assistant",
        timestamp: "2026-10-06T10:59:00.000Z",
        message: { id: "msg_3", model: "claude-opus-5-5", content: [], usage: { input_tokens: 1, cache_read_input_tokens: 2000, output_tokens: 1 } },
      })}\n`,
    );
    const second = source.sessions(NOW).find((s) => s.sessionId === S1);
    expect(second?.summary?.steps).toBe(3);
    expect(second?.summary?.contextTokens).toBe(2001);
    // The custom title of the first read stays.
    expect(second?.summary?.customTitle).toBe("fixture-title");
  });
});

describe("helpers", () => {
  test("inScope accepts the folder itself and folders inside it, not a sibling with the same prefix", () => {
    expect(inScope("/home/user/src/proj", ["/home/user/src/proj"])).toBe(true);
    expect(inScope("/home/user/src/proj/.worktrees/w2", ["/home/user/src/proj"])).toBe(true);
    expect(inScope("/home/user/src/project2", ["/home/user/src/proj"])).toBe(false);
    expect(inScope("/home/user/src", ["/home/user/src/proj"])).toBe(false);
  });

  test("the title is the custom title, the AI title, the name, then the first 60 characters of the folder name", () => {
    const summary = { customTitle: undefined, aiTitle: "AI" } as Parameters<typeof sessionTitle>[0];
    expect(sessionTitle(summary, "name", "/w")).toBe("AI");
    expect(sessionTitle(undefined, "name", "/w")).toBe("name");
    expect(sessionTitle(undefined, undefined, `/w/${"x".repeat(80)}`)).toBe("x".repeat(60));
  });

  test("claudeRow of a session without a transcript has zero numbers", () => {
    const row = claudeRow(
      {
        sessionId: "s",
        kind: "interactive",
        name: "n",
        cwd: "/w",
        live: true,
        state: "idle",
        waitingFor: undefined,
        waitingSource: undefined,
        pid: 1,
        tmux: undefined,
        jobId: undefined,
        startTimeMs: NOW - 1000,
        lastActivityMs: NOW - 500,
        stateSinceMs: undefined,
        transcriptGrowthMs: undefined,
        summary: undefined,
        subagents: [],
      },
      prices,
      NOW,
    );
    expect(row).toMatchObject({ steps: 0, contextTokens: 0, costKind: "apiEquivalent", cost: 0, elapsedMs: 500, model: undefined });
    expect(row.active).toBe(true);
  });
});

describe("the turn end while a background task runs", () => {
  const running = summarizeTranscript(transcriptOf([L.prompt(0), L.bashStart(1, "toolu_a", "bash1"), L.assistant(2), L.turnEnd(3)]));
  const reported = summarizeTranscript(
    transcriptOf([L.prompt(0), L.bashStart(1, "toolu_a", "bash1"), L.turnEnd(3), L.enqueue(4, "toolu_a", "bash1")]),
  );
  const noTask = summarizeTranscript(transcriptOf([L.prompt(0), L.assistant(1), L.turnEnd(2)]));
  const session = (overrides: Partial<ClaudeSession> = {}): ClaudeSession => ({
    sessionId: "s",
    kind: "interactive",
    name: "n",
    cwd: "/w",
    live: true,
    state: "busy",
    waitingFor: undefined,
    waitingSource: undefined,
    pid: 1,
    tmux: undefined,
    jobId: undefined,
    startTimeMs: NOW - 1000,
    lastActivityMs: NOW - 500,
    stateSinceMs: undefined,
    transcriptGrowthMs: undefined,
    summary: running,
    subagents: [],
    ...overrides,
  });

  test("a live interactive session that is busy or idle after its turn end with a running task gives ended", () => {
    expect(turnOf(session())).toBe("ended");
    expect(turnOf(session({ state: "idle" }))).toBe("ended");
  });

  test("no turn end, no running task, a wait, no process, or a background job give undefined", () => {
    expect(turnOf(session({ summary: reported }))).toBeUndefined();
    expect(turnOf(session({ summary: noTask }))).toBeUndefined();
    expect(turnOf(session({ summary: undefined }))).toBeUndefined();
    expect(turnOf(session({ state: "waiting" }))).toBeUndefined();
    expect(turnOf(session({ live: false, state: "ended" }))).toBeUndefined();
    expect(turnOf(session({ kind: "background" }))).toBeUndefined();
  });

  test("the row and the status row carry the turn and the task count", () => {
    const row = claudeRow(session(), undefined, NOW);
    expect(row).toMatchObject({ turn: "ended", backgroundTasks: 1 });
    expect(claudeStatusRow(row)).toMatchObject({ turn: "ended", backgroundTasks: 1 });
    expect(claudeStatusRow(claudeRow(session({ summary: noTask }), undefined, NOW))).toMatchObject({ turn: null, backgroundTasks: 0 });
  });
});
