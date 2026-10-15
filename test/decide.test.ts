/** Tests for `idfx decide --json`: one choice question to Jev, no network. */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs, UsageError } from "../src/args";
import { decide, type DecideDeps } from "../src/decide";
import { JEV_MODEL, JEV_STATE_LIMIT } from "../src/jev";
import { stateDir } from "../src/state";

const KEY = "sk-or-v1-secret-decide-key";
const FILE_KEY = "sk-or-v1-secret-file-key";

const INPUT = {
  state: "The sky is blue today.",
  question: "What colour is the sky?",
  options: { blue: "The sky is blue.", red: "The sky is red." },
  title: "idfx decide test",
};

const OK_BODY = {
  id: "gen-123",
  model: "typesafe/jev-1.13-20260917",
  answers: { decision: { type: "choice", choice: "blue", confidence: 0.97, probabilities: { blue: 0.97, red: 0.03 } } },
  usage: { cost: 0.0002 },
};

type Call = { url: string; init: RequestInit | undefined };

/** A temp env with its own state and config folders; the key in env unless `key` is null. */
function tempEnv(key: string | null = KEY): Record<string, string | undefined> {
  const root = mkdtempSync(path.join(tmpdir(), "decide-"));
  return {
    XDG_STATE_HOME: path.join(root, "state"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    ...(key === null ? {} : { OPENROUTER_API_KEY: key }),
  };
}

function writeKeyFile(env: Record<string, string | undefined>, key: string): void {
  const dir = path.join(env.XDG_CONFIG_HOME as string, "idfix");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "openrouter.key"), `${key}\n`);
}

/** Run decide with a fake fetch that answers each call with the next response. */
async function run(
  env: Record<string, string | undefined>,
  stdin: string,
  responses: Array<{ status: number; body: unknown } | Error>,
): Promise<{ code: number; out: string[]; err: string[]; calls: Call[]; slept: number[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const calls: Call[] = [];
  const slept: number[] = [];
  let index = 0;
  const deps: DecideDeps = {
    readStdin: () => Promise.resolve(stdin),
    doFetch: async (input, init) => {
      calls.push({ url: String(input), init });
      const next = responses[Math.min(index++, responses.length - 1)];
      if (next === undefined) throw new Error("no response");
      if (next instanceof Error) throw next;
      return new Response(JSON.stringify(next.body), { status: next.status });
    },
    sleep: (ms) => {
      slept.push(ms);
      return Promise.resolve();
    },
    now: () => new Date("2026-10-15T12:00:00.000Z"),
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
  };
  const code = await decide(env, deps);
  return { code, out, err, calls, slept };
}

function errorOf(err: string[]): { type: string; message: string } {
  expect(err).toHaveLength(1);
  return (JSON.parse(err[0] as string) as { error: { type: string; message: string } }).error;
}

function logLines(env: Record<string, string | undefined>): Array<Record<string, unknown>> {
  const file = path.join(stateDir(env), "decide.log");
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function logText(env: Record<string, string | undefined>): string {
  return readFileSync(path.join(stateDir(env), "decide.log"), "utf8");
}

describe("decide args", () => {
  test("decide --json parses", () => {
    expect(parseArgs(["decide", "--json"])).toEqual({ command: "decide", json: true });
  });

  test("decide without --json is a usage error", () => {
    expect(() => parseArgs(["decide"])).toThrow(UsageError);
  });
});

describe("decide success", () => {
  test("prints the answer line, sends one choice question, and exits 0", async () => {
    const env = tempEnv();
    const r = await run(env, JSON.stringify(INPUT), [{ status: 200, body: OK_BODY }]);
    expect(r.code).toBe(0);
    expect(r.err).toEqual([]);
    expect(r.out).toHaveLength(1);
    expect(JSON.parse(r.out[0] as string)).toEqual({
      choice: "blue",
      confidence: 0.97,
      probabilities: { blue: 0.97, red: 0.03 },
      model: "typesafe/jev-1.13-20260917",
      cost: 0.0002,
      id: "gen-123",
    });
    expect(r.calls).toHaveLength(1);
    const sent = JSON.parse(String(r.calls[0]?.init?.body)) as Record<string, unknown>;
    expect(sent).toEqual({
      model: JEV_MODEL,
      state: INPUT.state,
      questions: { decision: { type: "choice", instructions: INPUT.question, criteria: INPUT.options } },
    });
  });

  test("sends the title as the X-Title header", async () => {
    const r = await run(tempEnv(), JSON.stringify(INPUT), [{ status: 200, body: OK_BODY }]);
    const headers = r.calls[0]?.init?.headers as Record<string, string>;
    expect(headers["X-Title"]).toBe("idfx decide test");
    expect(headers.Authorization).toBe(`Bearer ${KEY}`);
  });

  test("missing optional fields of the answer become null, and the model falls back", async () => {
    const { title: _title, ...noTitle } = INPUT;
    const body = { answers: { decision: { type: "choice", choice: "red" } } };
    const r = await run(tempEnv(), JSON.stringify(noTitle), [{ status: 200, body }]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out[0] as string)).toEqual({
      choice: "red",
      confidence: null,
      probabilities: null,
      model: JEV_MODEL,
      cost: null,
      id: null,
    });
    const headers = r.calls[0]?.init?.headers as Record<string, string>;
    expect(headers["X-Title"]).toBeUndefined();
  });

  test("an object state is sent as it is", async () => {
    const r = await run(tempEnv(), JSON.stringify({ ...INPUT, state: { lesson: "x" } }), [{ status: 200, body: OK_BODY }]);
    expect(r.code).toBe(0);
    expect((JSON.parse(String(r.calls[0]?.init?.body)) as { state: unknown }).state).toEqual({ lesson: "x" });
  });
});

describe("decide HTTP errors", () => {
  const cases: Array<[string, number, string, number]> = [
    ["402", 402, "limit", 1],
    ["401", 401, "auth", 1],
    ["403", 403, "auth", 1],
  ];
  for (const [name, status, type, calls] of cases) {
    test(`HTTP ${name} is ${type}`, async () => {
      const r = await run(tempEnv(), JSON.stringify(INPUT), [{ status, body: { error: { message: "nope" } } }]);
      expect(r.code).toBe(1);
      expect(r.out).toEqual([]);
      const error = errorOf(r.err);
      expect(error.type).toBe(type);
      expect(error.message).toContain(String(status));
      expect(r.calls).toHaveLength(calls);
    });
  }

  test("HTTP 429 after the retry is limit", async () => {
    const r = await run(tempEnv(), JSON.stringify(INPUT), [{ status: 429, body: {} }]);
    expect(r.code).toBe(1);
    expect(r.calls).toHaveLength(2);
    expect(r.slept).toEqual([2000]);
    expect(errorOf(r.err).type).toBe("limit");
  });

  test("HTTP 500 after the retry is failed", async () => {
    const r = await run(tempEnv(), JSON.stringify(INPUT), [{ status: 500, body: {} }]);
    expect(r.code).toBe(1);
    expect(r.calls).toHaveLength(2);
    expect(errorOf(r.err).type).toBe("failed");
  });

  test("a 429 with a good retry succeeds", async () => {
    const r = await run(tempEnv(), JSON.stringify(INPUT), [{ status: 429, body: {} }, { status: 200, body: OK_BODY }]);
    expect(r.code).toBe(0);
    expect(r.calls).toHaveLength(2);
  });

  test("a network error is failed and writes no log line", async () => {
    const env = tempEnv();
    const r = await run(env, JSON.stringify(INPUT), [new Error("connection refused")]);
    expect(r.code).toBe(1);
    const error = errorOf(r.err);
    expect(error.type).toBe("failed");
    expect(error.message).toContain("connection refused");
    expect(() => logText(env)).toThrow();
  });

  test("a choice that is not an option is failed", async () => {
    const body = { ...OK_BODY, answers: { decision: { type: "choice", choice: "green" } } };
    const r = await run(tempEnv(), JSON.stringify(INPUT), [{ status: 200, body }]);
    expect(r.code).toBe(1);
    expect(errorOf(r.err)).toEqual({ type: "failed", message: "HTTP 200 with a choice that is not an option: green" });
  });

  test("a 200 without answers is failed", async () => {
    const r = await run(tempEnv(), JSON.stringify(INPUT), [{ status: 200, body: { model: "m" } }]);
    expect(r.code).toBe(1);
    expect(errorOf(r.err).type).toBe("failed");
  });

  test("an error message never carries the key", async () => {
    const r = await run(tempEnv(), JSON.stringify(INPUT), [{ status: 401, body: { error: { message: `bad key ${KEY}` } } }]);
    expect(r.err.join("\n")).not.toContain(KEY);
  });
});

describe("decide input errors", () => {
  const cases: Array<[string, string]> = [
    ["not JSON", "{nope"],
    ["not an object", "[1,2]"],
    ["missing state", JSON.stringify({ question: "q", options: INPUT.options })],
    ["missing question", JSON.stringify({ state: "s", options: INPUT.options })],
    ["empty question", JSON.stringify({ ...INPUT, question: "  " })],
    ["missing options", JSON.stringify({ state: "s", question: "q" })],
    ["one option", JSON.stringify({ ...INPUT, options: { blue: "b" } })],
    ["option not a string", JSON.stringify({ ...INPUT, options: { blue: "b", red: 1 } })],
    ["state a number", JSON.stringify({ ...INPUT, state: 3 })],
    ["title not a string", JSON.stringify({ ...INPUT, title: 3 })],
    ["unknown key", JSON.stringify({ ...INPUT, extra: true })],
    ["state too long", JSON.stringify({ ...INPUT, state: "x".repeat(JEV_STATE_LIMIT) })],
  ];
  for (const [name, stdin] of cases) {
    test(`${name} is input, exit 2, no request`, async () => {
      const r = await run(tempEnv(), stdin, [{ status: 200, body: OK_BODY }]);
      expect(r.code).toBe(2);
      expect(errorOf(r.err).type).toBe("input");
      expect(r.calls).toHaveLength(0);
    });
  }

  test("a state of exactly the limit is accepted", async () => {
    const state = "x".repeat(JEV_STATE_LIMIT - 2);
    const r = await run(tempEnv(), JSON.stringify({ ...INPUT, state }), [{ status: 200, body: OK_BODY }]);
    expect(r.code).toBe(0);
  });
});

describe("decide key", () => {
  test("a missing key is auth and names the env var and the key file", async () => {
    const env = tempEnv(null);
    const r = await run(env, JSON.stringify(INPUT), [{ status: 200, body: OK_BODY }]);
    expect(r.code).toBe(1);
    const error = errorOf(r.err);
    expect(error.type).toBe("auth");
    expect(error.message).toContain("OPENROUTER_API_KEY");
    expect(error.message).toContain(path.join(env.XDG_CONFIG_HOME as string, "idfix", "openrouter.key"));
    expect(r.calls).toHaveLength(0);
  });

  test("the key file of idfix is used without the env var", async () => {
    const env = tempEnv(null);
    writeKeyFile(env, FILE_KEY);
    const r = await run(env, JSON.stringify(INPUT), [{ status: 200, body: OK_BODY }]);
    expect(r.code).toBe(0);
    expect((r.calls[0]?.init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${FILE_KEY}`);
  });

  test("the env var beats the key file", async () => {
    const env = tempEnv(KEY);
    writeKeyFile(env, FILE_KEY);
    const r = await run(env, JSON.stringify(INPUT), [{ status: 200, body: OK_BODY }]);
    expect((r.calls[0]?.init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
  });
});

describe("decide log", () => {
  test("a success appends one line with the right fields", async () => {
    const env = tempEnv();
    await run(env, JSON.stringify(INPUT), [{ status: 200, body: OK_BODY }]);
    expect(logLines(env)).toEqual([
      {
        source: "idfx-decide",
        event: "end",
        time: "2026-10-15T12:00:00.000Z",
        status: 200,
        model: "typesafe/jev-1.13-20260917",
        cost: 0.0002,
        id: "gen-123",
        title: "idfx decide test",
        choice: "blue",
        error: null,
      },
    ]);
  });

  test("an HTTP failure appends a line with the status and the error type", async () => {
    const env = tempEnv();
    await run(env, JSON.stringify(INPUT), [{ status: 402, body: { error: { message: "no credits" } } }]);
    const [line] = logLines(env);
    expect(line?.status).toBe(402);
    expect(line?.error).toBe("limit");
    expect(line?.choice).toBeNull();
    expect(line?.model).toBe(JEV_MODEL);
  });

  test("the log never contains the key", async () => {
    const env = tempEnv();
    const body = { ...OK_BODY, id: KEY };
    await run(env, JSON.stringify({ ...INPUT, title: `t ${KEY}` }), [{ status: 200, body }]);
    expect(logText(env)).not.toContain(KEY);
  });

  test("an input error writes no log line", async () => {
    const env = tempEnv();
    await run(env, "{nope", []);
    expect(() => logText(env)).toThrow();
  });

  test("a failed log write warns on stderr and keeps the result", async () => {
    const env = tempEnv();
    // A file where the state folder should be makes mkdir fail.
    mkdirSync(env.XDG_STATE_HOME as string, { recursive: true });
    writeFileSync(stateDir(env), "not a folder");
    const r = await run(env, JSON.stringify(INPUT), [{ status: 200, body: OK_BODY }]);
    expect(r.code).toBe(0);
    expect(r.out).toHaveLength(1);
    expect(r.err).toHaveLength(1);
    expect(r.err[0]).toContain("warning: cannot write decide.log");
  });
});
