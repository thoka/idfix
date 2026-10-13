/**
 * The Claude sandbox runs (`idfx run --driver claude`) in `idfx top`, with
 * their guards. The rows come from the run records, and the numbers from
 * the transcript in the state folder of the sandbox.
 *
 * The state folder is writable by the agent in the sandbox, so the
 * transcript is untrusted data: it is read only with `readStateFile` of
 * `src/claude/session.ts` (no links, inside the state folder, a size limit).
 * A file that fails this check gives a row without numbers.
 *
 * The guards use the thresholds and the loop key of the opencode guard of
 * `src/detect.ts` (`LOOP_LIMIT`, `STALL_MS`, `trailingLoop`). They act only
 * on a run whose record says `running`:
 *
 * - loop: the last `LOOP_LIMIT` tool calls of the transcript have the same
 *   tool and the same input. The row shows `looping` while the row lasts.
 * - stall: the transcript did not change for `STALL_MS`. Before the
 *   transcript exists, the start of the run counts as its last change.
 *
 * A guard hit sets the state of the row (`looping` or `stalled`, red in
 * `top`) and adds the warning lines of `formatFinding` to the row. It never
 * stops the run, like the opencode guard: the orchestrator decides.
 */
import { lstatSync } from "node:fs";
import path from "node:path";
import type { Env } from "../config";
import { formatFinding, LOOP_LIMIT, STALL_MS, trailingLoop, type Finding } from "../detect";
import { shorten, toolMainArg } from "../events";
import { loadAllRunRecords, recordDriver, type ClaudeRunInfo, type RunRecord } from "../runs";
import type { SessionRowState } from "../top/model";
import { claudeRoot } from "./files";
import { loadPrices, type PriceTable } from "./prices";
import {
  claudeRow,
  createClaudeSource,
  ENDED_VISIBLE_MS,
  loadClaudeRows,
  type ClaudeRow,
  type ClaudeRowsLoader,
} from "./rows";
import { findClaudeTranscript } from "./run";
import { readStateFile, TRANSCRIPT_LIMIT, type TranscriptRead } from "./session";
import { summarizeTranscript, transcriptToolCalls, type TranscriptSummary, type TranscriptToolCall } from "./transcript";

/** Whether a run shows: while it runs, and for `ENDED_VISIBLE_MS` after its end. Pure. */
export function claudeRunVisible(info: ClaudeRunInfo, nowMs: number): boolean {
  if (info.status === "running") return true;
  const ended = Date.parse(info.endedAt ?? "");
  return !Number.isNaN(ended) && nowMs - ended <= ENDED_VISIBLE_MS;
}

/**
 * The row state of a run: `running` is `busy`, `ok` is `idle` (a later
 * `idfx say` can resume it), `failed` and `aborted` are `ended`. Pure.
 */
export function claudeRunRowState(status: string): SessionRowState {
  if (status === "running") return "busy";
  if (status === "ok") return "idle";
  return "ended";
}

/** The session ID of the current transcript: the resume ID, else the record ID. */
export function runTranscriptId(record: RunRecord, info: ClaudeRunInfo): string {
  return info.resumeId ?? record.sessionId;
}

export type RunGuardOptions = { loopLimit?: number; stallMs?: number };

/**
 * The guard findings of a running run. `growthMs` is the last change of the
 * transcript, or the start of the run without a transcript. Pure.
 */
export function runFindings(
  sessionId: string,
  calls: readonly TranscriptToolCall[],
  growthMs: number | undefined,
  nowMs: number,
  options: RunGuardOptions = {},
): Finding[] {
  const findings: Finding[] = [];
  const loop = trailingLoop(calls, options.loopLimit ?? LOOP_LIMIT);
  if (loop !== undefined) {
    const input = loop.call.input;
    const record = input !== null && typeof input === "object" ? (input as Record<string, unknown>) : {};
    findings.push({
      kind: "loop",
      sessionId,
      tool: loop.call.tool,
      input: shorten(toolMainArg(loop.call.tool, record), 80),
      count: loop.count,
    });
  }
  if (growthMs !== undefined) {
    const silentMs = nowMs - growthMs;
    if (silentMs >= (options.stallMs ?? STALL_MS)) {
      findings.push({ kind: "stall", sessionId, seconds: Math.round(silentMs / 1000) });
    }
  }
  return findings;
}

/** What the source read of one transcript. */
export type RunTranscript = {
  summary: TranscriptSummary;
  calls: TranscriptToolCall[];
  /** The modification time of the transcript, in ms, when known. */
  mtimeMs: number | undefined;
};

/** The newest of the known times. */
const newest = (...times: Array<number | undefined>): number | undefined => {
  const known = times.filter((ms): ms is number => ms !== undefined && Number.isFinite(ms));
  return known.length === 0 ? undefined : Math.max(...known);
};

/**
 * The row of one run, with the guard findings of a running run. A run
 * without a transcript shows the numbers of its record. Pure.
 */
export function claudeRunRow(
  record: RunRecord,
  transcript: RunTranscript | undefined,
  prices: PriceTable | undefined,
  nowMs: number,
  options: RunGuardOptions = {},
): ClaudeRow {
  const info = record.claude as ClaudeRunInfo;
  const running = info.status === "running";
  const startMs = Date.parse(record.startedAt);
  const startTimeMs = Number.isNaN(startMs) ? undefined : startMs;
  const endedMs = Date.parse(info.endedAt ?? "");
  const summary = transcript?.summary;
  const findings = running
    ? runFindings(record.sessionId, transcript?.calls ?? [], newest(transcript?.mtimeMs, startTimeMs), nowMs, options)
    : [];
  const base = claudeRow(
    {
      sessionId: record.sessionId,
      kind: "background",
      name: record.title ?? undefined,
      cwd: record.directory,
      live: running,
      state: claudeRunRowState(info.status),
      waitingFor: undefined,
      waitingSource: undefined,
      pid: undefined,
      tmux: undefined,
      jobId: undefined,
      startTimeMs,
      lastActivityMs: newest(summary?.lastActivityMs, transcript?.mtimeMs, Number.isNaN(endedMs) ? undefined : endedMs),
      stateSinceMs: undefined,
      transcriptGrowthMs: transcript?.mtimeMs,
      summary,
      subagents: [],
    },
    prices,
    nowMs,
  );
  // Without a price or a transcript, the cost of the result JSONs stands in.
  const fallbackCost =
    (transcript === undefined || base.apiEquivalentUsd === undefined) && info.costUsd !== null ? info.costUsd : undefined;
  const looping = findings.some((finding) => finding.kind === "loop");
  const stalled = findings.some((finding) => finding.kind === "stall");
  return {
    ...base,
    // The title of the run comes first: it is the one that `idfx run --title` set.
    title: record.title ?? base.title,
    model: base.model ?? info.model ?? undefined,
    state: looping ? "looping" : stalled ? "stalled" : base.state,
    ...(fallbackCost === undefined ? {} : { cost: fallbackCost, costKind: "apiEquivalent", apiEquivalentUsd: fallbackCost }),
    sandbox: info.sandbox,
    ...(findings.length === 0 ? {} : { attention: findings.flatMap((finding) => formatFinding(finding)) }),
  };
}

/** The parts of the run source that the tests replace. */
export type ClaudeRunSourceDeps = {
  /** The run records to show. */
  records: () => Promise<RunRecord[]>;
  /** The transcript of a session in the state folder, or null. */
  findTranscript: (stateDir: string, sessionId: string) => string | null;
  /** Reads a transcript from the state folder (`readStateFile`). */
  readTranscript: (stateDir: string, file: string, limit: number) => TranscriptRead;
  /** The size and the modification time of a file without a link follow, or undefined. */
  statFile: (file: string) => { size: number; mtimeMs: number } | undefined;
};

/** The default parts: the run records of `cwd` and of the state folder of `env`, and the real files. */
export function defaultRunSourceDeps(env: Env, cwd: string): ClaudeRunSourceDeps {
  return {
    records: () => loadAllRunRecords(cwd, env),
    findTranscript: findClaudeTranscript,
    readTranscript: readStateFile,
    statFile: (file) => {
      try {
        const stat = lstatSync(file);
        return { size: stat.size, mtimeMs: stat.mtimeMs };
      } catch {
        return undefined;
      }
    },
  };
}

/** One row of a run and the session IDs that it covers (the record ID and the resume ID). */
export type ClaudeRunEntry = { row: ClaudeRow; ids: string[] };

export type ClaudeRunSource = {
  /**
   * The rows of the runs that show at `nowMs`. A transcript is read again
   * only when its size or its modification time changed. `prices` loads
   * only when a run shows.
   */
  entries(nowMs: number, prices: () => Promise<PriceTable | undefined>): Promise<ClaudeRunEntry[]>;
};

export function createClaudeRunSource(deps: ClaudeRunSourceDeps, options: RunGuardOptions = {}): ClaudeRunSource {
  const cache = new Map<string, { size: number; mtimeMs: number; transcript: RunTranscript }>();

  const readTranscript = (info: ClaudeRunInfo, id: string): RunTranscript | undefined => {
    const file = deps.findTranscript(info.stateDir, id);
    if (file === null) return undefined;
    const stat = deps.statFile(file);
    if (stat === undefined) return undefined;
    const cached = cache.get(file);
    if (cached !== undefined && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.transcript;
    let read: TranscriptRead;
    try {
      read = deps.readTranscript(info.stateDir, file, TRANSCRIPT_LIMIT);
    } catch {
      // A link or a file outside the state folder: no numbers for this run.
      return undefined;
    }
    const transcript: RunTranscript = {
      summary: summarizeTranscript(read.bytes),
      calls: transcriptToolCalls(read.bytes),
      mtimeMs: read.mtimeMs ?? stat.mtimeMs,
    };
    cache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, transcript });
    return transcript;
  };

  return {
    async entries(nowMs, prices) {
      const shown = (await deps.records()).filter(
        (record) => recordDriver(record) === "claude" && record.claude !== undefined && claudeRunVisible(record.claude, nowMs),
      );
      if (shown.length === 0) return [];
      const table = await prices();
      return shown.map((record) => {
        const info = record.claude as ClaudeRunInfo;
        const id = runTranscriptId(record, info);
        return {
          row: claudeRunRow(record, readTranscript(info, id), table, nowMs, options),
          ids: [...new Set([record.sessionId, id])],
        };
      });
    },
  };
}

/**
 * The host rows and the run rows together. A run whose session is a host
 * session already (by the record ID or the resume ID) shows only once, as
 * the host row. Pure.
 */
export function mergeRunRows(host: readonly ClaudeRow[], runs: readonly ClaudeRunEntry[]): ClaudeRow[] {
  const known = new Set(host.map((row) => row.sessionId));
  return [...host, ...runs.filter((entry) => !entry.ids.some((id) => known.has(id))).map((entry) => entry.row)];
}

/**
 * The Claude loader of `top`: the Claude Code sessions on the host
 * (`$CLAUDE_CONFIG_DIR`, else `~/.claude`) and the Claude sandbox runs from
 * the run records of `cwd` and of the state folder. Both share one price
 * table, which loads at most once. A failure of the run part costs only the
 * run rows, with one warning on stderr.
 */
export function claudeTopLoader(env: Env, cwd: string, runDeps: ClaudeRunSourceDeps = defaultRunSourceDeps(env, path.resolve(cwd))): ClaudeRowsLoader {
  const source = createClaudeSource(claudeRoot(env));
  const runs = createClaudeRunSource(runDeps);
  let prices: Promise<PriceTable | undefined> | undefined;
  const loadOnce = () => {
    prices ??= loadPrices(env);
    return prices;
  };
  let warned = false;
  return async (nowMs) => {
    const host = await loadClaudeRows({ source, nowMs, loadPrices: loadOnce });
    let entries: ClaudeRunEntry[] = [];
    try {
      entries = await runs.entries(nowMs, loadOnce);
    } catch (error) {
      if (!warned) console.error(`warning: claude runs: ${error instanceof Error ? error.message : String(error)}`);
      warned = true;
    }
    return mergeRunRows(host, entries);
  };
}
