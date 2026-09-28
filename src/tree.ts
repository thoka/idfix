/** The session tree: one session and all of its descendant sessions. */
import type { OpencodeClient } from "@opencode-ai/sdk";
import { unwrap } from "./client";
import type { MessageEntry, UsageTotals } from "./summary";
import { summarizeMessages, summarizeTree } from "./summary";

/**
 * Every descendant of a session: the direct children, their children, and so
 * on, parents before children. `listChildren` returns the child session IDs
 * of one session. Each ID is visited once, so a cycle cannot loop forever.
 */
export async function collectDescendants(
  rootId: string,
  listChildren: (id: string) => Promise<readonly string[]>,
): Promise<string[]> {
  const visited = new Set<string>([rootId]);
  const descendants: string[] = [];
  let frontier = await listChildren(rootId);
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const id of frontier) {
      if (visited.has(id)) continue;
      visited.add(id);
      descendants.push(id);
      next.push(...(await listChildren(id)));
    }
    frontier = next;
  }
  return descendants;
}

/** The child lookup of an SDK client, for `collectDescendants`. */
export function childIdsOf(
  client: OpencodeClient,
  directory: string,
): (id: string) => Promise<readonly string[]> {
  return async (id) =>
    unwrap(
      await client.session.children({ path: { id }, query: { directory } }),
      "list child sessions",
    ).map((session) => session.id);
}

/** Messages of one session and of all of its descendant sessions. */
export type SessionTree = {
  /** Messages of the main session, in order. */
  main: MessageEntry[];
  /** Messages of each descendant session, in discovery order. */
  descendants: MessageEntry[][];
};

/** Load the messages of a session and of all of its descendant sessions. */
export async function loadSessionTree(
  client: OpencodeClient,
  sessionId: string,
  directory: string,
): Promise<SessionTree> {
  const messagesOf = async (id: string): Promise<MessageEntry[]> =>
    unwrap(await client.session.messages({ path: { id }, query: { directory } }), "load messages");
  const [main, ids] = await Promise.all([
    messagesOf(sessionId),
    collectDescendants(sessionId, childIdsOf(client, directory)),
  ]);
  const descendants = await Promise.all(ids.map(messagesOf));
  return { main, descendants };
}

/** Cost and token totals over a loaded session tree. */
export function treeUsage(tree: SessionTree): UsageTotals {
  return summarizeTree(
    summarizeMessages(tree.main),
    tree.descendants.map((messages) => summarizeMessages(messages)),
  );
}
