/**
 * The real cost from the proxy log: `watch` and `log` sum the `end` lines of
 * the proxy (`src/proxy/`) for one session tree. One JSON log line per model
 * request goes into `serve-<port>.log` (sandbox mode, mixed with server
 * output) or `proxy-<port>.log` (host mode); all live in `stateDir`.
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

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
  if (parsed.source !== "oc-sub-cost-proxy" || parsed.event !== "end") return null;
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
