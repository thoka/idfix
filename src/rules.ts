/** `oc-sub ping --rules`: does the agent on the server see the shared rules? */
import path from "node:path";
import type { OpencodeClient } from "@opencode-ai/sdk";
import { assertOk, makeClient, requireServer, unwrap } from "./client";
import { type Env } from "./config";
import { readTextFile } from "./keys";
import { resolveCommandUrl } from "./sandbox";
import { SHARED_DIR_HINT, SHARED_DIR_UNSET, firstHeading, sharedAgentsFile } from "./shared";
import { formatCost, summarizeMessages, finalAssistantText, type MessageEntry } from "./summary";

/**
 * The prompt of the check. The agent replies with the first heading of the
 * shared rules file, or NONE. Chosen after real runs on 2026-09-30: a prompt
 * that asked for "the first heading of your global rules" was unreliable,
 * because the model mixed the file with the project rules. Naming "a custom
 * instructions file named AGENTS.md that is not part of this project" made
 * the reply correct in 3 of 3 real runs with the flash model, and the model
 * replied NONE when no such file was loaded. The prompt uses low reasoning
 * effort (see skills/oc-sub/reference.md), which the tests also used.
 */
export const RULES_PROMPT =
  "Among the rules loaded into your context, one file is a custom instructions file named AGENTS.md " +
  "that is not part of this project. Reply with the first line in that file that starts with '# ', " +
  "verbatim, or reply NONE if there is no such file. Nothing else.";

/** The agent that answers the rules prompt. */
export const RULES_AGENT = "researcher";

/**
 * The variant with low reasoning effort that opencode 1.18.32 accepts in the
 * prompt body. The generated SDK type omits the field, so the calls cast it.
 */
export const RULES_VARIANT = "low";

/** The parts of the rules check that the tests replace. */
export type RulesClient = {
  /** Creates a session and returns its ID. */
  createSession: (directory: string) => Promise<string>;
  /** Sends the prompt and waits for the reply. */
  prompt: (sessionId: string, directory: string, text: string) => Promise<void>;
  /** The messages of the session, for the cost and the reply. */
  messages: (sessionId: string, directory: string) => Promise<MessageEntry[]>;
  /** Deletes the session. Returns whether it worked. */
  deleteSession: (sessionId: string, directory: string) => Promise<boolean>;
};

export type RulesDeps = {
  /** The content of a file, or null when it is missing or unreadable. */
  readText: (file: string) => Promise<string | null>;
  /** Fails when no usable server answers on the URL. */
  checkServer: (baseUrl: string, env: Env) => Promise<void>;
  /** Builds the client for a server URL. */
  client: (baseUrl: string, env: Env) => RulesClient;
};

function sdkClient(client: OpencodeClient): RulesClient {
  return {
    createSession: async (directory) => {
      const created = unwrap(await client.session.create({ query: { directory } }), "create session");
      return created.id;
    },
    prompt: async (sessionId, directory, text) => {
      // The `variant` field is missing from the generated type of 1.18.32.
      const body = {
        agent: RULES_AGENT,
        variant: RULES_VARIANT,
        parts: [{ type: "text", text }],
      } as unknown as Parameters<typeof client.session.prompt>[0]["body"];
      assertOk(await client.session.prompt({ path: { id: sessionId }, query: { directory }, body }), "send prompt");
    },
    messages: async (sessionId, directory) =>
      unwrap(await client.session.messages({ path: { id: sessionId }, query: { directory } }), "load messages"),
    deleteSession: async (sessionId, directory) => {
      try {
        assertOk(await client.session.delete({ path: { id: sessionId }, query: { directory } }), "delete session");
        return true;
      } catch {
        return false;
      }
    },
  };
}

const defaultDeps: RulesDeps = {
  readText: readTextFile,
  checkServer: requireServer,
  client: (baseUrl, env) => sdkClient(makeClient(baseUrl, env)),
};

/**
 * `oc-sub ping --rules`: reads the first heading of the shared AGENTS.md on
 * the host, asks the agent on the server for it, and compares. Prints pass or
 * fail with the cost of the session, and deletes the session afterwards when
 * the API allows it. Exit code 0 on pass, 1 on fail.
 */
export async function pingRules(
  args: { url?: string; dir?: string },
  env: Env = process.env,
  deps: RulesDeps = defaultDeps,
): Promise<number> {
  const sharedFile = sharedAgentsFile(env);
  if (sharedFile === undefined) {
    console.error(`error: ${SHARED_DIR_UNSET}`);
    console.error(SHARED_DIR_HINT);
    return 1;
  }
  const content = await deps.readText(sharedFile);
  if (content === null) {
    console.error(`error: cannot read the shared agents file ${sharedFile}`);
    console.error("Set OC_SUB_SHARED_DIR to the folder that holds AGENTS.md.");
    return 1;
  }
  const heading = firstHeading(content);
  if (heading === null) {
    console.error(`error: the shared agents file ${sharedFile} has no line that starts with "# ".`);
    return 1;
  }

  const baseUrl = resolveCommandUrl(args.url, env, args.dir);
  await deps.checkServer(baseUrl, env);
  const directory = path.resolve(args.dir ?? process.cwd());
  const client = deps.client(baseUrl, env);

  const sessionId = await client.createSession(directory);
  let pass = false;
  try {
    await client.prompt(sessionId, directory, RULES_PROMPT);
    const messages = await client.messages(sessionId, directory);
    const reply = finalAssistantText(messages);
    const cost = formatCost(summarizeMessages(messages).cost);
    if (reply !== null && reply.includes(heading)) {
      console.log(`rules: pass (${cost})`);
      pass = true;
    } else {
      console.log(`rules: FAIL, expected the heading ${JSON.stringify(heading)}, got ${JSON.stringify(reply)} (${cost})`);
    }
  } finally {
    const deleted = await client.deleteSession(sessionId, directory);
    if (!deleted) console.error(`warning: could not delete the check session ${sessionId}`);
  }
  return pass ? 0 : 1;
}
