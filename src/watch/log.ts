/**
 * The event log of `idfx watch --all`: `$XDG_STATE_HOME/idfx/events.jsonl`
 * (default `~/.local/state/idfx/events.jsonl`). Design:
 * .plan/design/idfx-watch.md, section 4. The envelope follows section 6 of
 * the tool protocol, version 0.
 *
 * - One writer. The lock file `events.lock` holds the PID and the process
 *   start time of the watcher. It is created with `O_EXCL`, so only one
 *   process can create it. A lock whose process is gone (or whose PID now
 *   belongs to another process) is stale, and the next watcher takes it.
 * - Each event is a CloudEvents 1.0 JSON object on one line. The file is
 *   opened in append mode, and each line goes out with one `write` call.
 * - `sequence` has 20 digits with leading zeros and grows by 1 for each
 *   event. `id` is the same number without the zeros. The sequence continues
 *   after a restart and after a rotation.
 * - Above 10 MB, the file is renamed to `events.<first sequence>.jsonl`, and
 *   a new file starts.
 * - At start, `readLogState` reads the newest rotated file and the current
 *   file. It gives the last sequence, the time of the last event, the time of
 *   the last heartbeat, and the last record of each condition and session.
 *   The record of `SessionHandedOff` keeps `data.planCommit`, so a restart
 *   does not repeat the event for the same plan commit.
 */
import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { procStartOf } from "../claude/files";
import {
  CONDITION_TYPES,
  INFO,
  type ConditionRecord,
  type ConditionType,
  type Edge,
  type Severity,
} from "./conditions";

export const EVENTS_FILE = "events.jsonl";
export const LOCK_FILE = "events.lock";
/** The current file is rotated when it is larger than this. */
export const ROTATE_BYTES = 10 * 1024 * 1024;
export const SEQUENCE_DIGITS = 20;
export const HEARTBEAT_TYPE = "dv.idfx.watch.heartbeat";

/** The folder of the event log: `$XDG_STATE_HOME/idfx`, else `~/.local/state/idfx`. */
export function watchStateDir(env: Record<string, string | undefined>, home: string = homedir()): string {
  const base =
    env.XDG_STATE_HOME !== undefined && path.isAbsolute(env.XDG_STATE_HOME)
      ? env.XDG_STATE_HOME
      : path.join(env.HOME ?? home, ".local", "state");
  return path.join(base, "idfx");
}

/**
 * The event type of each condition: `dv.idfx.session.<condition in kebab
 * case>`. `SessionWaitsForUser` uses `dv.idfx.session.waiting`, the type of
 * tool protocol, version 0, section 6. The
 * restore of the state reads `data.condition`, not the type, so an old log
 * with `waits-for-user` still restores.
 */
export const EVENT_TYPES: Record<ConditionType, string> = {
  SessionWaitsForUser: "dv.idfx.session.waiting",
  SessionStalled: "dv.idfx.session.stalled",
  ContextHigh: "dv.idfx.session.context-high",
  HandoverFailed: "dv.idfx.session.handover-failed",
  ApiError: "dv.idfx.session.api-error",
  SessionUnnamed: "dv.idfx.session.unnamed",
  SessionHandedOff: "dv.idfx.session.handed-off",
  SessionBackground: "dv.idfx.session.background",
};

/** The `data` of a condition event. */
export type ConditionData = {
  condition: ConditionType;
  status: "True" | "False";
  reason: string;
  message: string;
  lastTransitionTime: string;
  session: string;
  cwd: string;
  kind: string;
  /** `SessionHandedOff` only: the hash of the last commit of the plan (`PLAN.md` in the plan folder). */
  planCommit?: string;
};

/** One CloudEvents 1.0 event in the JSON format, with the extensions `sequence` and severity. */
export type CloudEvent = {
  specversion: "1.0";
  id: string;
  source: string;
  type: string;
  time: string;
  subject?: string;
  sequence: string;
  severitytext: string;
  severitynumber: number;
  data: Record<string, unknown>;
};

/** A sequence number with 20 digits and leading zeros. */
export function formatSequence(sequence: number): string {
  return String(sequence).padStart(SEQUENCE_DIGITS, "0");
}

/** The `source` of the events of a host: `//<hostname>/idfx`. */
export function sourceOf(hostname: string): string {
  return `//${hostname}/idfx`;
}

const iso = (ms: number): string => new Date(ms).toISOString();

function envelope(
  sequence: number,
  source: string,
  type: string,
  timeMs: number,
  severity: Severity,
  data: Record<string, unknown>,
  subject: string | undefined,
): CloudEvent {
  return {
    specversion: "1.0",
    id: String(sequence),
    source,
    type,
    time: iso(timeMs),
    ...(subject === undefined ? {} : { subject }),
    sequence: formatSequence(sequence),
    severitytext: severity.text,
    severitynumber: severity.number,
    data,
  };
}

/** The event of one edge. */
export function conditionEvent(edge: Edge, sequence: number, source: string): CloudEvent {
  const data: ConditionData = {
    condition: edge.condition,
    status: edge.status,
    reason: edge.reason,
    message: edge.message,
    lastTransitionTime: iso(edge.lastTransitionMs),
    session: edge.session,
    cwd: edge.cwd,
    kind: edge.kind,
    ...(edge.planCommit === undefined ? {} : { planCommit: edge.planCommit }),
  };
  return envelope(sequence, source, EVENT_TYPES[edge.condition], edge.lastTransitionMs, edge.severity, data, edge.subject);
}

/** The heartbeat event: the watcher lives. `data` holds the count of sessions and of True conditions. */
export function heartbeatEvent(
  sequence: number,
  source: string,
  timeMs: number,
  counts: { sessions: number; open: number },
): CloudEvent {
  return envelope(sequence, source, HEARTBEAT_TYPE, timeMs, INFO, { ...counts }, undefined);
}

/** The record of a condition event, or undefined for another line. */
export function recordOf(event: unknown): ConditionRecord | undefined {
  if (event === null || typeof event !== "object") return undefined;
  const data = (event as { data?: unknown; subject?: unknown }).data;
  const subject = (event as { subject?: unknown }).subject;
  if (data === null || typeof data !== "object") return undefined;
  const d = data as Record<string, unknown>;
  if (!CONDITION_TYPES.includes(d.condition as ConditionType)) return undefined;
  if (d.status !== "True" && d.status !== "False") return undefined;
  if (typeof d.session !== "string") return undefined;
  const transition = typeof d.lastTransitionTime === "string" ? Date.parse(d.lastTransitionTime) : Number.NaN;
  return {
    condition: d.condition as ConditionType,
    status: d.status,
    reason: typeof d.reason === "string" ? d.reason : "",
    message: typeof d.message === "string" ? d.message : "",
    lastTransitionMs: Number.isFinite(transition) ? transition : 0,
    session: d.session,
    subject: typeof subject === "string" ? subject : d.session.slice(0, 8),
    cwd: typeof d.cwd === "string" ? d.cwd : "",
    kind: typeof d.kind === "string" ? d.kind : "",
    ...(typeof d.planCommit === "string" ? { planCommit: d.planCommit } : {}),
  };
}

/** What the watcher reads from its log at start. */
export type LogState = {
  /** The last sequence number, or 0 without any event. */
  lastSequence: number;
  /** The `time` of the last event, in ms. */
  lastTimeMs: number | undefined;
  /** The `time` of the last heartbeat, in ms. */
  lastHeartbeatMs: number | undefined;
  /** The last record of each condition and session. */
  records: ConditionRecord[];
};

/** The rotated files of a folder, oldest first: `events.<sequence>.jsonl`. */
export function rotatedFiles(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .map((name) => /^events\.(\d+)\.jsonl$/.exec(name))
    .filter((match): match is RegExpExecArray => match !== null)
    .sort((a, b) => Number(a[1]) - Number(b[1]))
    .map((match) => path.join(dir, match[0]));
}

function readLines(file: string): string[] {
  try {
    return readFileSync(file, "utf8").split("\n");
  } catch {
    return [];
  }
}

/**
 * The state of the log in `dir`: the newest rotated file, then the current
 * file. A line that does not parse (for example the cut last line after a
 * crash) is skipped.
 */
export function readLogState(dir: string): LogState {
  const rotated = rotatedFiles(dir);
  const files = [...rotated.slice(-1), path.join(dir, EVENTS_FILE)];
  const state: LogState = { lastSequence: 0, lastTimeMs: undefined, lastHeartbeatMs: undefined, records: [] };
  const records = new Map<string, ConditionRecord>();
  for (const file of files) {
    for (const line of readLines(file)) {
      if (line.trim().length === 0) continue;
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event === null || typeof event !== "object") continue;
      const { sequence, time, type } = event as { sequence?: unknown; time?: unknown; type?: unknown };
      if (typeof sequence === "string" && /^\d+$/.test(sequence)) {
        state.lastSequence = Math.max(state.lastSequence, Number(sequence));
      }
      const timeMs = typeof time === "string" ? Date.parse(time) : Number.NaN;
      if (Number.isFinite(timeMs)) {
        state.lastTimeMs = Math.max(state.lastTimeMs ?? timeMs, timeMs);
        if (type === HEARTBEAT_TYPE) state.lastHeartbeatMs = Math.max(state.lastHeartbeatMs ?? timeMs, timeMs);
      }
      const record = recordOf(event);
      if (record !== undefined) records.set(`${record.condition}\u0000${record.session}`, record);
    }
  }
  // An older rotated file can hold a higher number only by a fault, but the
  // sequence must never go back, so all rotated names count.
  for (const file of rotated) {
    const match = /events\.(\d+)\.jsonl$/.exec(file);
    if (match?.[1] !== undefined) state.lastSequence = Math.max(state.lastSequence, Number(match[1]));
  }
  state.records = [...records.values()];
  return state;
}

/** The process checks of the lock: the own PID, and the `/proc/<pid>/stat` text of a PID. */
export type LockProcess = {
  pid: number;
  procStat(pid: number): string | undefined;
};

export const nodeLockProcess: LockProcess = {
  pid: process.pid,
  procStat(pid) {
    try {
      return readFileSync(`/proc/${pid}/stat`, "utf8");
    } catch {
      return undefined;
    }
  },
};

export type Lock = { release(): void };

export type LockResult = { ok: true; lock: Lock } | { ok: false; holderPid: number };

type LockContent = { pid: number; procStart: string | undefined };

function readLock(file: string): LockContent | undefined {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { pid?: unknown; procStart?: unknown };
    if (typeof raw.pid !== "number") return undefined;
    return { pid: raw.pid, procStart: typeof raw.procStart === "string" ? raw.procStart : undefined };
  } catch {
    return undefined;
  }
}

/** Whether the process of a lock still lives: the PID exists and its start time matches. */
function holderLives(content: LockContent, proc: LockProcess): boolean {
  const stat = proc.procStat(content.pid);
  if (stat === undefined) return false;
  return content.procStart === undefined || procStartOf(stat) === content.procStart;
}

/** The holder of the lock in `dir`: none (no file, or a broken file), a live watcher, or a stale lock of a gone process. */
export type LockHolder = { state: "none" } | { state: "live"; pid: number } | { state: "stale"; pid: number };

/** Reads the lock of `dir` without taking it. The `watch-running` check of `doctor` uses it. */
export function lockHolder(dir: string, proc: LockProcess = nodeLockProcess): LockHolder {
  const holder = readLock(path.join(dir, LOCK_FILE));
  if (holder === undefined) return { state: "none" };
  return holderLives(holder, proc) ? { state: "live", pid: holder.pid } : { state: "stale", pid: holder.pid };
}

/**
 * Take the lock `events.lock` in `dir`. The file is created with `O_EXCL`
 * and holds the PID and the start time of the process. A lock of a dead
 * process (or of a reused PID) is removed, and the next try takes it.
 */
export function acquireLock(dir: string, proc: LockProcess = nodeLockProcess): LockResult {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, LOCK_FILE);
  const stat = proc.procStat(proc.pid);
  const own: LockContent = { pid: proc.pid, procStart: stat === undefined ? undefined : procStartOf(stat) };
  const text = `${JSON.stringify(own)}\n`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o644);
      try {
        writeSync(fd, text);
      } finally {
        closeSync(fd);
      }
      return {
        ok: true,
        lock: {
          release() {
            // Remove the file only while it is still ours.
            const now = readLock(file);
            if (now?.pid === own.pid && now.procStart === own.procStart) {
              try {
                unlinkSync(file);
              } catch {
                // Already gone.
              }
            }
          },
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const holder = readLock(file);
    if (holder !== undefined && holderLives(holder, proc)) return { ok: false, holderPid: holder.pid };
    // A stale or broken lock: remove it and try once more.
    try {
      unlinkSync(file);
    } catch {
      // Another watcher removed it first.
    }
  }
  const holder = readLock(file);
  return { ok: false, holderPid: holder?.pid ?? 0 };
}

/** The writer of the event log. Only the holder of the lock writes. */
export type EventWriter = {
  /** Append one event with the next sequence number. `make` gets the number. */
  append(make: (sequence: number) => CloudEvent): CloudEvent;
  /** The last sequence number written. */
  lastSequence(): number;
  close(): void;
};

/**
 * Open the current file in append mode. `lastSequence` comes from
 * `readLogState`. A cut last line (after a crash) is closed with a newline,
 * so the next event starts on its own line.
 */
export function openEventWriter(dir: string, lastSequence: number, rotateBytes: number = ROTATE_BYTES): EventWriter {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, EVENTS_FILE);
  let sequence = lastSequence;
  let fd = openSync(file, "a");
  let size = fstatSync(fd).size;
  let firstSequence: number | undefined;

  if (size > 0) {
    const text = readFileSync(file, "utf8");
    if (!text.endsWith("\n")) size += writeSync(fd, "\n");
    for (const line of text.split("\n")) {
      try {
        const value = (JSON.parse(line) as { sequence?: unknown }).sequence;
        if (typeof value === "string" && /^\d+$/.test(value)) {
          firstSequence = Number(value);
          break;
        }
      } catch {
        // Skip a broken line.
      }
    }
  }

  const rotate = (): void => {
    closeSync(fd);
    const first = firstSequence ?? sequence;
    renameSync(file, path.join(dir, `events.${formatSequence(first)}.jsonl`));
    fd = openSync(file, "a");
    size = 0;
    firstSequence = undefined;
  };

  return {
    append(make) {
      if (size > rotateBytes) rotate();
      sequence += 1;
      const event = make(sequence);
      const line = `${JSON.stringify(event)}\n`;
      // One write call for the full line.
      size += writeSync(fd, line);
      firstSequence ??= sequence;
      return event;
    },
    lastSequence: () => sequence,
    close() {
      closeSync(fd);
    },
  };
}
