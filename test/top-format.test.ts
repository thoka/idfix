/**
 * Tests for the text snapshot of `oc-sub top --once`, with invented rows.
 * No server and no clock: the tests pass `nowMs` themselves.
 */
import { describe, expect, test } from "bun:test";
import stringWidth from "string-width";
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
    driver: "opencode",
    costKind: "real",
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
    // The title starts at the same display column in every line, also with icons.
    const titleStart = (line: string, title: string) => stringWidth(line) - stringWidth(title);
    expect(titleStart(lines[1] as string, "one")).toBe(titleStart(lines[0] as string, "title"));
    expect(titleStart(lines[2] as string, "two")).toBe(titleStart(lines[0] as string, "title"));
    // Without color, the state shows as a word column after the id.
    expect(lines[0]?.startsWith("  id     state")).toBe(true);
    expect(lines[1]?.startsWith("🔧ses_1  busy")).toBe(true);
    expect(lines[2]?.startsWith("🔎longer idle")).toBe(true);
    expect(lines[1]).toContain(" 0.1 ");
    expect(lines[1]).toContain("1m05s");
    expect(lines[1]).toContain(" 5s ");
    expect(lines[1]).toContain("6.3k");
    expect(lines[1]).toContain("10%");
    expect(lines[1]).not.toContain("$");
  });

  test("shows the CODE, the worktree, and the project only with showProject", () => {
    const rows = [
      row({ sessionId: "ses_abcdef123456", directory: "/home/user/src/idfix/.worktrees/8d" }),
      row({ sessionId: "ses_zzzzzz654321", directory: "/home/user/src/idfix" }),
    ];
    const hidden = formatTopTable(rows, NOW, { color: true });
    expect(hidden[0]?.startsWith("  id     where")).toBe(true);
    // With color, the id carries the state color and the state column is gone.
    expect(hidden[1]?.startsWith("\u001b[32m🔧123456\u001b[39m 8d    ")).toBe(true);
    expect(hidden.join("\n")).not.toContain("busy");
    expect(hidden.join("\n")).not.toContain("opsub");
    // Without a configured name, the full project name shows, with the worktree in one cell.
    const shown = formatTopTable(rows, NOW, { showProject: true });
    expect(shown[1]?.startsWith("🔧123456 busy  idfix/8d ")).toBe(true);
    expect(shown[2]?.startsWith("🔧654321 busy  idfix    ")).toBe(true);
    // With a configured name, the shortName shows.
    const short = formatTopTable(rows, NOW, { showProject: true, projectName: () => "opsub" });
    expect(short[1]?.startsWith("🔧123456 busy  opsub/8d ")).toBe(true);
  });

  test("keeps a minimum title with a long worktree name", () => {
    const longFolder = `/repo/.worktrees/${"w".repeat(100)}`;
    const lines = formatTopTable([row({ sessionId: "ses_1", directory: longFolder, title: "t".repeat(80) })], NOW, {
      width: 120,
    });
    // The title keeps at least 16 cells, even when the line gets wider.
    expect(stringWidth(lines[1] as string)).toBeGreaterThan(120);
    expect(lines[1]).toContain("t".repeat(16));
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
    for (const line of lines) expect(stringWidth(line)).toBeLessThanOrEqual(160);
    // The title gets exactly the space between the padded prefix and the width.
    const header = lines[0] as string;
    const prefix = stringWidth(header) - "title".length;
    expect(header.endsWith("title")).toBe(true);
    const xCount = (lines[1]?.match(/x+$/) ?? [""])[0]?.length ?? 0;
    expect(xCount).toBe(160 - prefix);
  });

  test("uses the elapsed time of the row, which stops for idle sessions", () => {
    const lines = formatTopTable([row({ sessionId: "ses_1", elapsedMs: 65_000 })], NOW + 500_000);
    expect(lines[1]).toContain("1m05s ");
  });

  test("pads the title column with short values without breaking the alignment", () => {
    const lines = formatTopTable([row({ sessionId: "ses_1", title: "short" })], NOW);
    expect(lines[1]?.trimEnd().endsWith("short")).toBe(true);
  });
});

describe("Claude rows in the snapshot (step 25g.2)", () => {
  const claude = (overrides: Partial<TopTableRow> & { sessionId: string }): TopTableRow =>
    row({ agent: "", driver: "claude", costKind: "apiEquivalent", cost: 0.43, ...overrides });

  test("an API price is gray with color and has a ~ without color", () => {
    const rows = [claude({ sessionId: "abc-111111" }), row({ sessionId: "ses_222222", cost: 0.43 })];
    const colored = formatTopTable(rows, NOW, { color: true });
    expect(colored[1]).toContain("\u001b[90m43\u001b[39m");
    expect(colored[2]).not.toContain("\u001b[90m");
    const plain = formatTopTable(rows, NOW);
    expect(plain[1]).toMatch(/^✳ 111111 busy +8d +~43 /);
    expect(plain[2]).toMatch(/^🔧222222 busy +8d +43 /);
  });

  test("a row without a price has an empty cost cell", () => {
    const plain = formatTopTable([claude({ sessionId: "abc-333333", costKind: "none", cost: 0 })], NOW);
    expect(plain[1]).toMatch(/^✳ 333333 busy +8d +1m05s /);
  });

  test("an ended row is gray as a whole", () => {
    const colored = formatTopTable([claude({ sessionId: "abc-444444", state: "ended" })], NOW, { color: true });
    expect(colored[1]?.startsWith("\u001b[90m✳ 444444")).toBe(true);
    expect(colored[1]?.endsWith("\u001b[39m")).toBe(true);
  });

  test("a waiting Claude row gets its waitingFor text as a pending line", () => {
    const lines = formatTopTable(
      [claude({ sessionId: "abc-555555", state: "waiting", waitingFor: "approve\n  Bash" })],
      NOW,
    );
    expect(lines.slice(1)).toEqual([expect.stringMatching(/^✳ 555555 waiting /), "  waiting for: approve Bash"]);
  });

  test("the ctx cell shows the window share", () => {
    const plain = formatTopTable([claude({ sessionId: "abc-666666", contextTokens: 123_000, contextWindow: 200_000 })], NOW);
    expect(plain[1]).toContain(" 123k 62% ");
  });
});
