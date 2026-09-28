/** `oc-sub run`: create a session, send the brief asynchronously, record it. */
import path from "node:path";
import { resolvePort, resolveServerUrl, type Env } from "./config";
import { assertOk, makeClient, unwrap } from "./client";
import { makeRunRecord, writeRunRecord } from "./runs";
import { addDir, serveDirsPath } from "./state";

export function attachCommand(url: string, directory: string, sessionId: string): string {
  return `opencode attach ${url} --dir ${directory} --session ${sessionId}`;
}

export async function run(
  args: { url?: string; agent: string; dir: string; briefFile?: string; text?: string; title?: string },
  env: Env = process.env,
): Promise<number> {
  const baseUrl = resolveServerUrl(args.url, env);
  const directory = path.resolve(args.dir);
  const client = makeClient(baseUrl, env);

  const brief = args.briefFile !== undefined ? await readBrief(args.briefFile) : (args.text ?? "");

  const created = unwrap(
    await client.session.create({
      query: { directory },
      body: args.title === undefined ? {} : { title: args.title },
    }),
    "create session",
  );

  assertOk(
    await client.session.promptAsync({
      path: { id: created.id },
      query: { directory },
      body: {
        agent: args.agent,
        parts: [{ type: "text", text: brief }],
      },
    }),
    "send brief",
  );

  const record = makeRunRecord({
    sessionId: created.id,
    directory,
    agent: args.agent,
    title: args.title,
  });
  const recordPath = await writeRunRecord(process.cwd(), record);
  // `oc-sub down` checks these directories for busy sessions.
  await addDir(serveDirsPath(env, resolvePort(undefined, baseUrl)), directory);

  console.log(created.id);
  console.log(attachCommand(baseUrl, directory, created.id));
  console.log(`run record: ${recordPath}`);
  return 0;
}

async function readBrief(file: string): Promise<string> {
  try {
    return await Bun.file(file).text();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`cannot read brief file ${file}: ${reason}`);
  }
}
