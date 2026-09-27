/** `oc-sub log`: final assistant text plus the cost and token summary. */
import path from "node:path";
import { resolveServerUrl, type Env } from "./config";
import { makeClient, unwrap } from "./client";
import { finalAssistantText, formatSummary, summarizeMessages } from "./summary";

export async function log(args: { url?: string; session: string; dir?: string }, env: Env = process.env): Promise<number> {
  const baseUrl = resolveServerUrl(args.url, env);
  const directory = path.resolve(args.dir ?? process.cwd());
  const client = makeClient(baseUrl, env);

  const messages = unwrap(
    await client.session.messages({ path: { id: args.session }, query: { directory } }),
    "load messages",
  );

  const text = finalAssistantText(messages);
  if (text !== null) {
    console.log(text);
    console.log("");
  } else {
    console.error("no assistant text in this session");
  }
  console.log(formatSummary(summarizeMessages(messages)));
  return 0;
}
