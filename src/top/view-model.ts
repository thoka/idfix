/**
 * The pure logic of the live view of `oc-sub top` (step 8g): the selected
 * row, the visible part of the table, the lines of the detail pane, and the
 * footer. No Ink and no React here, so every rule has a unit test; the Ink
 * components of `src/top/view.tsx` only lay these lines out.
 */
import { formatRequest } from "../requests";
import { formatCost } from "../summary";
import { sessionCode } from "./columns";
import type { LiveServer } from "./live";
import { treePending } from "./load";
import type { SessionDetail, SessionRow, SessionRowState } from "./model";

/** The Ink color of each state. */
export const STATE_COLORS: Record<SessionRowState, string> = {
  waiting: "yellow",
  looping: "red",
  stalled: "red",
  reasoning: "magenta",
  retry: "yellow",
  busy: "green",
  idle: "gray",
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

/** The short line of one session: CODE, agent, state, and title. */
function sessionLine(detail: SessionRow): string {
  const agent = detail.agent.length > 0 ? detail.agent : "-";
  return `${sessionCode(detail.sessionId)}  ${agent}  ${detail.state}  ${detail.title}`;
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
 */
export function detailLines(detail: SessionDetail | undefined, maxLines: number): DetailLine[] {
  if (maxLines <= 0) return [];
  if (detail === undefined) return [{ text: "no session selected", tone: "dim" }];
  const fixed: DetailLine[] = [{ text: sessionLine(detail), tone: "head" }];
  const pending = treePending(detail);
  if (pending.length > 0) {
    fixed.push({ text: "pending:", tone: "section" });
    for (const request of pending) {
      for (const line of formatRequest(request)) fixed.push({ text: `  ${line}`, tone: "pending" });
    }
  }
  if (detail.children.length > 0) {
    fixed.push({ text: "subagents:", tone: "section" });
    fixed.push(...treeLines(detail.children, "  "));
  }
  if (fixed.length >= maxLines) return fixed.slice(0, maxLines);
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
  return `oc-sub attach ${sessionCode(sessionId)}`;
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

/** The key help of the footer. */
export const KEY_HELP = "j/k or arrows: move  o: attach command  a: all projects/this project  q: quit";

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
};

/**
 * The three footer lines: the servers with their state, the totals of the
 * shown sessions with the scope, and the key help or a message.
 */
export function footerLines(input: FooterInput): [string, string, string] {
  const servers = input.servers.length === 0 ? "no known server" : input.servers.map(serverLabel).join("  |  ");
  const cost = input.rows.reduce((sum, row) => sum + row.cost, 0);
  const count = input.rows.length === 1 ? "1 session" : `${input.rows.length} sessions`;
  const scope = input.all ? "all projects" : input.scopeLabel;
  return [`servers: ${servers}`, `${count}  cost ${formatCost(cost)}  scope: ${scope}`, input.message ?? KEY_HELP];
}
