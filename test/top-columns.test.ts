/** Tests for the pure column functions of `oc-sub top` (step 8f). */
import { describe, expect, test } from "bun:test";
import stringWidth from "string-width";
import {
  costCell,
  formatContextCell,
  rowIcon,
  agentIcon,
  columnHeaders,
  formatAge,
  formatCents,
  formatContext,
  padTable,
  rowCells,
  sessionCode,
  shortWorktree,
  splitFolder,
  ICON_WIDTH,
} from "../src/top/columns";
import type { SessionRow } from "../src/top/model";
import { claudeRowOf, openRow } from "./top-rows";

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
    driver: "opencode",
    costKind: "real",
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
    expect(splitFolder("/home/u/dv/idfix/.worktrees/8g-top-view")).toEqual({
      project: "idfix",
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

describe("compact cells", () => {
  test("formatAge counts seconds only below ten minutes", () => {
    expect(formatAge(0)).toBe("0s");
    expect(formatAge(42_000)).toBe("42s");
    expect(formatAge(245_000)).toBe("4m05s");
    expect(formatAge(34 * 60_000 + 59_000)).toBe("34m");
    expect(formatAge(3 * 3_600_000 + 12 * 60_000 + 5_000)).toBe("3h12m");
    expect(formatAge(2 * 86_400_000 + 4 * 3_600_000)).toBe("2d04h");
    expect(formatAge(-5)).toBe("0s");
  });

  test("formatCents shows cents without a unit", () => {
    expect(formatCents(0.00077859)).toBe("0.1");
    expect(formatCents(0.043)).toBe("4.3");
    expect(formatCents(0.567)).toBe("57");
    expect(formatCents(12.34)).toBe("1234");
  });

  test("formatContext", () => {
    expect(formatContext(6333)).toBe("6.3k");
    expect(formatContext(123_456)).toBe("123k");
  });

  test("agentIcon and shortWorktree", () => {
    expect(agentIcon("coder")).toBe("🔧");
    expect(agentIcon("researcher")).toBe("🔎");
    expect(agentIcon("reader")).toBe("📖");
    expect(agentIcon("planner")).toBe("pl");
    expect(agentIcon("x")).toBe("x ");
    expect(agentIcon("")).toBe("--");
    expect(shortWorktree("research-driver-layer")).toBe("🔬driver-layer");
    expect(shortWorktree("research-")).toBe("research-");
    expect(shortWorktree("8f")).toBe("8f");
  });
});

describe("columnHeaders and rowCells", () => {
  test("project and worktree share the where column", () => {
    expect(columnHeaders({ showProject: true }).slice(0, 3)).toEqual(["session", "where", "cost"]);
    expect(columnHeaders({ showProject: true, stateColumn: true }).slice(0, 3)).toEqual(["session", "state", "where"]);
  });

  test("the cells follow the headers, and the project keeps its full name without a resolver", () => {
    const [cells] = rowCells(
      [row({ sessionId: "ses_xxxxABCDEF", directory: "/d/idfix/.worktrees/8f", agent: "" })],
      { showProject: true },
    );
    expect(cells).toEqual([
      "--ABCDEF",
      "idfix/8f",
      "0.1",
      "1m05s",
      "5s",
      "2",
      "3",
      "6.3k",
      "10%",
      "a title",
    ]);
  });

  test("without the project, the where cell shows only the worktree, with a research icon", () => {
    const [cells] = rowCells([row({ sessionId: "ses_1", directory: "/d/p/.worktrees/research-x" })], {
      showProject: false,
    });
    expect(cells?.[1]).toBe("🔬x");
  });

  test("a row uses the configured project name when the resolver gives one", () => {
    const [cells] = rowCells(
      [row({ sessionId: "ses_xxxxABCDEF", directory: "/d/idfix/.worktrees/8i" })],
      {
        showProject: true,
        projectName: (directory) => (directory === "/d/idfix/.worktrees/8i" ? "opsub" : directory),
      },
    );
    expect(cells?.[1]).toBe("opsub/8i");
  });
});

describe("padTable", () => {
  test("pads the columns by display width and cuts the title to the width", () => {
    const table = padTable([row({ sessionId: "ses_1", title: "x".repeat(300) })], { showProject: false, width: 140 });
    expect(table.header[0]).toBe("  id   ");
    const line = table.rows[0]?.join(" ") ?? "";
    expect(stringWidth(line)).toBe(140);
  });

  test("right-aligns the numbers", () => {
    const table = padTable(
      [row({ sessionId: "ses_1", cost: 0.001 }), row({ sessionId: "ses_2", cost: 1.5 })],
      { showProject: false, width: 140 },
    );
    expect(table.rows[0]?.[2]).toBe("0.1");
    expect(table.rows[1]?.[2]).toBe("150");
  });
});

describe("Claude cells (step 25g.2)", () => {
  test("a Claude session shows the icon ✳, a subagent the icon of its agent", () => {
    expect(rowIcon(claudeRowOf("s"))).toBe("✳ ");
    expect(stringWidth(rowIcon(claudeRowOf("s")))).toBe(ICON_WIDTH);
    expect(rowIcon(claudeRowOf("s", { agent: "researcher" }))).toBe("🔎");
    expect(rowIcon(openRow("s", { agent: "" }))).toBe("--");
  });

  test("the cost cell is empty without a price and marks an API price only on request", () => {
    expect(costCell({ cost: 0, costKind: "none" }, true)).toBe("");
    expect(costCell({ cost: 0.043, costKind: "apiEquivalent" }, false)).toBe("4.3");
    expect(costCell({ cost: 0.043, costKind: "apiEquivalent" }, true)).toBe("~4.3");
    expect(costCell({ cost: 0.043, costKind: "real" }, true)).toBe("4.3");
  });

  test("the ctx cell adds the window share when the window is known", () => {
    expect(formatContextCell(123_000, 200_000)).toBe("123k 62%");
    expect(formatContextCell(6_300, undefined)).toBe("6.3k");
    expect(formatContextCell(6_300, 200_000)).toBe("6.3k  3%");
    expect(formatContextCell(200_000, 200_000)).toBe("200k 100%");
    expect(formatContextCell(6_300, 0)).toBe("6.3k");
    // An opencode row with a known window gets the share too.
    const [cells] = rowCells([openRow("ses_x", { contextTokens: 50_000, contextWindow: 1_000_000 })], { showProject: false });
    expect(cells?.[columnHeaders({ showProject: false }).indexOf("ctx")]).toBe("50.0k  5%");
  });

  test("rowCells of a Claude row without a price", () => {
    const options = { showProject: false, costMarker: true };
    const headers = columnHeaders(options);
    const [cells] = rowCells([claudeRowOf("abcdef-123456", { costKind: "none", contextTokens: 2_000, contextWindow: undefined })], options);
    expect(cells?.[headers.indexOf("session")]).toBe("✳ 123456");
    expect(cells?.[headers.indexOf("cost")]).toBe("");
    expect(cells?.[headers.indexOf("ctx")]).toBe("2.0k");
  });
});
