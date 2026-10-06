/**
 * The probe runner (PLAN.md step 10d): one probe run per provider and run
 * number, strictly one run at a time, so the real-cost delta of the project
 * key belongs to exactly one run.
 *
 * One run:
 *  1. create the run worktree `probe-<provider>-<n>-<HHMMSS>` inside the
 *     sandbox clone (the same `oc-sub worktree` code); the `HHMMSS` stamp
 *     comes from the start time of the batch, so a step name is unique per
 *     batch and a leftover of an older batch is never reused,
 *  2. write `.opencode/opencode.json` with the model alias
 *     `glm-probe-<provider>` into the worktree, through `sbx exec`, before
 *     any server request touches the folder (a fresh directory loads its
 *     config on first use, see .plan/research/probe-routing.md section 4),
 *  3. note the key usage of the project key, start the run with the agent
 *     `coder`, the probe task text, and the model alias, and wait until the
 *     session tree is settled (the logic of `oc-sub watch`, with its
 *     guards). After the time limit the run is aborted and counts as
 *     failed with rule `timeout`,
 *  4. read the messages, `answer.md`, and the commit state, and evaluate,
 *  5. read the key usage again and write one JSON line into
 *     `probe/results/<date>.jsonl`,
 *  6. remove the run worktree.
 *
 * A run that fails at any step writes a result line with the error and the
 * loop goes on with the next run. A failure in a worktree step (create,
 * config write, remove) counts with rule `setup`, not as a provider
 * failure. Every `sbx` call goes through the
 * injectable runner, and every server and OpenRouter call goes through
 * injectable dependencies, so the tests use fakes only.
 */
import { mkdir, appendFile } from "node:fs/promises";
import path from "node:path";
import type { OpencodeClient } from "@opencode-ai/sdk";
import { assertOk, unwrap } from "../client";
import type { Env } from "../config";
import { worktree, worktreeRm, type CloneDeps } from "../clone";
import { createGuard, type Finding } from "../detect";
import { fetchKeyUsage, projectRootOfRun, resolveDirectoryKey, type KeyFetch } from "../keys";
import { listPendingRequests, type PendingRequest } from "../requests";
import { sbxBin, shellQuote, type Runner, type SandboxState } from "../sandbox";
import { missingSessionIsSettled, treeIsSettled } from "../settled";
import { summarizeMessages } from "../summary";
import { collectDescendants, childIdsOf } from "../tree";
import { evaluateRun, speedMetrics, type ExpectedAnswer, type SpeedMetrics } from "./evaluate";
import type { MessageEntry } from "../summary";

/** The API id of the probed model. */
export const PROBE_MODEL_ID = "z-ai/glm-5.3-flash";
/** The providerID part of the model alias. */
export const PROBE_PROVIDER_ID = "openrouter";
/** The time limit of one probe run. */
export const PROBE_TIMEOUT_MS = 15 * 60_000;
/** How often the settled check polls the server. */
export const PROBE_POLL_MS = 2_000;
/** The provider slug of the control run: it must fail. */
export const CONTROL_PROVIDER = "no-such-provider";

/** The model alias of one provider in the run configuration. */
export function probeAlias(provider: string): string {
  return `glm-probe-${provider.toLowerCase()}`;
}

/**
 * The per-run opencode configuration: one model alias per provider whose
 * API id is the real model and whose `options.provider` pins the OpenRouter
 * provider. Pure. The provider slug is the OpenRouter slug in lower case.
 */
export function probeConfig(provider: string): string {
  return JSON.stringify({
    provider: {
      [PROBE_PROVIDER_ID]: {
        models: {
          [probeAlias(provider)]: {
            id: PROBE_MODEL_ID,
            options: {
              provider: { only: [provider.toLowerCase()], allow_fallbacks: false },
            },
          },
        },
      },
    },
  });
}

/** The worktree step name of one probe run. */
export function probeStep(provider: string, run: number, stamp?: string): string {
  const base = `probe-${provider.toLowerCase()}-${run}`;
  return stamp === undefined ? base : `${base}-${stamp}`;
}

/**
 * The `HHMMSS` stamp of a batch, from its start time in UTC. Every batch of
 * a probe run uses it in its step names, so a leftover of an older batch
 * can never be reused by a newer one.
 */
export function batchStamp(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(11, 19).replaceAll(":", "");
}

/** The results file of one day, for example `probe/results/2026-09-30.jsonl`. */
export function resultsFilePath(resultsDir: string, date: Date): string {
  return path.join(resultsDir, `${date.toISOString().slice(0, 10)}.jsonl`);
}

/** The failure entries of a result line. The evaluate rules plus `timeout` and `error`. */
export type ProbeFailure = { rule: string; detail: string };

/** One JSONL result line. */
export type ProbeRunResult = {
  provider: string;
  run: number;
  /** The worktree step name of the run, unique per batch. */
  step: string;
  sessionId: string | null;
  pass: boolean;
  control: boolean;
  failures: ProbeFailure[];
  speed: SpeedMetrics;
  estimatedCost: number;
  realCostDelta: number | null;
  wallMs: number;
};

/** The parts of the probe runner that the tests replace. */
export type ProbeDeps = {
  /** Runs the `sbx exec` commands (config write, `answer.md`, git). */
  runner: Runner;
  /** The sandbox state of a project, or null without a state file. */
  sandboxState: (project: string) => SandboxState | null;
  /** The project name of a directory. */
  projectName: (directory: string) => string;
  /** The opencode server client. */
  client: OpencodeClient;
  /** The base URL of the server, for the pending-request lists. */
  baseUrl: string;
  /** The fetch that reads the OpenRouter key usage. */
  fetch: KeyFetch;
  /** The OpenRouter key of a directory, or null without one. */
  resolveKey: (directory: string) => Promise<string | null>;
  /** The pending question and permission requests of a directory. */
  pendingRequests: (directory: string) => Promise<PendingRequest[]>;
  /** Appends one JSON line to the results file. */
  appendResult: (file: string, line: string) => Promise<void>;
  /** The clock and the timer, so the tests control the time. */
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  pollMs: number;
  runTimeoutMs: number;
};

export function defaultResolveKey(client: OpencodeClient, env: Env) {
  return async (directory: string) => (await resolveDirectoryKey(client, directory, env))?.key ?? null;
}

export function defaultPendingRequests(baseUrl: string, env: Env) {
  return (directory: string) => listPendingRequests(baseUrl, directory, env);
}

/** Appends one line to a file, creating its folder. The default of appendResult. */
export async function appendResultLine(file: string, line: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${line}\n`);
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const even = sorted.length % 2 === 0;
  return even ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/** The median helper of the end table, exported for the tests. */
export { median };

/**
 * The error texts that mark a routing refusal of OpenRouter, matched
 * case-insensitively against the error of a failed run. The control run
 * passes only on one of these: a model-not-found error (an unloaded alias
 * config) must not count.
 */
export const ROUTING_REFUSAL_PATTERNS: readonly string[] = ["no endpoints found", "no allowed providers"];

/** Whether an error text shows a routing refusal of OpenRouter. Pure. */
export function isRoutingRefusal(text: string | null): boolean {
  if (text === null) return false;
  const lower = text.toLowerCase();
  return ROUTING_REFUSAL_PATTERNS.some((pattern) => lower.includes(pattern));
}

/** The error field of the SDK assistant message. */
type AssistantError = { data?: { message?: unknown } };

/**
 * The error text of the session: the message of the `error` field of the
 * first assistant message that carries one, or null without one.
 */
export function sessionErrorText(messages: readonly MessageEntry[]): string | null {
  for (const entry of messages) {
    if (entry.info.role !== "assistant") continue;
    const error = (entry.info as { error?: AssistantError }).error;
    if (error === undefined || error === null) continue;
    const message = error.data?.message;
    if (typeof message === "string" && message.length > 0) return message;
    return JSON.stringify(error);
  }
  return null;
}

/** The detail line of a pending request that paused a run: type and title. */
export function pendingDetail(pending: PendingRequest): string {
  const title =
    pending.kind === "question"
      ? pending.request.questions[0]?.question ?? pending.request.questions[0]?.header ?? "unknown question"
      : pending.request.permission;
  return `the run paused on a ${pending.kind} request and was aborted: ${title}`;
}

/**
 * Whether the session tree answered: any assistant message produced output
 * tokens. The control run counts this as a routing failure.
 */
function sessionAnswered(messages: readonly MessageEntry[]): boolean {
  return messages.some(
    (entry) => entry.info.role === "assistant" && (entry.info as { tokens: { output: number } }).tokens.output > 0,
  );
}

export type ProbeInput = {
  /** The project root (`--dir`): the sandbox state and its clone come from here. */
  dir: string;
  providers: readonly string[];
  runs: number;
  taskText: string;
  expected: ExpectedAnswer;
  /** Control mode: the runs must fail with a routing error, not answer. */
  control: boolean;
  resultsFile: string;
  env: Env;
};

/**
 * Run the whole probe: for each provider and run number, one probe run,
 * strictly sequential. Returns one result per run, in run order.
 */
export async function runProbe(input: ProbeInput, deps: ProbeDeps): Promise<ProbeRunResult[]> {
  const results: ProbeRunResult[] = [];
  // One stamp for the whole batch: every step name of the batch carries it,
  // so it can never collide with a leftover of an older batch.
  const stamp = batchStamp(deps.now());
  for (const provider of input.providers) {
    for (let run = 1; run <= input.runs; run++) {
      // The runs are strictly sequential: the real-cost delta of the key
      // belongs to exactly one run.
      const result = await runOne(input, provider, run, stamp, deps);
      results.push(result);
      const line = JSON.stringify(result);
      await deps.appendResult(input.resultsFile, line);
    }
  }
  return results;
}

/** One probe run, with every step of the brief. Never throws. */
async function runOne(input: ProbeInput, provider: string, run: number, stamp: string, deps: ProbeDeps): Promise<ProbeRunResult> {
  const startedMs = deps.now();
  const result: ProbeRunResult = {
    provider,
    run,
    step: probeStep(provider, run, stamp),
    sessionId: null,
    pass: false,
    control: input.control,
    failures: [],
    speed: { timeToFirstTokenMs: null, wallTimeMs: null, generationMs: null, outputTokens: 0, reasoningTokens: 0, generationTokensPerSecond: null },
    estimatedCost: 0,
    realCostDelta: null,
    wallMs: 0,
  };
  const step = result.step;
  const root = path.resolve(input.dir);
  const project = deps.projectName(projectRootOfRun(root));
  const state = deps.sandboxState(project);
  let worktreeCreated = false;
  let answered = false;
  // The worktree steps (create, config write, remove) are setup: they say
  // nothing about the provider, so they fail with rule `setup`.
  let phase: "setup" | "run" = "setup";
  try {
    if (state === null) throw new Error(`no sandbox state for project ${project}. Run oc-sub up first.`);
    const worktreePath = await createWorktree(step, root, input.env, deps);
    worktreeCreated = true;

    // The config must exist before the first server request to the folder:
    // a fresh directory loads its config on first use (probe-routing.md §4).
    writeRunConfig(deps.runner, state.name, worktreePath, provider, input.env);
    phase = "run";

    const key = await deps.resolveKey(worktreePath);
    const usageBefore = key !== null ? await fetchKeyUsage(key, deps.fetch) : null;

    const sessionId = await startRun(input, provider, worktreePath, deps, (id) => {
      result.sessionId = id;
    });
    result.sessionId = sessionId;

    const { timedOut, pending } = await waitForSettled(sessionId, worktreePath, deps);
    let paused = false;
    if (timedOut) {
      result.failures.push({ rule: "timeout", detail: `the run did not settle within ${deps.runTimeoutMs / 1000}s and was aborted` });
      await abortRun(deps.client, sessionId, worktreePath);
    }
    if (pending !== null) {
      // The run waits for an answer that the probe cannot give. Aborting at
      // once keeps the 15 minute budget for the other runs.
      paused = true;
      result.failures.push({ rule: "paused", detail: pendingDetail(pending) });
      await abortRun(deps.client, sessionId, worktreePath);
    }

    const messages = unwrap(
      await deps.client.session.messages({ path: { id: sessionId }, query: { directory: worktreePath } }),
      "load messages",
    );
    answered = sessionAnswered(messages);
    const answer = readAnswer(deps.runner, state.name, worktreePath, input.env);
    const hasCommit = hasCommitOverBase(deps.runner, state.name, worktreePath, input.env);

    if (input.control) {
      // The control must fail with a routing refusal of OpenRouter. It
      // passes only when the session error (or the thrown error below)
      // shows one, for example `No endpoints found`. A model-not-found
      // error, which happens when the alias config did not load, is
      // exactly the failure that the control must catch: any other error
      // fails the control with rule `control`, and the detail quotes it.
      const errorText = sessionErrorText(messages);
      const refused = isRoutingRefusal(errorText);
      result.pass = refused;
      if (refused) {
        result.failures = [{ rule: "control-error", detail: errorText ?? "the run failed with a routing refusal" }];
      } else {
        result.failures.push({
          rule: "control",
          detail: errorText ?? "the control run answered or failed without a routing refusal",
        });
      }
    } else {
      // A failed run records the error text of the session in its failures.
      const errorText = sessionErrorText(messages);
      if (errorText !== null) result.failures.push({ rule: "error", detail: errorText });
      const evaluated = evaluateRun({ messages, answer, hasCommit, expected: input.expected });
      result.pass = evaluated.pass && !timedOut && !paused && errorText === null;
      result.failures.push(...evaluated.failures);
    }
    result.speed = speedMetrics(messages);
    result.estimatedCost = summarizeMessages(messages).cost;

    const usageAfter = key !== null ? await fetchKeyUsage(key, deps.fetch) : null;
    result.realCostDelta = usageBefore !== null && usageAfter !== null ? usageAfter - usageBefore : null;
  } catch (error) {
    result.pass = false;
    const detail = error instanceof Error ? error.message : String(error);
    if (phase === "setup") {
      // A setup failure says nothing about the provider.
      result.failures.push({ rule: "setup", detail });
    } else {
      result.failures.push({ rule: "error", detail });
      // A control run that fails with a routing refusal did what it should:
      // the pin made OpenRouter refuse the request. Any other error, for
      // example a model-not-found error from an unloaded alias config, fails
      // the control, and the detail quotes the error text.
      if (input.control) {
        if (!answered && isRoutingRefusal(detail)) {
          result.pass = true;
          result.failures = [{ rule: "control-error", detail }];
        } else {
          result.failures.push({ rule: "control", detail });
        }
      }
    }
  }
  result.wallMs = deps.now() - startedMs;
  if (worktreeCreated) {
    const removed = await removeWorktree(step, root, input.env, deps);
    if (!removed) {
      result.pass = false;
      result.failures.push({ rule: "setup", detail: `removing the run worktree ${step} failed` });
    }
  }
  return result;
}

/** The sbx exec command prefix of the sandbox clone. */
function execCmd(env: Env, name: string, ...args: readonly string[]): string[] {
  return [sbxBin(env), "exec", name, ...args];
}

/** The clone-mode dependencies of the worktree commands, over the probe deps. */
function cloneDeps(deps: ProbeDeps): CloneDeps {
  return {
    runner: deps.runner,
    sandboxState: deps.sandboxState,
    projectName: deps.projectName,
    // The probe task needs only grep and git, so no project setup command.
    setupCommand: () => undefined,
    // The worktree removal disposes the opencode instance of the folder
    // first, so that opencode stops writing into it before `git worktree
    // remove` runs (the package-install race).
    dispose: async (baseUrl, directory) => {
      assertOk(await deps.client.instance.dispose({ query: { directory } }), "dispose instance");
    },
    sleep: deps.sleep,
  };
}

/** Creates the run worktree with the same code as `oc-sub worktree`. */
async function createWorktree(step: string, root: string, env: Env, deps: ProbeDeps): Promise<string> {
  const code = await worktree({ step, dir: root, noSetup: true }, env, cloneDeps(deps));
  if (code !== 0) throw new Error(`creating the run worktree ${step} failed`);
  return path.join(root, ".worktrees", step);
}

/** Removes the run worktree with the same code as `oc-sub worktree rm`. */
async function removeWorktree(step: string, root: string, env: Env, deps: ProbeDeps): Promise<boolean> {
  const code = await worktreeRm({ step, dir: root }, env, cloneDeps(deps));
  if (code !== 0) console.error(`warning: removing the run worktree ${step} failed`);
  return code === 0;
}

/**
 * Writes `.opencode/opencode.json` with the model alias of the provider
 * into the worktree, through `sbx exec`. Must run before the first server
 * request to the worktree.
 */
function writeRunConfig(runner: Runner, name: string, worktreePath: string, provider: string, env: Env): void {
  const configDir = path.join(worktreePath, ".opencode");
  const configFile = path.join(configDir, "opencode.json");
  const script = `mkdir -p ${shellQuote(configDir)} && printf %s ${shellQuote(probeConfig(provider))} > ${shellQuote(configFile)}`;
  const result = runner(execCmd(env, name, "sh", "-c", script));
  if (result.exitCode !== 0) {
    throw new Error(`writing the probe configuration into the worktree failed (exit ${result.exitCode})`);
  }
}

/** Creates the session and sends the probe task with the model alias. */
async function startRun(
  input: ProbeInput,
  provider: string,
  worktreePath: string,
  deps: ProbeDeps,
  onCreated: (sessionId: string) => void,
): Promise<string> {
  const created = unwrap(
    await deps.client.session.create({ query: { directory: worktreePath }, body: {} }),
    "create session",
  );
  onCreated(created.id);
  assertOk(
    await deps.client.session.promptAsync({
      path: { id: created.id },
      query: { directory: worktreePath },
      body: {
        agent: "coder",
        parts: [{ type: "text", text: input.taskText }],
        model: { providerID: PROBE_PROVIDER_ID, modelID: probeAlias(provider) },
      },
    }),
    "send probe task",
  );
  return created.id;
}

async function abortRun(client: OpencodeClient, sessionId: string, directory: string): Promise<void> {
  assertOk(await client.session.abort({ path: { id: sessionId }, query: { directory } }), "abort session");
}

/**
 * The settled wait of `oc-sub watch`, as a poll loop: the session tree is
 * the session and all descendant sessions, a pending request keeps it
 * waiting, the guards check for stalls, and a missing session is settled
 * per `missingSessionIsSettled`. Returns whether the time limit hit first.
 */
async function waitForSettled(
  sessionId: string,
  worktreePath: string,
  deps: ProbeDeps,
): Promise<{ timedOut: boolean; pending: PendingRequest | null; findings: Finding[] }> {
  const client = deps.client;
  const guard = createGuard();
  const findings: Finding[] = [];
  const childrenOf = childIdsOf(client, worktreePath);
  const deadline = deps.now() + deps.runTimeoutMs;
  for (;;) {
    if (deps.now() >= deadline) return { timedOut: true, pending: null, findings };
    try {
      const states = unwrap(await client.session.status({ query: { directory: worktreePath } }), "session status");
      const descendants = await collectDescendants(sessionId, childrenOf);
      const ids = new Set([sessionId, ...descendants]);
      const now = deps.now();
      ids.forEach((id) => guard.touch(id, now));
      findings.push(...guard.checkStalls(states, now));
      const pending = await deps.pendingRequests(worktreePath);
      const pendingOfTree = pending.filter((request) => ids.has(request.request.sessionID));
      if (pendingOfTree.length > 0) {
        // The run pauses on a question or a permission request. The probe
        // cannot answer, so the caller aborts the run at once instead of
        // waiting for the time limit.
        return { timedOut: false, pending: pendingOfTree[0]!, findings };
      }
      if (!treeIsSettled([sessionId, ...descendants], states)) {
        await deps.sleep(deps.pollMs);
        continue;
      }
      if (states[sessionId] !== undefined) return { timedOut: false, pending: null, findings };
      // The main session is missing from the status map: ended, or so new
      // that the server has not marked it busy yet. The messages tell.
      const session = unwrap(
        await client.session.get({ path: { id: sessionId }, query: { directory: worktreePath } }),
        "load session",
      );
      const messages = unwrap(
        await client.session.messages({ path: { id: sessionId }, query: { directory: worktreePath } }),
        "load messages",
      );
      if (missingSessionIsSettled(messages, session.time.updated, deps.now())) {
        return { timedOut: false, pending: null, findings };
      }
    } catch {
      // Server unreachable right now; the next poll tries again.
    }
    await deps.sleep(deps.pollMs);
  }
}

/** The content of `answer.md` in the worktree, or null without one. */
function readAnswer(runner: Runner, name: string, worktreePath: string, env: Env): string | null {
  const result = runner(execCmd(env, name, "cat", path.join(worktreePath, "answer.md")));
  return result.exitCode === 0 ? result.stdout : null;
}

/** Whether a commit exists over the base (`host/alpha`) inside the clone. */
function hasCommitOverBase(runner: Runner, name: string, worktreePath: string, env: Env): boolean {
  const result = runner(execCmd(env, name, "git", "-C", worktreePath, "rev-list", "--count", "host/alpha..HEAD"));
  if (result.exitCode !== 0) return false;
  return result.stdout.trim() !== "0";
}
