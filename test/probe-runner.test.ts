/**
 * Tests for the probe runner (src/probe/runner.ts). Every dependency is a
 * fake: the `sbx` runner, the server client, the OpenRouter fetch, the key
 * source, the pending requests, the results writer, and the clock. No real
 * sandbox, server, or paid call runs here.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AssistantMessage, Message, OpencodeClient, Part, UserMessage } from "@opencode-ai/sdk";
import type { Env } from "../src/config";
import type { SandboxState } from "../src/sandbox";
import type { MessageEntry } from "../src/summary";
import {
  CONTROL_PROVIDER,
  median,
  probeAlias,
  probeConfig,
  probeStep,
  resultsFilePath,
  runProbe,
  PROBE_MODEL_ID,
  type ProbeDeps,
} from "../src/probe/runner";
import type { ExpectedAnswer } from "../src/probe/evaluate";

const EXPECTED: ExpectedAnswer = {
  interfaces: [
    { name: "ProbeLedgerEntry", line: 1, fields: ["entryId", "recordedAt"] },
    { name: "ProbeManifestField", line: 2, fields: ["key", "label"] },
  ],
};
const ROOT = "/repo";
const NAME = "oc-sub-probe-project";
const STATE: SandboxState = { name: NAME, root: ROOT, port: 18768 };
const WORKTREE = `${ROOT}/.worktrees/probe-z-ai-1`;
const BASE = 1_760_000_000_000;

function answerText(): string {
  return EXPECTED.interfaces.map((iface) => `# ${iface.name}\n${iface.fields.join("\n")}`).join("\n\n");
}

function messages(): MessageEntry[] {
  const user: UserMessage = {
    id: "msg_u",
    sessionID: "ses_p1",
    role: "user",
    time: { created: BASE },
    agent: "coder",
    model: { providerID: "openrouter", modelID: PROBE_MODEL_ID },
    parts: [],
  } as unknown as UserMessage;
  const assistant: AssistantMessage = {
    id: "msg_a",
    sessionID: "ses_p1",
    role: "assistant",
    time: { created: BASE + 1, completed: BASE + 500 },
    parentID: "msg_u",
    modelID: PROBE_MODEL_ID,
    providerID: "openrouter",
    mode: "code",
    path: { cwd: WORKTREE, root: WORKTREE },
    cost: 0.01,
    tokens: { input: 1000, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
  } as unknown as AssistantMessage;
  const text: Part = { id: "prt_1", sessionID: "ses_p1", messageID: "msg_a", type: "text", text: answerText(), time: { start: BASE + 50 } };
  return [
    { info: user as unknown as Message, parts: [] },
    { info: assistant as unknown as Message, parts: [text] },
  ];
}

type ClientOptions = {
  busyPolls?: number;
  promptError?: Error;
};

/**
 * The fake server client. It shares the `log` with the fake `sbx` runner,
 * so the test can assert the order of the steps across both fakes.
 */
function fakeClient(options: ClientOptions, log: string[], sessionMessages: MessageEntry[]): OpencodeClient {
  let polls = 0;
  const busyPolls = options.busyPolls ?? 0;
  return {
    session: {
      // The SDK wraps every answer in { data, error }, like unwrap/assertOk read it.
      create: async () => {
        log.push("session-create");
        return { data: { id: "ses_p1" } };
      },
      promptAsync: async () => {
        log.push("prompt");
        if (options.promptError) throw options.promptError;
        return { data: null };
      },
      status: async () => {
        polls += 1;
        return { data: polls <= busyPolls ? { ses_p1: { type: "busy" } } : {} };
      },
      children: async () => ({ data: [] }),
      messages: async () => ({ data: sessionMessages }),
      get: async () => ({ data: { id: "ses_p1", time: { created: BASE, updated: BASE + 100 } } }),
      abort: async () => {
        log.push("abort");
        return { data: null };
      },
    },
  } as unknown as OpencodeClient;
}

/** The scripted `sbx` runner: records every command and answers per command. */
function fakeRunner(options: {
  answerMd?: string | null;
  commitCount?: string;
  failFirstConfig?: number;
  calls?: string[][];
  log?: string[];
}) {
  let configWrites = 0;
  return (cmd: readonly string[]) => {
    options.calls?.push([...cmd]);
    const text = cmd.join(" ");
    if (cmd[3] === "test" && cmd[4] === "-d") return { stdout: "", exitCode: 1 };
    if (cmd[3] === "sh" && text.includes("mkdir -p")) {
      configWrites += 1;
      if (configWrites <= (options.failFirstConfig ?? 0)) return { stdout: "", exitCode: 1 };
      options.log?.push("config-write");
      return { stdout: "", exitCode: 0 };
    }
    if (cmd[3] === "cat") {
      return { stdout: options.answerMd ?? "", exitCode: options.answerMd === null ? 1 : 0 };
    }
    if (text.includes("rev-list --count")) return { stdout: `${options.commitCount ?? "1"}\n`, exitCode: 0 };
    if (cmd[0] === "git" && cmd[4] === "user.name") return { stdout: "Ada\n", exitCode: 0 };
    if (cmd[0] === "git" && cmd[4] === "user.email") return { stdout: "ada@example.com\n", exitCode: 0 };
    if (text.includes("remote get-url")) return { stdout: "", exitCode: 1 };
    return { stdout: "", exitCode: 0 };
  };
}

type Fixture = {
  deps: ProbeDeps;
  calls: string[][];
  log: string[];
  jsonl: { file: string; line: string }[];
  aborts: string[];
  cleanup: () => void;
};

function makeFixture(
  overrides: {
    clientOptions?: ClientOptions;
    runnerOptions?: Parameters<typeof fakeRunner>[0];
    fetchUsage?: number[];
  } = {},
): Fixture {
  const stateHome = mkdtempSync(path.join(tmpdir(), "oc-sub-probe-"));
  const calls: string[][] = [];
  const log: string[] = [];
  const jsonl: { file: string; line: string }[] = [];
  const aborts: string[] = [];
  let fetchCalls = 0;
  let tick = 0;
  const deps: ProbeDeps = {
    runner: fakeRunner({ answerMd: answerText(), calls, log, ...overrides.runnerOptions }),
    sandboxState: () => STATE,
    projectName: () => "probe-project",
    client: fakeClient(overrides.clientOptions ?? {}, log, messages()),
    baseUrl: "http://127.0.0.1:18768",
    fetch: async () => {
      const value = overrides.fetchUsage ? overrides.fetchUsage[fetchCalls++] : fetchCalls++ * 0.01;
      return Response.json({ data: { usage: value } });
    },
    resolveKey: async () => "sk-or-probe-fake",
    pendingRequests: async () => [],
    appendResult: async (file, line) => {
      jsonl.push({ file, line });
    },
    now: () => {
      tick += 1000;
      return BASE + tick;
    },
    sleep: async () => {},
    pollMs: 1000,
    runTimeoutMs: 60_000,
  };
  return {
    deps,
    calls,
    log,
    jsonl,
    aborts,
    cleanup: () => rmSync(stateHome, { recursive: true, force: true }),
  };
}

function input(overrides: Partial<Parameters<typeof runProbe>[0]> = {}): Parameters<typeof runProbe>[0] {
  return {
    dir: ROOT,
    providers: ["z-ai"],
    runs: 1,
    taskText: "probe task",
    expected: EXPECTED,
    control: false,
    resultsFile: "/results/probe.jsonl",
    env: {} as Env,
    ...overrides,
  };
}

/** The passing messages, but the assistant message failed with a session error. */
function messagesWithSessionError(message: string): MessageEntry[] {
  const entries = messages();
  const assistant = entries[1]!.info as AssistantMessage & { error?: unknown };
  assistant.error = { name: "APIError", data: { message, statusCode: 400, isRetryable: false } };
  assistant.tokens.output = 0;
  return entries;
}

describe("probe helpers", () => {
  test("probeConfig defines the alias with the provider pin", () => {
    const config = JSON.parse(probeConfig("BaseTen"));
    expect(config.provider.openrouter.models["glm-probe-baseten"]).toEqual({
      id: PROBE_MODEL_ID,
      options: { provider: { only: ["baseten"], allow_fallbacks: false } },
    });
    expect(probeAlias("z-ai")).toBe("glm-probe-z-ai");
    expect(probeStep("z-ai", 2)).toBe("probe-z-ai-2");
  });

  test("resultsFilePath uses the ISO date", () => {
    expect(resultsFilePath("/results", new Date("2026-09-30T12:00:00Z"))).toBe(path.join("/results", "2026-09-30.jsonl"));
  });

  test("median over sorted values, averaged for an even count", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});

describe("runProbe", () => {
  test("a passing run: prompt with the alias, evaluation, cost delta, JSONL line, worktree removal", async () => {
    const fx = makeFixture({ fetchUsage: [1.0, 1.23] });
    try {
      const results = await runProbe(input(), fx.deps);
      expect(results).toHaveLength(1);
      const result = results[0]!;
      expect(result.pass).toBe(true);
      expect(result.failures).toEqual([]);
      expect(result.sessionId).toBe("ses_p1");
      expect(result.estimatedCost).toBe(0.01);
      expect(result.realCostDelta).toBeCloseTo(0.23);
      expect(result.speed.timeToFirstTokenMs).toBe(50);
      // The prompt request selects the model alias.
      expect(fx.log.filter((entry) => entry === "prompt")).toHaveLength(1);
      // One JSONL line with the fields of the brief.
      expect(fx.jsonl).toHaveLength(1);
      const line = JSON.parse(fx.jsonl[0]!.line);
      expect(line).toMatchObject({
        provider: "z-ai",
        run: 1,
        sessionId: "ses_p1",
        pass: true,
        control: false,
        failures: [],
        estimatedCost: 0.01,
        realCostDelta: expect.closeTo(0.23),
      });
      expect(line.speed.timeToFirstTokenMs).toBe(50);
      expect(fx.jsonl[0]!.file).toBe("/results/probe.jsonl");
      // The worktree was removed again.
      const removed = fx.calls.filter((cmd) => cmd.join(" ").includes("worktree remove --force"));
      expect(removed).toHaveLength(1);
    } finally {
      fx.cleanup();
    }
  });

  test("the config file is written before the run starts", async () => {
    const fx = makeFixture();
    try {
      await runProbe(input(), fx.deps);
      const configIndex = fx.log.indexOf("config-write");
      expect(configIndex).toBeGreaterThanOrEqual(0);
      expect(configIndex).toBeLessThan(fx.log.indexOf("session-create"));
      expect(fx.log.indexOf("session-create")).toBeLessThan(fx.log.indexOf("prompt"));
    } finally {
      fx.cleanup();
    }
  });

  test("a failed rule: the answer and the commit do not match", async () => {
    const fx = makeFixture({ runnerOptions: { answerMd: "wrong content", commitCount: "0" } });
    try {
      const results = await runProbe(input(), fx.deps);
      expect(results[0]!.pass).toBe(false);
      const rules = results[0]!.failures.map((failure) => failure.rule);
      expect(rules).toContain("answer");
      expect(rules).toContain("commit");
    } finally {
      fx.cleanup();
    }
  });

  test("a run that throws in the middle: the worktree is removed and the next run starts", async () => {
    const fx = makeFixture({ runnerOptions: { failFirstConfig: 1 } });
    try {
      const results = await runProbe(input({ providers: ["z-ai", "baseten"] }), fx.deps);
      expect(results).toHaveLength(2);
      expect(results[0]!.pass).toBe(false);
      expect(results[0]!.failures[0]!.rule).toBe("error");
      expect(results[1]!.provider).toBe("baseten");
      expect(results[1]!.pass).toBe(true);
      // Both worktrees were removed.
      const removed = fx.calls.filter((cmd) => cmd.join(" ").includes("worktree remove --force"));
      expect(removed).toHaveLength(2);
    } finally {
      fx.cleanup();
    }
  });

  test("the timeout: the run is aborted and counts as failed with rule timeout", async () => {
    const fx = makeFixture({ clientOptions: { busyPolls: 1000 } });
    fx.deps.runTimeoutMs = 5000;
    try {
      const results = await runProbe(input(), fx.deps);
      expect(results[0]!.pass).toBe(false);
      expect(results[0]!.failures[0]!.rule).toBe("timeout");
      expect(fx.log).toContain("abort");
    } finally {
      fx.cleanup();
    }
  });

  test("the control mode: only a routing refusal passes", async () => {
    // A thrown routing refusal passes: the pin made OpenRouter refuse.
    const fxError = makeFixture({
      clientOptions: { promptError: new Error("No endpoints found for no-such-provider") },
    });
    try {
      const results = await runProbe(input({ control: true, providers: [CONTROL_PROVIDER] }), fxError.deps);
      expect(results[0]!.pass).toBe(true);
      expect(results[0]!.control).toBe(true);
      expect(results[0]!.failures[0]!.rule).toBe("control-error");
      expect(results[0]!.failures[0]!.detail).toContain("No endpoints found");
    } finally {
      fxError.cleanup();
    }
    // A model-not-found error (the alias config did not load) is the exact
    // failure that the control must catch: it fails with rule control.
    const fxModel = makeFixture({
      clientOptions: { promptError: new Error("Model not found: openrouter/glm-probe-no-such-provider") },
    });
    try {
      const results = await runProbe(input({ control: true, providers: [CONTROL_PROVIDER] }), fxModel.deps);
      expect(results[0]!.pass).toBe(false);
      const control = results[0]!.failures.find((failure) => failure.rule === "control");
      expect(control?.detail).toContain("Model not found");
    } finally {
      fxModel.cleanup();
    }
    // A session error with a routing refusal (no thrown error) passes.
    const fxSession = makeFixture({ clientOptions: {} });
    fxSession.deps.client = fakeClient({}, fxSession.log, messagesWithSessionError("No allowed providers are available"));
    try {
      const results = await runProbe(input({ control: true, providers: [CONTROL_PROVIDER] }), fxSession.deps);
      expect(results[0]!.pass).toBe(true);
    } finally {
      fxSession.cleanup();
    }
    // The run answers: the control fails.
    const fxAnswer = makeFixture();
    try {
      const results = await runProbe(input({ control: true, providers: [CONTROL_PROVIDER] }), fxAnswer.deps);
      expect(results[0]!.pass).toBe(false);
      expect(results[0]!.failures[0]!.rule).toBe("control");
    } finally {
      fxAnswer.cleanup();
    }
  });

  test("a failed normal run records the error text of the session", async () => {
    const fx = makeFixture();
    fx.deps.client = fakeClient({}, fx.log, messagesWithSessionError("No endpoints found for z-ai"));
    try {
      const results = await runProbe(input(), fx.deps);
      const errors = results[0]!.failures.filter((failure) => failure.rule === "error");
      expect(errors).toHaveLength(1);
      expect(errors[0]!.detail).toContain("No endpoints found");
      expect(results[0]!.pass).toBe(false);
    } finally {
      fx.cleanup();
    }
  });

  test("a pending request aborts the run at once with rule paused", async () => {
    let first = true;
    const fx = makeFixture();
    const pending = async () => {
      if (first) {
        first = false;
        return [
          {
            kind: "question" as const,
            request: { id: "q1", sessionID: "ses_p1", questions: [{ question: "Delete build/tmp.txt?", header: "Delete file", options: [] }] },
          },
        ];
      }
      return [];
    };
    fx.deps.pendingRequests = pending;
    try {
      const results = await runProbe(input(), fx.deps);
      expect(results[0]!.pass).toBe(false);
      const paused = results[0]!.failures.find((failure) => failure.rule === "paused");
      expect(paused?.detail).toContain("question");
      expect(paused?.detail).toContain("Delete build/tmp.txt?");
      expect(fx.log).toContain("abort");
    } finally {
      fx.cleanup();
    }
  });
});
