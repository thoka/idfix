/**
 * The Claude Code sessions in `idfx top` (design
 * .plan/design/claude-sessions-top.md, sections 5 to 7). The rows come from
 * `src/claude/rows.ts`. This module only puts them next to the opencode
 * rows of the model of `src/top/model.ts`:
 *
 * - `scopeClaudeRows` applies the folder rule of `top` without `--all`.
 * - `claudeDetail` turns a Claude row into the `SessionDetail` of the
 *   detail pane. The subagents become its children, like the child sessions
 *   of an opencode run. A Claude detail has no log lines in this step.
 * - `sortTopRows` puts the active rows first and the inactive rows last,
 *   and inside each part the waiting rows first and the ended rows last.
 * - `withClaudeRows` wraps a `TopModel`, so that `rows` and `session` also
 *   cover the Claude rows. The opencode model stays as it is.
 */
import { inScope, type ClaudeRow } from "../claude/rows";
import { isActive, type SessionDetail, type SessionRow, type SessionRowState, type TopModel } from "./model";

/** The sort group of a state: waiting first, ended last, every other state between. */
export function stateRank(state: SessionRowState): number {
  if (state === "waiting") return 0;
  if (state === "ended") return 2;
  return 1;
}

/**
 * The order of the table: the active rows first, then the inactive rows
 * (only a job file or a transcript is left, no process). Inside each part,
 * the waiting rows come first and the ended rows last, and inside each
 * state group the newest start comes first (the order of the opencode
 * model). The start time keeps the order stable while the sessions work,
 * so the rows do not jump on every tick.
 */
export function sortTopRows<T extends SessionRow>(rows: T[]): T[] {
  const part = (row: SessionRow) => (isActive(row) ? 0 : 1);
  return rows.sort(
    (a, b) =>
      part(a) - part(b) ||
      stateRank(a.state) - stateRank(b.state) ||
      (b.startTimeMs ?? 0) - (a.startTimeMs ?? 0),
  );
}

/**
 * The Claude rows that `top` shows: all rows with `--all` (`scope`
 * undefined), else only the rows whose folder is inside one of the scope
 * directories (the project of `--dir` and its worktrees).
 */
export function scopeClaudeRows(rows: readonly ClaudeRow[], scope: readonly string[] | undefined): ClaudeRow[] {
  return scope === undefined ? [...rows] : rows.filter((row) => inScope(row.directory, scope));
}

/** The detail of a Claude row: the subagents as children, no log, and no opencode requests. */
export function claudeDetail(row: ClaudeRow): SessionDetail {
  return { ...row, log: [], pending: [], children: row.children.map(claudeDetail) };
}

/**
 * The model of `top` with the Claude rows: `rows` merges and sorts both
 * kinds, and `session` finds a Claude row when the opencode model does not
 * know the ID. `claudeRows` gives the current Claude rows, already in
 * scope. All other methods are the ones of the opencode model.
 */
export function withClaudeRows(model: TopModel, claudeRows: () => readonly ClaudeRow[]): TopModel {
  return {
    ...model,
    rows(nowMs) {
      return sortTopRows([...model.rows(nowMs), ...claudeRows()]);
    },
    session(id) {
      const detail = model.session(id);
      if (detail !== undefined) return detail;
      const row = claudeRows().find((entry) => entry.sessionId === id);
      return row === undefined ? undefined : claudeDetail(row);
    },
  };
}
