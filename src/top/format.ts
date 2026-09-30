/** The text snapshot of `oc-sub top --once`: one padded table line per session. */
import type { PendingRequest } from "../requests";
import { formatRequest } from "../requests";
import { displayFolder } from "../status";
import { formatCost, formatDuration } from "../summary";
import type { SessionRow } from "./model";

/** One row of the top table: a session row plus the pending requests of its session tree. */
export type TopTableRow = SessionRow & { pending: readonly PendingRequest[] };

/** The columns of the table, in order. The title comes last and is not padded. */
const HEADERS = [
  "session",
  "folder",
  "agent",
  "state",
  "elapsed",
  "last",
  "steps",
  "tools",
  "ctx",
  "cost",
  "reason",
  "title",
] as const;

/** The line width that `top` uses when stdout is not a terminal. */
export const DEFAULT_WIDTH = 160;

/** The title never gets shorter than this, even when the line gets wider. */
const MIN_TITLE = 24;

/** The display options of the snapshot. */
export type TopTableOptions = {
  /** The scope directory: folders inside it show relative to it. */
  scopeDir?: string;
  /** The line width that the title is cut to. Default: `DEFAULT_WIDTH`. */
  width?: number;
  /** The home directory: a folder that starts with it shows with `~`. */
  home?: string;
};

function folderOf(row: SessionRow, options: TopTableOptions): string {
  let folder =
    options.scopeDir === undefined ? row.directory : displayFolder(row.directory, options.scopeDir);
  const home = options.home;
  if (home !== undefined && home.length > 0 && (folder === home || folder.startsWith(`${home}/`))) {
    folder = `~${folder.slice(home.length)}`;
  }
  return folder;
}

function cellsOf(row: TopTableRow, nowMs: number, options: TopTableOptions): string[] {
  return [
    row.sessionId,
    folderOf(row, options),
    row.agent,
    row.state,
    formatDuration(row.elapsedMs),
    formatDuration(Math.max(0, row.msSinceEvent)),
    String(row.steps),
    String(row.toolCalls),
    `${(row.contextTokens / 1000).toFixed(1)}k`,
    formatCost(row.cost),
    `${Math.round(row.reasoningShare * 100)}%`,
    row.title,
  ];
}

/**
 * The snapshot: one header line, one line per session, and one indented line
 * per pending request. The fixed columns are padded to the widest value, and
 * the title is cut so that the line fits into `width`. The title keeps at
 * least 24 characters, so a long folder never hides it completely; such a
 * line is then longer than `width`.
 */
export function formatTopTable(
  rows: readonly TopTableRow[],
  nowMs: number,
  options: TopTableOptions = {},
): string[] {
  const width = options.width ?? DEFAULT_WIDTH;
  const cells = rows.map((row) => cellsOf(row, nowMs, options));
  const widths = HEADERS.map((header, column) =>
    Math.max(header.length, ...cells.map((cell) => cell[column]?.length ?? 0)),
  );
  const line = (cell: string[]): string =>
    cell.map((value, column) => (column === HEADERS.length - 1 ? value : value.padEnd(widths[column] ?? 0))).join("  ");

  const lines: string[] = [line([...HEADERS])];
  // The prefix before the title: the padded columns plus the two-space gaps.
  const prefix = widths.slice(0, -1).reduce((sum, width) => sum + width, 0) + 2 * (HEADERS.length - 1);
  const maxTitle = Math.max(MIN_TITLE, width - prefix);
  rows.forEach((row, index) => {
    const cell = cells[index];
    if (cell === undefined) return;
    cell[HEADERS.length - 1] = row.title.length > maxTitle ? row.title.slice(0, maxTitle) : row.title;
    lines.push(line(cell));
    for (const pending of row.pending) {
      lines.push(...formatRequest(pending).map((requestLine) => `  ${requestLine}`));
    }
  });
  return lines;
}
