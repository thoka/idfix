/**
 * Tests for the Ink view of `idfx top` with Claude rows (steps 25g.2 and
 * 25g.3), with a fake live source and a fake tmux runner, so no real
 * process starts.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { claudeDetail } from "../src/top/claude";
import { TopView, type ViewSource } from "../src/top/view";
import type { ClaudeRow } from "../src/claude/rows";
import type { PaneResult } from "../src/top/tmux";
import { claudeRowOf } from "./top-rows";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 50));

const waitingRow = () =>
  claudeRowOf("sess-abc123", {
    directory: "/repo",
    title: "claude work",
    state: "waiting",
    waitingFor: "approve Bash",
    contextTokens: 123_000,
  });

function fakeSource(row: ClaudeRow = waitingRow()): ViewSource {
  return {
    model: {
      rows: () => [row],
      session: (id) => (id === row.sessionId ? claudeDetail(row) : undefined),
    },
    onChange: () => {},
    servers: () => [],
    stop: () => {},
  };
}

describe("TopView with a Claude row", () => {
  test("shows the row and its detail, and o without a tmux pane only shows a note", async () => {
    const opened: string[] = [];
    const { lastFrame, stdin, unmount } = render(
      <TopView
        start={async () => fakeSource()}
        initialAll={false}
        scopeLabel="~/repo"
        nowMs={() => 0}
        redrawMs={60_000}
        openPane={async (id) => {
          opened.push(id);
          return { ok: true };
        }}
      />,
    );
    try {
      await tick();
      const frame = lastFrame() ?? "";
      expect(frame).toContain("✳ abc123");
      expect(frame).toContain("123k 62%");
      expect(frame).toContain("claude interactive  model claude-opus-5-5");
      expect(frame).toContain("waiting for: approve Bash");
      expect(frame).not.toContain("log:");

      stdin.write("o");
      await tick();
      expect(opened).toEqual([]);
      expect(lastFrame()).toContain("open: no tmux pane");
    } finally {
      unmount();
    }
  });
});

/** Press `o` on one Claude row, and return the argv that reached the tmux runner and the last frame. */
async function pressOpen(row: ClaudeRow, result: PaneResult | undefined): Promise<{ argvs: string[][]; frame: string }> {
  const argvs: string[][] = [];
  const opened: string[] = [];
  const { lastFrame, stdin, unmount } = render(
    <TopView
      start={async () => fakeSource(row)}
      initialAll={false}
      scopeLabel="~/repo"
      nowMs={() => 0}
      redrawMs={60_000}
      openPane={async (id) => {
        opened.push(id);
        return { ok: true };
      }}
      runTmux={async (argv) => {
        argvs.push(argv);
        return result;
      }}
    />,
  );
  try {
    await tick();
    stdin.write("o");
    await tick();
    expect(opened).toEqual([]);
    return { argvs, frame: lastFrame() ?? "" };
  } finally {
    unmount();
  }
}

describe("the key o on a Claude row", () => {
  test("a background session opens claude attach with its job ID in a new pane", async () => {
    const row = claudeRowOf("sess-bg0001", { kind: "background", jobId: "b3e132e9", state: "busy" });
    const { argvs, frame } = await pressOpen(row, { ok: true });
    expect(argvs).toHaveLength(1);
    const argv = argvs[0] ?? [];
    expect(argv.slice(0, 2)).toEqual(["tmux", "split-window"]);
    expect(argv.slice(3)).toEqual(["-c", process.cwd(), "claude", "attach", "b3e132e9"]);
    expect(frame).toContain("in a new tmux pane");
  });

  test("outside tmux, a background session shows the attach command", async () => {
    const row = claudeRowOf("sess-bg0002", { kind: "background", jobId: "b3e132e9", state: "busy" });
    const { frame } = await pressOpen(row, undefined);
    expect(frame).toContain("attach with: claude attach b3e132e9");
  });

  test("an interactive session in tmux switches to its pane", async () => {
    const row = claudeRowOf("sess-in0001", { tmux: "5:@5.%40", state: "idle" });
    const { argvs, frame } = await pressOpen(row, { ok: true });
    expect(argvs).toEqual([["tmux", "switch-client", "-t", "%40"]]);
    expect(frame).toContain("switched to tmux pane %40");
  });

  test("outside tmux, the switch shows a note", async () => {
    const row = claudeRowOf("sess-in0002", { tmux: "5:@5.%40", state: "idle" });
    const { frame } = await pressOpen(row, undefined);
    expect(frame).toContain("outside tmux");
  });

  test("a tmux error shows in the footer", async () => {
    const row = claudeRowOf("sess-in0003", { tmux: "5:@5.%40", state: "idle" });
    const { frame } = await pressOpen(row, { ok: false, error: "no current client" });
    expect(frame).toContain("tmux error: no current client");
  });

  test("an ended session opens nothing", async () => {
    const row = claudeRowOf("sess-end001", { tmux: "5:@5.%40", state: "ended" });
    const { argvs, frame } = await pressOpen(row, { ok: true });
    expect(argvs).toEqual([]);
    expect(frame).toContain("open: session ended");
  });
});

describe("the key h", () => {
  test("hides and shows the inactive rows, and the selection moves to a visible row", async () => {
    const live = claudeRowOf("sess-live01", { state: "busy", startTimeMs: 1 });
    const gone = claudeRowOf("sess-gone01", { state: "waiting", active: false, startTimeMs: 2 });
    const source: ViewSource = {
      model: {
        rows: () => [live, gone],
        session: (id) => [live, gone].map(claudeDetail).find((detail) => detail.sessionId === id),
      },
      onChange: () => {},
      servers: () => [],
      stop: () => {},
    };
    const { lastFrame, stdin, unmount } = render(
      <TopView start={async () => source} initialAll={false} scopeLabel="~/repo" nowMs={() => 0} redrawMs={60_000} />,
    );
    try {
      await tick();
      // Select the inactive row; its mark shows after the CODE.
      stdin.write("j");
      await tick();
      let frame = lastFrame() ?? "";
      expect(frame).toContain("gone01·");
      expect(frame).toContain("h: hide inactive");
      expect(frame).toContain("(no process)");

      stdin.write("h");
      await tick();
      frame = lastFrame() ?? "";
      expect(frame).not.toContain("gone01·");
      expect(frame).toContain("live01");
      expect(frame).toContain("h: show 1 inactive");
      expect(frame).toContain("1 session ");
      // The detail pane shows the remaining active row.
      expect(frame).not.toContain("(no process)");

      stdin.write("h");
      await tick();
      frame = lastFrame() ?? "";
      expect(frame).toContain("gone01·");
      expect(frame).toContain("h: hide inactive");
      expect(frame).not.toContain("(no process)");
    } finally {
      unmount();
    }
  });
});
