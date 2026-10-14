/**
 * Regression test: an interactive session whose turn ended, while Claude
 * Code still writes the status `shell` in its session file, is idle and does
 * not stall. Claude Code keeps `shell` after the turn end while a shell
 * process of the session lives, for example a hung command that a finished
 * subagent moved to the background. The transcript below has the shape of
 * the real end of such a session, with invented content.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClaudeSource, liveState, loadClaudeRows } from "../src/claude/rows";
import { claudeStatusRow, statusConditions } from "../src/status";
import { MINUTE, fixtureFs } from "./claude-fixture";
import { turnLines as L, turnTime } from "./claude-turn-lines";

const ID = "99999999-0000-4000-8000-000000000009";
const PID = 1009;
const PROC_START = "900";

/** The end of the real transcript, shape only. */
const LINES = [
  L.prompt(0),
  L.assistant(10),
  // A Bash task that the session stopped with TaskStop: no task report follows.
  L.bashStart(20, "toolu_bash", "bfake0001"),
  L.taskStop(30, "toolu_stop", "bfake0001"),
  // A background subagent, then the turn ends with the stop hook lines.
  L.agentStart(40, "toolu_agent", "afake0000000000001"),
  L.assistant(50),
  ...L.stopHookEnd(60),
  // The subagent hands back: a peer message and its task report are queued, then delivered.
  L.enqueue(400, "toolu_agent", "afake0000000000001"),
  L.peer(401, "afake0000000000001"),
  L.assistant(410),
  ...L.stopHookEnd(420),
];
const TURN_END = turnTime(420);

function root(status: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "idfix-claude-idle-shell-"));
  mkdirSync(path.join(dir, "sessions"));
  mkdirSync(path.join(dir, "projects", "-home-user-src-proj"), { recursive: true });
  writeFileSync(
    path.join(dir, "sessions", `${PID}.json`),
    JSON.stringify({
      pid: PID,
      procStart: PROC_START,
      sessionId: ID,
      cwd: "/home/user/src/proj",
      startedAt: turnTime(0) - MINUTE,
      kind: "interactive",
      name: "proj-dev",
      status,
      updatedAt: TURN_END + 25,
      statusUpdatedAt: TURN_END + 25,
    }),
  );
  writeFileSync(path.join(dir, "projects", "-home-user-src-proj", `${ID}.jsonl`), `${LINES.join("\n")}\n`);
  return dir;
}

async function rowAt(status: string, nowMs: number) {
  const fs = fixtureFs({ procStarts: { [PID]: PROC_START }, mtimes: { [`${ID}.jsonl`]: TURN_END } });
  const rows = await loadClaudeRows({ source: createClaudeSource(root(status), fs), nowMs, loadPrices: async () => undefined });
  const row = rows.find((r) => r.sessionId === ID);
  if (row === undefined) throw new Error("no row of the session");
  return row;
}

describe("a session whose turn ended while Claude Code shows the status shell", () => {
  const later = TURN_END + 20 * MINUTE;

  test("is idle from its turn end, with no running task", async () => {
    const row = await rowAt("shell", later);
    expect(row).toMatchObject({ state: "idle", stateSinceMs: TURN_END, backgroundTasks: 0, turn: undefined });
    expect(claudeStatusRow(row)).toMatchObject({ turn: null, backgroundTasks: 0 });
  });

  test("does not stall after 15 minutes without transcript growth", async () => {
    for (const status of ["shell", "busy"]) {
      const row = await rowAt(status, later);
      const log = { lastSequence: 0, lastTimeMs: undefined, lastHeartbeatMs: undefined, records: [] };
      const types = statusConditions([row], log, later).map((condition) => condition.type);
      expect(types).not.toContain("SessionStalled");
    }
  });

  test("a turn that runs still reads as busy", () => {
    const session = { status: "shell" } as Parameters<typeof liveState>[0];
    expect(liveState(session, undefined, { turnEnded: false })).toBe("busy");
    expect(liveState(session, undefined, undefined)).toBe("busy");
    expect(liveState({ ...session, status: "busy" }, undefined, { turnEnded: true })).toBe("idle");
    expect(liveState({ ...session, status: "waiting" }, undefined, { turnEnded: true })).toBe("waiting");
  });
});
