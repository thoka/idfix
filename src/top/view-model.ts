/**
 * The pure logic of the live view of `idfx top`: the selected
 * row, the visible part of the table, the lines of the detail pane, and the
 * footer. No Ink and no React here, so every rule has a unit test; the Ink
 * components of `src/top/view.tsx` only lay these lines out.
 *
 * A Claude Code session has its own detail: the kind and the
 * model, what it waits for, and its subagents. It has no log lines yet.
 * Its API price does not count in the cost total of the footer, because it
 * is not a real charge. The footer names it on its own. The key `o` on a
 * Claude session attaches or switches to it in tmux.
 */
import type { ClaudeRow } from "../claude/rows";
import { formatRequest } from "../requests";
import { formatCost } from "../summary";
import { hasInactiveMark, sessionCode, stateText } from "./columns";
import type { LiveServer } from "./live";
import { treePending } from "./load";
import { isActive, type SessionDetail, type SessionRow, type SessionRowState } from "./model";
import { claudeAttachArgv, tmuxPaneOf, tmuxSwitchArgv } from "./tmux";

/** The Ink color of each state. */
export const STATE_COLORS: Record<SessionRowState, string> = {
  waiting: "yellow",
  looping: "red",
  stalled: "red",
  reasoning: "magenta",
  retry: "yellow",
  busy: "green",
  idle: "gray",
  ended: "gray",
};

/** The selected row: its session ID, and its index for when the session disappears. */
export type Selection = { id: string | undefined; index: number };

/**
 * The selection for the current rows. It stays on the same session when the
 * rows change order. When that session is gone, the row at the same index
 * (or the last row) takes over. Without rows, nothing is selected.
 */
export function resolveSelection(rows: readonly SessionRow[], selection: Selection): Selection {
  if (rows.length === 0) return { id: undefined, index: 0 };
  const found = selection.id === undefined ? -1 : rows.findIndex((row) => row.sessionId === selection.id);
  if (found >= 0) return { id: selection.id, index: found };
  const index = Math.min(Math.max(0, selection.index), rows.length - 1);
  return { id: rows[index]?.sessionId, index };
}

/** Move the selection by `delta` rows, and stop at the first and the last row. */
export function moveSelection(rows: readonly SessionRow[], selection: Selection, delta: number): Selection {
  const current = resolveSelection(rows, selection);
  if (rows.length === 0) return current;
  const index = Math.min(Math.max(0, current.index + delta), rows.length - 1);
  return { id: rows[index]?.sessionId, index };
}

/**
 * The rows that the table shows: all rows, or with `hideInactive` only the
 * rows with a process (see `isActive`).
 */
export function visibleRows<T extends SessionRow>(rows: readonly T[], hideInactive: boolean): T[] {
  return hideInactive ? rows.filter((row) => isActive(row)) : [...rows];
}

/**
 * The selection after the key `h` hides or shows the inactive rows. It
 * stays on the same session when that row is still visible. A hidden
 * session gives its place to the nearest visible row: the inactive rows
 * come last, so that is the last active row. The new selection is stored,
 * so that the next `h` does not jump back to the hidden session.
 */
export function selectionAfterHide(rows: readonly SessionRow[], selection: Selection, hideInactive: boolean): Selection {
  return resolveSelection(visibleRows(rows, hideInactive), selection);
}

/**
 * The first visible row of a table with `count` rows in `height` lines, so
 * that the selected row is visible and stays near the middle.
 */
export function firstVisibleRow(count: number, selected: number, height: number): number {
  if (height <= 0 || count <= height) return 0;
  const start = selected - Math.floor(height / 2);
  return Math.min(Math.max(0, start), count - height);
}

/** The heights of the parts of the screen. */
export type ScreenLayout = { tableRows: number; detailLines: number; footerLines: number };

/** The lines of the footer: servers, totals, and the key help or a message. */
export const FOOTER_LINES = 3;

/**
 * Split the screen height into the table, the detail pane, and the footer.
 * One line stays empty at the bottom, because Ink clears the whole screen
 * on every frame when the output fills the terminal. The table has one
 * header line and the detail pane one separator line on top of their share.
 */
export function screenLayout(height: number): ScreenLayout {
  const usable = Math.max(0, height - 1 - FOOTER_LINES - 2);
  const detailLines = Math.max(3, Math.floor(usable * 0.45));
  const tableRows = Math.max(1, usable - detailLines);
  return { tableRows, detailLines, footerLines: FOOTER_LINES };
}

/** The kind of a detail line, which gives its color. */
export type DetailTone = "head" | "section" | "pending" | "tree" | "log" | "error" | "dim";

/** One line of the detail pane. */
export type DetailLine = { text: string; tone: DetailTone };

/**
 * The short line of one session: CODE, agent, state, and title. An
 * inactive state has its mark, for example `waiting·`.
 */
function sessionLine(detail: SessionRow): string {
  const agent = detail.agent.length > 0 ? detail.agent : "-";
  return `${sessionCode(detail.sessionId)}  ${agent}  ${stateText(detail)}  ${detail.title}`;
}

/** The head line of the detail pane: the session line, and `no process` for an inactive session. */
function headLine(detail: SessionRow): string {
  return hasInactiveMark(detail) ? `${sessionLine(detail)}  (no process)` : sessionLine(detail);
}

/** The pending line of a waiting Claude session, on one line. */
export function waitingLine(text: string): string {
  return `waiting for: ${text.replace(/\s+/g, " ").trim()}`;
}

/** The second head line of a Claude session: the kind and the model. */
function claudeInfoLine(detail: SessionRow): string {
  return `claude ${detail.kind ?? "session"}  model ${detail.model ?? "-"}`;
}

/** The subagent sessions as a tree, one line per session. */
function treeLines(children: readonly SessionDetail[], indent: string): DetailLine[] {
  const lines: DetailLine[] = [];
  children.forEach((child, index) => {
    const last = index === children.length - 1;
    lines.push({ text: `${indent}${last ? "└─" : "├─"} ${sessionLine(child)}`, tone: "tree" });
    lines.push(...treeLines(child.children, `${indent}${last ? "   " : "│  "}`));
  });
  return lines;
}

/**
 * The lines of the detail pane for the selected session, at most `maxLines`.
 * The order: one head line, the pending requests of the session tree, the
 * subagent sessions as a tree, and the last events as a short log. When the
 * space runs out, the log keeps its newest lines, and the other parts are
 * cut at the end.
 *
 * A Claude session has a second head line with its kind and its model, the
 * `waitingFor` text as its pending line, and no log.
 */
export function detailLines(detail: SessionDetail | undefined, maxLines: number): DetailLine[] {
  if (maxLines <= 0) return [];
  if (detail === undefined) return [{ text: "no session selected", tone: "dim" }];
  const claude = detail.driver === "claude";
  const fixed: DetailLine[] = [{ text: headLine(detail), tone: "head" }];
  if (claude) fixed.push({ text: claudeInfoLine(detail), tone: "dim" });
  const pending = treePending(detail);
  if (pending.length > 0 || detail.waitingFor !== undefined) {
    fixed.push({ text: "pending:", tone: "section" });
    for (const request of pending) {
      for (const line of formatRequest(request)) fixed.push({ text: `  ${line}`, tone: "pending" });
    }
    if (detail.waitingFor !== undefined) fixed.push({ text: `  ${waitingLine(detail.waitingFor)}`, tone: "pending" });
  }
  if (detail.children.length > 0) {
    fixed.push({ text: "subagents:", tone: "section" });
    fixed.push(...treeLines(detail.children, "  "));
  }
  if (fixed.length >= maxLines || claude) return fixed.slice(0, maxLines);
  const room = maxLines - fixed.length - 1;
  if (room <= 0) return fixed;
  const log: DetailLine[] =
    detail.log.length === 0
      ? [{ text: "  no events yet", tone: "dim" }]
      : detail.log.slice(-room).map((line) => ({
          text: `  ${line.line}`,
          tone: line.kind === "error" || line.kind === "tool-failed" ? "error" : "log",
        }));
  return [...fixed, { text: "log:", tone: "section" }, ...log];
}

/** The attach command of a session, as `o` shows it. */
export function attachCommand(sessionId: string): string {
  return `idfx attach ${sessionCode(sessionId)}`;
}

/**
 * What the key `o` does on a Claude session: run a tmux
 * command, or only show a note in the footer. A `run` action carries the
 * footer text for each result: `opened` when tmux succeeds, `outside` when
 * `top` runs outside tmux, and `fallback`, which follows a tmux error.
 */
export type ClaudeOpenAction =
  | { kind: "run"; argv: string[]; opened: string; outside: string; fallback: string }
  | { kind: "note"; text: string };

/**
 * The Claude row of `id` among `rows`. A subagent ID gives its parent
 * session, because a subagent has no terminal of its own.
 */
export function claudeRowFor(rows: readonly SessionRow[], id: string): ClaudeRow | undefined {
  for (const row of rows) {
    if (row.driver !== "claude") continue;
    const claude = row as ClaudeRow;
    if (claude.sessionId === id || (claude.children ?? []).some((child) => child.sessionId === id)) return claude;
  }
  return undefined;
}

/**
 * The action of `o` on a Claude row. A background session with a job ID
 * opens a new tmux pane with `claude attach <jobId>`. An interactive
 * session with a tmux pane switches the tmux client of `top` to that pane.
 * Otherwise the footer says why nothing opens: the session ended, it has
 * no job ID, or it has no tmux pane.
 */
export function claudeOpenAction(
  row: ClaudeRow,
  cwd: string,
  size: { columns: number; rows: number },
): ClaudeOpenAction {
  if (row.state === "ended") return { kind: "note", text: "open: session ended" };
  if (row.kind === "background") {
    if (row.jobId === undefined) return { kind: "note", text: "open: no job id for this background session" };
    const command = `claude attach ${row.jobId}`;
    return {
      kind: "run",
      argv: claudeAttachArgv(row.jobId, cwd, size),
      opened: `attached ${sessionCode(row.sessionId)} in a new tmux pane`,
      outside: `attach with: ${command}`,
      fallback: `attach with: ${command}`,
    };
  }
  const pane = tmuxPaneOf(row.tmux);
  if (pane === undefined) return { kind: "note", text: "open: no tmux pane" };
  return {
    kind: "run",
    argv: tmuxSwitchArgv(pane),
    opened: `switched to tmux pane ${pane}`,
    outside: `open: top runs outside tmux; the session is in tmux pane ${row.tmux}`,
    fallback: `the session is in tmux pane ${row.tmux}`,
  };
}

/** One server as the footer names it: the project (or `host`), the port, and the state. */
export function serverLabel(server: LiveServer): string {
  const name = server.project ?? "host";
  let address = server.url;
  try {
    address = new URL(server.url).port || server.url;
  } catch {
    // An unusual URL shows as it is.
  }
  return `${name} :${address} ${server.state}`;
}

/**
 * The key help of the footer. `hiddenInactive` is the number of hidden
 * inactive rows when the key `h` hides them, else undefined.
 */
export function keyHelp(hiddenInactive?: number): string {
  const toggle = hiddenInactive === undefined ? "h: hide inactive" : `h: show ${hiddenInactive} inactive`;
  return `j/k or arrows: move  o: open  ${toggle}  a: all projects/this project  q: quit`;
}

/** The key help of the footer while the inactive rows show (the default). */
export const KEY_HELP = keyHelp();

/** The input of the footer. */
export type FooterInput = {
  servers: readonly LiveServer[];
  rows: readonly SessionRow[];
  /** Whether the view shows all projects. */
  all: boolean;
  /** The scope folder without --all. */
  scopeLabel: string;
  /** A message that replaces the key help, for example the attach command. */
  message?: string;
  /** The number of hidden inactive rows when the key `h` hides them, else undefined. */
  hiddenInactive?: number;
};

/**
 * The three footer lines: the servers with their state, the totals of the
 * shown sessions with the scope, and the key help or a message. The cost
 * total counts only real charges. The API price of the Claude sessions
 * shows on its own as `api ~$x`, when one is known.
 */
export function footerLines(input: FooterInput): [string, string, string] {
  const servers = input.servers.length === 0 ? "no known server" : input.servers.map(serverLabel).join("  |  ");
  const sumOf = (kind: SessionRow["costKind"]) =>
    input.rows.reduce((sum, row) => sum + (row.costKind === kind ? row.cost : 0), 0);
  const cost = sumOf("real");
  const api = input.rows.some((row) => row.costKind === "apiEquivalent") ? `  api ~${formatCost(sumOf("apiEquivalent"))}` : "";
  const count = input.rows.length === 1 ? "1 session" : `${input.rows.length} sessions`;
  const scope = input.all ? "all projects" : input.scopeLabel;
  return [`servers: ${servers}`, `${count}  cost ${formatCost(cost)}${api}  scope: ${scope}`, input.message ?? keyHelp(input.hiddenInactive)];
}
