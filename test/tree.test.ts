import { describe, expect, test } from "bun:test";
import type { Message, OpencodeClient } from "@opencode-ai/sdk";
import { collectDescendants, loadSessionTree, treeUsage } from "../src/tree";
import type { MessageEntry } from "../src/summary";

/** A child lookup over invented edges. Sessions without an entry have no children. */
function listChildrenOf(edges: Record<string, string[]>): (id: string) => Promise<string[]> {
  return async (id) => edges[id] ?? [];
}

describe("collectDescendants", () => {
  test("finds children and grandchildren, parents before children", async () => {
    const edges = { root: ["b", "c"], b: ["d"], c: [], d: [] };
    expect(await collectDescendants("root", listChildrenOf(edges))).toEqual(["b", "c", "d"]);
  });

  test("a session without children has no descendants", async () => {
    expect(await collectDescendants("root", listChildrenOf({}))).toEqual([]);
  });

  test("stops at a cycle back to the root", async () => {
    const edges = { root: ["b"], b: ["root", "c"], c: [] };
    expect(await collectDescendants("root", listChildrenOf(edges))).toEqual(["b", "c"]);
  });

  test("stops at a cycle among the descendants", async () => {
    const edges = { root: ["b"], b: ["c"], c: ["b"] };
    expect(await collectDescendants("root", listChildrenOf(edges))).toEqual(["b", "c"]);
  });

  test("a child that two parents list is visited once", async () => {
    const edges = { root: ["b", "c"], b: ["c"], c: [] };
    expect(await collectDescendants("root", listChildrenOf(edges))).toEqual(["b", "c"]);
  });
});

/** One assistant message with invented cost and tokens. */
function assistant(
  sessionId: string,
  cost: number,
  tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } },
): MessageEntry {
  const info: Extract<Message, { role: "assistant" }> = {
    id: `msg_${sessionId}`,
    sessionID: sessionId,
    role: "assistant",
    time: { created: 1 },
    parentID: "msg_0",
    modelID: "m",
    providerID: "p",
    mode: "primary",
    path: { cwd: "/x", root: "/x" },
    cost,
    tokens,
  };
  return { info, parts: [] };
}

type StubOptions = { path: { id: string } };
type StubResult<T> = { data?: T; error?: unknown };

/** An SDK client stub over invented children edges and per-session messages. */
function stubClient(children: Record<string, string[]>, messages: Record<string, MessageEntry[]>): OpencodeClient {
  const stub = {
    session: {
      children: async (options: StubOptions): Promise<StubResult<{ id: string }[]>> => ({
        data: (children[options.path.id] ?? []).map((id) => ({ id })),
      }),
      messages: async (options: StubOptions): Promise<StubResult<MessageEntry[]>> => ({
        data: messages[options.path.id] ?? [],
      }),
    },
  };
  return stub as unknown as OpencodeClient;
}

describe("loadSessionTree", () => {
  test("loads the main session and the messages of children and grandchildren", async () => {
    const client = stubClient(
      { main: ["a"], a: ["g"], g: [] },
      {
        main: [assistant("main", 0.01, { input: 10, output: 20, reasoning: 0, cache: { read: 0, write: 0 } })],
        a: [assistant("a", 0.02, { input: 100, output: 50, reasoning: 1, cache: { read: 2, write: 3 } })],
        g: [assistant("g", 0.04, { input: 5, output: 1, reasoning: 0, cache: { read: 0, write: 0 } })],
      },
    );
    const tree = await loadSessionTree(client, "main", "/dir");
    expect(tree.main).toHaveLength(1);
    expect(tree.descendants).toHaveLength(2);
    const totals = treeUsage(tree);
    expect(totals.subagentSessions).toBe(2);
    expect(totals.subagents.cost).toBeCloseTo(0.06, 10);
    expect(totals.subagents.tokens.input).toBe(105);
    expect(totals.total.cost).toBeCloseTo(0.07, 10);
    expect(totals.total.tokens.input).toBe(115);
  });

  test("a session without children keeps an empty subagent part", async () => {
    const client = stubClient(
      {},
      { main: [assistant("main", 0.01, { input: 10, output: 20, reasoning: 0, cache: { read: 0, write: 0 } })] },
    );
    const tree = await loadSessionTree(client, "main", "/dir");
    expect(tree.descendants).toEqual([]);
    const totals = treeUsage(tree);
    expect(totals.subagentSessions).toBe(0);
    expect(totals.total.cost).toBeCloseTo(0.01, 10);
    expect(totals.subagents.cost).toBe(0);
  });
});

describe("treeUsage", () => {
  test("splits the usage of the main session from the usage of the descendants", () => {
    const totals = treeUsage({
      main: [assistant("main", 0.01, { input: 10, output: 20, reasoning: 2, cache: { read: 3, write: 4 } })],
      descendants: [
        [assistant("a", 0.02, { input: 100, output: 50, reasoning: 1, cache: { read: 2, write: 3 } })],
        [assistant("b", 0.04, { input: 5, output: 1, reasoning: 0, cache: { read: 0, write: 0 } })],
      ],
    });
    expect(totals.subagentSessions).toBe(2);
    expect(totals.subagents.cost).toBeCloseTo(0.06, 10);
    expect(totals.subagents.tokens.cache.read).toBe(2);
    expect(totals.total.cost).toBeCloseTo(0.07, 10);
    expect(totals.total.tokens.reasoning).toBe(3);
    expect(totals.total.tokens.cache.write).toBe(7);
  });
});
