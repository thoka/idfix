/** `oc-sub say`: send a follow-up message into a session without waiting. */
import path from "node:path";
import { resolveServerUrl, type Env } from "./config";
import { assertOk, makeClient, requireServer, unwrap } from "./client";

export async function say(
  args: { url?: string; session: string; dir?: string; agent?: string; text: string },
  env: Env = process.env,
): Promise<number> {
  const baseUrl = resolveServerUrl(args.url, env);
  await requireServer(baseUrl, env);
  const directory = path.resolve(args.dir ?? process.cwd());
  const client = makeClient(baseUrl, env);

  let agent = args.agent;
  if (agent === undefined) {
    // Take the agent from the last user message of the session, so a follow-up
    // goes to the same agent as the brief.
    const messages = unwrap(
      await client.session.messages({ path: { id: args.session }, query: { directory } }),
      "list messages",
    );
    const lastUser = [...messages].reverse().find((entry) => entry.info.role === "user");
    if (lastUser === undefined || lastUser.info.role !== "user") {
      throw new Error(`session ${args.session} has no user message. Give --agent NAME`);
    }
    agent = lastUser.info.agent;
  }

  assertOk(
    await client.session.promptAsync({
      path: { id: args.session },
      query: { directory },
      body: {
        agent,
        parts: [{ type: "text", text: args.text }],
      },
    }),
    "send message",
  );
  console.log(`sent to ${args.session} (agent ${agent}). Watch it with: oc-sub watch ${args.session} --dir ${directory}`);
  return 0;
}
