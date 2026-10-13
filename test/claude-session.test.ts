import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { findClaudeTranscript } from "../src/claude/run";
import { claudeStateDir } from "../src/claude/sandbox-state";
import {
  addUsage,
  claudeAbort,
  claudeLog,
  claudeProcessPattern,
  claudeSay,
  lastAssistantText,
  readStateFile,
  type ClaudeSessionDeps,
} from "../src/claude/session";
import { loadRunRecord, makeRunRecord, runRecordPath, stateRunRecordPath, writeRunRecord, writeStateRunRecord, type ClaudeRunInfo, type RunRecord } from "../src/runs";
import type { Runner } from "../src/sandbox";

const SESSION = "0b6f6c1e-1111-4222-8333-944455556666";

function resultJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 1000,
    num_turns: 2,
    result: "follow-up done",
    session_id: SESSION,
    total_cost_usd: 0.01,
    usage: { input_tokens: 5, output_tokens: 7, server_tool_use: { web_search_requests: 1 }, service_tier: "standard" },
    modelUsage: { "claude-sonnet-5-5": {} },
    ...overrides,
  });
}

function assistantLine(id: string, text: string): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: "2026-10-13T10:00:00Z",
    message: { id, model: "claude-sonnet-5-5", content: [{ type: "text", text }], usage: { input_tokens: 3, output_tokens: 4 } },
  });
}

type Fixture = {
  base: string;
  cwd: string;
  env: Record<string, string>;
  name: string;
  stateDir: string;
  calls: string[][];
  synced: string[];
  deps: ClaudeSessionDeps;
};

function info(stateDir: string, overrides: Partial<ClaudeRunInfo> = {}): ClaudeRunInfo {
  return {
    sandbox: "claude-proj",
    stateDir,
    model: "sonnet",
    status: "ok",
    error: null,
    exitCode: 0,
    isError: false,
    subtype: "success",
    numTurns: 1,
    durationMs: 3000,
    costUsd: 0.03,
    costKind: "api-equivalent-estimate",
    usage: { input_tokens: 10, output_tokens: 20, server_tool_use: { web_search_requests: 0 } },
    transcript: null,
    endedAt: "2026-10-13T09:00:00.000Z",
    ...overrides,
  };
}

/** A temp env, a run record in the state folder and in cwd, and deps with a fake runner. */
async function fixture(
  answer: (cmd: readonly string[]) => { stdout?: string; exitCode?: number; stderr?: string },
  overrides: Partial<ClaudeRunInfo> = {},
): Promise<Fixture> {
  const base = mkdtempSync(path.join(tmpdir(), "idfx-claude-session-"));
  const cwd = path.join(base, "cwd");
  mkdirSync(cwd);
  const env = { HOME: path.join(base, "home"), XDG_STATE_HOME: path.join(base, "state"), CLAUDE_CONFIG_DIR: path.join(base, "host-claude") };
  const name = "claude-proj";
  const stateDir = claudeStateDir(env, name);
  mkdirSync(stateDir, { recursive: true });
  const record = makeRunRecord({
    sessionId: SESSION,
    directory: "/work/proj",
    agent: "claude",
    title: "T",
    driver: "claude",
    startedAt: new Date("2026-10-13T08:59:00Z"),
    claude: info(stateDir, overrides),
  });
  await writeRunRecord(cwd, record);
  await writeStateRunRecord(env, record);
  const calls: string[][] = [];
  const synced: string[] = [];
  const runner: Runner = (cmd) => {
    calls.push([...cmd]);
    const res = answer(cmd);
    return { stdout: res.stdout ?? "", exitCode: res.exitCode ?? 0, stderr: res.stderr ?? "" };
  };
  const deps: ClaudeSessionDeps = {
    runner,
    sync: (hostDir, state) => {
      synced.push(`${hostDir} -> ${state}`);
      return { pluginDirs: [], missingPlugins: [] };
    },
    findTranscript: findClaudeTranscript,
    cwd,
    now: () => new Date("2026-10-13T10:00:00Z"),
    load: loadRunRecord,
    readTranscript: readStateFile,
  };
  return { base, cwd, env, name, stateDir, calls, synced, deps };
}

function readRecord(file: string): RunRecord {
  return JSON.parse(readFileSync(file, "utf8")) as RunRecord;
}

function lsLine(name: string, workspace: string): string {
  return `SANDBOX AGENT STATUS PORTS WORKSPACE\n${name}   claude   running    ${workspace}\n`;
}

let out: string[];
let err: string[];
let logSpy: ReturnType<typeof spyOn>;
let errSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  out = [];
  err = [];
  logSpy = spyOn(console, "log").mockImplementation((line: unknown) => {
    out.push(String(line));
  });
  errSpy = spyOn(console, "error").mockImplementation((line: unknown) => {
    err.push(String(line));
  });
});

afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
});

describe("pure helpers", () => {
  test("addUsage adds numbers, also nested, and keeps the later other values", () => {
    expect(addUsage({ a: 1, n: { x: 2 }, tier: "a" }, { a: 3, n: { x: 1, y: 5 }, tier: "b", c: 4 })).toEqual({
      a: 4,
      n: { x: 3, y: 5 },
      tier: "b",
      c: 4,
    });
    expect(addUsage(null, { a: 1 })).toEqual({ a: 1 });
    expect(addUsage({ a: 1 }, null)).toEqual({ a: 1 });
  });

  test("claudeProcessPattern does not match its own text", () => {
    const pattern = new RegExp(claudeProcessPattern(SESSION));
    expect(pattern.test(`/usr/bin/node /usr/local/bin/claude -p x --resume ${SESSION}`)).toBe(true);
    expect(pattern.test(`pkill -f ${claudeProcessPattern(SESSION)}`)).toBe(false);
  });

  test("lastAssistantText joins the text blocks of the last message", () => {
    const text = [
      assistantLine("m1", "first"),
      JSON.stringify({ type: "user", message: { content: "hi" } }),
      assistantLine("m2", "second a"),
      JSON.stringify({ type: "assistant", message: { id: "m2", content: [{ type: "tool_use", id: "t" }] } }),
      assistantLine("m2", "second b"),
      "not json",
    ].join("\n");
    expect(lastAssistantText(new TextEncoder().encode(text))).toBe("second a\n\nsecond b");
    expect(lastAssistantText(new TextEncoder().encode("{}\n"))).toBeNull();
  });
});

describe("readStateFile", () => {
  test("reads a file, and only the end of a large one from a line start", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "idfx-state-file-"));
    const file = path.join(dir, "t.jsonl");
    writeFileSync(file, "aaaa\nbbbb\ncccc\n");
    expect(new TextDecoder().decode(readStateFile(dir, file).bytes)).toBe("aaaa\nbbbb\ncccc\n");
    const cut = readStateFile(dir, file, 8);
    expect(cut.cut).toBe(true);
    expect(new TextDecoder().decode(cut.bytes)).toBe("cccc\n");
  });

  test("refuses a link and a file outside the state folder", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "idfx-state-file-"));
    const outside = mkdtempSync(path.join(tmpdir(), "idfx-state-out-"));
    writeFileSync(path.join(outside, "secret"), "x\n");
    symlinkSync(path.join(outside, "secret"), path.join(dir, "link.jsonl"));
    expect(() => readStateFile(dir, path.join(dir, "link.jsonl"))).toThrow(/not a regular file/);
    symlinkSync(outside, path.join(dir, "linked-dir"));
    expect(() => readStateFile(dir, path.join(dir, "linked-dir", "secret"))).toThrow(/outside the state folder/);
  });
});

describe("claudeSay", () => {
  test("resumes the session in the sandbox and adds up the record", async () => {
    let f!: Fixture;
    let during: RunRecord | undefined;
    f = await fixture((cmd) => {
      if (cmd[1] === "ls") return { stdout: lsLine(f.name, `/work/proj, ${f.stateDir}`) };
      if (cmd.includes("bash")) {
        during = readRecord(stateRunRecordPath(f.env, SESSION));
        return { stdout: resultJson() };
      }
      return {};
    });
    expect(await claudeSay({ session: SESSION, text: "go on" }, f.env, f.deps)).toBe(0);
    expect(during?.claude?.status).toBe("running");
    const exec = f.calls[1]!;
    expect(exec.slice(0, 5)).toEqual(["sbx", "exec", "-e", `CLAUDE_CONFIG_DIR=${f.stateDir}`, f.name]);
    expect(exec[7]).toContain(`'claude' '-p' 'go on' '--resume' '${SESSION}' '--output-format' 'json'`);
    expect(exec[7]).toContain("cd '/work/proj'");
    expect(f.synced).toHaveLength(1);
    const record = readRecord(stateRunRecordPath(f.env, SESSION));
    expect(record).toEqual(readRecord(runRecordPath(f.cwd, SESSION)));
    expect(record.claude).toMatchObject({
      status: "ok",
      numTurns: 3,
      durationMs: 4000,
      costUsd: 0.04,
      usage: { input_tokens: 15, output_tokens: 27, server_tool_use: { web_search_requests: 1 }, service_tier: "standard" },
      endedAt: "2026-10-13T10:00:00.000Z",
    });
    expect(record.claude?.resumeId).toBeUndefined();
    expect(out[0]).toBe(SESSION);
    expect(out.at(-1)).toBe("\nfollow-up done");
  });

  test("refuses a session that still runs a turn", async () => {
    const f = await fixture(() => ({}), { status: "running" });
    expect(await claudeSay({ session: SESSION, text: "x" }, f.env, f.deps)).toBe(1);
    expect(err.join("\n")).toMatch(/still runs a turn/);
    expect(f.calls).toEqual([]);
  });

  test("refuses a missing sandbox", async () => {
    const f = await fixture((cmd) => (cmd[1] === "ls" ? { stdout: "SANDBOX\n" } : {}));
    expect(await claudeSay({ session: SESSION, text: "x" }, f.env, f.deps)).toBe(1);
    expect(err.join("\n")).toMatch(/does not exist/);
    expect(f.calls).toHaveLength(1);
  });

  test("a failed turn marks the record failed", async () => {
    let f!: Fixture;
    f = await fixture((cmd) => {
      if (cmd[1] === "ls") return { stdout: lsLine(f.name, `/work/proj, ${f.stateDir}`) };
      if (cmd.includes("bash")) return { exitCode: 1, stderr: "boom" };
      return {};
    });
    expect(await claudeSay({ session: SESSION, text: "x" }, f.env, f.deps)).toBe(1);
    expect(readRecord(stateRunRecordPath(f.env, SESSION)).claude).toMatchObject({ status: "failed", costUsd: 0.03, numTurns: 1 });
  });

  test("resumes the resume ID when the record has one", async () => {
    let f!: Fixture;
    f = await fixture(
      (cmd) => {
        if (cmd[1] === "ls") return { stdout: lsLine(f.name, `/work/proj, ${f.stateDir}`) };
        if (cmd.includes("bash")) return { stdout: resultJson({ session_id: "other-id" }) };
        return {};
      },
      { resumeId: "other-id" },
    );
    expect(await claudeSay({ session: SESSION, text: "x" }, f.env, f.deps)).toBe(0);
    expect(f.calls[1]![7]).toContain("'--resume' 'other-id'");
    expect(readRecord(stateRunRecordPath(f.env, SESSION)).claude?.resumeId).toBe("other-id");
  });

  test("a record without a claude object is refused", async () => {
    const f = await fixture(() => ({}));
    await writeStateRunRecord(f.env, makeRunRecord({ sessionId: SESSION, directory: "/w", agent: "coder" }));
    expect(await claudeSay({ session: SESSION, text: "x" }, f.env, f.deps)).toBe(1);
    expect(err.join("\n")).toMatch(/no claude object/);
  });
});

describe("claudeAbort", () => {
  test("kills the claude process of the session in the sandbox and marks the record", async () => {
    const f = await fixture(() => ({ exitCode: 0 }), { status: "running" });
    expect(await claudeAbort({ session: SESSION }, f.env, f.deps)).toBe(0);
    expect(f.calls).toEqual([["sbx", "exec", f.name, "pkill", "-TERM", "-f", claudeProcessPattern(SESSION)]]);
    expect(readRecord(stateRunRecordPath(f.env, SESSION)).claude).toMatchObject({ status: "aborted", error: "aborted with idfx abort" });
    expect(readRecord(runRecordPath(f.cwd, SESSION)).claude?.status).toBe("aborted");
    expect(out).toEqual([`aborted ${SESSION}`]);
  });

  test("a stale running record without a process is marked aborted", async () => {
    const f = await fixture(() => ({ exitCode: 1 }), { status: "running" });
    expect(await claudeAbort({ session: SESSION }, f.env, f.deps)).toBe(0);
    expect(readRecord(stateRunRecordPath(f.env, SESSION)).claude?.status).toBe("aborted");
  });

  test("an ended session without a process is left alone", async () => {
    const f = await fixture(() => ({ exitCode: 1 }));
    expect(await claudeAbort({ session: SESSION }, f.env, f.deps)).toBe(1);
    expect(err.join("\n")).toMatch(/no running Claude process/);
    expect(readRecord(stateRunRecordPath(f.env, SESSION)).claude?.status).toBe("ok");
  });

  test("a pkill error stops with code 1", async () => {
    const f = await fixture(() => ({ exitCode: 2, stderr: "bad" }), { status: "running" });
    expect(await claudeAbort({ session: SESSION }, f.env, f.deps)).toBe(1);
    expect(readRecord(stateRunRecordPath(f.env, SESSION)).claude?.status).toBe("running");
  });
});

describe("claudeLog", () => {
  test("prints the last answer, the tokens, and the record totals", async () => {
    const f = await fixture(() => ({}));
    const file = path.join(f.stateDir, "projects", "-work-proj", `${SESSION}.jsonl`);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${assistantLine("m1", "first")}\n${assistantLine("m2", "the answer")}\n`);
    expect(await claudeLog({ session: SESSION }, f.env, f.deps)).toBe(0);
    expect(out[0]).toBe("the answer");
    expect(out[1]).toBe("");
    expect(out[2]).toBe("tokens in 6, out 8, thinking 0, cache read 0, cache write 0");
    expect(out[3]).toBe("status ok, turns 1");
    expect(out[4]).toMatch(/cost ~\$0\.0300 \(API-equivalent estimate/);
    expect(f.calls).toEqual([]);
  });

  test("a missing transcript still prints the record totals and exits 1", async () => {
    const f = await fixture(() => ({}));
    expect(await claudeLog({ session: SESSION }, f.env, f.deps)).toBe(1);
    expect(err.join("\n")).toMatch(/no transcript/);
    expect(out.at(-1)).toMatch(/cost ~\$0\.0300/);
  });

  test("a linked transcript is refused", async () => {
    const f = await fixture(() => ({}));
    const outside = mkdtempSync(path.join(tmpdir(), "idfx-state-out-"));
    writeFileSync(path.join(outside, "x.jsonl"), `${assistantLine("m", "secret")}\n`);
    mkdirSync(path.join(f.stateDir, "projects", "p"), { recursive: true });
    symlinkSync(path.join(outside, "x.jsonl"), path.join(f.stateDir, "projects", "p", `${SESSION}.jsonl`));
    const code = await claudeLog({ session: SESSION }, f.env, f.deps);
    expect(code).toBe(1);
    expect(out.join("\n")).not.toContain("secret");
  });
});
