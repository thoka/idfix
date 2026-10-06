/**
 * The files of Claude Code under `~/.claude` (or `$CLAUDE_CONFIG_DIR`):
 * the paths, the liveness check of a session file, and the readers of the
 * session files, the job states, and the transcript folders. All file and
 * process access goes through `ClaudeFs`, so the tests use fixtures.
 *
 * Privacy rules. The reader opens only names that end in `.json` in the
 * `sessions` folder, never the `.key` files next to them. Of a job state, it
 * keeps only `state`, `detail`, `needs`, `createdAt`, `updatedAt`, and the
 * join keys `sessionId`, `cwd`, `worktreePath`, and `name`. It never keeps
 * `intent` or `providerEnv`. It never reads `history.jsonl`.
 */
import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** The file and process access of the reader. */
export type ClaudeFs = {
  /** The names in a folder, or an empty list when it is missing. */
  listDir(dir: string): string[];
  /** The text of a file, or undefined when it is missing. */
  readText(file: string): string | undefined;
  /** The bytes of a file from `offset` to its end, or undefined when it is missing. */
  readBytes(file: string, offset: number): Uint8Array | undefined;
  /** The modification time of a file in ms, or undefined when it is missing. */
  mtimeMs(file: string): number | undefined;
  /** The text of `/proc/<pid>/stat`, or undefined when the process does not exist. */
  procStat(pid: number): string | undefined;
};

export const nodeClaudeFs: ClaudeFs = {
  listDir(dir) {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  },
  readText(file) {
    try {
      return readFileSync(file, "utf8");
    } catch {
      return undefined;
    }
  },
  readBytes(file, offset) {
    let fd: number | undefined;
    try {
      fd = openSync(file, "r");
      const size = statSync(file).size;
      if (size <= offset) return new Uint8Array(0);
      const buffer = new Uint8Array(size - offset);
      let read = 0;
      while (read < buffer.length) {
        const n = readSync(fd, buffer, read, buffer.length - read, offset + read);
        if (n === 0) break;
        read += n;
      }
      return buffer.subarray(0, read);
    } catch {
      return undefined;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  },
  mtimeMs(file) {
    try {
      return statSync(file).mtimeMs;
    } catch {
      return undefined;
    }
  },
  procStat(pid) {
    try {
      return readFileSync(`/proc/${pid}/stat`, "utf8");
    } catch {
      return undefined;
    }
  },
};

/** The root of the Claude Code files: `$CLAUDE_CONFIG_DIR`, else `~/.claude`. */
export function claudeRoot(env: Record<string, string | undefined>): string {
  const dir = env.CLAUDE_CONFIG_DIR;
  if (dir !== undefined && dir.length > 0) return dir;
  return path.join(env.HOME ?? homedir(), ".claude");
}

/** The transcript folder name of a working directory: each character that is not a letter or a digit becomes `-`. */
export function projectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/** The kind of a session as `claude agents` names it. */
export type SessionKind = "interactive" | "background";

/** The fields of `sessions/<pid>.json` that idfix uses. */
export type SessionFile = {
  pid: number;
  /** Field 22 of `/proc/<pid>/stat` at the start of the process. */
  procStart: string;
  sessionId: string;
  cwd: string;
  name: string | undefined;
  kind: SessionKind;
  jobId: string | undefined;
  /** `busy`, `idle`, `waiting`, or `shell`. */
  status: string | undefined;
  waitingFor: string | undefined;
  /** The tmux pane of an interactive session, for example `5:@5.%40`. */
  tmux: string | undefined;
  startedAtMs: number | undefined;
  /** The newest of `updatedAt` and `statusUpdatedAt`, in ms. */
  updatedAtMs: number | undefined;
};

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const nonEmpty = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;
const finite = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** An ISO time or a number of ms, as ms. */
function timeMs(value: unknown): number | undefined {
  if (typeof value === "number") return finite(value);
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : undefined;
  }
  return undefined;
}

function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** The fields of a session file, or undefined when a required field is missing. */
export function parseSessionFile(text: string): SessionFile | undefined {
  const raw = parseObject(text);
  if (raw === undefined) return undefined;
  const pid = finite(raw.pid);
  const sessionId = nonEmpty(raw.sessionId);
  const cwd = nonEmpty(raw.cwd);
  const procStart = typeof raw.procStart === "number" ? String(raw.procStart) : str(raw.procStart);
  if (pid === undefined || sessionId === undefined || cwd === undefined || procStart === undefined) return undefined;
  const updated = [finite(raw.updatedAt), finite(raw.statusUpdatedAt)].filter((ms): ms is number => ms !== undefined);
  return {
    pid,
    procStart,
    sessionId,
    cwd,
    name: nonEmpty(raw.name),
    kind: raw.kind === "bg" || raw.kind === "background" ? "background" : "interactive",
    jobId: nonEmpty(raw.jobId),
    status: nonEmpty(raw.status),
    waitingFor: nonEmpty(raw.waitingFor),
    tmux: nonEmpty(raw.tmux),
    startedAtMs: finite(raw.startedAt),
    updatedAtMs: updated.length === 0 ? undefined : Math.max(...updated),
  };
}

/**
 * Field 22 of a `/proc/<pid>/stat` text: the start time of the process in
 * clock ticks after boot. The second field (the command name) can hold
 * spaces and parentheses, so the count starts after the last `)`.
 */
export function procStartOf(stat: string): string | undefined {
  const close = stat.lastIndexOf(")");
  if (close < 0) return undefined;
  // After the command name come field 3 (state) and onward.
  const fields = stat.slice(close + 1).trim().split(/\s+/);
  return fields[22 - 3];
}

/** Whether the process of a session file lives: the pid exists and its start time matches, so a reused pid does not count. */
export function isLive(session: SessionFile, fs: ClaudeFs): boolean {
  const stat = fs.procStat(session.pid);
  if (stat === undefined) return false;
  return procStartOf(stat) === session.procStart;
}

/**
 * The session files of live processes. Only names that end in `.json` are
 * opened, never the `.key` files next to them. A file that a crash left
 * behind stays where it is and does not count.
 */
export function readLiveSessions(root: string, fs: ClaudeFs): SessionFile[] {
  const dir = path.join(root, "sessions");
  const sessions: SessionFile[] = [];
  for (const name of fs.listDir(dir)) {
    if (!name.endsWith(".json")) continue;
    const text = fs.readText(path.join(dir, name));
    if (text === undefined) continue;
    const session = parseSessionFile(text);
    if (session !== undefined && isLive(session, fs)) sessions.push(session);
  }
  return sessions;
}

/** The fields of `jobs/<jobId>/state.json` that idfix keeps. */
export type JobState = {
  jobId: string;
  sessionId: string | undefined;
  /** The folder of the session: `worktreePath` when the job runs in a worktree, else `cwd`. */
  cwd: string | undefined;
  name: string | undefined;
  /** `working`, `blocked`, or `done`. */
  state: string | undefined;
  detail: string | undefined;
  needs: string | undefined;
  createdAtMs: number | undefined;
  updatedAtMs: number | undefined;
};

/** The kept fields of a job state. `intent`, `providerEnv`, and the rest are dropped here. */
export function parseJobState(text: string, jobId: string): JobState | undefined {
  const raw = parseObject(text);
  if (raw === undefined) return undefined;
  return {
    jobId,
    sessionId: nonEmpty(raw.sessionId),
    cwd: nonEmpty(raw.worktreePath) ?? nonEmpty(raw.cwd),
    name: nonEmpty(raw.name),
    state: nonEmpty(raw.state),
    detail: nonEmpty(raw.detail),
    needs: nonEmpty(raw.needs),
    createdAtMs: timeMs(raw.createdAt),
    updatedAtMs: timeMs(raw.updatedAt),
  };
}

/** The states of all background jobs. */
export function readJobs(root: string, fs: ClaudeFs): JobState[] {
  const dir = path.join(root, "jobs");
  const jobs: JobState[] = [];
  for (const jobId of fs.listDir(dir)) {
    const text = fs.readText(path.join(dir, jobId, "state.json"));
    if (text === undefined) continue;
    const job = parseJobState(text, jobId);
    if (job !== undefined) jobs.push(job);
  }
  return jobs;
}

/** One transcript file of a top-level session. */
export type TranscriptFile = {
  sessionId: string;
  file: string;
  mtimeMs: number;
};

/** The transcripts of all sessions, by session ID. A session ID in several folders keeps its newest file. */
export function listTranscripts(root: string, fs: ClaudeFs): Map<string, TranscriptFile> {
  const projects = path.join(root, "projects");
  const transcripts = new Map<string, TranscriptFile>();
  for (const dir of fs.listDir(projects)) {
    for (const name of fs.listDir(path.join(projects, dir))) {
      if (!name.endsWith(".jsonl")) continue;
      const file = path.join(projects, dir, name);
      const mtimeMs = fs.mtimeMs(file);
      if (mtimeMs === undefined) continue;
      const sessionId = name.slice(0, -".jsonl".length);
      const known = transcripts.get(sessionId);
      if (known === undefined || known.mtimeMs < mtimeMs) transcripts.set(sessionId, { sessionId, file, mtimeMs });
    }
  }
  return transcripts;
}

/** One subagent of a session: its transcript and the fields of its `.meta.json`. */
export type SubagentFile = {
  agentId: string;
  file: string;
  agentType: string | undefined;
  description: string | undefined;
};

/** The subagents of a session: `<sessionId>/subagents/agent-<id>.jsonl` next to its transcript. */
export function listSubagents(transcript: string, fs: ClaudeFs): SubagentFile[] {
  const dir = path.join(transcript.slice(0, -".jsonl".length), "subagents");
  const agents: SubagentFile[] = [];
  for (const name of fs.listDir(dir).sort()) {
    if (!name.startsWith("agent-") || !name.endsWith(".jsonl")) continue;
    const agentId = name.slice("agent-".length, -".jsonl".length);
    const metaText = fs.readText(path.join(dir, `agent-${agentId}.meta.json`));
    const meta = metaText === undefined ? undefined : parseObject(metaText);
    agents.push({
      agentId,
      file: path.join(dir, name),
      agentType: nonEmpty(meta?.agentType),
      description: nonEmpty(meta?.description),
    });
  }
  return agents;
}
