/**
 * Tests for the text snapshot of `oc-sub top --once`, with invented rows.
 * No server and no clock: the tests pass `nowMs` themselves.
 */
import { describe, expect, test } from "bun:test";
import { formatTopTable, type TopTableRow } from "../src/top/format";
import type { QuestionRequest } from "../src/requests";

const NOW = 1_000_000;

function row(overrides: Partial<TopTableRow> & { sessionId: string }): TopTableRow {
  return {
    server: "http://127.0.0.1:8767",
    directory: "/repo/.worktrees/8d",
    title: `session ${overrides.sessionId}`,
    agent: "coder",
    state: "busy",
    startTimeMs: NOW - 65_000,
    elapsedMs: 65_000,
    msSinceEvent: 5_000,
    steps: 2,
    toolCalls: 3,
    contextTokens: 4605 + 1728,
    cost: 0.00077859,
    outputTokens: 65,
    reasoningTokens: 7,
    reasoningShare: 7 / 72,
    lastStepReasoning: 7,
    pending: [],
    ...overrides,
  };
}

const questionPending = [
  {
    kind: "question" as const,
    request: {
      id: "que_01j4",
      sessionID: "ses_1",
      questions: [
        {
          question: "Should I delete build/tmp.txt?",
          header: "Delete file",
          options: [
            { label: "Yes", description: "delete the file" },
            { label: "No", description: "keep the file" },
          ],
        },
      ],
    } as QuestionRequest,
  },
];

describe("formatTopTable", () => {
  test("prints one header line and one padded line per row", () => {
    const lines = formatTopTable(
      [
        row({ sessionId: "ses_1", title: "one" }),
        row({ sessionId: "ses_longer", directory: "/repo", state: "idle", steps: 12, agent: "researcher", title: "two" }),
      ],
      NOW,
    );
    expect(lines).toHaveLength(3);
    const header = lines[0] as string;
    // Every column of every line starts where the header column starts.
    const starts = [...header.matchAll(/\S+/g)].map((match) => match.index ?? 0);
    for (const line of lines.slice(1)) {
      const cellStarts = [...line.matchAll(/\S+/g)].map((match) => match.index ?? 0);
      expect(cellStarts.slice(0, -1)).toEqual(starts.slice(0, -1));
    }
    expect(lines[1]).toContain("ses_1");
    expect(lines[1]).toContain("$0.0008");
    expect(lines[1]).toContain("1m05s");
    expect(lines[1]).toContain("0m05s");
    expect(lines[1]).toContain("6.3k");
    expect(lines[1]).toContain("10%");
  });

  test("shows the folder relative to the scope directory where possible", () => {
    const lines = formatTopTable([row({ sessionId: "ses_1" })], NOW, { scopeDir: "/repo" });
    expect(lines[1]).toContain(" .worktrees/8d ");
    const absolute = formatTopTable([row({ sessionId: "ses_1" })], NOW);
    expect(absolute[1]).toContain(" /repo/.worktrees/8d ");
  });

  test("replaces the home directory with ~ and keeps a minimum title with a long folder", () => {
    const home = "/home/user";
    const longFolder = `${home}/dv/a-very-long-project-name/.worktrees/an-even-longer-worktree-name`;
    const lines = formatTopTable([row({ sessionId: "ses_1", directory: longFolder, title: "t".repeat(80) })], NOW, {
      home,
      width: 120,
    });
    expect(lines[1]).toContain(" ~/dv/a-very-long-project-name/.worktrees/an-even-longer-worktree-name ");
    // The title keeps at least 24 characters, even when the line gets wider.
    expect(lines[1]?.length).toBeGreaterThan(120);
    expect(lines[1]).toContain("t".repeat(24));
  });

  test("adds one indented line block per pending request", () => {
    const lines = formatTopTable([row({ sessionId: "ses_1", pending: questionPending, state: "waiting" })], NOW);
    expect(lines.slice(2)).toEqual([
      "  question que_01j4 in ses_1",
      "    1. [Delete file] Should I delete build/tmp.txt?",
      "       - Yes: delete the file",
      "       - No: keep the file",
    ]);
  });

  test("cuts the title so that the line fits into the width", () => {
    const longTitle = "x".repeat(200);
    const lines = formatTopTable([row({ sessionId: "ses_1", title: longTitle })], NOW, { width: 160 });
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(160);
    // The title gets exactly the space between the padded prefix and the width.
    const header = lines[0] as string;
    const prefix = header.length - "title".length;
    const xCount = (lines[1]?.match(/x+$/) ?? [""])[0]?.length ?? 0;
    expect(xCount).toBe(160 - prefix);
  });

  test("uses the elapsed time of the row, which stops for idle sessions", () => {
    const lines = formatTopTable([row({ sessionId: "ses_1", elapsedMs: 65_000 })], NOW + 500_000);
    expect(lines[1]).toContain(" 1m05s ");
  });

  test("pads the title column with short values without breaking the alignment", () => {
    const lines = formatTopTable([row({ sessionId: "ses_1", title: "short" })], NOW);
    expect(lines[1]?.trimEnd().endsWith("short")).toBe(true);
  });
});
