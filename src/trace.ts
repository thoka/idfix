/**
 * `oc-sub trace`: stage one of the trace analysis. It loads a session and
 * all of its subagent sessions (as `oc-sub log` does), cuts each session
 * into steps, computes cheap signals without a model, and writes one JSON
 * line per step. The cutting and the signals are pure functions over the
 * message list, so the tests need no server.
 *
 * A step is one assistant message span from a `step-start` part to its
 * `step-finish` part, with the reasoning, text, tool, and patch parts in
 * between. Verified against the opencode 1.18.32 SDK types: the parts match
 * this shape (`StepStartPart`, `StepFinishPart`, `ToolPart`, `PatchPart`).
 * One assistant message can hold several step spans; a message without a
 * `step-finish` (an aborted run) ends in an unfinished step.
 */
import path from "node:path";
import type { Message, Part, ToolState } from "@opencode-ai/sdk";
import type { Env } from "./config";
import { resolveCommandUrl } from "./sandbox";
import { makeClient, requireServer, unwrap } from "./client";
import type { MessageEntry } from "./summary";
import { loadSessionTree } from "./tree";
import { REASONING_LIMIT } from "./detect";
import { toolMainArg } from "./events";
import {
  DEFAULT_MAX_STEPS,
  costEstimate,
  costSummary,
  tagSteps,
  type JevError,
  type JevTag,
  type JevFetch,
} from "./jev";
import { projectKeyPath, projectNameOfRun, readTextFile } from "./keys";

/** How much of the step text goes into the record. */
export const TEXT_EXCERPT_LIMIT = 500;
/** How much of the reasoning text goes into the record. */
export const REASONING_EXCERPT_LIMIT = 300;

/** One tool call inside a step. */
export type TraceToolCall = {
  tool: string;
  /** The main argument, per `toolMainArg` (file path, command, pattern, ...). */
  arg: string;
  status: ToolState["status"];
  failed: boolean;
};

/** One record per step, the output of stage one. */
export type TraceStep = {
  sessionID: string;
  /** The parent session, or null for a root session. */
  parentSessionID: string | null;
  messageID: string;
  /** The part IDs of the span, from `step-start` to `step-finish`. */
  partIDs: string[];
  /** The step index within the session, starting at 0. */
  stepIndex: number;
  agent: string;
  model: string;
  tools: TraceToolCall[];
  tokens: { input: number; output: number; reasoning: number; cacheRead: number };
  /** Duration from the tool times of the step, when the parts carry times. */
  durationMs?: number;
  /** Whether the step has a `step-finish` part. */
  finished: boolean;
  /** Any tool call of the step failed. */
  toolError: boolean;
  /** Same tool and main argument as an earlier call in the session. */
  duplicateCall: boolean;
  /** A read of a file that the session already read and did not change since. */
  rereadFile: boolean;
  /** A second edit of the same file in the session. */
  reeditFile: boolean;
  /** Reasoning tokens above `REASONING_LIMIT`. */
  longReasoning: boolean;
  /** The first `TEXT_EXCERPT_LIMIT` characters of the text parts. */
  text: string;
  /** The first `REASONING_EXCERPT_LIMIT` characters of the reasoning. */
  reasoningExcerpt: string;
  /** The Jev answers of stage two, only with `trace --tag`. */
  jev?: JevTag | JevError;
  /** The question-set version of the `jev` field, only with `trace --tag`. */
  jevQuestionsVersion?: string;
};

/** One `step-start`...`step-finish` span (or an open span without finish). */
export type RawStep = {
  entry: MessageEntry;
  parts: Part[];
  finish?: Extract<Part, { type: "step-finish" }>;
};

function isAssistant(entry: MessageEntry): boolean {
  return entry.info.role === "assistant";
}

/** Cut one session into raw step spans, in order. */
export function cutSteps(messages: readonly MessageEntry[]): RawStep[] {
  const steps: RawStep[] = [];
  for (const entry of messages) {
    if (!isAssistant(entry)) continue;
    let open: RawStep | undefined;
    const close = () => {
      if (open !== undefined) steps.push(open);
      open = undefined;
    };
    for (const part of entry.parts) {
      if (part.type === "step-start") {
        close();
        open = { entry, parts: [part] };
      } else if (open !== undefined) {
        open.parts.push(part);
        if (part.type === "step-finish") {
          open.finish = part;
          close();
        }
      }
    }
    close();
  }
  return steps;
}

const READ_TOOLS = new Set(["read"]);
const EDIT_TOOLS = new Set(["edit", "write"]);
/** The text parts of a step, without synthetic parts, joined. */
function stepText(parts: readonly Part[]): string {
  const text = parts
    .filter((part): part is Extract<Part, { type: "text" }> => part.type === "text" && part.synthetic !== true)
    .map((part) => part.text)
    .join("\n");
  return text.slice(0, TEXT_EXCERPT_LIMIT);
}

/** The first reasoning text of a step, shortened. */
function reasoningExcerpt(parts: readonly Part[]): string {
  for (const part of parts) {
    if (part.type === "reasoning" && part.text.trim().length > 0) return part.text.slice(0, REASONING_EXCERPT_LIMIT);
  }
  return "";
}

/** Duration of a step from the tool times, or undefined without times. */
function stepDuration(parts: readonly Part[]): number | undefined {
  let start: number | undefined;
  let end: number | undefined;
  for (const part of parts) {
    if (part.type !== "tool") continue;
    const time = part.state.time;
    if (time === undefined) continue;
    start = start === undefined ? time.start : Math.min(start, time.start);
    if (time.end !== undefined) end = end === undefined ? time.end : Math.max(end, time.end);
  }
  if (start === undefined || end === undefined) return undefined;
  return Math.max(0, end - start);
}

function toolCalls(parts: readonly Part[]): TraceToolCall[] {
  const calls: TraceToolCall[] = [];
  for (const part of parts) {
    if (part.type !== "tool") continue;
    calls.push({
      tool: part.tool,
      arg: toolMainArg(part.tool, part.state.input),
      status: part.state.status,
      failed: part.state.status === "error",
    });
  }
  return calls;
}

/**
 * Cut one session into step records with the session-wide signals. The
 * signals fold over the steps in order: a read marks a file clean, an edit
 * marks it dirty and counts a reedit, and every tool call joins the set of
 * seen calls.
 */
export function traceSession(messages: readonly MessageEntry[], parentSessionID: string | null): TraceStep[] {
  const seenCalls = new Set<string>();
  const cleanReads = new Set<string>();
  const editedFiles = new Set<string>();
  const records: TraceStep[] = [];
  let stepIndex = 0;
  for (const raw of cutSteps(messages)) {
    const info: Message = raw.entry.info;
    // The stored message data carries `agent`; the 1.18.32 SDK type omits it.
    const agent = (info as { agent?: string }).agent ?? "";
    const tools = toolCalls(raw.parts);
    const finish = raw.finish;
    const tokens = finish
      ? {
          input: finish.tokens.input,
          output: finish.tokens.output,
          reasoning: finish.tokens.reasoning,
          cacheRead: finish.tokens.cache.read,
        }
      : { input: 0, output: 0, reasoning: 0, cacheRead: 0 };
    let duplicateCall = false;
    let rereadFile = false;
    let reeditFile = false;
    for (const call of tools) {
      const key = `${call.tool}\n${call.arg}`;
      if (seenCalls.has(key)) duplicateCall = true;
      seenCalls.add(key);
      const file = call.arg;
      if (READ_TOOLS.has(call.tool)) {
        if (cleanReads.has(file)) rereadFile = true;
        cleanReads.add(file);
      } else if (EDIT_TOOLS.has(call.tool)) {
        if (editedFiles.has(file)) reeditFile = true;
        editedFiles.add(file);
        cleanReads.delete(file);
      }
    }
    records.push({
      sessionID: raw.entry.info.sessionID,
      parentSessionID,
      messageID: raw.entry.info.id,
      partIDs: raw.parts.map((part) => part.id),
      stepIndex: stepIndex++,
      agent,
      model: info.role === "assistant" ? `${info.providerID}/${info.modelID}` : "",
      tools,
      tokens,
      durationMs: stepDuration(raw.parts),
      finished: finish !== undefined,
      toolError: tools.some((call) => call.failed),
      duplicateCall,
      rereadFile,
      reeditFile,
      longReasoning: tokens.reasoning > REASONING_LIMIT,
      text: stepText(raw.parts),
      reasoningExcerpt: reasoningExcerpt(raw.parts),
    });
  }
  return records;
}

/**
 * The steps of a session tree: the main session first, then each
 * descendant session with its parent ID.
 */
export type TraceTree = Array<{ sessionID: string; parentSessionID: string | null; steps: TraceStep[] }>;

/** Trace one session and all of its subagent sessions. */
export async function traceRun(
  args: { url?: string; session: string; dir?: string },
  env: Env = process.env,
): Promise<TraceTree> {
  const baseUrl = resolveCommandUrl(args.url, env, args.dir);
  await requireServer(baseUrl, env);
  const directory = path.resolve(args.dir ?? process.cwd());
  const client = makeClient(baseUrl, env);
  const tree = await loadSessionTree(client, args.session, directory);
  const parentOf = async (id: string): Promise<string | null> => {
    const session = unwrap(await client.session.get({ path: { id }, query: { directory } }), "load session");
    return session.parentID ?? null;
  };
  const trace: TraceTree = [
    { sessionID: args.session, parentSessionID: await parentOf(args.session), steps: traceSession(tree.main, null) },
  ];
  for (let i = 0; i < tree.descendants.length; i++) {
    const id = tree.ids[i + 1];
    if (id === undefined) break;
    const parent = await parentOf(id);
    const messages = tree.descendants[i];
    if (messages === undefined) break;
    trace.push({ sessionID: id, parentSessionID: parent, steps: traceSession(messages, parent) });
  }
  return trace;
}

/** The OpenRouter key for `trace --tag`: the environment variable first, then the project key file of the project of `--dir`. Never printed. */
export async function traceKey(dir: string, env: Env): Promise<string | null> {
  const fromEnv = env.OPENROUTER_API_KEY?.trim();
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  const keyPath = projectKeyPath(projectNameOfRun(dir), env);
  const fromFile = (await readTextFile(keyPath))?.trim();
  return fromFile !== undefined && fromFile.length > 0 ? fromFile : null;
}

/** The fetch and the sleep that the tests replace. */
export type TraceTagDeps = {
  doFetch?: JevFetch;
  sleep?: (ms: number) => Promise<void>;
};

/** Run `oc-sub trace`: print one JSON line per step to stdout or --out. */
export async function trace(
  args: { url?: string; session: string; dir?: string; out?: string; tag?: boolean; maxSteps?: number },
  env: Env = process.env,
  deps: TraceTagDeps = {},
): Promise<number> {
  const traceTree = await traceRun(args, env);
  if (args.tag === true) {
    const directory = path.resolve(args.dir ?? process.cwd());
    const key = await traceKey(directory, env);
    if (key === null) {
      const keyPath = projectKeyPath(projectNameOfRun(directory), env);
      console.error(`no key: set OPENROUTER_API_KEY or create ${keyPath}`);
      return 2;
    }
    const steps = traceTree.flatMap((session) => session.steps);
    console.error(costEstimate(steps.length));
    const totalCost = await tagSteps(steps, key, {
      maxSteps: args.maxSteps ?? DEFAULT_MAX_STEPS,
      doFetch: deps.doFetch ?? fetch,
      sleep: deps.sleep,
      log: (line) => console.error(line),
    });
    console.error(costSummary(totalCost));
  }
  const lines = traceTree.flatMap((session) => session.steps.map((step) => JSON.stringify(step))).join("\n");
  const output = lines.length > 0 ? `${lines}\n` : "";
  if (args.out === undefined) {
    process.stdout.write(output);
  } else {
    await Bun.write(args.out, output);
  }
  return 0;
}
