/**
 * The recheck head of a research report. A report can
 * start with a YAML front matter that holds three keys:
 *
 *   ---
 *   checked: 2026-10-01
 *   recheck: 1m
 *   decisions:
 *     - "Use DeepInfra as a direct provider"
 *   ---
 *
 * `checked` is the date of the last check of the facts (YYYY-MM-DD). It is
 * required when `recheck` is set. `recheck` is an interval (`30d`, `2w`,
 * `2m`, counted from `checked`), a date, or any other text as a trigger,
 * for example "on new sbx release" (a trigger is never due by date).
 * `decisions` is a list of short texts that name the plan items that rest
 * on the facts. The format follows a shared research index format, so
 * both tools compute the same due dates.
 *
 * The project has no YAML parser in `package.json`, so this module parses
 * only these three keys by hand. It is not a general YAML parser.
 */

/** The recheck head of one report, after parsing. */
export type ResearchHead = {
  /** The date of the last check of the facts, YYYY-MM-DD. */
  checked?: string;
  /** The interval, a date, or a trigger text. */
  recheck?: string;
  /** The plan items that rest on the facts. */
  decisions: string[];
};

/**
 * The result of the due computation for one head. A trigger is never due;
 * the check lists it as information only.
 */
export type RecheckState =
  | { kind: "due"; due: string }
  | { kind: "not-due"; due: string }
  | { kind: "trigger" }
  | { kind: "invalid"; problem: string };

/**
 * The named intervals of the first head format. The research index reads them
 * as triggers, so they never become due there. The check marks them as
 * invalid and names the replacement.
 */
export const LEGACY_INTERVALS: Record<string, string> = {
  weekly: "1w",
  biweekly: "2w",
  monthly: "1m",
  quarterly: "3m",
  yearly: "12m",
};

/** Parse an interval `Nd`, `Nw`, or `Nm` into days or months. */
export function parseInterval(text: string): { days?: number; months?: number } | undefined {
  const match = text.match(/^(\d+)([dwm])$/);
  if (match === null) return undefined;
  const n = Number(match[1]);
  if (match[2] === "d") return { days: n };
  if (match[2] === "w") return { days: 7 * n };
  return { months: n };
}

/** Today as YYYY-MM-DD, in the local time zone. */
export function todayString(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Whether the string is a calendar date YYYY-MM-DD. */
function isDateString(text: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(Date.parse(`${text}T00:00:00Z`));
}

/**
 * Parse the front matter of a report. Returns null when the text does not
 * start with a front matter block or the block holds none of the three
 * keys (so reports with an unrelated front matter do not count).
 * Decisions may use quotes; the parser strips a pair of double quotes.
 */
export function parseResearchHead(text: string): ResearchHead | null {
  if (!text.startsWith("---\n")) return null;
  const end = text.indexOf("\n---", 4);
  if (end === -1) return null;
  const lines = text.slice(4, end).split("\n");
  const head: ResearchHead = { decisions: [] };
  let inDecisions = false;
  let keys = 0;
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    const item = line.match(/^\s*-\s+(.*)$/);
    if (inDecisions && item !== null) {
      head.decisions.push((item[1] ?? "").trim().replace(/^"(.*)"$/, "$1"));
      continue;
    }
    inDecisions = false;
    const pair = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (pair === null) continue;
    const key = pair[1] ?? "";
    const value = (pair[2] ?? "").trim();
    if (key === "checked" && value.length > 0) {
      head.checked = value;
      keys++;
    } else if (key === "recheck" && value.length > 0) {
      head.recheck = value;
      keys++;
    } else if (key === "decisions") {
      inDecisions = true;
      keys++;
    }
  }
  if (keys === 0) return null;
  return head;
}

/** Add days or months to a date string YYYY-MM-DD. A month clamps the day. */
function addInterval(date: string, interval: { days?: number; months?: number }): string {
  const [y = 0, m = 0, d = 0] = date.split("-").map(Number);
  if (interval.days !== undefined) {
    const next = new Date(Date.UTC(y, m - 1, d + interval.days));
    return next.toISOString().slice(0, 10);
  }
  const months = interval.months ?? 0;
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  const next = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(d, lastDay)));
  return next.toISOString().slice(0, 10);
}

/**
 * Compute the due state of a head against `today` (YYYY-MM-DD). An interval
 * is due when the date that `checked` plus the interval gives is today or
 * earlier. A plain date is due when it is today or earlier. Any other text
 * is a trigger and never due by date. An invalid head names its problem.
 */
export function recheckState(head: ResearchHead, today: string): RecheckState {
  if (head.recheck === undefined) {
    return { kind: "invalid", problem: "recheck is missing" };
  }
  if (head.checked === undefined) {
    return { kind: "invalid", problem: "checked is missing" };
  }
  if (!isDateString(head.checked)) {
    return { kind: "invalid", problem: `checked is not a date YYYY-MM-DD (${head.checked})` };
  }
  const recheck = head.recheck;
  const legacy = LEGACY_INTERVALS[recheck];
  if (legacy !== undefined) {
    return { kind: "invalid", problem: `recheck ${recheck} is the old format, write ${legacy}` };
  }
  const interval = parseInterval(recheck);
  if (interval !== undefined) {
    const due = addInterval(head.checked, interval);
    return due <= today ? { kind: "due", due } : { kind: "not-due", due };
  }
  if (isDateString(recheck)) {
    return recheck <= today ? { kind: "due", due: recheck } : { kind: "not-due", due: recheck };
  }
  return { kind: "trigger" };
}
