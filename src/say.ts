/** `oc-sub say`: send a follow-up message into a session without waiting. */
import path from "node:path";
import type { Env } from "./config";
import type { OpencodeClient } from "@opencode-ai/sdk";
import { splitModel } from "./run";
import { resolveCommandUrl } from "./sandbox";
import { assertOk, makeClient, requireServer, unwrap } from "./client";
import { answerHint, filterRequests, formatRequest, listPendingRequests } from "./requests";
import { childIdsOf, collectDescendants } from "./tree";

/**
 * Warn on stderr when the session or one of its subagent sessions waits for an
 * answer to a question or permission request: the queued message reaches the
 * agent only after the answer. A failed list call prints no warning, because
 * the warning is a comfort and must never block the message.
 */
async function warnAboutPendingRequests(
  baseUrl: string,
  client: OpencodeClient,
  sessionId: string,
  directory: string,
  env: Env,
): Promise<void> {
  try {
    const treeIds = await collectDescendants(sessionId, childIdsOf(client, directory));
    const sessions = new Set([sessionId, ...treeIds]);
    const pending = filterRequests(await listPendingRequests(baseUrl, directory, env), sessions);
    if (pending.length === 0) return;
    console.error(
      `session ${sessionId} waits for an answer. The message stays queued until the request has an answer.`,
    );
    for (const item of pending) {
      for (const line of formatRequest(item)) console.error(`  ${line}`);
      console.error(`  ${answerHint(item, directory)}`);
    }
  } catch {
    // Comfort only: send the message even when the list call fails.
  }
}

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

  await warnAboutPendingRequests(baseUrl, client, args.session, directory, env);

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
