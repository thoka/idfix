/**
 * The columns of `idfx top`, shared by the `--once` table and
 * the live view. All functions here are pure: no file system, no git, no
 * clock.
 *
 * - The session column shows the attach CODE: the last 6 characters of the
 *   session ID, the same CODE that `idfx attach CODE` takes.
 * - The folder of a session splits into project and worktree. A folder
 *   `<root>/.worktrees/<name>/...` belongs to the project `basename(<root>)`
 *   and the worktree `<name>`. Every other folder is the main folder of the
 *   project `basename(folder)`, with the worktree `-`.
 * - The `where` column shows both in one cell: `project/worktree`, or only
 *   `project` for the main folder. The project is the configured
 *   `shortName` of the project (`.opencode/oc-sub.json`), else the full
 *   name; the caller injects the name resolver (see
 *   `makeProjectNameResolver`). Without `--all` the cell shows only the
 *   worktree, because all rows belong to one project.
 * - The table is compact: the agent icon in front of the CODE,
 *   short times, the cost in cents, and one space between columns. The
 *   state has no column: the live view colors the `id` cell. Only a plain
 *   text table without color gets a `state` column (`stateColumn`). Icons
 *   are two cells wide, so the padding measures the display width. The
 *   `id` header starts after the icon, so that it lines up with the codes.
 * - A Claude Code session shows the icon `✳`. Its cost is the
 *   API price of its tokens, not a real charge: the views show the cell in
 *   gray, and a table without color marks it with `~`. A session without a
 *   known price has an empty cost cell. The `ctx` cell adds the share of
 *   the context window when the window of the model is known.
 * - An inactive row (no process, see `SessionRow.active`) that did not end
 *   gets the mark `·` (`INACTIVE_MARK`) after its state: in the `state`
 *   cell when the table has that column (`waiting·`), else after the CODE
 *   in the `id` cell (`abc123·`), because there the color of the `id` cell
 *   shows the state. An ended row needs no mark: it never has a process.
 */
import path from "node:path";
import cliTruncate from "cli-truncate";
import stringWidth from "string-width";
import { isActive, type SessionRow } from "./model";

/** How many characters of the session ID the session column shows. */
export const CODE_LENGTH = 6;

/** The attach CODE of a session: the last 6 characters of its ID. */
export function sessionCode(sessionId: string): string {
  return sessionId.slice(-CODE_LENGTH);
}

/** The mark of a row without a process: `waiting·` means "waits, but no process runs". */
export const INACTIVE_MARK = "·";

/** Whether a row gets the inactive mark: no process, and not ended. */
export function hasInactiveMark(row: Pick<SessionRow, "active" | "state">): boolean {
  return !isActive(row) && row.state !== "ended";
}

/** The state of a row as text, with the inactive mark when it applies, for example `waiting·`. */
export function stateText(row: Pick<SessionRow, "active" | "state">): string {
  return hasInactiveMark(row) ? `${row.state}${INACTIVE_MARK}` : row.state;
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

/** The icon of each agent. An unknown agent shows its first two letters. */
export const AGENT_ICONS: Record<string, string> = {
  coder: "🔧",
  researcher: "🔎",
  reader: "📖",
};

/** The icon of a Claude Code session. Its subagents show the icon of their agent type. */
export const CLAUDE_ICON = "✳";

/** Worktree name prefixes that the `where` column shows as an icon. */
export const WORKTREE_PREFIX_ICONS: ReadonlyArray<readonly [prefix: string, icon: string]> = [["research-", "🔬"]];

/** The agent icon, or the first two letters of an unknown agent, or `--`. */
export function agentIcon(agent: string): string {
  if (agent.length === 0) return "--";
  return AGENT_ICONS[agent] ?? agent.slice(0, 2).padEnd(2);
}

/** The icon of a row: `✳` for a Claude session without an agent, else the icon of its agent. */
export function rowIcon(row: Pick<SessionRow, "agent" | "driver">): string {
  if (row.driver === "claude" && row.agent.length === 0) return CLAUDE_ICON.padEnd(ICON_WIDTH);
  return agentIcon(row.agent);
}

/** A worktree name with a known prefix replaced by its icon. */
export function shortWorktree(worktree: string): string {
  for (const [prefix, icon] of WORKTREE_PREFIX_ICONS) {
    if (worktree.startsWith(prefix) && worktree.length > prefix.length) return icon + worktree.slice(prefix.length);
  }
  return worktree;
}

/**
 * A duration in at most five characters. Seconds count only below ten
 * minutes: "42s", "4m05s", "34m", "3h12m", "2d04h".
 */
export function formatAge(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const pad = (n: number) => String(n).padStart(2, "0");
  if (total < 60) return `${total}s`;
  if (total < 600) return `${Math.floor(total / 60)}m${pad(total % 60)}s`;
  if (total < 3600) return `${Math.floor(total / 60)}m`;
  if (total < 86_400) return `${Math.floor(total / 3600)}h${pad(Math.floor((total % 3600) / 60))}m`;
  return `${Math.floor(total / 86_400)}d${pad(Math.floor((total % 86_400) / 3600))}h`;
}

/** A cost in US dollars as cents without a unit: "0.1", "4.3", "57", "1234". */
export function formatCents(cost: number): string {
  const cents = Math.max(0, cost * 100);
  return cents < 10 ? cents.toFixed(1) : String(Math.round(cents));
}

/** The context size in thousands of tokens: "6.3k", "123k". */
export function formatContext(tokens: number): string {
  const thousands = tokens / 1000;
  return thousands < 100 ? `${thousands.toFixed(1)}k` : `${Math.round(thousands)}k`;
}

/**
 * The `ctx` cell: the size, plus the share of the context window when the
 * window is known, for example "123k 62%" or "6.3k  3%".
 */
export function formatContextCell(tokens: number, contextWindow: number | undefined): string {
  const size = formatContext(tokens);
  if (contextWindow === undefined || contextWindow <= 0) return size;
  // The share has a fixed width, so the sizes and the shares line up in the column.
  const share = String(Math.round((tokens / contextWindow) * 100)).padStart(2);
  return `${size} ${share}%`;
}

/**
 * The `¢` cell: empty without a known price (`costKind` "none"), and with
 * `marker` a `~` in front of an API price, so that a table without color
 * still shows that the number is not a real charge.
 */
export function costCell(row: Pick<SessionRow, "cost" | "costKind">, marker: boolean): string {
  if (row.costKind === "none") return "";
  const cents = formatCents(row.cost);
  return marker && row.costKind === "apiEquivalent" ? `~${cents}` : cents;
}

/** The key of every column, in order. The title comes last. */
export const ALL_HEADERS = [
  "session",
  "state",
  "where",
  "cost",
  "elapsed",
  "last",
  "steps",
  "tools",
  "ctx",
  "reason",
  "title",
] as const;

export type ColumnHeader = (typeof ALL_HEADERS)[number];

/** The shown label of each column. The icon column has none. */
export const HEADER_LABELS: Record<ColumnHeader, string> = {
  session: "id",
  state: "state",
  where: "where",
  cost: "¢",
  elapsed: "run",
  last: "last",
  steps: "stp",
  tools: "tls",
  ctx: "ctx",
  reason: "rsn",
  title: "title",
};

/** The columns with numbers. They align to the right. */
const RIGHT_ALIGNED: ReadonlySet<ColumnHeader> = new Set(["cost", "elapsed", "last", "steps", "tools", "ctx", "reason"]);

/** The column options: whether the project shows in the `where` column, and the state column. */
export type ColumnOptions = {
  /**
   * Show the state as a word column after `id`. A table without color sets
   * it, because there the color of the `id` cell cannot show the state.
   */
  stateColumn?: boolean;
  /** Show the project in the `where` column. `top --all` sets it. */
  showProject: boolean;
  /**
   * The shown project name of a run folder. Default: the computed name of
   * `splitFolder`. Callers pass `makeProjectNameResolver()`, which shows
   * the configured `shortName` of the project root when it has one.
   */
  projectName?: (directory: string) => string;
  /**
   * Mark an API price in the `¢` cell with `~`. A table without color sets
   * it, because there the gray color cannot show the kind of the cost.
   */
  costMarker?: boolean;
};

/** The keys of the shown columns. */
export function columnHeaders(options: ColumnOptions): ColumnHeader[] {
  return ALL_HEADERS.filter((header) => options.stateColumn === true || header !== "state");
}

/** The `where` cell: `project/worktree`, `project`, or without the project only the worktree. */
function whereCell(directory: string, options: ColumnOptions, nameOf: (directory: string) => string): string {
  const worktree = splitFolder(directory).worktree;
  const tree = worktree === "-" ? "-" : shortWorktree(worktree);
  if (!options.showProject) return tree;
  const project = nameOf(directory);
  return tree === "-" ? project : `${project}/${tree}`;
}

/**
 * The cells of every row, in the order of `columnHeaders(options)`. The
 * shown project name comes from `options.projectName`, or from the folder.
 */
export function rowCells(rows: readonly SessionRow[], options: ColumnOptions): string[][] {
  const nameOf = options.projectName ?? ((directory: string) => splitFolder(directory).project);
  const stateColumn = options.stateColumn === true;
  return rows.map((row) => {
    // The mark goes where the state shows: the state cell, or the colored `id` cell.
    const idMark = !stateColumn && hasInactiveMark(row) ? INACTIVE_MARK : "";
    const cells: Record<ColumnHeader, string> = {
      session: rowIcon(row) + sessionCode(row.sessionId) + idMark,
      state: stateText(row),
      where: whereCell(row.directory, options, nameOf),
      cost: costCell(row, options.costMarker === true),
      elapsed: formatAge(row.elapsedMs),
      last: formatAge(row.msSinceEvent),
      steps: String(row.steps),
      tools: String(row.toolCalls),
      ctx: formatContextCell(row.contextTokens, row.contextWindow),
      reason: `${Math.round(row.reasoningShare * 100)}%`,
      title: row.title,
    };
    return columnHeaders(options).map((header) => cells[header]);
  });
}

/** The line width that `top` uses when stdout is not a terminal. */
export const DEFAULT_WIDTH = 160;

/** The title never gets shorter than this, even when the line gets wider. */
export const MIN_TITLE = 16;

/** The gap between two columns. */
export const GAP = " ";

/** The width of the agent icon. The `id` header starts after it. */
export const ICON_WIDTH = 2;

/** The padded table: the headers and cells with padding, and the title cut to the width. */
export type PaddedTable = {
  headers: ColumnHeader[];
  /** The header line, padded like the rows. */
  header: string[];
  /** One padded cell list per row. Only the title is not padded. */
  rows: string[][];
};

/** Pad a cell to a display width. Icons count as two cells. */
function padCell(value: string, width: number, right: boolean): string {
  const fill = " ".repeat(Math.max(0, width - stringWidth(value)));
  return right ? fill + value : value + fill;
}

/**
 * Pad every column to its widest value and cut the title so that a line
 * fits into `width`. Widths count display cells, so an icon counts two.
 * The title keeps at least 16 cells, so a long value never hides it
 * completely; such a line is then longer than `width`. Joined with `GAP`,
 * a padded row gives one table line.
 */
export function padTable(rows: readonly SessionRow[], options: ColumnOptions & { width: number }): PaddedTable {
  const headers = columnHeaders(options);
  const labels = headers.map((header) => HEADER_LABELS[header]);
  const cells = rowCells(rows, options);
  const last = headers.length - 1;
  const widths = headers.map((header, column) =>
    Math.max(
      stringWidth(HEADER_LABELS[header] ?? "") + (header === "session" ? ICON_WIDTH : 0),
      ...cells.map((cell) => stringWidth(cell[column] ?? "")),
    ),
  );
  const prefix = widths.slice(0, -1).reduce((sum, width) => sum + width, 0) + GAP.length * last;
  const maxTitle = Math.max(MIN_TITLE, options.width - prefix);
  const pad = (cell: string[], isHeader: boolean): string[] =>
    cell.map((value, column) => {
      const header = headers[column] as ColumnHeader;
      if (column === last) {
        return stringWidth(value) > maxTitle
          ? cliTruncate(value, maxTitle, { position: "end", truncationCharacter: "" })
          : value;
      }
      // The `id` header starts after the icon, so that it lines up with the codes.
      const text = isHeader && header === "session" ? " ".repeat(ICON_WIDTH) + value : value;
      return padCell(text, widths[column] ?? 0, RIGHT_ALIGNED.has(header));
    });
  return { headers, header: pad(labels, true), rows: cells.map((cell) => pad(cell, false)) };
}
