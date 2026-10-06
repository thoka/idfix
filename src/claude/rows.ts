/**
 * The join of the Claude Code files and the mapping to `SessionRow` of
 * `src/top/model.ts`. Design: docs/design/claude-sessions-top.md, sections
 * 2, 5, and 6.
 *
 * The join: a live session file, then its job state through `jobId` (or the
 * session ID), then its transcript through the session ID. Background jobs
 * without a live process and transcripts without a live process add the
 * sessions that wait or that ended.
 *
 * Which sessions show: a live session always, a waiting session always,
 * and an ended session for 60 minutes after its last activity. The folder
 * rule of `status` and `top` without `--all` is `inScope`.
 */
import path from "node:path";
import type { SessionRow, SessionRowState } from "../top/model";
import {
  claudeRoot,
  listSubagents,
  listTranscripts,
  nodeClaudeFs,
  readJobs,
  readLiveSessions,
  type ClaudeFs,
  type JobState,
  type SessionFile,
  type SessionKind,
  type TranscriptFile,
} from "./files";
import { apiEquivalentUsd, contextWindowOf, loadPrices, type PriceTable } from "./prices";
import {
  createTranscriptReader,
  mergeUsage,
  totalTokens,
  type TokenCounts,
  type TranscriptReader,
  type TranscriptSummary,
} from "./transcript";

/** An ended session shows for this long after its last activity, the `RECENT_MS` rule of `src/top/load.ts`. */
export const ENDED_VISIBLE_MS = 60 * 60 * 1000;

/** The longest title from a folder name. */
const FOLDER_TITLE_LENGTH = 60;

/** One subagent of a session, read from its own transcript. */
export type ClaudeSubagent = {
  agentId: string;
  agentType: string | undefined;
  description: string | undefined;
  summary: TranscriptSummary;
};

/** One Claude Code session after the join. */
export type ClaudeSession = {
  sessionId: string;
  kind: SessionKind;
  name: string | undefined;
  cwd: string;
  /** Whether a live process belongs to the session. */
  live: boolean;
  state: SessionRowState;
  /** What the session waits for: `waitingFor` of the session file, or `needs` of a blocked job. */
  waitingFor: string | undefined;
  pid: number | undefined;
  tmux: string | undefined;
  jobId: string | undefined;
  startTimeMs: number | undefined;
  /** The newest time of the transcript, the session file, and the job state. */
  lastActivityMs: number | undefined;
  summary: TranscriptSummary | undefined;
  subagents: ClaudeSubagent[];
};

/** A `SessionRow` of a Claude session, with the fields that only Claude sessions have. */
export type ClaudeRow = SessionRow & {
  driver: "claude";
  kind: SessionKind;
  name: string | undefined;
  waitingFor: string | undefined;
  pid: number | undefined;
  tmux: string | undefined;
  jobId: string | undefined;
  lastActivityMs: number | undefined;
  /** The API price of the tokens of the session and its subagents, or undefined without a price. */
  apiEquivalentUsd: number | undefined;
  apiErrors: number;
  /** One row per subagent. */
  children: ClaudeRow[];
};

/** Whether a folder is one of the directories or inside one of them. */
export function inScope(cwd: string, directories: readonly string[]): boolean {
  return directories.some((dir) => {
    const relative = path.relative(dir, cwd);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  });
}

/** The state of a live session from its session file and its job. */
export function liveState(session: SessionFile, job: JobState | undefined): SessionRowState {
  if (session.status === "waiting" || job?.state === "blocked") return "waiting";
  if (session.status === "busy" || session.status === "shell") return "busy";
  return "idle";
}

/** The state of a job without a live process. */
export function jobState(job: JobState): SessionRowState {
  if (job.state === "blocked") return "waiting";
  if (job.state === "working") return "busy";
  return "ended";
}

const newest = (...times: Array<number | undefined>): number | undefined => {
  const known = times.filter((ms): ms is number => ms !== undefined);
  return known.length === 0 ? undefined : Math.max(...known);
};

/** The title rule of the design: custom title, AI title, session name, then the folder name. */
export function sessionTitle(summary: TranscriptSummary | undefined, name: string | undefined, cwd: string): string {
  return (
    summary?.customTitle ??
    summary?.aiTitle ??
    name ??
    path.basename(cwd).slice(0, FOLDER_TITLE_LENGTH)
  );
}

export type ClaudeSource = {
  /**
   * The sessions that show at `nowMs`, after the join, with their
   * transcripts read up to now. A second call reads only the new bytes.
   */
  sessions(nowMs: number): ClaudeSession[];
};

/** A reader of the Claude Code files under `root`, with one incremental transcript reader per file. */
export function createClaudeSource(root: string, fs: ClaudeFs = nodeClaudeFs): ClaudeSource {
  const readers = new Map<string, TranscriptReader>();

  const readTranscript = (file: string): TranscriptSummary | undefined => {
    let reader = readers.get(file);
    if (reader === undefined) {
      reader = createTranscriptReader();
      readers.set(file, reader);
    }
    const bytes = fs.readBytes(file, reader.offset());
    // A file that went away keeps what was read before.
    if (bytes === undefined) return reader.offset() > 0 ? reader.summary() : undefined;
    if (bytes.byteLength > 0) reader.feed(bytes);
    return reader.summary();
  };

  const subagentsOf = (transcript: TranscriptFile | undefined): ClaudeSubagent[] => {
    if (transcript === undefined) return [];
    return listSubagents(transcript.file, fs).map((agent) => ({
      agentId: agent.agentId,
      agentType: agent.agentType,
      description: agent.description,
      summary: readTranscript(agent.file) ?? createTranscriptReader().summary(),
    }));
  };

  return {
    sessions(nowMs) {
      const live = readLiveSessions(root, fs);
      const jobs = readJobs(root, fs);
      const transcripts = listTranscripts(root, fs);
      const jobById = new Map(jobs.map((job) => [job.jobId, job]));
      const jobBySession = new Map(
        jobs.filter((job) => job.sessionId !== undefined).map((job) => [job.sessionId as string, job]),
      );
      const result: ClaudeSession[] = [];
      const seen = new Set<string>();

      for (const session of live) {
        if (seen.has(session.sessionId)) continue;
        seen.add(session.sessionId);
        const job =
          (session.jobId === undefined ? undefined : jobById.get(session.jobId)) ?? jobBySession.get(session.sessionId);
        const transcript = transcripts.get(session.sessionId);
        const summary = transcript === undefined ? undefined : readTranscript(transcript.file);
        const state = liveState(session, job);
        result.push({
          sessionId: session.sessionId,
          kind: session.kind,
          name: session.name ?? job?.name,
          cwd: session.cwd,
          live: true,
          state,
          waitingFor: session.status === "waiting" ? session.waitingFor : state === "waiting" ? job?.needs : undefined,
          pid: session.pid,
          tmux: session.tmux,
          jobId: session.jobId ?? job?.jobId,
          startTimeMs: session.startedAtMs ?? job?.createdAtMs ?? summary?.firstActivityMs,
          lastActivityMs: newest(summary?.lastActivityMs, session.updatedAtMs, job?.updatedAtMs),
          summary,
          subagents: subagentsOf(transcript),
        });
      }

      for (const job of jobs) {
        if (job.sessionId === undefined || seen.has(job.sessionId)) continue;
        const transcript = transcripts.get(job.sessionId);
        const state = jobState(job);
        const lastSeen = newest(job.updatedAtMs, transcript?.mtimeMs);
        if (state === "ended" && (lastSeen === undefined || nowMs - lastSeen > ENDED_VISIBLE_MS)) continue;
        seen.add(job.sessionId);
        const summary = transcript === undefined ? undefined : readTranscript(transcript.file);
        const cwd = job.cwd ?? summary?.cwd;
        if (cwd === undefined) continue;
        result.push({
          sessionId: job.sessionId,
          kind: "background",
          name: job.name,
          cwd,
          live: false,
          state,
          waitingFor: state === "waiting" ? job.needs : undefined,
          pid: undefined,
          tmux: undefined,
          jobId: job.jobId,
          startTimeMs: job.createdAtMs ?? summary?.firstActivityMs,
          lastActivityMs: newest(summary?.lastActivityMs, job.updatedAtMs),
          summary,
          subagents: subagentsOf(transcript),
        });
      }

      for (const transcript of transcripts.values()) {
        if (seen.has(transcript.sessionId)) continue;
        if (nowMs - transcript.mtimeMs > ENDED_VISIBLE_MS) continue;
        const summary = readTranscript(transcript.file);
        if (summary?.cwd === undefined) continue;
        seen.add(transcript.sessionId);
        result.push({
          sessionId: transcript.sessionId,
          kind: "interactive",
          name: summary.agentName,
          cwd: summary.cwd,
          live: false,
          state: "ended",
          waitingFor: undefined,
          pid: undefined,
          tmux: undefined,
          jobId: undefined,
          startTimeMs: summary.firstActivityMs,
          lastActivityMs: newest(summary.lastActivityMs),
          summary,
          subagents: subagentsOf(transcript),
        });
      }
      return result;
    },
  };
}

/** The usage of one summary, or nothing. */
const usageOf = (summary: TranscriptSummary | undefined): ReadonlyMap<string, TokenCounts> =>
  summary?.usageByModel ?? new Map();

type Counts = { steps: number; toolCalls: number; usage: Map<string, TokenCounts> };

function countsOf(summaries: ReadonlyArray<TranscriptSummary | undefined>): Counts {
  const counts: Counts = { steps: 0, toolCalls: 0, usage: new Map() };
  for (const summary of summaries) {
    if (summary === undefined) continue;
    counts.steps += summary.steps;
    counts.toolCalls += summary.toolCalls;
    mergeUsage(counts.usage, usageOf(summary));
  }
  return counts;
}

type RowInput = {
  sessionId: string;
  directory: string;
  title: string;
  agent: string;
  state: SessionRowState;
  startTimeMs: number | undefined;
  lastActivityMs: number | undefined;
  own: TranscriptSummary | undefined;
  counts: Counts;
};

/** The common fields of a session row and a subagent row. */
function baseRow(input: RowInput, prices: PriceTable | undefined, nowMs: number): SessionRow & { apiEquivalentUsd: number | undefined } {
  const tokens = totalTokens(input.counts.usage);
  const output = Math.max(0, tokens.output - tokens.thinking);
  const cost = apiEquivalentUsd(prices, input.counts.usage);
  const model = input.own?.model;
  const working = input.state !== "idle" && input.state !== "ended";
  const elapsedEnd = working ? nowMs : (input.lastActivityMs ?? nowMs);
  return {
    sessionId: input.sessionId,
    server: "",
    directory: input.directory,
    title: input.title,
    agent: input.agent,
    state: input.state,
    startTimeMs: input.startTimeMs,
    elapsedMs: input.startTimeMs === undefined ? 0 : Math.max(0, elapsedEnd - input.startTimeMs),
    msSinceEvent: input.lastActivityMs === undefined ? 0 : Math.max(0, nowMs - input.lastActivityMs),
    steps: input.counts.steps,
    toolCalls: input.counts.toolCalls,
    contextTokens: input.own?.contextTokens ?? 0,
    // Without a price the cell stays empty, so the number is 0 and the kind says why.
    cost: cost ?? 0,
    outputTokens: output,
    reasoningTokens: tokens.thinking,
    reasoningShare: output + tokens.thinking > 0 ? tokens.thinking / (output + tokens.thinking) : 0,
    lastStepReasoning: input.own?.lastThinking ?? 0,
    driver: "claude",
    model,
    contextWindow: contextWindowOf(prices, model),
    costKind: cost === undefined ? "none" : "apiEquivalent",
    apiEquivalentUsd: cost,
  };
}

/** The row of one Claude session: its own numbers plus the sums of its subagents, and one child row per subagent. */
export function claudeRow(session: ClaudeSession, prices: PriceTable | undefined, nowMs: number): ClaudeRow {
  const children: ClaudeRow[] = session.subagents.map((agent) => {
    const row = baseRow(
      {
        sessionId: agent.agentId,
        directory: session.cwd,
        title: agent.description ?? agent.agentType ?? agent.agentId,
        agent: agent.agentType ?? "",
        // A subagent has no state file of its own. It ends with its session.
        state: session.state === "ended" ? "ended" : "idle",
        startTimeMs: agent.summary.firstActivityMs,
        lastActivityMs: agent.summary.lastActivityMs,
        own: agent.summary,
        counts: countsOf([agent.summary]),
      },
      prices,
      nowMs,
    );
    return {
      ...row,
      driver: "claude",
      kind: session.kind,
      name: undefined,
      waitingFor: undefined,
      pid: undefined,
      tmux: undefined,
      jobId: undefined,
      lastActivityMs: agent.summary.lastActivityMs,
      apiErrors: agent.summary.apiErrors,
      children: [],
    };
  });
  const row = baseRow(
    {
      sessionId: session.sessionId,
      directory: session.cwd,
      title: sessionTitle(session.summary, session.name, session.cwd),
      agent: "",
      state: session.state,
      startTimeMs: session.startTimeMs,
      lastActivityMs: session.lastActivityMs,
      own: session.summary,
      counts: countsOf([session.summary, ...session.subagents.map((agent) => agent.summary)]),
    },
    prices,
    nowMs,
  );
  return {
    ...row,
    driver: "claude",
    kind: session.kind,
    name: session.name,
    waitingFor: session.waitingFor,
    pid: session.pid,
    tmux: session.tmux,
    jobId: session.jobId,
    lastActivityMs: session.lastActivityMs,
    apiErrors: session.summary?.apiErrors ?? 0,
    children,
  };
}

/** The sort rank of a state: waiting first, ended last. */
function stateRank(state: SessionRowState): number {
  if (state === "waiting") return 0;
  if (state === "ended") return 2;
  return 1;
}

/** Waiting rows first, ended rows last, and the newest activity first inside each group. */
export function sortClaudeRows<T extends { state: SessionRowState; lastActivityMs: number | undefined }>(rows: T[]): T[] {
  return rows.sort(
    (a, b) => stateRank(a.state) - stateRank(b.state) || (b.lastActivityMs ?? 0) - (a.lastActivityMs ?? 0),
  );
}

/**
 * The rows of all Claude sessions that show at `nowMs`, sorted by
 * `sortClaudeRows`. The prices load only when at least one session shows,
 * so a machine without Claude sessions never downloads the price file.
 */
export async function loadClaudeRows(options: {
  source: ClaudeSource;
  nowMs: number;
  loadPrices: () => Promise<PriceTable | undefined>;
}): Promise<ClaudeRow[]> {
  const sessions = options.source.sessions(options.nowMs);
  if (sessions.length === 0) return [];
  const prices = await options.loadPrices();
  return sortClaudeRows(sessions.map((session) => claudeRow(session, prices, options.nowMs)));
}

/** Loads the Claude rows that show at `nowMs`. The tests of `status` and `top` replace it. */
export type ClaudeRowsLoader = (nowMs: number) => Promise<ClaudeRow[]>;

/**
 * A loader that keeps one source over all its calls, so a second call reads
 * only the new bytes of each transcript. The files come from
 * `$CLAUDE_CONFIG_DIR` (else `~/.claude`) and the prices from the LiteLLM
 * cache under `$XDG_CACHE_HOME/idfix/`. The prices load at most once per
 * loader, at the first call that finds a session. The live view of `top`
 * calls one loader on each tick.
 */
export function claudeRowsLoader(env: Record<string, string | undefined>): ClaudeRowsLoader {
  const source = createClaudeSource(claudeRoot(env));
  let prices: Promise<PriceTable | undefined> | undefined;
  return (nowMs) =>
    loadClaudeRows({
      source,
      nowMs,
      loadPrices: () => {
        prices ??= loadPrices(env);
        return prices;
      },
    });
}
