import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  claudeCostLine,
  claudeOutcome,
  claudeRun,
  claudeSandboxName,
  defaultClaudeRunDeps,
  findClaudeTranscript,
  isLimitMessage,
  parseClaudeResult,
  type ClaudeRunDeps,
} from "../src/claude/run";
import { claudeStateDir } from "../src/claude/sandbox-state";
import { runRecordPath, stateRunRecordPath, type RunRecord } from "../src/runs";
import type { Runner } from "../src/sandbox";

const SESSION = "0b6f6c1e-1111-4222-8333-944455556666";

function resultJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 3800,
    num_turns: 1,
    result: "done",
    session_id: SESSION,
    total_cost_usd: 0.0312,
    usage: { input_tokens: 10, output_tokens: 20 },
    modelUsage: { "claude-sonnet-5-5": { costUSD: 0.0312 } },
    ...overrides,
  });
}

describe("pure helpers", () => {
  test("claudeSandboxName", () => {
    expect(claudeSandboxName("idfix")).toBe("claude-idfix");
    expect(claudeSandboxName("My Repo!")).toBe("claude-my-repo-");
  });

  test("parseClaudeResult reads the fields of the result JSON", () => {
    expect(parseClaudeResult(`${resultJson()}\n`)).toEqual({
      sessionId: SESSION,
      isError: false,
      subtype: "success",
      numTurns: 1,
      durationMs: 3800,
      costUsd: 0.0312,
      usage: { input_tokens: 10, output_tokens: 20 },
      result: "done",
      model: "claude-sonnet-5-5",
    });
  });

  test("parseClaudeResult takes the last JSON line after other output", () => {
    expect(parseClaudeResult(`some noise\n${resultJson({ result: "x" })}\n`)?.result).toBe("x");
    expect(parseClaudeResult("no json here")).toBeNull();
    expect(parseClaudeResult("[1,2]")).toBeNull();
  });

  test("isLimitMessage", () => {
    expect(isLimitMessage("Claude AI usage limit reached|1760000000")).toBe(true);
    expect(isLimitMessage("You've hit your limit · resets 3pm")).toBe(true);
    expect(isLimitMessage("done")).toBe(false);
    expect(isLimitMessage(null)).toBe(false);
    expect(isLimitMessage(`${"x".repeat(600)} limit reached`)).toBe(false);
  });

  test("claudeOutcome", () => {
    expect(claudeOutcome(0, parseClaudeResult(resultJson()), "")).toEqual({ status: "ok" });
    expect(claudeOutcome(1, null, "boom\nmore")).toEqual({ status: "failed", error: "sbx exec ended with code 1: boom" });
    expect(claudeOutcome(0, null, "")).toEqual({ status: "failed", error: "the run printed no result JSON" });
    const errored = claudeOutcome(0, parseClaudeResult(resultJson({ is_error: true, subtype: "error_max_turns", result: "stop" })), "");
    expect(errored).toEqual({ status: "failed", error: "Claude Code reported an error (error_max_turns): stop" });
    const limit = claudeOutcome(0, parseClaudeResult(resultJson({ result: "Claude AI usage limit reached|1" })), "");
    expect(limit.status).toBe("failed");
    expect(claudeOutcome(1, null, "usage limit reached")).toEqual({
      status: "failed",
      error: "Claude Code hit a usage limit: usage limit reached",
    });
  });

  test("claudeCostLine marks the cost as an estimate", () => {
    expect(claudeCostLine(0.0312)).toBe("cost ~$0.0312 (API-equivalent estimate; on a Max plan the run costs nothing extra)");
    expect(claudeCostLine(null)).toMatch(/unknown/);
  });
});

describe("findClaudeTranscript", () => {
  test("finds the transcript and follows no links", () => {
    const state = mkdtempSync(path.join(tmpdir(), "idfx-claude-run-"));
    const file = path.join(state, "projects", "-w", `${SESSION}.jsonl`);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "{}\n");
    expect(findClaudeTranscript(state, SESSION)).toBe(file);
    expect(findClaudeTranscript(state, "../x")).toBeNull();
    expect(findClaudeTranscript(path.join(state, "none"), SESSION)).toBeNull();

    const outside = mkdtempSync(path.join(tmpdir(), "idfx-claude-out-"));
    mkdirSync(path.join(outside, "p"));
    writeFileSync(path.join(outside, "p", "other.jsonl"), "{}\n");
    const linked = mkdtempSync(path.join(tmpdir(), "idfx-claude-run-"));
    mkdirSync(path.join(linked, "projects"));
    symlinkSync(path.join(outside, "p"), path.join(linked, "projects", "p"));
    expect(findClaudeTranscript(linked, "other")).toBeNull();
  });
});

type Fixture = {
  root: string;
  env: Record<string, string>;
  stateDir: string;
  name: string;
  calls: string[][];
  deps: ClaudeRunDeps;
  synced: string[];
  ensured: string[];
};

/** A project folder, an env with temp state folders, and deps with a fake runner. */
function fixture(answer: (cmd: readonly string[]) => { stdout?: string; exitCode?: number; stderr?: string }): Fixture {
  const base = mkdtempSync(path.join(tmpdir(), "idfx-claude-run-"));
  const root = path.join(base, "proj");
  mkdirSync(root);
  const env = { HOME: path.join(base, "home"), XDG_STATE_HOME: path.join(base, "state"), CLAUDE_CONFIG_DIR: path.join(base, "host-claude") };
  const name = "claude-proj";
  const stateDir = claudeStateDir(env, name);
  const calls: string[][] = [];
  const synced: string[] = [];
  const ensured: string[] = [];
  const runner: Runner = (cmd) => {
    calls.push([...cmd]);
    const res = answer(cmd);
    return { stdout: res.stdout ?? "", exitCode: res.exitCode ?? 0, stderr: res.stderr ?? "" };
  };
  const deps: ClaudeRunDeps = {
    runner,
    sync: (hostDir, state) => {
      synced.push(`${hostDir} -> ${state}`);
      return { pluginDirs: [path.join(state, "plugins-src", "p1")], missingPlugins: [] };
    },
    ensureStateDir: (state) => ensured.push(state),
    findTranscript: (state, id) => path.join(state, "projects", "-proj", `${id}.jsonl`),
    readBrief: async () => "do the thing",
    cwd: base,
    now: () => new Date("2026-10-13T10:00:00Z"),
  };
  return { root, env, stateDir, name, calls, deps, synced, ensured };
}

function lsLine(name: string, workspace: string): string {
  return `SANDBOX AGENT STATUS PORTS WORKSPACE\n${name}   claude   stopped    ${workspace}\n`;
}

function readRecord(file: string): RunRecord {
  return JSON.parse(readFileSync(file, "utf8")) as RunRecord;
}

describe("claudeRun", () => {
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

  test("runs in an existing sandbox and writes the record", async () => {
    let f!: Fixture;
    f = fixture((cmd) => {
      if (cmd[1] === "ls") return { stdout: lsLine(f.name, `${f.root}, ${f.stateDir}`) };
      if (cmd.includes("bash")) return { stdout: `${resultJson()}\n` };
      return {};
    });
    const code = await claudeRun({ dir: f.root, briefFile: "b.md", model: "sonnet", title: "T" }, f.env, f.deps);
    expect(code).toBe(0);
    expect(f.calls.map((c) => c[1])).toEqual(["ls", "exec", "exec"]);
    expect(f.calls[1]).toEqual(["sbx", "exec", f.name, "test", "-d", f.root]);
    const run = f.calls[2]!;
    expect(run.slice(0, 5)).toEqual(["sbx", "exec", "-e", `CLAUDE_CONFIG_DIR=${f.stateDir}`, f.name]);
    expect(run[7]).toContain("'claude' '-p' 'do the thing' '--output-format' 'json' '--model' 'sonnet' '--plugin-dir'");
    expect(run[7]).toContain(`cd '${f.root}'`);
    expect(f.synced).toEqual([`${f.env.CLAUDE_CONFIG_DIR} -> ${f.stateDir}`]);
    expect(f.ensured).toEqual([]);

    const record = readRecord(runRecordPath(f.deps.cwd, SESSION));
    expect(record).toEqual(readRecord(stateRunRecordPath(f.env, SESSION)));
    expect(record).toMatchObject({
      sessionId: SESSION,
      directory: f.root,
      agent: "claude",
      title: "T",
      driver: "claude",
      startedAt: "2026-10-13T10:00:00.000Z",
      claude: {
        sandbox: f.name,
        stateDir: f.stateDir,
        model: "sonnet",
        status: "ok",
        error: null,
        exitCode: 0,
        isError: false,
        subtype: "success",
        numTurns: 1,
        durationMs: 3800,
        costUsd: 0.0312,
        costKind: "api-equivalent-estimate",
        usage: { input_tokens: 10, output_tokens: 20 },
        transcript: path.join(f.stateDir, "projects", "-proj", `${SESSION}.jsonl`),
      },
    });
    expect(out[0]).toBe(SESSION);
    expect(out[1]).toMatch(/API-equivalent estimate/);
    expect(out.at(-1)).toBe("\ndone");
  });

  test("the model falls back to modelUsage", async () => {
    let f!: Fixture;
    f = fixture((cmd) => {
      if (cmd[1] === "ls") return { stdout: lsLine(f.name, `${f.root}, ${f.stateDir}`) };
      if (cmd.includes("bash")) return { stdout: resultJson() };
      return {};
    });
    expect(await claudeRun({ dir: f.root, text: "x" }, f.env, f.deps)).toBe(0);
    expect(f.calls[2]![7]).not.toContain("--model");
    expect(readRecord(runRecordPath(f.deps.cwd, SESSION)).claude?.model).toBe("claude-sonnet-5-5");
  });

  test("creates a missing sandbox with the state mount and checks the clone", async () => {
    let f!: Fixture;
    f = fixture((cmd) => {
      if (cmd[1] === "ls") return { stdout: "SANDBOX AGENT STATUS PORTS WORKSPACE\n" };
      if (cmd.includes("bash")) return { stdout: resultJson() };
      return {};
    });
    expect(await claudeRun({ dir: f.root, text: "x" }, f.env, f.deps)).toBe(0);
    expect(f.ensured).toEqual([f.stateDir]);
    expect(f.calls[1]).toEqual(["sbx", "create", "--clone", "--skills=off", "--name", f.name, "claude", f.root, f.stateDir]);
    expect(f.calls[2]).toEqual(["sbx", "exec", f.name, "git", "-C", f.root, "rev-parse", "--git-dir"]);
    expect(f.calls[3]?.slice(3)).toEqual(["test", "-d", f.root]);
  });

  test("a create without a clone stops before the run", async () => {
    let f!: Fixture;
    f = fixture((cmd) => {
      if (cmd[1] === "ls") return { stdout: "" };
      if (cmd.includes("rev-parse")) return { exitCode: 128 };
      return {};
    });
    expect(await claudeRun({ dir: f.root, text: "x" }, f.env, f.deps)).toBe(1);
    expect(err.join("\n")).toMatch(/has no git clone/);
    expect(f.calls.some((c) => c.includes("bash"))).toBe(false);
    expect(f.synced).toEqual([]);
  });

  test("a failed create stops with its code", async () => {
    const f = fixture((cmd) => (cmd[1] === "create" ? { exitCode: 3, stderr: "no login" } : {}));
    expect(await claudeRun({ dir: f.root, text: "x" }, f.env, f.deps)).toBe(1);
    expect(err.join("\n")).toMatch(/sbx create of the sandbox claude-proj failed with code 3/);
    expect(err.join("\n")).toMatch(/no login/);
  });

  test("an existing sandbox without the state mount is refused", async () => {
    let f!: Fixture;
    f = fixture((cmd) => (cmd[1] === "ls" ? { stdout: lsLine(f.name, f.root) } : {}));
    expect(await claudeRun({ dir: f.root, text: "x" }, f.env, f.deps)).toBe(1);
    expect(err.join("\n")).toMatch(/does not mount the state folder/);
    expect(f.calls).toHaveLength(1);
  });

  test("--sandbox names the sandbox and its state folder", async () => {
    let f!: Fixture;
    f = fixture((cmd) => {
      const state = claudeStateDir(f.env, "claude-spike");
      if (cmd[1] === "ls") return { stdout: lsLine("claude-spike", `${f.root}, ${state}`) };
      if (cmd.includes("bash")) return { stdout: resultJson() };
      return {};
    });
    expect(await claudeRun({ dir: f.root, text: "x", sandbox: "claude-spike" }, f.env, f.deps)).toBe(0);
    expect(f.calls[1]?.[2]).toBe("claude-spike");
    expect(readRecord(runRecordPath(f.deps.cwd, SESSION)).claude?.stateDir).toBe(claudeStateDir(f.env, "claude-spike"));
  });

  test("a folder missing in the sandbox stops before the sync", async () => {
    let f!: Fixture;
    f = fixture((cmd) => {
      if (cmd[1] === "ls") return { stdout: lsLine(f.name, `${f.root}, ${f.stateDir}`) };
      if (cmd.includes("test")) return { exitCode: 1 };
      return {};
    });
    const dir = path.join(f.root, ".worktrees", "s1");
    expect(await claudeRun({ dir, text: "x" }, f.env, f.deps)).toBe(1);
    expect(err.join("\n")).toMatch(/does not exist in the sandbox claude-proj/);
    expect(f.synced).toEqual([]);
  });

  test("an empty brief is refused before any sbx call", async () => {
    const f = fixture(() => ({}));
    expect(await claudeRun({ dir: f.root, text: "  " }, f.env, f.deps)).toBe(1);
    expect(f.calls).toEqual([]);
  });

  async function failedRun(answer: { stdout?: string; exitCode?: number; stderr?: string }) {
    let f!: Fixture;
    f = fixture((cmd) => {
      if (cmd[1] === "ls") return { stdout: lsLine(f.name, `${f.root}, ${f.stateDir}`) };
      if (cmd.includes("bash")) return answer;
      return {};
    });
    const code = await claudeRun({ dir: f.root, text: "x" }, f.env, f.deps);
    return { code, f };
  }

  test("is_error with a non-zero exit is a failure with a record", async () => {
    const { code, f } = await failedRun({ stdout: resultJson({ is_error: true, subtype: "error_during_execution", result: "API Error: 500" }), exitCode: 1 });
    expect(code).toBe(1);
    const record = readRecord(runRecordPath(f.deps.cwd, SESSION));
    expect(record.claude).toMatchObject({ status: "failed", exitCode: 1, isError: true, error: "sbx exec ended with code 1: API Error: 500" });
    expect(err.join("\n")).toMatch(/the Claude run failed/);
    expect(out).toEqual([]);
  });

  test("a limit message is a failure even with exit 0", async () => {
    const { code, f } = await failedRun({ stdout: resultJson({ result: "Claude AI usage limit reached|1760000000" }) });
    expect(code).toBe(1);
    expect(readRecord(runRecordPath(f.deps.cwd, SESSION)).claude?.error).toMatch(/usage limit/);
  });

  test("a run without result JSON gets a generated ID in its record", async () => {
    const { code, f } = await failedRun({ exitCode: 1, stderr: "claude: command not found" });
    expect(code).toBe(1);
    const recordLine = err.find((line) => line.startsWith("run record: "))!;
    const record = readRecord(recordLine.slice("run record: ".length));
    expect(record.sessionId).toMatch(/^claude-failed-/);
    expect(record.claude).toMatchObject({ status: "failed", transcript: null, costUsd: null, exitCode: 1 });
    expect(record.claude?.error).toMatch(/command not found/);
    expect(existsSync(f.stateDir)).toBe(false);
  });
});

describe("claudeRun with a fake sbx on disk", () => {
  test("runs the real runner, sync, and transcript scan against a script", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "idfx-claude-e2e-"));
    const root = path.join(base, "proj");
    mkdirSync(root);
    const host = path.join(base, "host-claude");
    mkdirSync(host);
    writeFileSync(path.join(host, "CLAUDE.md"), "# rules\n");
    const env = { HOME: path.join(base, "home"), XDG_STATE_HOME: path.join(base, "state"), CLAUDE_CONFIG_DIR: host, SBX_BIN: path.join(base, "sbx") };
    const state = claudeStateDir(env, "claude-proj");
    const log = path.join(base, "sbx.log");
    // The fake sbx: `ls` lists nothing, `create` and the checks succeed, and
    // the run writes a transcript into the state folder and prints the JSON.
    writeFileSync(
      env.SBX_BIN,
      `#!/bin/sh
echo "$*" >> '${log}'
case "$1" in
  ls) echo "SANDBOX AGENT STATUS PORTS WORKSPACE" ;;
  create) test -d "$8" ;;
  exec)
    if [ "$2" = "-e" ]; then
      dir="\${3#CLAUDE_CONFIG_DIR=}"
      mkdir -p "$dir/projects/-proj"
      echo '{}' > "$dir/projects/-proj/${SESSION}.jsonl"
      echo '${resultJson()}'
    fi ;;
esac
`,
    );
    chmodSync(env.SBX_BIN, 0o755);
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    let code: number;
    try {
      code = await claudeRun({ dir: root, text: "x" }, env, { ...defaultClaudeRunDeps, cwd: base });
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
    }
    expect(code).toBe(0);
    expect(readFileSync(path.join(state, "CLAUDE.md"), "utf8")).toBe("# rules\n");
    const record = readRecord(stateRunRecordPath(env, SESSION));
    expect(record.claude?.transcript).toBe(path.join(state, "projects", "-proj", `${SESSION}.jsonl`));
    const lines = readFileSync(log, "utf8").trim().split("\n");
    expect(lines.map((line) => line.split(" ")[0])).toEqual(["ls", "create", "exec", "exec", "exec"]);
  });
});
