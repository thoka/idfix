/**
 * Tests for the Ink view of `oc-sub top` (step 8g), with ink-testing-library
 * and a fake live source. No server and no real stream.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import type { LiveServer } from "../src/top/live";
import type { SessionDetail, SessionRow } from "../src/top/model";
import { TopView, type ViewSource } from "../src/top/view";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 50));

function row(sessionId: string, overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    sessionId,
    server: "http://127.0.0.1:18768",
    directory: "/home/u/dv/opencode-subagents/.worktrees/8g",
    title: `title ${sessionId}`,
    agent: "coder",
    state: "busy",
    startTimeMs: 0,
    elapsedMs: 65_000,
    msSinceEvent: 1_000,
    steps: 1,
    toolCalls: 2,
    contextTokens: 1000,
    cost: 0.01,
    outputTokens: 0,
    reasoningTokens: 0,
    reasoningShare: 0,
    lastStepReasoning: 0,
    ...overrides,
  };
}

type FakeSource = ViewSource & { setRows(rows: SessionRow[]): void; stopped: boolean };

function fakeSource(initial: SessionRow[]): FakeSource {
  let rows = initial;
  const listeners: Array<() => void> = [];
  const servers: LiveServer[] = [
    { project: "opencode-subagents", url: "http://127.0.0.1:18768", sandbox: true, state: "up" },
  ];
  const source: FakeSource = {
    stopped: false,
    model: {
      rows: () => rows,
      session: (id): SessionDetail | undefined => {
        const found = rows.find((candidate) => candidate.sessionId === id);
        return found === undefined
          ? undefined
          : { ...found, log: [{ kind: "tool", line: `tool bash: in ${id}` }], pending: [], children: [] };
      },
    },
    onChange: (listener) => {
      listeners.push(listener);
    },
    servers: () => servers,
    stop: () => {
      source.stopped = true;
    },
    setRows: (next) => {
      rows = next;
      for (const listener of listeners) listener();
    },
  };
  return source;
}

describe("TopView", () => {
  test("shows the rows, the detail of the first row, and the footer", async () => {
    const source = fakeSource([row("ses_aaaaaa111111"), row("ses_bbbbbb222222", { state: "waiting" })]);
    const { lastFrame, unmount } = render(
      <TopView start={async () => source} initialAll={false} scopeLabel="~/dv/opencode-subagents" />,
    );
    await tick();
    const frame = lastFrame() ?? "";
    expect(frame).toMatch(/session +worktree +agent +state/);
    expect(frame.split("\n")[0]).not.toContain("project");
    expect(frame).toContain("111111   8g        coder  busy");
    expect(frame).toContain("222222   8g        coder  waiting");
    expect(frame).toContain("tool bash: in ses_aaaaaa111111");
    expect(frame).toContain("servers: opencode-subagents :18768 up");
    expect(frame).toContain("2 sessions  cost $0.0200  scope: ~/dv/opencode-subagents");
    expect(frame).toContain("q: quit");
    unmount();
  });

  test("j and k move the selection, which stays on its session when the rows change order", async () => {
    const source = fakeSource([row("ses_a00001"), row("ses_b00002"), row("ses_c00003")]);
    const { lastFrame, stdin, unmount } = render(<TopView start={async () => source} initialAll={false} scopeLabel="~" />);
    await tick();
    stdin.write("j");
    await tick();
    expect(lastFrame()).toContain("tool bash: in ses_b00002");
    stdin.write("j");
    await tick();
    stdin.write("k");
    await tick();
    expect(lastFrame()).toContain("tool bash: in ses_b00002");
    source.setRows([row("ses_c00003"), row("ses_b00002"), row("ses_a00001")]);
    await tick();
    expect(lastFrame()).toContain("tool bash: in ses_b00002");
    // The arrow keys move too.
    stdin.write("\u001B[A");
    await tick();
    expect(lastFrame()).toContain("tool bash: in ses_c00003");
    unmount();
  });

  test("o shows the attach command of the selected session in the footer", async () => {
    const source = fakeSource([row("ses_a0000ABCDEF")]);
    const { lastFrame, stdin, unmount } = render(<TopView start={async () => source} initialAll={false} scopeLabel="~" />);
    await tick();
    stdin.write("o");
    await tick();
    expect(lastFrame()).toContain("attach with: oc-sub attach ABCDEF");
    unmount();
  });

  test("a switches to all projects and back, and stops the old source", async () => {
    const scopes: boolean[] = [];
    const sources: FakeSource[] = [];
    const start = async (all: boolean) => {
      scopes.push(all);
      const source = fakeSource([row("ses_a00001")]);
      sources.push(source);
      return source;
    };
    const { lastFrame, stdin, unmount } = render(<TopView start={start} initialAll={false} scopeLabel="~/dv/p" />);
    await tick();
    stdin.write("a");
    await tick();
    expect(scopes).toEqual([false, true]);
    expect(sources[0]?.stopped).toBe(true);
    expect(lastFrame()).toMatch(/session +project +worktree/);
    expect(lastFrame()).toContain("opsub");
    expect(lastFrame()).toContain("scope: all projects");
    stdin.write("a");
    await tick();
    expect(scopes).toEqual([false, true, false]);
    unmount();
    expect(sources[2]?.stopped).toBe(true);
  });

  test("shows no sessions, and q quits and stops the source", async () => {
    const source = fakeSource([]);
    const { lastFrame, stdin } = render(<TopView start={async () => source} initialAll={false} scopeLabel="~" />);
    await tick();
    expect(lastFrame()).toContain("no sessions");
    expect(lastFrame()).toContain("no session selected");
    stdin.write("q");
    await tick();
    expect(source.stopped).toBe(true);
  });

  test("shows a loading line until the source has started", async () => {
    const { lastFrame, unmount } = render(
      <TopView start={() => new Promise<ViewSource>(() => {})} initialAll={false} scopeLabel="~" />,
    );
    await tick();
    expect(lastFrame()).toContain("loading the servers ...");
    unmount();
  });
});
