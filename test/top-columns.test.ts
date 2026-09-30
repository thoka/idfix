/** Tests for the pure column functions of `oc-sub top` (step 8f). */
import { describe, expect, test } from "bun:test";
import {
  columnHeaders,
  padTable,
  rowCells,
  sessionCode,
  splitFolder,
} from "../src/top/columns";
import type { SessionRow } from "../src/top/model";

function row(overrides: Partial<SessionRow> & { sessionId: string }): SessionRow {
  return {
    server: "http://127.0.0.1:8767",
    directory: "/repo",
    title: "a title",
    agent: "coder",
    state: "busy",
    startTimeMs: 0,
    elapsedMs: 65_000,
    msSinceEvent: 5_000,
    steps: 2,
    toolCalls: 3,
    contextTokens: 6333,
    cost: 0.00077859,
    outputTokens: 65,
    reasoningTokens: 7,
    reasoningShare: 7 / 72,
    lastStepReasoning: 7,
    ...overrides,
  };
}

describe("sessionCode", () => {
  test("is the last 6 characters of the session ID", () => {
    expect(sessionCode("ses_2a3b4c5d6e7fABCDEF")).toBe("ABCDEF");
    expect(sessionCode("ses")).toBe("ses");
  });
});

describe("splitFolder", () => {
  test("a folder under .worktrees gives the project and the worktree", () => {
    expect(splitFolder("/home/u/dv/opencode-subagents/.worktrees/8g-top-view")).toEqual({
      project: "opencode-subagents",
      worktree: "8g-top-view",
    });
  });

  test("a folder inside a worktree still names the worktree", () => {
    expect(splitFolder("/p/.worktrees/w1/src/top")).toEqual({ project: "p", worktree: "w1" });
  });

  test("the main folder has the worktree -", () => {
    expect(splitFolder("/home/u/dv/terminator")).toEqual({ project: "terminator", worktree: "-" });
    expect(splitFolder("/home/u/dv/terminator/")).toEqual({ project: "terminator", worktree: "-" });
  });

  test("an empty folder and a bare .worktrees folder", () => {
    expect(splitFolder("")).toEqual({ project: "-", worktree: "-" });
    expect(splitFolder("/p/.worktrees")).toEqual({ project: ".worktrees", worktree: "-" });
  });
});

describe("columnHeaders and rowCells", () => {
  test("the project column shows only with showProject", () => {
    expect(columnHeaders({ showProject: false })).not.toContain("project");
    expect(columnHeaders({ showProject: true }).slice(0, 3)).toEqual(["session", "project", "worktree"]);
  });

  test("the cells follow the headers, and the project keeps its full name without a resolver", () => {
    const [cells] = rowCells(
      [row({ sessionId: "ses_xxxxABCDEF", directory: "/d/opencode-subagents/.worktrees/8f", agent: "" })],
      { showProject: true },
    );
    expect(cells).toEqual([
      "ABCDEF",
      "opencode-subagents",
      "8f",
      "-",
      "busy",
      "1m05s",
      "0m05s",
      "2",
      "3",
      "6.3k",
      "$0.0008",
      "10%",
      "a title",
    ]);
  });

  test("a row uses the configured project name when the resolver gives one", () => {
    const [cells] = rowCells(
      [row({ sessionId: "ses_xxxxABCDEF", directory: "/d/opencode-subagents/.worktrees/8i" })],
      {
        showProject: true,
        projectName: (directory) => (directory === "/d/opencode-subagents/.worktrees/8i" ? "opsub" : directory),
      },
    );
    expect(cells?.[1]).toBe("opsub");
  });
});

describe("padTable", () => {
  test("pads the columns and cuts the title to the width", () => {
    const table = padTable([row({ sessionId: "ses_1", title: "x".repeat(300) })], { showProject: false, width: 140 });
    expect(table.header[0]).toBe("session");
    const line = table.rows[0]?.join("  ") ?? "";
    expect(line.length).toBe(140);
  });
});
