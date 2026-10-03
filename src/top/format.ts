/** The text snapshot of `oc-sub top --once`: one padded table line per session. */
import type { PendingRequest } from "../requests";
import { formatRequest } from "../requests";
import { Chalk, type ForegroundColorName } from "chalk";
import { DEFAULT_WIDTH, GAP, padTable } from "./columns";
import type { SessionRow } from "./model";
import { STATE_COLORS } from "./view-model";

export { DEFAULT_WIDTH } from "./columns";

/** Basic ANSI colors. The caller decides with `color` whether the output gets them. */
const ansi = new Chalk({ level: 1 });

/** One row of the top table: a session row plus the pending requests of its session tree. */
export type TopTableRow = SessionRow & { pending: readonly PendingRequest[] };

/** The display options of the snapshot. */
export type TopTableOptions = {
  /** Show the project column. `top --all` sets it. Default: false. */
  showProject?: boolean;
  /** The shown project name of a run folder. Default: the computed folder name. */
  projectName?: (directory: string) => string;
  /** The line width that the title is cut to. Default: `DEFAULT_WIDTH`. */
  width?: number;
  /**
   * Color the `id` cell by the state, like the live view. Without color,
   * the table gets a `state` column instead. Default: false.
   */
  color?: boolean;
};

/**
 * The snapshot: one header line, one line per session, and one indented line
 * per pending request. The columns come from `src/top/columns.ts`: the
 * session CODE, the project (only with `showProject`), the worktree, and the
 * numbers. The fixed columns are padded to the widest value, and the title
 * is cut so that the line fits into `width`, but it keeps at least 24
 * characters.
 */
export function formatTopTable(
  rows: readonly TopTableRow[],
  nowMs: number,
  options: TopTableOptions = {},
): string[] {
  const color = options.color ?? false;
  const table = padTable(rows, {
    stateColumn: !color,
    showProject: options.showProject ?? false,
    projectName: options.projectName,
    width: options.width ?? DEFAULT_WIDTH,
  });
  const lines: string[] = [table.header.join(GAP).trimEnd()];
  rows.forEach((row, index) => {
    const cells = table.rows[index];
    if (cells === undefined) return;
    const [id = "", ...rest] = cells;
    const shownId = color ? ansi[STATE_COLORS[row.state] as ForegroundColorName](id) : id;
    lines.push([shownId, ...rest].join(GAP).trimEnd());
    for (const pending of row.pending) {
      lines.push(...formatRequest(pending).map((requestLine) => `  ${requestLine}`));
    }
  });
  return lines;
}
