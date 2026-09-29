/** `oc-sub abort`: abort a running session. */
import path from "node:path";
import type { Env } from "./config";
import { resolveCommandUrl } from "./sandbox";
import { assertOk, makeClient, requireServer } from "./client";

export async function abort(args: { url?: string; session: string; dir?: string }, env: Env = process.env): Promise<number> {
  const baseUrl = resolveCommandUrl(args.url, env, args.dir);
  await requireServer(baseUrl, env);
  const directory = path.resolve(args.dir ?? process.cwd());
  const client = makeClient(baseUrl, env);

  assertOk(
    await client.session.abort({ path: { id: args.session }, query: { directory } }),
    "abort session",
  );
  console.log(`aborted ${args.session}`);
  return 0;
}
