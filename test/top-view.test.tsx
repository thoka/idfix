/** Tests for the Ink view of `oc-sub top` with Claude rows (step 25g.2), with a fake live source. */
import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { claudeDetail } from "../src/top/claude";
import { TopView, type ViewSource } from "../src/top/view";
import { CLAUDE_OPEN_NOTE } from "../src/top/view-model";
import { claudeRowOf } from "./top-rows";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 50));

function fakeSource(): ViewSource {
  const row = claudeRowOf("sess-abc123", {
    directory: "/repo",
    title: "claude work",
    state: "waiting",
    waitingFor: "approve Bash",
    contextTokens: 123_000,
  });
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
  test("shows the row and its detail, and o only shows a note", async () => {
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
      expect(lastFrame()).toContain(CLAUDE_OPEN_NOTE);
    } finally {
      unmount();
    }
  });
});
