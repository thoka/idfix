/** Tests for the merge of the Claude rows into the model of `top`. */
import { describe, expect, test } from "bun:test";
import { claudeDetail, scopeClaudeRows, sortTopRows, withClaudeRows } from "../src/top/claude";
import { createTopModel, type TopModel } from "../src/top/model";
import { claudeRowOf, openRow } from "./top-rows";

describe("sortTopRows", () => {
  test("waiting rows come first, ended rows last, the newest start first inside a group", () => {
    const rows = [
      claudeRowOf("ended-new", { state: "ended", startTimeMs: 50 }),
      openRow("busy-old", { startTimeMs: 10 }),
      claudeRowOf("wait-old", { state: "waiting", startTimeMs: 5 }),
      openRow("idle-new", { state: "idle", startTimeMs: 40 }),
      openRow("wait-new", { state: "waiting", startTimeMs: 30 }),
      claudeRowOf("ended-old", { state: "ended", startTimeMs: 1 }),
    ];
    expect(sortTopRows(rows).map((row) => row.sessionId)).toEqual([
      "wait-new",
      "wait-old",
      "idle-new",
      "busy-old",
      "ended-new",
      "ended-old",
    ]);
  });
});

describe("scopeClaudeRows", () => {
  const rows = [
    claudeRowOf("in", { directory: "/dv/idfix" }),
    claudeRowOf("tree", { directory: "/dv/idfix/.worktrees/25g2/src" }),
    claudeRowOf("out", { directory: "/dv/meta" }),
    claudeRowOf("prefix", { directory: "/dv/idfix-old" }),
  ];

  test("without --all only the folders of the project and its worktrees show", () => {
    const scope = ["/dv/idfix", "/dv/idfix/.worktrees/25g2"];
    expect(scopeClaudeRows(rows, scope).map((row) => row.sessionId)).toEqual(["in", "tree"]);
  });

  test("with --all every row shows", () => {
    expect(scopeClaudeRows(rows, undefined)).toHaveLength(4);
  });
});

describe("claudeDetail", () => {
  test("the subagents become the children, without log and requests", () => {
    const detail = claudeDetail(claudeRowOf("p", { children: [claudeRowOf("c", { agent: "Explore" })] }));
    expect(detail.log).toEqual([]);
    expect(detail.pending).toEqual([]);
    expect(detail.children.map((child) => [child.sessionId, child.agent, child.children])).toEqual([["c", "Explore", []]]);
  });
});

/** An opencode model with one busy session in `/repo`. */
function opencodeModel(): TopModel {
  const model = createTopModel();
  model.seed(
    "http://127.0.0.1:1",
    {
      session: {
        id: "ses_open",
        projectID: "p",
        directory: "/repo",
        title: "opencode run",
        version: "1",
        time: { created: 100, updated: 100 },
      },
      status: { type: "busy" },
      messages: [],
      pending: [],
    },
    1_000,
  );
  return model;
}

describe("withClaudeRows", () => {
  test("rows merges both kinds in the sort order of top", () => {
    let claude = [claudeRowOf("c-wait", { state: "waiting", startTimeMs: 1 }), claudeRowOf("c-ended", { state: "ended", startTimeMs: 999 })];
    const model = withClaudeRows(opencodeModel(), () => claude);
    expect(model.rows(1_000).map((row) => row.sessionId)).toEqual(["c-wait", "ses_open", "c-ended"]);
    // The getter reads the current rows on each call.
    claude = [];
    expect(model.rows(1_000).map((row) => row.sessionId)).toEqual(["ses_open"]);
  });

  test("session finds the opencode detail first, then the Claude detail", () => {
    const model = withClaudeRows(opencodeModel(), () => [claudeRowOf("c1", { children: [claudeRowOf("c1-sub")] })]);
    expect(model.session("ses_open")?.driver).toBe("opencode");
    expect(model.session("c1")?.children.map((child) => child.sessionId)).toEqual(["c1-sub"]);
    expect(model.session("nope")).toBeUndefined();
  });
});
