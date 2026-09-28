/** `oc-sub answer`: reply to a pending question or permission request. */
import path from "node:path";
import { resolveServerUrl, type Env } from "./config";
import { requireServer } from "./client";
import { listPendingRequests, rejectQuestion, replyPermission, replyQuestion } from "./requests";
import type { Reply } from "./args";

export async function answer(
  args: { url?: string; request: string; dir?: string; reply?: Reply; reject: boolean; answers: string[] },
  env: Env = process.env,
): Promise<number> {
  const baseUrl = resolveServerUrl(args.url, env);
  await requireServer(baseUrl, env);
  const directory = path.resolve(args.dir ?? process.cwd());

  // The kind of the request comes from the pending lists, not from the ID.
  const pending = await listPendingRequests(baseUrl, directory, env);
  const found = pending.find((entry) => entry.request.id === args.request);
  if (found === undefined) {
    throw new Error(
      `no pending request ${args.request} on ${baseUrl} for ${directory} (checked the pending questions and permissions)`,
    );
  }

  if (found.kind === "permission") {
    if (args.reply === undefined) {
      throw new Error(`request ${args.request} is a permission request. Give --reply once, --reply always, or --reply reject`);
    }
    await replyPermission(baseUrl, directory, args.request, args.reply, env);
    console.log(`permission ${args.request} in ${found.request.sessionID}: ${args.reply}`);
  } else {
    if (args.reply !== undefined) {
      throw new Error(`request ${args.request} is a question. Give one answer per question, or --reject`);
    }
    if (args.reject) {
      await rejectQuestion(baseUrl, directory, args.request, env);
      console.log(`question ${args.request} in ${found.request.sessionID} rejected`);
    } else {
      const questions = found.request.questions;
      if (args.answers.length !== questions.length) {
        const listed = questions
          .map((question, index) => `${index + 1}. [${question.header}] ${question.question}`)
          .join("\n");
        throw new Error(
          `request ${args.request} asks ${questions.length} question(s), got ${args.answers.length} answer(s):\n${listed}`,
        );
      }
      await replyQuestion(
        baseUrl,
        directory,
        args.request,
        args.answers.map((answer) => [answer]),
        env,
      );
      console.log(`question ${args.request} in ${found.request.sessionID} answered`);
    }
  }
  console.log("watch the session again to follow the rest of the run");
  return 0;
}
