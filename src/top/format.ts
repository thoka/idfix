/** The text snapshot of `oc-sub top --once`: one padded table line per session. */
import type { PendingRequest } from "../requests";
import { formatRequest } from "../requests";
import { Chalk, type ForegroundColorName } from "chalk";
import { DEFAULT_WIDTH, GAP, padTable } from "./columns";
import type { SessionRow } from "./model";
import { STATE_COLORS, waitingLine } from "./view-model";

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
 * per pending request, or one indented `waiting for:` line for a waiting
 * Claude session. The columns come from `src/top/columns.ts`: the
 * session CODE, the project (only with `showProject`), the worktree, and the
 * numbers. The fixed columns are padded to the widest value, and the title
 * is cut so that the line fits into `width`, but it keeps at least 24
 * characters.
 *
 * With `color`, the `id` cell has the color of the state, an ended row is
 * gray as a whole, and the API price of a Claude session is gray. Without
 * color, the table has a `state` column, and an API price has a `~` in
 * front.
 */
export function formatTopTable(
  rows: readonly TopTableRow[],
  nowMs: number,
  options: TopTableOptions = {},
): string[] {
  const color = options.color ?? false;
  const table = padTable(rows, {
    stateColumn: !color,
    costMarker: !color,
    showProject: options.showProject ?? false,
    projectName: options.projectName,
    width: options.width ?? DEFAULT_WIDTH,
  });
  const costColumn = table.headers.indexOf("cost");
  const lines: string[] = [table.header.join(GAP).trimEnd()];
  rows.forEach((row, index) => {
    const cells = table.rows[index];
    if (cells === undefined) return;
    if (!color) {
      lines.push(cells.join(GAP).trimEnd());
    } else if (row.state === "ended") {
      lines.push(ansi.gray(cells.join(GAP).trimEnd()));
    } else {
      const shown = cells.map((cell, column) => {
        if (column === 0) return ansi[STATE_COLORS[row.state] as ForegroundColorName](cell);
        if (column === costColumn && row.costKind === "apiEquivalent") return ansi.gray(cell);
        return cell;
      });
      lines.push(shown.join(GAP).trimEnd());
    }
    for (const pending of row.pending) {
      lines.push(...formatRequest(pending).map((requestLine) => `  ${requestLine}`));
    }
    if (row.waitingFor !== undefined) lines.push(`  ${waitingLine(row.waitingFor)}`);
  });
  return lines;
}
