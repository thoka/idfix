/**
 * The columns of `oc-sub top` (step 8f), shared by the `--once` table and
 * the live view. All functions here are pure: no file system, no git, no
 * clock.
 *
 * - The session column shows the attach CODE: the last 6 characters of the
 *   session ID, the same CODE that `oc-sub attach CODE` takes.
 * - The folder of a session splits into two columns, project and worktree.
 *   A folder `<root>/.worktrees/<name>/...` belongs to the project
 *   `basename(<root>)` and the worktree `<name>`. Every other folder is the
 *   main folder of the project `basename(folder)`, with the worktree `-`.
 * - The project column shows a short name (see `shortProjectName`). Without
 *   `--all` it is hidden, because all rows belong to one project.
 */
import path from "node:path";
import { formatCost, formatDuration } from "../summary";
import type { SessionRow } from "./model";

/** How many characters of the session ID the session column shows. */
export const CODE_LENGTH = 6;

/** A project name up to this length stays as it is. */
export const SHORT_NAME_MAX = 8;

/** The attach CODE of a session: the last 6 characters of its ID. */
export function sessionCode(sessionId: string): string {
  return sessionId.slice(-CODE_LENGTH);
}

/** The project and the worktree of a session folder. */
export type FolderParts = { project: string; worktree: string };

/**
 * Split a session folder into project and worktree. The worktree is the
 * first folder name under `.worktrees/`, or `-` for the main folder. An
 * empty folder (a session without a known directory) gives `-` for both.
 */
export function splitFolder(directory: string): FolderParts {
  if (directory.length === 0) return { project: "-", worktree: "-" };
  const parts = path.resolve(directory).split(path.sep).filter((part) => part.length > 0);
  const index = parts.lastIndexOf(".worktrees");
  if (index > 0 && index < parts.length - 1) {
    return { project: parts[index - 1] ?? "-", worktree: parts[index + 1] ?? "-" };
  }
  return { project: parts[parts.length - 1] ?? "/", worktree: "-" };
}

/**
 * The short form of one project name. A name of at most 8 characters stays.
 * A longer name keeps the first 2 characters of its first part and the
 * first 3 characters of each later part; the parts split at `-`, `_`, and
 * `.`. For example `opencode-subagents` gives `opsub`.
 */
export function shortProjectName(name: string): string {
  if (name.length <= SHORT_NAME_MAX) return name;
  const parts = name.split(/[-_.]/).filter((part) => part.length > 0);
  if (parts.length === 0) return name;
  return parts.map((part, index) => part.slice(0, index === 0 ? 2 : 3)).join("");
}

/**
 * The shown name of every project. Two projects with the same short name
 * both keep their full name, so the column never mixes up two projects.
 */
export function shortProjectNames(names: Iterable<string>): Map<string, string> {
  const unique = [...new Set(names)];
  const byShort = new Map<string, string[]>();
  for (const name of unique) {
    const short = shortProjectName(name);
    const owners = byShort.get(short);
    if (owners === undefined) byShort.set(short, [name]);
    else owners.push(name);
  }
  const shown = new Map<string, string>();
  for (const [short, owners] of byShort) {
    for (const name of owners) shown.set(name, owners.length > 1 ? name : short);
  }
  return shown;
}

/** The header of every column, in order. The title comes last. */
export const ALL_HEADERS = [
  "session",
  "project",
  "worktree",
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

export type ColumnHeader = (typeof ALL_HEADERS)[number];

/** The column options: whether the project column shows. */
export type ColumnOptions = {
  /** Show the project column. `top --all` sets it; without `--all` it is hidden. */
  showProject: boolean;
};

/** The headers of the shown columns. */
export function columnHeaders(options: ColumnOptions): ColumnHeader[] {
  return ALL_HEADERS.filter((header) => options.showProject || header !== "project");
}

/**
 * The cells of every row, in the order of `columnHeaders(options)`. The
 * short project names are computed over all given rows.
 */
export function rowCells(rows: readonly SessionRow[], options: ColumnOptions): string[][] {
  const folders = rows.map((row) => splitFolder(row.directory));
  const names = shortProjectNames(folders.map((folder) => folder.project));
  return rows.map((row, index) => {
    const folder = folders[index] ?? { project: "-", worktree: "-" };
    const cells: Record<ColumnHeader, string> = {
      session: sessionCode(row.sessionId),
      project: names.get(folder.project) ?? folder.project,
      worktree: folder.worktree,
      agent: row.agent.length > 0 ? row.agent : "-",
      state: row.state,
      elapsed: formatDuration(row.elapsedMs),
      last: formatDuration(Math.max(0, row.msSinceEvent)),
      steps: String(row.steps),
      tools: String(row.toolCalls),
      ctx: `${(row.contextTokens / 1000).toFixed(1)}k`,
      cost: formatCost(row.cost),
      reason: `${Math.round(row.reasoningShare * 100)}%`,
      title: row.title,
    };
    return columnHeaders(options).map((header) => cells[header]);
  });
}

/** The line width that `top` uses when stdout is not a terminal. */
export const DEFAULT_WIDTH = 160;

/** The title never gets shorter than this, even when the line gets wider. */
export const MIN_TITLE = 24;

/** The gap between two columns. */
export const GAP = "  ";

/** The padded table: the headers and cells with padding, and the title cut to the width. */
export type PaddedTable = {
  headers: ColumnHeader[];
  /** The header line, padded like the rows. */
  header: string[];
  /** One padded cell list per row. Only the title is not padded. */
  rows: string[][];
};

/**
 * Pad every column to its widest value and cut the title so that a line
 * fits into `width`. The title keeps at least 24 characters, so a long
 * value never hides it completely; such a line is then longer than `width`.
 * Joined with `GAP`, a padded row gives one table line.
 */
export function padTable(rows: readonly SessionRow[], options: ColumnOptions & { width: number }): PaddedTable {
  const headers = columnHeaders(options);
  const cells = rowCells(rows, options);
  const last = headers.length - 1;
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...cells.map((cell) => cell[column]?.length ?? 0)),
  );
  const prefix = widths.slice(0, -1).reduce((sum, width) => sum + width, 0) + GAP.length * last;
  const maxTitle = Math.max(MIN_TITLE, options.width - prefix);
  const pad = (cell: string[]): string[] =>
    cell.map((value, column) =>
      column === last ? (value.length > maxTitle ? value.slice(0, maxTitle) : value) : value.padEnd(widths[column] ?? 0),
    );
  return { headers, header: pad([...headers]), rows: cells.map(pad) };
}
