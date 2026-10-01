/** `oc-sub say`: send a follow-up message into a session without waiting. */
import path from "node:path";
import type { Env } from "./config";
import { splitModel } from "./run";
import { resolveCommandUrl } from "./sandbox";
import { assertOk, makeClient, requireServer, unwrap } from "./client";

export async function say(
  args: { url?: string; session: string; dir?: string; agent?: string; model?: string; text: string },
  env: Env = process.env,
): Promise<number> {
  const baseUrl = resolveCommandUrl(args.url, env, args.dir);
  await requireServer(baseUrl, env);
  const directory = path.resolve(args.dir ?? process.cwd());
  const client = makeClient(baseUrl, env);

  let agent = args.agent;
  let model = args.model === undefined ? undefined : splitModel(args.model);
  if (agent === undefined || model === undefined) {
    // Take what the last user message of the session used, so a follow-up
    // goes to the same agent and model as the brief.
    const messages = unwrap(
      await client.session.messages({ path: { id: args.session }, query: { directory } }),
      "list messages",
    );
    const lastUser = [...messages].reverse().find((entry) => entry.info.role === "user");
    const found = lastUser !== undefined && lastUser.info.role === "user" ? lastUser.info : undefined;
    if (found === undefined && agent === undefined) {
      throw new Error(`session ${args.session} has no user message. Give --agent NAME`);
    }
    if (agent === undefined && found !== undefined) agent = found.agent;
    if (model === undefined && found?.model !== undefined) {
      model = {
        providerID: found.model.providerID,
        modelID: found.model.modelID,
      };
    }
  }

  assertOk(
    await client.session.promptAsync({
      path: { id: args.session },
      query: { directory },
      body: {
        agent,
        parts: [{ type: "text", text: args.text }],
        ...(model === undefined ? {} : { model }),
      },
    }),
    "send message",
  );
  const modelText = model === undefined ? "" : `, model ${model.providerID}/${model.modelID}`;
  console.log(
    `sent to ${args.session} (agent ${agent}${modelText}). Watch it with: oc-sub watch ${args.session} --dir ${directory}`,
  );
  return 0;
}
