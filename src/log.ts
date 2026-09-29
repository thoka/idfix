/** `oc-sub log`: final assistant text plus the cost and token summary. */
import path from "node:path";
import { resolveServerUrl, type Env } from "./config";
import { makeClient, requireServer } from "./client";
import { realCostOutput } from "./realcost";
import { finalAssistantText, formatTotals } from "./summary";
import { loadSessionTree, treeUsage } from "./tree";

export async function log(args: { url?: string; session: string; dir?: string }, env: Env = process.env): Promise<number> {
  const baseUrl = resolveServerUrl(args.url, env);
  await requireServer(baseUrl, env);
  const directory = path.resolve(args.dir ?? process.cwd());
  const client = makeClient(baseUrl, env);

  // The messages of the session and of all of its subagent sessions.
  const tree = await loadSessionTree(client, args.session, directory);

  const text = finalAssistantText(tree.main);
  if (text !== null) {
    console.log(text);
    console.log("");
  } else {
    console.error("no assistant text in this session");
  }
  console.log(formatTotals(treeUsage(tree)));
  // The real cost from OpenRouter, below the estimated cost line.
  const realCost = await realCostOutput(client, args.session, env);
  if (realCost !== null) console.log(realCost);
  return 0;
}
