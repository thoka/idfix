/**
 * `idfx decide --json`: one typed choice question to Jev for another
 * project. It reads one JSON object on stdin, sends one decisions request
 * with the retry of `sendDecisionsRequest`, and prints one JSON line: the
 * answer on stdout, or `{"error": {"type", "message"}}` on stderr.
 *
 * Each call that reached the API appends one JSON line to
 * `<stateDir>/decide.log`, so the daily budget sees its cost.
 *
 * The key comes from `OPENROUTER_API_KEY`, else from the key file of the
 * project idfix itself. It is never printed, logged, or stored.
 */
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { Env } from "./config";
import { JEV_MODEL, JEV_STATE_LIMIT, sendDecisionsRequest, type JevFetch } from "./jev";
import { projectKeyPath, readTextFile } from "./keys";
import { stateDir } from "./state";

/** The project whose key file `decide` reads, independent of the folder of the caller. */
export const DECIDE_KEY_PROJECT = "idfix";

/** The ID of the one question in the request. */
const QUESTION_ID = "decision";

/** The error types of a failed call. */
export type DecideErrorType = "limit" | "auth" | "input" | "failed";

/** The checked input of one call. */
export type DecideInput = {
  state: Record<string, unknown> | string;
  question: string;
  options: Record<string, string>;
  title?: string;
};

/** The answer line on stdout. */
export type DecideResult = {
  choice: string;
  confidence: number | null;
  probabilities: Record<string, number> | null;
  model: string;
  cost: number | null;
  id: string | null;
};

/** The parts that the tests replace. */
export type DecideDeps = {
  doFetch?: JevFetch;
  sleep?: (ms: number) => Promise<void>;
  readStdin?: () => Promise<string>;
  now?: () => Date;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
};

class InputError extends Error {}

const ALLOWED_KEYS = new Set(["state", "question", "options", "title"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Check the stdin text and return the input. Throws InputError. Pure. */
export function parseDecideInput(text: string): DecideInput {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new InputError("stdin is not valid JSON");
  }
  if (!isPlainObject(raw)) throw new InputError("stdin must be one JSON object");
  const unknown = Object.keys(raw).filter((key) => !ALLOWED_KEYS.has(key));
  if (unknown.length > 0) throw new InputError(`unknown keys: ${unknown.join(", ")}`);
  const { state, question, options, title } = raw;
  if (state === undefined) throw new InputError("missing field state");
  if (typeof state !== "string" && !isPlainObject(state)) throw new InputError("state must be an object or a string");
  const stateLength = JSON.stringify(state).length;
  if (stateLength > JEV_STATE_LIMIT) {
    throw new InputError(`state is ${stateLength} characters as JSON, the limit is ${JEV_STATE_LIMIT}`);
  }
  if (typeof question !== "string" || question.trim().length === 0) {
    throw new InputError("question must be a non-empty string");
  }
  if (!isPlainObject(options)) throw new InputError("options must be an object from option name to criterion text");
  const entries = Object.entries(options);
  if (entries.length < 2) throw new InputError("options needs at least 2 entries");
  for (const [name, criterion] of entries) {
    if (typeof criterion !== "string") throw new InputError(`the criterion of option "${name}" must be a string`);
  }
  if (title !== undefined && typeof title !== "string") throw new InputError("title must be a string");
  return {
    state,
    question,
    options: options as Record<string, string>,
    ...(title === undefined ? {} : { title }),
  };
}

/** The decisions request body with the one choice question. Pure. */
export function buildDecideBody(input: DecideInput): object {
  return {
    model: JEV_MODEL,
    state: input.state,
    questions: { [QUESTION_ID]: { type: "choice", instructions: input.question, criteria: input.options } },
  };
}

/** The key: the environment variable first, then the key file of idfix. Never printed. */
export async function decideKey(env: Env): Promise<string | null> {
  const fromEnv = env.OPENROUTER_API_KEY?.trim();
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  const fromFile = (await readTextFile(projectKeyPath(DECIDE_KEY_PROJECT, env)))?.trim();
  return fromFile !== undefined && fromFile.length > 0 ? fromFile : null;
}

/** The error type of a non-200 status after the retry. Pure. */
export function errorTypeOfStatus(status: number): DecideErrorType {
  if (status === 402 || status === 429) return "limit";
  if (status === 401 || status === 403) return "auth";
  return "failed";
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function probabilitiesOf(value: unknown): Record<string, number> | null {
  if (!isPlainObject(value)) return null;
  const out: Record<string, number> = {};
  for (const [name, p] of Object.entries(value)) {
    if (typeof p === "number") out[name] = p;
  }
  return out;
}

/** Remove the key from a text, so that no message carries it. */
function withoutKey(text: string, key: string): string {
  return key.length > 0 ? text.split(key).join("***") : text;
}

/** Run `idfx decide --json`. Returns the exit code: 0 success, 1 failure, 2 input error. */
export async function decide(env: Env = process.env, deps: DecideDeps = {}): Promise<number> {
  const out = deps.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const err = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  const now = deps.now ?? (() => new Date());
  let key = "";
  const fail = (type: DecideErrorType, message: string): number => {
    err(JSON.stringify({ error: { type, message: withoutKey(message, key) } }));
    return type === "input" ? 2 : 1;
  };

  let input: DecideInput;
  try {
    const readStdin = deps.readStdin ?? (() => Bun.stdin.text());
    input = parseDecideInput(await readStdin());
  } catch (error) {
    if (error instanceof InputError) return fail("input", error.message);
    return fail("input", `cannot read stdin: ${error instanceof Error ? error.message : String(error)}`);
  }

  const found = await decideKey(env);
  if (found === null) {
    return fail("auth", `no key: set OPENROUTER_API_KEY or create ${projectKeyPath(DECIDE_KEY_PROJECT, env)}`);
  }
  key = found;

  let status: number;
  let body: unknown;
  try {
    const headers: Record<string, string> = input.title === undefined ? {} : { "X-Title": input.title };
    ({ status, body } = await sendDecisionsRequest(buildDecideBody(input), key, deps.doFetch ?? fetch, deps.sleep, headers));
  } catch (error) {
    return fail("failed", `request failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const b = isPlainObject(body) ? body : {};
  const model = stringOrNull(b.model) ?? JEV_MODEL;
  const usage = isPlainObject(b.usage) ? b.usage : {};
  const cost = numberOrNull(usage.cost);
  const id = stringOrNull(b.id);
  const answers = isPlainObject(b.answers) ? b.answers : {};
  const answer = isPlainObject(answers[QUESTION_ID]) ? (answers[QUESTION_ID] as Record<string, unknown>) : {};
  const choice = stringOrNull(answer.choice);

  let errorType: DecideErrorType | null = null;
  let errorMessage = "";
  if (status !== 200) {
    errorType = errorTypeOfStatus(status);
    const apiMessage = isPlainObject(b.error) ? stringOrNull(b.error.message) : null;
    errorMessage = `HTTP ${status}${apiMessage === null ? "" : `: ${apiMessage}`}`;
  } else if (choice === null || !Object.hasOwn(input.options, choice)) {
    errorType = "failed";
    errorMessage = choice === null ? "HTTP 200 without a choice" : `HTTP 200 with a choice that is not an option: ${choice}`;
  }

  const logLine = {
    source: "idfx-decide",
    event: "end",
    time: now().toISOString(),
    status,
    model,
    cost,
    id,
    title: input.title ?? null,
    choice: errorType === null ? choice : null,
    error: errorType,
  };
  try {
    const dir = stateDir(env);
    await mkdir(dir, { recursive: true });
    await appendFile(path.join(dir, "decide.log"), `${withoutKey(JSON.stringify(logLine), key)}\n`);
  } catch (error) {
    err(`warning: cannot write decide.log: ${withoutKey(error instanceof Error ? error.message : String(error), key)}`);
  }

  if (errorType !== null) return fail(errorType, errorMessage);
  const result: DecideResult = {
    choice: choice as string,
    confidence: numberOrNull(answer.confidence),
    probabilities: probabilitiesOf(answer.probabilities),
    model,
    cost,
    id,
  };
  out(JSON.stringify(result));
  return 0;
}
