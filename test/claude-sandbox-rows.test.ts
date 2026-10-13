import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LOOP_LIMIT, STALL_MS, trailingLoop } from "../src/detect";
import { parsePriceFile, priceCachePath } from "../src/claude/prices";
import type { ClaudeRow } from "../src/claude/rows";
import { findClaudeTranscript } from "../src/claude/run";
import {
  claudeRunRow,
  claudeRunRowState,
  claudeRunVisible,
  claudeTopLoader,
  createClaudeRunSource,
  mergeRunRows,
  runFindings,
  type ClaudeRunSourceDeps,
  type RunTranscript,
} from "../src/claude/sandbox-rows";
import { readStateFile } from "../src/claude/session";
import { summarizeTranscript, transcriptToolCalls } from "../src/claude/transcript";
import { makeRunRecord, type ClaudeRunInfo, type RunRecord } from "../src/runs";
import { claudeOpenAction, detailLines } from "../src/top/view-model";
import { claudeDetail } from "../src/top/claude";
import { FIXTURE_DIR } from "./claude-fixture";

const prices = parsePriceFile(readFileSync(path.join(FIXTURE_DIR, "litellm-prices.json"), "utf8"));
const START = Date.parse("2026-10-13T10:00:00.000Z");
const SECOND = 1000;
const ID = "aaaaaaaa-0000-4000-8000-00000000000a";

const at = (second: number): string => new Date(START + second * SECOND).toISOString();

/** An assistant line with one tool call, in the shape of Claude Code 2.1.x. No real content. */
function toolLine(second: number, n: number, tool = "Bash", input: Record<string, unknown> = { command: "ls" }): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      id: `msg_${n}`,
      model: "claude-opus-5-5",
      content: [{ type: "tool_use", id: `toolu_${n}`, name: tool, input }],
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 },
    },
    timestamp: at(second),
    cwd: "/work/proj",
  });
}

const text = (lines: string[]): Uint8Array => new TextEncoder().encode(`${lines.join("\n")}\n`);

function info(overrides: Partial<ClaudeRunInfo> = {}): ClaudeRunInfo {
  return {
    sandbox: "idfx-claude-proj",
    stateDir: "/state",
    model: "claude-opus-5-5",
    status: "running",
    error: null,
    exitCode: null,
    isError: null,
    subtype: null,
    numTurns: null,
    durationMs: null,
    costUsd: null,
    costKind: "api-equivalent-estimate",
    usage: null,
    transcript: null,
    endedAt: null,
    ...overrides,
  };
}

function record(overrides: Partial<ClaudeRunInfo> = {}, sessionId = ID): RunRecord {
  return makeRunRecord({
    sessionId,
    directory: "/work/proj",
    agent: "claude",
    title: "fix the parser",
    startedAt: new Date(START),
    driver: "claude",
    claude: info(overrides),
  });
}

function transcriptOf(lines: string[], mtimeMs: number): RunTranscript {
  const bytes = text(lines);
  return { summary: summarizeTranscript(bytes), calls: transcriptToolCalls(bytes), mtimeMs };
}

describe("trailingLoop", () => {
  const call = (tool: string, input: unknown) => ({ tool, input });
  test("finds a row of LOOP_LIMIT identical calls at the end, with the key order ignored", () => {
    const calls = [call("Read", { a: 1 }), ...Array.from({ length: LOOP_LIMIT }, (_, i) => call("Bash", i % 2 === 0 ? { a: 1, b: 2 } : { b: 2, a: 1 }))];
    expect(trailingLoop(calls)?.count).toBe(LOOP_LIMIT);
    expect(trailingLoop(calls)?.call.tool).toBe("Bash");
  });
  test("a loop that ended earlier does not count", () => {
    const calls = [...Array.from({ length: LOOP_LIMIT }, () => call("Bash", { c: 1 })), call("Read", { f: "x" })];
    expect(trailingLoop(calls)).toBeUndefined();
    expect(trailingLoop([])).toBeUndefined();
  });
});

describe("transcriptToolCalls", () => {
  test("lists each tool_use block once, in order, and skips other lines", () => {
    const lines = [
      toolLine(1, 1, "Read", { file_path: "a" }),
      toolLine(1, 1, "Read", { file_path: "a" }),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_1" }] } }),
      "not json",
      toolLine(2, 2, "Bash", { command: "ls" }),
    ];
    expect(transcriptToolCalls(text(lines))).toEqual([
      { id: "toolu_1", tool: "Read", input: { file_path: "a" } },
      { id: "toolu_2", tool: "Bash", input: { command: "ls" } },
    ]);
  });
});

describe("runFindings", () => {
  const loopCalls = Array.from({ length: LOOP_LIMIT }, (_, i) => ({ id: `t${i}`, tool: "Bash", input: { command: "bun test" } }));
  test("reports a loop with the main argument and a stall after STALL_MS", () => {
    const findings = runFindings(ID, loopCalls, START, START + STALL_MS);
    expect(findings).toEqual([
      { kind: "loop", sessionId: ID, tool: "Bash", input: "bun test", count: LOOP_LIMIT },
      { kind: "stall", sessionId: ID, seconds: STALL_MS / 1000 },
    ]);
  });
  test("reports nothing for a run that works", () => {
    expect(runFindings(ID, loopCalls.slice(1), START, START + STALL_MS - 1)).toEqual([]);
  });
});

describe("claudeRunRow", () => {
  test("a running run shows busy, its model, tokens, and the API-equivalent cost", () => {
    const row = claudeRunRow(record(), transcriptOf([toolLine(1, 1), toolLine(2, 2, "Read", { file_path: "x" })], START + 2 * SECOND), prices, START + 10 * SECOND);
    expect(row.state).toBe("busy");
    expect(row.active).toBe(true);
    expect(row.driver).toBe("claude");
    expect(row.title).toBe("fix the parser");
    expect(row.model).toBe("claude-opus-5-5");
    expect(row.sandbox).toBe("idfx-claude-proj");
    expect(row.steps).toBe(2);
    expect(row.toolCalls).toBe(2);
    expect(row.outputTokens).toBe(10);
    expect(row.costKind).toBe("apiEquivalent");
    expect(row.cost).toBeGreaterThan(0);
    expect(row.attention).toBeUndefined();
  });

  test("a loop sets the state looping and the warning lines", () => {
    const lines = Array.from({ length: LOOP_LIMIT }, (_, i) => toolLine(i, i));
    const row = claudeRunRow(record(), transcriptOf(lines, START + 5 * SECOND), prices, START + 10 * SECOND);
    expect(row.state).toBe("looping");
    expect(row.attention?.[0]).toBe("needs attention: loop");
  });

  test("a silent transcript sets the state stalled; without a transcript the start counts", () => {
    const row = claudeRunRow(record(), transcriptOf([toolLine(1, 1)], START), prices, START + STALL_MS + SECOND);
    expect(row.state).toBe("stalled");
    expect(row.attention).toContain("needs attention: stall");
    const empty = claudeRunRow(record(), undefined, prices, START + STALL_MS);
    expect(empty.state).toBe("stalled");
    expect(claudeRunRow(record(), undefined, prices, START + STALL_MS - 1).state).toBe("busy");
  });

  test("an ended run has no guard, and without a transcript the record cost and model stand in", () => {
    const lines = Array.from({ length: LOOP_LIMIT }, (_, i) => toolLine(i, i));
    const done = record({ status: "ok", endedAt: at(30), costUsd: 0.25 });
    expect(claudeRunRow(done, transcriptOf(lines, START), prices, START + STALL_MS * 2).state).toBe("idle");
    const bare = claudeRunRow(done, undefined, prices, START + 60 * SECOND);
    expect(bare.state).toBe("idle");
    expect(bare.active).toBe(false);
    expect(bare.cost).toBe(0.25);
    expect(bare.costKind).toBe("apiEquivalent");
    expect(bare.model).toBe("claude-opus-5-5");
    expect(claudeRunRow(record({ status: "aborted", endedAt: at(30) }), undefined, prices, START).state).toBe("ended");
  });

  test("states and visibility", () => {
    expect(claudeRunRowState("running")).toBe("busy");
    expect(claudeRunRowState("ok")).toBe("idle");
    expect(claudeRunRowState("failed")).toBe("ended");
    expect(claudeRunVisible(info(), START)).toBe(true);
    expect(claudeRunVisible(info({ status: "ok", endedAt: at(0) }), START + 60 * 60 * SECOND)).toBe(true);
    expect(claudeRunVisible(info({ status: "ok", endedAt: at(0) }), START + 61 * 60 * SECOND)).toBe(false);
    expect(claudeRunVisible(info({ status: "failed", endedAt: null }), START)).toBe(false);
  });
});

describe("the detail pane and the open key of a run", () => {
  test("shows the sandbox and the guard lines, and o gives a note", () => {
    const lines = Array.from({ length: LOOP_LIMIT }, (_, i) => toolLine(i, i));
    const row = claudeRunRow(record(), transcriptOf(lines, START + 5 * SECOND), prices, START + 10 * SECOND);
    const texts = detailLines(claudeDetail(row), 10).map((line) => line.text);
    expect(texts[1]).toBe("claude sandbox run in idfx-claude-proj  model claude-opus-5-5");
    expect(texts).toContain("needs attention: loop");
    expect(claudeOpenAction(row, "/", { columns: 80, rows: 24 })).toEqual({
      kind: "note",
      text: `open: a sandbox run has no terminal; use idfx log ${ID}`,
    });
  });
});

/** A state folder with a transcript of `lines` for the session `id`. */
function stateFolder(id: string, lines: string[]): { stateDir: string; file: string } {
  const stateDir = mkdtempSync(path.join(tmpdir(), "idfx-run-rows-"));
  const folder = path.join(stateDir, "projects", "-work-proj");
  mkdirSync(folder, { recursive: true });
  const file = path.join(folder, `${id}.jsonl`);
  writeFileSync(file, `${lines.join("\n")}\n`);
  return { stateDir, file };
}

function sourceDeps(records: RunRecord[], reads: string[]): ClaudeRunSourceDeps {
  return {
    records: async () => records,
    findTranscript: findClaudeTranscript,
    readTranscript: (stateDir, file, limit) => {
      reads.push(file);
      return readStateFile(stateDir, file, limit);
    },
    statFile: (file) => {
      try {
        const stat = Bun.file(file);
        return { size: stat.size, mtimeMs: stat.lastModified };
      } catch {
        return undefined;
      }
    },
  };
}

describe("createClaudeRunSource", () => {
  test("reads the transcript of the state folder, again only after a change, and skips old runs", async () => {
    const { stateDir, file } = stateFolder(ID, [toolLine(1, 1)]);
    const old = record({ status: "ok", endedAt: at(-2 * 60 * 60), stateDir }, "bbbbbbbb-0000-4000-8000-00000000000b");
    const reads: string[] = [];
    const source = createClaudeRunSource(sourceDeps([record({ stateDir }), old], reads));
    const nowMs = START + 10 * SECOND;
    utimesSync(file, new Date(START), new Date(START));
    const first = await source.entries(nowMs, async () => prices);
    expect(first.map((entry) => entry.row.sessionId)).toEqual([ID]);
    expect(first[0]?.row.steps).toBe(1);
    expect(first[0]?.ids).toEqual([ID]);
    await source.entries(nowMs, async () => prices);
    expect(reads).toEqual([file]);
    writeFileSync(file, `${[toolLine(1, 1), toolLine(2, 2)].join("\n")}\n`);
    utimesSync(file, new Date(START + 2 * SECOND), new Date(START + 2 * SECOND));
    const second = await source.entries(nowMs, async () => prices);
    expect(second[0]?.row.steps).toBe(2);
    expect(reads.length).toBe(2);
  });

  test("a linked transcript gives a row without numbers; the prices load only when a run shows", async () => {
    const { stateDir, file } = stateFolder("other", [toolLine(1, 1)]);
    symlinkSync(file, path.join(path.dirname(file), `${ID}.jsonl`));
    let priceLoads = 0;
    const source = createClaudeRunSource(sourceDeps([record({ stateDir })], []));
    const entries = await source.entries(START, async () => {
      priceLoads += 1;
      return prices;
    });
    expect(entries[0]?.row.steps).toBe(0);
    expect(priceLoads).toBe(1);
    const none = createClaudeRunSource(sourceDeps([], []));
    expect(await none.entries(START, async () => {
      priceLoads += 1;
      return prices;
    })).toEqual([]);
    expect(priceLoads).toBe(1);
  });

  test("the resume ID picks the transcript and joins the IDs", async () => {
    const resume = "cccccccc-0000-4000-8000-00000000000c";
    const { stateDir } = stateFolder(resume, [toolLine(1, 1)]);
    const source = createClaudeRunSource(sourceDeps([record({ stateDir, resumeId: resume })], []));
    const [entry] = await source.entries(START, async () => prices);
    expect(entry?.ids).toEqual([ID, resume]);
    expect(entry?.row.steps).toBe(1);
  });
});

describe("mergeRunRows", () => {
  test("a run that is a host session already shows once", () => {
    const host = { sessionId: "cccccccc-0000-4000-8000-00000000000c" } as ClaudeRow;
    const run = claudeRunRow(record(), undefined, prices, START);
    const other = { ...run, sessionId: "dddd" };
    const merged = mergeRunRows([host], [
      { row: run, ids: [ID, "cccccccc-0000-4000-8000-00000000000c"] },
      { row: other, ids: ["dddd"] },
    ]);
    expect(merged.map((row) => row.sessionId)).toEqual(["cccccccc-0000-4000-8000-00000000000c", "dddd"]);
  });
});

describe("claudeTopLoader", () => {
  test("adds the run rows to the host rows, and a failing run part costs only the run rows", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "idfx-top-loader-"));
    const env = { CLAUDE_CONFIG_DIR: path.join(base, "claude"), XDG_CACHE_HOME: path.join(base, "cache") };
    mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true });
    const cache = priceCachePath(env);
    mkdirSync(path.dirname(cache), { recursive: true });
    writeFileSync(cache, readFileSync(path.join(FIXTURE_DIR, "litellm-prices.json")));
    const loader = claudeTopLoader(env, base, sourceDeps([record()], []));
    const rows = await loader(START);
    expect(rows.map((row) => [row.sessionId, row.sandbox])).toEqual([[ID, "idfx-claude-proj"]]);

    const broken = claudeTopLoader(env, base, { ...sourceDeps([], []), records: async () => { throw new Error("boom"); } });
    const errors: string[] = [];
    const original = console.error;
    console.error = (message: string) => errors.push(message);
    try {
      expect(await broken(START)).toEqual([]);
      expect(await broken(START)).toEqual([]);
    } finally {
      console.error = original;
    }
    expect(errors).toEqual(["warning: claude runs: boom"]);
  });
});
