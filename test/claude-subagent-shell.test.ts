/**
 * Regression test: a Bash task of a subagent keeps the session in the status
 * `shell` after the subagent reported, and the session then shows a
 * background task (`SessionBackground`).
 *
 * The real case: a background subagent started a Bash task, then ran a wait
 * loop in the foreground that could not end. After 10 minutes its timeout
 * moved the loop to the background. Both start lines are in the transcript
 * of the subagent, not of the session. The subagent reported `completed`,
 * the session ended its turn, and the loop ran on for two hours without a
 * task report. The transcript count of running tasks was 0, but Claude Code
 * kept the status `shell`. The lines below have the shape of the real
 * transcripts, with invented content.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClaudeSource, loadClaudeRows } from "../src/claude/rows";
import { claudeStatusRow, statusConditions } from "../src/status";
import { MINUTE, fixtureFs } from "./claude-fixture";
import { turnLines as L, turnTime } from "./claude-turn-lines";

const ID = "99999999-0000-4000-8000-000000000010";
const PID = 1010;
const PROC_START = "910";
const AGENT = "afake0000000000002";

/** The session: it starts the subagent, ends its turn, gets the reports of the subagent, and ends its turn again. */
const SESSION_LINES = [
  L.prompt(0),
  L.agentStart(10, "toolu_agent", AGENT),
  L.assistant(20),
  ...L.stopHookEnd(30),
  // The report of the first Bash task of the subagent: it ends a task that this transcript never saw start.
  L.enqueue(300, "toolu_sub_bash", "bfake0002"),
  L.peer(900, AGENT),
  L.enqueue(901, "toolu_agent", AGENT),
  L.assistant(910),
  ...L.stopHookEnd(920),
];
const TURN_END = turnTime(920);

/** The subagent: a background Bash task, then a foreground loop that its timeout moves to the background. */
const AGENT_LINES = [
  L.bashStart(100, "toolu_sub_bash", "bfake0002"),
  L.assistant(110),
  JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_sub_loop", content: "FAKE TIMEOUT" }] },
    toolUseResult: { stdout: "", stderr: "", interrupted: false, backgroundTaskId: "bfake0003", timedOutAfterMs: 600000 },
    timestamp: new Date(turnTime(710)).toISOString(),
  }),
  L.assistant(720),
];

function root(status: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "idfix-claude-subagent-shell-"));
  const project = path.join(dir, "projects", "-home-user-src-proj");
  mkdirSync(path.join(dir, "sessions"));
  mkdirSync(path.join(project, ID, "subagents"), { recursive: true });
  writeFileSync(
    path.join(dir, "sessions", `${PID}.json`),
    JSON.stringify({
      pid: PID,
      procStart: PROC_START,
      sessionId: ID,
      cwd: "/home/user/src/proj",
      startedAt: turnTime(0) - MINUTE,
      kind: "interactive",
      name: "proj",
      status,
      updatedAt: TURN_END + 25,
      statusUpdatedAt: TURN_END + 25,
    }),
  );
  writeFileSync(path.join(project, `${ID}.jsonl`), `${SESSION_LINES.join("\n")}\n`);
  writeFileSync(path.join(project, ID, "subagents", `agent-${AGENT}.jsonl`), `${AGENT_LINES.join("\n")}\n`);
  return dir;
}

async function rowAt(status: string, nowMs: number) {
  const fs = fixtureFs({
    procStarts: { [PID]: PROC_START },
    mtimes: { [`${ID}.jsonl`]: TURN_END, [`agent-${AGENT}.jsonl`]: turnTime(720) },
  });
  const rows = await loadClaudeRows({ source: createClaudeSource(root(status), fs), nowMs, loadPrices: async () => undefined });
  const row = rows.find((r) => r.sessionId === ID);
  if (row === undefined) throw new Error("no row of the session");
  return row;
}

const noLog = { lastSequence: 0, lastTimeMs: undefined, lastHeartbeatMs: undefined, records: [] };

describe("a session whose subagent left a Bash task, with the status shell after the turn end", () => {
  const later = TURN_END + 120 * MINUTE;

  test("counts no task in its own transcript, but its turn is ended", async () => {
    const row = await rowAt("shell", later);
    expect(row).toMatchObject({ state: "idle", backgroundTasks: 0, turn: "ended" });
    expect(claudeStatusRow(row)).toMatchObject({ state: "idle", turn: "ended", backgroundTasks: 0 });
  });

  test("gives SessionBackground and no SessionStalled", async () => {
    const row = await rowAt("shell", later);
    const conditions = statusConditions([row], noLog, later);
    expect(conditions.map((condition) => condition.type)).not.toContain("SessionStalled");
    expect(conditions.find((condition) => condition.type === "SessionBackground")).toMatchObject({
      status: "True",
      reason: "TurnEndedTaskRuns",
      message: "turn ended, a shell process runs",
    });
  });

  test("without the status shell, the session rests at its prompt", async () => {
    const row = await rowAt("idle", later);
    expect(row).toMatchObject({ state: "idle", backgroundTasks: 0, turn: undefined });
    expect(statusConditions([row], noLog, later).map((condition) => condition.type)).not.toContain("SessionBackground");
  });
});
