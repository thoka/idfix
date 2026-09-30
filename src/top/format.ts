/** The text snapshot of `oc-sub top --once`: one padded table line per session. */
import type { PendingRequest } from "../requests";
import { formatRequest } from "../requests";
import { DEFAULT_WIDTH, GAP, padTable } from "./columns";
import type { SessionRow } from "./model";

export { DEFAULT_WIDTH } from "./columns";

/** One row of the top table: a session row plus the pending requests of its session tree. */
export type TopTableRow = SessionRow & { pending: readonly PendingRequest[] };

/** The display options of the snapshot. */
export type TopTableOptions = {
  /** Show the project column. `top --all` sets it. Default: false. */
  showProject?: boolean;
  /** The line width that the title is cut to. Default: `DEFAULT_WIDTH`. */
  width?: number;
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
  const table = padTable(rows, { showProject: options.showProject ?? false, width: options.width ?? DEFAULT_WIDTH });
  const lines: string[] = [table.header.join(GAP).trimEnd()];
  rows.forEach((row, index) => {
    const cells = table.rows[index];
    if (cells === undefined) return;
    lines.push(cells.join(GAP).trimEnd());
    for (const pending of row.pending) {
      lines.push(...formatRequest(pending).map((requestLine) => `  ${requestLine}`));
    }
  });
  return lines;
}
