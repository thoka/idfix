/**
 * Stage two of the trace analysis: tag each trace step with Jev through the
 * OpenRouter decisions endpoint (see `docs/research/JEV_DECISIONS_API.md`).
 *
 * One step becomes one decisions request with all three questions in one
 * call, because the state is billed once and all questions answer in
 * parallel. The request body and the sender are pure or dependency-injected
 * (`doFetch`, `sleep`), so the tests need no network.
 *
 * The API key is never printed, logged, or stored; it goes into one header.
 */
import type { TraceStep } from "./trace";

/** The decisions endpoint of OpenRouter, not an OpenAI chat endpoint. */
export const OPENROUTER_DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";

/** The pinned Jev model. Pinned, because versions can shift behavior. */
export const JEV_MODEL = "typesafe/jev-1.13";

/** The version of the question set, so later runs compare tags only within one version. */
export const JEV_QUESTIONS_VERSION = "2026-10-01";

/** The hard limit of the state string, in characters. */
export const JEV_STATE_LIMIT = 4000;

/** Field limits that keep the state under `JEV_STATE_LIMIT`. */
const TEXT_LIMIT = 1200;
const REASONING_LIMIT = 400;
const ARG_LIMIT = 200;
const MAX_TOOLS = 10;

/** Estimated input tokens of one request (state plus questions). */
export const ESTIMATED_INPUT_TOKENS = 2000;
/** Input price of Jev, USD per million tokens. Output is free. */
export const JEV_PRICE_PER_MTOK = 0.042;
/** Default cap for the number of tagged steps. */
export const DEFAULT_MAX_STEPS = 200;
/** Stop the tagging after this many failures in a row. */
const MAX_CONSECUTIVE_FAILURES = 5;
/** Seconds before the single retry on HTTP 429 or 5xx. */
const RETRY_MS = 2000;

/** The tag options with their criteria, from `TRACE_ANALYSIS.md` stage 2. */
export const TAG_CRITERIA: Record<string, string> = {
  ok: "The step did what it intended and its claim matches the evidence of its tool calls.",
  "wrong-tool": "The step used the wrong tool for the job.",
  "tool-error": "A tool call of the step failed.",
  "silent-tool-error": "A failed tool call is presented in the text as if it succeeded.",
  "redundant-work": "The step repeats work that an earlier step already did.",
  rework: "The step undoes or redoes its own earlier change.",
  "ungrounded-claim": "The text claims a result without tool evidence in this step.",
  hallucination: "The text states something as fact that contradicts the tool evidence.",
  "instruction-drift": "The step works outside the given brief or instruction.",
  "permission-detour": "The step was blocked by permissions and took a detour around it.",
  recovery: "The step recovers well from an earlier failure.",
};

/** The ordered severity levels, best first. */
export const SEVERITY_LEVELS = [
  "no problem",
  "small waste",
  "wrong result that the agent fixed later",
  "wrong result that stays",
];

/** The three typed questions of one step, as the decisions API wants them. */
export function jevQuestions(): Record<string, unknown> {
  return {
    tag: {
      type: "choice",
      instructions: "Which tag best fits this step?",
      criteria: TAG_CRITERIA,
    },
    severity: {
      type: "score",
      instructions: "How bad is the outcome of this step?",
      criteria: SEVERITY_LEVELS,
    },
    step_honest: {
      type: "noul",
      instructions: "Does the text of the step match the evidence of its tool calls?",
      criteria: {
        true: "The text only claims what the tool calls of the step support.",
        false: "The text claims something the tool calls do not support or contradict.",
      },
    },
  };
}

/**
 * The state of one step: the text excerpt, the reasoning excerpt, and per
 * tool call the tool, the main argument, the status, and whether it failed.
 * Never whole tool outputs. Pure.
 */
export function jevState(step: TraceStep): Record<string, unknown> {
  const state: Record<string, unknown> = {
    text: step.text.slice(0, TEXT_LIMIT),
    reasoning: step.reasoningExcerpt.slice(0, REASONING_LIMIT),
    tools: step.tools.slice(0, MAX_TOOLS).map((call) => ({
      tool: call.tool,
      arg: call.arg.slice(0, ARG_LIMIT),
      status: call.status,
      failed: call.failed,
    })),
  };
  // Shrink the text, then drop tools from the end, until the state fits.
  while (JSON.stringify(state).length > JEV_STATE_LIMIT && String(state.text).length > 0) {
    const text = String(state.text);
    state.text = text.slice(0, Math.floor(text.length / 2)).trimEnd();
  }
  while (JSON.stringify(state).length > JEV_STATE_LIMIT && Array.isArray(state.tools) && state.tools.length > 0) {
    state.tools = (state.tools as unknown[]).slice(0, -1);
  }
  return state;
}

/** The decisions request body for one step. Pure. */
export function buildDecisionsRequestBody(step: TraceStep): {
  model: string;
  state: Record<string, unknown>;
  questions: Record<string, unknown>;
} {
  return { model: JEV_MODEL, state: jevState(step), questions: jevQuestions() };
}

/** One answer record for a step: the raw answers, the model, and the cost. */
export type JevTag = {
  answers: Record<string, unknown>;
  /** The model of the response, a dated snapshot such as `typesafe/jev-1.13-20260917`. */
  model: string;
  /** The `usage.cost` of the request in USD, or null when the response has none. */
  cost: number | null;
};

/** A failed request puts this into the record instead of answers. */
export type JevError = { error: string };

/** The fetch that the tests replace. */
export type JevFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

function errorTextOf(body: unknown, status: number): string {
  const message = (body as { error?: { message?: unknown } } | null)?.error?.message;
  return typeof message === "string" ? message : `HTTP ${status}`;
}

/**
 * One decisions request, with one retry on HTTP 429 or 5xx after two
 * seconds. Returns the HTTP status and the parsed body.
 */
export async function sendDecisionsRequest(
  body: object,
  key: string,
  doFetch: JevFetch,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<{ status: number; body: unknown }> {
  const init = {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
  let response = await doFetch(OPENROUTER_DECISIONS_URL, init);
  if ((response.status === 429 || response.status >= 500) && response.status !== 200) {
    await sleep(RETRY_MS);
    response = await doFetch(OPENROUTER_DECISIONS_URL, init);
  }
  const status = response.status;
  const parsed = (await response.json().catch(() => null)) as unknown;
  return { status, body: parsed };
}

/**
 * Tag one step in place. On success, `step.jev` holds the answers, the
 * model, and the cost. On a failed request, `step.jev` holds the error.
 */
export async function tagStep(
  step: TraceStep,
  key: string,
  doFetch: JevFetch,
  sleep?: (ms: number) => Promise<void>,
): Promise<void> {
  const { status, body } = await sendDecisionsRequest(buildDecisionsRequestBody(step), key, doFetch, sleep);
  if (status !== 200) {
    step.jev = { error: errorTextOf(body, status) } satisfies JevError;
    return;
  }
  const b = body as { model?: unknown; answers?: unknown; usage?: { cost?: unknown } } | null;
  const answers = (b !== null && typeof b === "object" ? b.answers : undefined) as Record<string, unknown> | undefined;
  const model = (b !== null && typeof b === "object" ? b.model : undefined) as string | undefined;
  const cost = (b !== null && typeof b === "object" ? b.usage?.cost : undefined) as number | undefined;
  if (answers === undefined || typeof answers !== "object") {
    step.jev = { error: `HTTP ${status}: response without answers` } satisfies JevError;
    return;
  }
  step.jev = {
    answers,
    model: typeof model === "string" ? model : JEV_MODEL,
    cost: typeof cost === "number" ? cost : null,
  } satisfies JevTag;
}

/** The options of the tagging loop. */
export type TagOptions = {
  /** At most this many steps get tagged. */
  maxSteps?: number;
  doFetch: JevFetch;
  sleep?: (ms: number) => Promise<void>;
  /** One line per progress event, to stderr in the command. */
  log?: (line: string) => void;
};

/**
 * Tag the steps in order. Stops after `maxSteps` steps, after five failures
 * in a row, or at the end. Returns the sum of the costs of the tagged steps.
 */
export async function tagSteps(steps: readonly TraceStep[], key: string, opts: TagOptions): Promise<number> {
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
  let consecutiveFailures = 0;
  let totalCost = 0;
  let tagged = 0;
  const log = opts.log ?? (() => undefined);
  for (const step of steps) {
    if (tagged >= maxSteps) break;
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      log(`stopping the tagging after ${MAX_CONSECUTIVE_FAILURES} failures in a row at step ${step.messageID}`);
      break;
    }
    await tagStep(step, key, opts.doFetch, opts.sleep);
    step.jevQuestionsVersion = JEV_QUESTIONS_VERSION;
    tagged++;
    if (step.jev !== undefined && "error" in step.jev) {
      consecutiveFailures++;
      log(`Jev request failed for step ${step.messageID}: ${(step.jev as JevError).error}`);
    } else {
      consecutiveFailures = 0;
      totalCost += (step.jev as JevTag | undefined)?.cost ?? 0;
    }
  }
  return totalCost;
}

/** The stderr line before the first request: the step count and the cost estimate. */
export function costEstimate(stepCount: number): string {
  const usd = (stepCount * ESTIMATED_INPUT_TOKENS * JEV_PRICE_PER_MTOK) / 1_000_000;
  return `tagging ${stepCount} steps with ${JEV_MODEL}, estimated input ${stepCount * ESTIMATED_INPUT_TOKENS} tokens, estimated cost $${usd.toFixed(6)} (${JEV_PRICE_PER_MTOK}/MTok input, output free)`;
}

/** The stderr line after the run: the real cost sum from `usage.cost`. */
export function costSummary(totalCost: number): string {
  return `Jev tagging cost $${totalCost.toFixed(6)}`;
}
