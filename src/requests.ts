/** Pending question and permission requests: list, filter, format, and answer them. */
import { authHeaderFromEnv, type Env } from "./config";

/** One selectable answer of a question. */
export type QuestionOption = { label: string; description: string };

/** One question of a question request. */
export type QuestionInfo = {
  question: string;
  header: string;
  options: QuestionOption[];
  multiple?: boolean;
  custom?: boolean;
};

/** A pending question request, raised by the `question` tool of the agent. */
export type QuestionRequest = {
  id: string;
  sessionID: string;
  questions: QuestionInfo[];
};

/** A pending permission request, raised by a tool call that matched an `ask` rule. */
export type PermissionRequest = {
  id: string;
  sessionID: string;
  permission: string;
  patterns: string[];
};

/** One pending request, with its kind. */
export type PendingRequest =
  | { kind: "question"; request: QuestionRequest }
  | { kind: "permission"; request: PermissionRequest };

/** The reply values of a permission request. */
export type PermissionReply = "once" | "always" | "reject";

/** The requests whose session is one of the given sessions. Keeps the input order. */
export function filterRequests(
  requests: readonly PendingRequest[],
  sessionIds: ReadonlySet<string>,
): PendingRequest[] {
  return requests.filter((pending) => sessionIds.has(pending.request.sessionID));
}

/** One block of lines that describes a pending request. The caller adds the hints. */
export function formatRequest(pending: PendingRequest): string[] {
  const head = `${pending.kind} ${pending.request.id} in ${pending.request.sessionID}`;
  if (pending.kind === "question") {
    const lines = [head];
    pending.request.questions.forEach((question, index) => {
      lines.push(`  ${index + 1}. [${question.header}] ${question.question}`);
      for (const option of question.options) {
        lines.push(`     - ${option.label}: ${option.description}`);
      }
    });
    return lines;
  }
  const { permission, patterns } = pending.request;
  return [head, `  ${permission}${patterns.length > 0 ? `: ${patterns.join(", ")}` : ""}`];
}

/** The command that answers the request, as a hint line for the orchestrator. */
export function answerHint(pending: PendingRequest, directory: string): string {
  if (pending.kind === "question") {
    const placeholders = pending.request.questions.map(() => '"<answer>"').join(" ");
    const answers = placeholders.length > 0 ? ` ${placeholders}` : "";
    return `answer with: idfx answer ${pending.request.id} --dir ${directory}${answers} (or --reject)`;
  }
  return `answer with: idfx answer ${pending.request.id} --dir ${directory} --reply once (or always, or reject)`;
}

/**
 * GET the pending questions and permission requests of one directory. The
 * published v1 SDK gen lacks these routes, so this is a raw fetch, like
 * `probeServer` for the health check.
 */
export async function listPendingRequests(baseUrl: string, directory: string, env: Env): Promise<PendingRequest[]> {
  const query = `?directory=${encodeURIComponent(directory)}`;
  const [questions, permissions] = await Promise.all([
    fetchJson<QuestionRequest[]>(baseUrl, `/question${query}`, {}, env, "list questions"),
    fetchJson<PermissionRequest[]>(baseUrl, `/permission${query}`, {}, env, "list permissions"),
  ]);
  return [
    ...questions.map((request) => ({ kind: "question" as const, request })),
    ...permissions.map((request) => ({ kind: "permission" as const, request })),
  ];
}

/** Answer a pending question request: one array of labels per question, in order. */
export async function replyQuestion(
  baseUrl: string,
  directory: string,
  requestID: string,
  answers: string[][],
  env: Env,
): Promise<boolean> {
  return fetchJson<boolean>(
    baseUrl,
    `/question/${encodeURIComponent(requestID)}/reply?directory=${encodeURIComponent(directory)}`,
    { method: "POST", body: { answers } },
    env,
    "answer question",
  );
}

/** Reject a pending question request. The agent sees the failed tool call. */
export async function rejectQuestion(
  baseUrl: string,
  directory: string,
  requestID: string,
  env: Env,
): Promise<boolean> {
  return fetchJson<boolean>(
    baseUrl,
    `/question/${encodeURIComponent(requestID)}/reject?directory=${encodeURIComponent(directory)}`,
    { method: "POST" },
    env,
    "reject question",
  );
}

/** Answer a pending permission request. A message with `reject` gives the agent the reason. */
export async function replyPermission(
  baseUrl: string,
  directory: string,
  requestID: string,
  reply: PermissionReply,
  env: Env,
  message?: string,
): Promise<boolean> {
  return fetchJson<boolean>(
    baseUrl,
    `/permission/${encodeURIComponent(requestID)}/reply?directory=${encodeURIComponent(directory)}`,
    { method: "POST", body: message === undefined ? { reply } : { reply, message } },
    env,
    "answer permission",
  );
}

async function fetchJson<T>(
  baseUrl: string,
  route: string,
  init: { method?: string; body?: unknown },
  env: Env,
  what: string,
): Promise<T> {
  const auth = authHeaderFromEnv(env);
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${route}`, {
      method: init.method ?? "GET",
      headers: {
        ...(auth === undefined ? undefined : { Authorization: auth }),
        ...(init.body === undefined ? undefined : { "Content-Type": "application/json" }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${what}: ${reason}`);
  }
  if (!response.ok) throw new Error(`${what}: ${await errorText(response)}`);
  return (await response.json()) as T;
}

/** A short message for a failed HTTP call: status plus the server message, if any. */
async function errorText(response: Response): Promise<string> {
  const raw = await response.text().catch(() => "");
  const message = jsonMessage(raw);
  if (message !== undefined) return `HTTP ${response.status}: ${message}`;
  return `HTTP ${response.status}${raw.length > 0 ? `: ${raw.slice(0, 200)}` : ""}`;
}

function jsonMessage(raw: string): string | undefined {
  if (raw.length === 0) return undefined;
  try {
    const parsed = JSON.parse(raw) as { message?: unknown; data?: { message?: unknown } };
    if (typeof parsed.data?.message === "string" && parsed.data.message.length > 0) return parsed.data.message;
    if (typeof parsed.message === "string" && parsed.message.length > 0) return parsed.message;
  } catch {
    // The body is not JSON.
  }
  return undefined;
}
