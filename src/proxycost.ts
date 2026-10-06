/**
 * The real cost from the proxy log: `watch` and `log` sum the `end` lines of
 * the proxy (`src/proxy/`) for one session tree. One JSON log line per model
 * request goes into `serve-<port>.log` (sandbox mode, mixed with server
 * output) or `proxy-<port>.log` (host mode); all live in `stateDir`. The
 * readers accept the source `idfx-cost-proxy` and the old `oc-sub-cost-proxy`.
 */
import { open, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { isProxyLogSource } from "./proxy/proxy";

/** Cost and request totals of one session tree in the proxy log. */
export type ProxyTotals = {
  /** The counted `end` lines of the tree sessions. */
  requests: number;
  /** Of those, the lines with `cost: null`, for example a failed request. */
  withoutCost: number;
  /** Cost and request count per upstream name, in alphabetical order. */
  byUpstream: { name: string; cost: number; requests: number }[];
};

/** The counters behind the totals. */
type Counters = {
  requests: number;
  withoutCost: number;
  byName: Map<string, { cost: number; requests: number }>;
};

type EndLine = {
  source?: unknown;
  event?: unknown;
  session?: unknown;
  upstream?: unknown;
  cost?: unknown;
};

function emptyCounters(): Counters {
  return { requests: 0, withoutCost: 0, byName: new Map() };
}

function fromCounters(counters: Counters): ProxyTotals {
  const byUpstream = [...counters.byName].map(([name, entry]) => ({ name, ...entry }));
  byUpstream.sort((a, b) => a.name.localeCompare(b.name));
  return { requests: counters.requests, withoutCost: counters.withoutCost, byUpstream };
}

/** The fields one log line must carry to count. Pure. */
function countedEndLine(line: string, sessionIds: ReadonlySet<string>): EndLine | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  let parsed: EndLine;
  try {
    parsed = JSON.parse(trimmed) as EndLine;
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  if (!isProxyLogSource(parsed.source) || parsed.event !== "end") return null;
  if (typeof parsed.session !== "string" || !sessionIds.has(parsed.session)) return null;
  return parsed;
}

function countLine(counters: Counters, line: EndLine): void {
  counters.requests++;
  const upstream = typeof line.upstream === "string" ? line.upstream : "unknown";
  const entry = counters.byName.get(upstream) ?? { cost: 0, requests: 0 };
  entry.requests++;
  if (typeof line.cost === "number" && Number.isFinite(line.cost)) {
    entry.cost += line.cost;
  } else {
    counters.withoutCost++;
  }
  counters.byName.set(upstream, entry);
}

/**
 * Sum the `end` lines of the tree sessions in the text of one log file.
 * Skips every line that is not JSON, has another `source`, is not an `end`
 * event, or has a session outside the set. Never throws. Pure.
 */
export function parseProxyLog(text: string, sessionIds: ReadonlySet<string>): ProxyTotals {
  const counters = emptyCounters();
  for (const line of text.split("\n")) {
    const parsed = countedEndLine(line, sessionIds);
    if (parsed !== null) countLine(counters, parsed);
  }
  return fromCounters(counters);
}

/** The money part of the proxy line: USD with 4 decimals. */
function dollars(cost: number): string {
  return `$${cost.toFixed(4)}`;
}

/**
 * The real-cost line of the proxy: the sum over one session tree.
 * Returns null when the log has no `end` line for the tree. Pure.
 */
export function formatProxyLine(totals: ProxyTotals): string | null {
  if (totals.requests === 0) return null;
  const total = totals.byUpstream.reduce((sum, upstream) => sum + upstream.cost, 0);
  const parts = totals.byUpstream.map((upstream) => `${upstream.name} ${dollars(upstream.cost)}`);
  if (totals.withoutCost > 0) parts.push(`${totals.withoutCost} requests without cost`);
  return `real cost ${dollars(total)} from the cost proxy (${totals.requests} requests, ${parts.join(", ")})`;
}

/**
 * The totals over every `serve-*.log` and `proxy-*.log` in the state folder.
 * A missing folder or an unreadable file counts as empty. Other callers take
 * `stateDir(env)` as the folder; tests use a temporary folder.
 */
export async function readProxyTotals(stateFolder: string, sessionIds: ReadonlySet<string>): Promise<ProxyTotals> {
  const counters = emptyCounters();
  let names: string[];
  try {
    names = await readdir(stateFolder);
  } catch {
    return fromCounters(counters);
  }
  const isLog = (name: string): boolean => /^serve-.*\.log$/.test(name) || /^proxy-.*\.log$/.test(name);
  for (const name of names.filter(isLog).sort()) {
    let text: string;
    try {
      text = await readFile(path.join(stateFolder, name), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const parsed = countedEndLine(line, sessionIds);
      if (parsed !== null) countLine(counters, parsed);
    }
  }
  return fromCounters(counters);
}

/** One model request of a tree session that has started but not ended yet. */
export type OpenRequest = {
  /** The session of the `start` line. */
  session: string;
  /** The upstream of the `start` line, `unknown` when it carries none. */
  upstream: string;
  /** The `time` of the `start` line, as epoch ms; undefined when unparsable. */
  startedMs?: number;
};

type ProxyLine = {
  source?: unknown;
  event?: unknown;
  request?: unknown;
  session?: unknown;
  upstream?: unknown;
  time?: unknown;
};

/** The fields one log line needs to count for the open requests. Pure. */
function proxyLine(line: string): ProxyLine | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  let parsed: ProxyLine;
  try {
    parsed = JSON.parse(trimmed) as ProxyLine;
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  if (!isProxyLogSource(parsed.source)) return null;
  return parsed;
}

/**
 * Collect the open requests of all sessions from the text of one log chunk
 * into `open`, keyed by the `request` number. The callers filter by the tree
 * afterwards: a subagent session joins the tree only on a later poll, and
 * its first request must not be lost. A `start` line opens a request, a later `end` line with the same number closes
 * it, and a `listening` line closes every open request, because the proxy
 * restarted and each count begins again at 1. Never throws. Pure.
 */
function collectOpenRequests(open: Map<number, OpenRequest>, text: string): void {
  for (const line of text.split("\n")) {
    const parsed = proxyLine(line);
    if (parsed === null) continue;
    if (parsed.event === "listening") {
      open.clear();
      continue;
    }
    if (typeof parsed.request !== "number") continue;
    if (parsed.event === "end") {
      open.delete(parsed.request);
      continue;
    }
    if (parsed.event !== "start" || typeof parsed.session !== "string") continue;
    const startedMs =
      typeof parsed.time === "string" ? Date.parse(parsed.time) : Number.NaN;
    open.set(parsed.request, {
      session: parsed.session,
      upstream: typeof parsed.upstream === "string" ? parsed.upstream : "unknown",
      startedMs: Number.isFinite(startedMs) ? startedMs : undefined,
    });
  }
}

/**
 * The open requests of the tree sessions in the text of one log file. Skips
 * every line that is not JSON, has another `source`, or carries no usable
 * `request` number. Never throws. Pure.
 */
export function parseOpenRequests(text: string, sessionIds: ReadonlySet<string>): OpenRequest[] {
  const open = new Map<number, OpenRequest>();
  collectOpenRequests(open, text);
  return [...open.values()].filter((request) => sessionIds.has(request.session));
}

/** The open requests of one log file, kept across calls. */
type LogCursor = {
  /** The byte offset of the next unread line. */
  offset: number;
  /** The open requests of the file, keyed by the `request` number. */
  open: Map<number, OpenRequest>;
};

/**
 * Reads only the new bytes of each proxy log since the last call, so a
 * status poll stays cheap on long logs. Keeps one cursor per file path: the
 * byte offset and the open requests so far. A file that got shorter has
 * been replaced or truncated, so the read starts again at offset 0. A file
 * that cannot be read counts as empty.
 */
export type OpenRequestReader = {
  read(stateFolder: string, sessionIds: ReadonlySet<string>): Promise<OpenRequest[]>;
};

export function createOpenRequestReader(): OpenRequestReader {
  const cursors = new Map<string, LogCursor>();
  return {
    async read(stateFolder, sessionIds) {
      let names: string[];
      try {
        names = await readdir(stateFolder);
      } catch {
        cursors.clear();
        return [];
      }
      const isLog = (name: string): boolean => /^serve-.*\.log$/.test(name) || /^proxy-.*\.log$/.test(name);
      const filePaths = names.filter(isLog).sort().map((name) => path.join(stateFolder, name));
      for (const gone of cursors.keys()) {
        if (!filePaths.includes(gone)) cursors.delete(gone);
      }
      const result: OpenRequest[] = [];
      for (const filePath of filePaths) {
        let cursor = cursors.get(filePath) ?? { offset: 0, open: new Map<number, OpenRequest>() };
        let handle: Awaited<ReturnType<typeof open>>;
        try {
          handle = await open(filePath, "r");
        } catch {
          cursors.delete(filePath);
          continue;
        }
        try {
          const size = (await handle.stat()).size;
          if (size < cursor.offset) cursor = { offset: 0, open: new Map() };
          const length = size - cursor.offset;
          if (length > 0) {
            const buffer = Buffer.alloc(length);
            const { bytesRead } = await handle.read(buffer, 0, length, cursor.offset);
            const chunk = buffer.subarray(0, bytesRead).toString("utf8");
            // Keep the last incomplete line for the next call, so a line
            // that is still being written is parsed whole.
            const cut = chunk.lastIndexOf("\n");
            const complete = cut === -1 ? "" : chunk.slice(0, cut + 1);
            cursor.offset += Buffer.byteLength(complete, "utf8");
            collectOpenRequests(cursor.open, complete);
          }
          cursors.set(filePath, cursor);
          for (const request of cursor.open.values()) {
            if (sessionIds.has(request.session)) result.push(request);
          }
        } catch {
          continue;
        } finally {
          await handle.close();
        }
      }
      return result;
    },
  };
}
