/** Tests for the pure logic of the live view of `oc-sub top` (step 8g). */
import { describe, expect, test } from "bun:test";
import type { SessionDetail, SessionRow } from "../src/top/model";
import type { QuestionRequest } from "../src/requests";
import {
  attachCommand,
  detailLines,
  firstVisibleRow,
  footerLines,
  KEY_HELP,
  moveSelection,
  resolveSelection,
  screenLayout,
  serverLabel,
} from "../src/top/view-model";
import { splitFlag, tmuxAttachArgv } from "../src/top/tmux";

function row(sessionId: string, overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    sessionId,
    server: "http://127.0.0.1:18768",
    directory: "/repo",
    title: `title ${sessionId}`,
    agent: "coder",
    state: "busy",
    startTimeMs: 0,
    elapsedMs: 0,
    msSinceEvent: 0,
    steps: 0,
    toolCalls: 0,
    contextTokens: 0,
    cost: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    reasoningShare: 0,
    lastStepReasoning: 0,
    ...overrides,
  };
}

function detail(sessionId: string, overrides: Partial<SessionDetail> = {}): SessionDetail {
  return { ...row(sessionId), log: [], pending: [], children: [], ...overrides };
}

const rows = [row("ses_a"), row("ses_b"), row("ses_c")];

describe("selection", () => {
  test("without a selection, the first row is selected", () => {
    expect(resolveSelection(rows, { id: undefined, index: 0 })).toEqual({ id: "ses_a", index: 0 });
  });

  test("the selection stays on the same session when the rows change order", () => {
    const reordered = [row("ses_c"), row("ses_a"), row("ses_b")];
    expect(resolveSelection(reordered, { id: "ses_b", index: 1 })).toEqual({ id: "ses_b", index: 2 });
  });

  test("a gone session hands the selection to the row at the same index, or the last row", () => {
    expect(resolveSelection([row("ses_a"), row("ses_c")], { id: "ses_b", index: 1 })).toEqual({ id: "ses_c", index: 1 });
    expect(resolveSelection([row("ses_a")], { id: "ses_c", index: 2 })).toEqual({ id: "ses_a", index: 0 });
    expect(resolveSelection([], { id: "ses_a", index: 0 })).toEqual({ id: undefined, index: 0 });
  });

  test("moving stops at the first and the last row", () => {
    let selection = moveSelection(rows, { id: "ses_a", index: 0 }, 1);
    expect(selection.id).toBe("ses_b");
    selection = moveSelection(rows, selection, 5);
    expect(selection).toEqual({ id: "ses_c", index: 2 });
    selection = moveSelection(rows, selection, -9);
    expect(selection).toEqual({ id: "ses_a", index: 0 });
    expect(moveSelection([], selection, 1)).toEqual({ id: undefined, index: 0 });
  });
});

describe("firstVisibleRow", () => {
  test("shows all rows when they fit", () => {
    expect(firstVisibleRow(3, 2, 10)).toBe(0);
  });

  test("keeps the selected row near the middle and inside the table", () => {
    expect(firstVisibleRow(100, 50, 10)).toBe(45);
    expect(firstVisibleRow(100, 2, 10)).toBe(0);
    expect(firstVisibleRow(100, 99, 10)).toBe(90);
  });
});

describe("screenLayout", () => {
  test("the parts and their fixed lines fit into the height, with one line to spare", () => {
    for (const height of [10, 24, 30, 60]) {
      const layout = screenLayout(height);
      const used = 1 + layout.tableRows + 1 + layout.detailLines + layout.footerLines;
      expect(used).toBeLessThanOrEqual(height - 1);
      expect(layout.tableRows).toBeGreaterThan(0);
    }
  });
});

const question = {
  kind: "question" as const,
  request: {
    id: "que_1",
    sessionID: "ses_child",
    questions: [{ question: "Delete build/tmp.txt?", header: "Delete file", options: [] }],
  } as QuestionRequest,
};

describe("detailLines", () => {
  test("without a session", () => {
    expect(detailLines(undefined, 5)).toEqual([{ text: "no session selected", tone: "dim" }]);
    expect(detailLines(undefined, 0)).toEqual([]);
  });

  test("shows the head, the pending requests of the tree, the subagent tree, and the log", () => {
    const grandchild = detail("ses_grand000001", { agent: "explore", state: "idle", title: "look" });
    const child = detail("ses_child00001", { pending: [question], children: [grandchild], state: "waiting", title: "sub" });
    const second = detail("ses_second0001", { title: "two" });
    const parent = detail("ses_parent0001", {
      children: [child, second],
      log: [
        { kind: "tool", line: "tool bash: ls" },
        { kind: "tool-failed", line: "tool bash failed: nope" },
      ],
    });
    const texts = detailLines(parent, 20).map((line) => line.text);
    expect(texts).toEqual([
      "nt0001  coder  busy  title ses_parent0001",
      "pending:",
      "  question que_1 in ses_child",
      "    1. [Delete file] Delete build/tmp.txt?",
      "subagents:",
      "  ├─ d00001  coder  waiting  sub",
      "  │  └─ 000001  explore  idle  look",
      "  └─ nd0001  coder  busy  two",
      "log:",
      "  tool bash: ls",
      "  tool bash failed: nope",
    ]);
    expect(detailLines(parent, 20).at(-1)?.tone).toBe("error");
  });

  test("the log keeps its newest lines when space runs out", () => {
    const log = Array.from({ length: 20 }, (_, i) => ({ kind: "tool" as const, line: `event ${i}` }));
    const lines = detailLines(detail("ses_x", { log }), 5);
    expect(lines.map((line) => line.text)).toEqual(["ses_x  coder  busy  title ses_x", "log:", "  event 17", "  event 18", "  event 19"]);
  });

  test("a session without events says so", () => {
    expect(detailLines(detail("ses_x"), 5).at(-1)).toEqual({ text: "  no events yet", tone: "dim" });
  });
});

describe("footer", () => {
  test("the attach command uses the CODE", () => {
    expect(attachCommand("ses_2a3b4cABCDEF")).toBe("oc-sub attach ABCDEF");
  });

  test("the key help names o: attach", () => {
    expect(KEY_HELP).toContain("o: attach ");
    expect(KEY_HELP).not.toContain("attach command");
  });

  test("names each server with its project, port, and state", () => {
    expect(serverLabel({ project: null, url: "http://127.0.0.1:8767", sandbox: false, state: "down" })).toBe("host :8767 down");
    expect(serverLabel({ project: "idfix", url: "http://127.0.0.1:18768", sandbox: true, state: "reconnecting" })).toBe(
      "idfix :18768 reconnecting",
    );
  });

  test("shows the servers, the totals, the scope, and the key help or a message", () => {
    const servers = [{ project: null, url: "http://127.0.0.1:8767", sandbox: false, state: "up" as const }];
    const footer = footerLines({
      servers,
      rows: [row("ses_a", { cost: 0.01 }), row("ses_b", { cost: 0.0025 })],
      all: false,
      scopeLabel: "~/dv/p",
    });
    expect(footer).toEqual(["servers: host :8767 up", "2 sessions  cost $0.0125  scope: ~/dv/p", KEY_HELP]);
    const withMessage = footerLines({ servers: [], rows: [row("ses_a")], all: true, scopeLabel: "~/dv/p", message: "hi" });
    expect(withMessage).toEqual(["servers: no known server", "1 session  cost $0.0000  scope: all projects", "hi"]);
  });
});

describe("tmux pane", () => {
  test("splitFlag follows the aspect ratio of the pane", () => {
    expect(splitFlag(200, 50)).toBe("-h");
    expect(splitFlag(100, 50)).toBe("-v");
    expect(splitFlag(80, 60)).toBe("-v");
  });

  test("tmuxAttachArgv builds the split-window command with the full session ID", () => {
    expect(tmuxAttachArgv(["bun", "src/cli.ts"], "ses_2a3b4cABCDEF", "/repo", { columns: 200, rows: 50 })).toEqual([
      "tmux",
      "split-window",
      "-h",
      "-c",
      "/repo",
      "bun",
      "src/cli.ts",
      "attach",
      "ses_2a3b4cABCDEF",
    ]);
    expect(tmuxAttachArgv(["bun", "src/cli.ts"], "ses_x", "/repo", { columns: 80, rows: 60 })[2]).toBe("-v");
  });
});
