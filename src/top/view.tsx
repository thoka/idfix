/**
 * The Ink view of `oc-sub top`: a full-screen live table of the
 * sessions, a detail pane for the selected session, and a footer. The view
 * is thin: the data comes from `startLive` (`src/top/live.ts`), and the
 * rules (selection, detail lines, footer text) come from the pure functions
 * of `src/top/view-model.ts`.
 *
 * It redraws after each change of the live model and at least once per
 * second, so that the times age. The first version only shows: no key
 * answers, aborts, or sends a message.
 *
 * Keys: `j`/`k` and the arrow keys move the selection, `o` opens the
 * selected session: an attach in a new tmux pane or a switch to its tmux
 * pane (without tmux it shows a note), `a` switches between the scope of `--dir`
 * and `--all`, and `q` or Ctrl-C quit.
 *
 * Claude Code sessions show in the same table. An ended row is
 * gray, and the API price of a Claude session is gray, because it is not a
 * real charge. The key `o` on a Claude row opens a background
 * session with `claude attach` in a new tmux pane, or switches the tmux
 * client to the pane of an interactive session. Otherwise the footer says
 * why nothing opens.
 */
import { Box, Text, useApp, useInput, useWindowSize } from "ink";
import React, { useEffect, useRef, useState } from "react";
import { makeProjectNameResolver } from "../project-config";
import { GAP, padTable } from "./columns";
import type { LiveHandle } from "./live";
import type { SessionRow } from "./model";
import { defaultOpenPane, defaultRunTmux, type PaneResult } from "./tmux";
import {
  attachCommand,
  claudeOpenAction,
  claudeRowFor,
  detailLines,
  firstVisibleRow,
  footerLines,
  moveSelection,
  resolveSelection,
  screenLayout,
  STATE_COLORS,
  type DetailTone,
  type Selection,
} from "./view-model";
import { sessionCode } from "./columns";

/** The part of the live handle that the view uses, so that the tests can pass a fake. */
export type ViewSource = Pick<LiveHandle, "onChange" | "servers" | "stop"> & {
  model: Pick<LiveHandle["model"], "rows" | "session">;
};

export type TopViewProps = {
  /** Start the live data for one scope: all projects, or the scope of `--dir`. */
  start: (all: boolean) => Promise<ViewSource>;
  /** The scope at the start: true for `--all`. */
  initialAll: boolean;
  /** The folder that the footer names without `--all`. */
  scopeLabel: string;
  /** The clock. Default: `Date.now`. */
  nowMs?: () => number;
  /** How often the view redraws without a change. Default: 1000 ms. */
  redrawMs?: number;
  /**
   * Open the attach of a session in a new tmux pane. It gets the size of
   * the pane of `top`, which sets the split direction. Default: tmux when
   * `$TMUX` is set, otherwise nothing (the footer shows the command).
   */
  openPane?: (
    sessionId: string,
    size: { columns: number; rows: number },
  ) => Promise<PaneResult | undefined>;
  /**
   * Run one tmux command for the key `o` on a Claude session: the attach
   * pane of a background session, or the switch to the pane of an
   * interactive one. Default: tmux when `$TMUX` is set, otherwise nothing
   * (the footer shows a note).
   */
  runTmux?: (argv: string[]) => Promise<PaneResult | undefined>;
};

const TONE_COLORS: Record<DetailTone, string | undefined> = {
  head: undefined,
  section: "cyan",
  pending: "yellow",
  tree: undefined,
  log: undefined,
  error: "red",
  dim: "gray",
};

/**
 * One table row: the padded cells, with the `id` cell in the color of the
 * state. An ended row is gray as a whole. The cell at `grayColumn` (the
 * API price of a Claude session) is gray.
 */
function TableRow(props: { cells: string[]; state: SessionRow["state"]; selected: boolean; grayColumn?: number }) {
  if (props.state === "ended") {
    return (
      <Text wrap="truncate" inverse={props.selected} color="gray">
        {props.cells.join(GAP)}
      </Text>
    );
  }
  const [id = "", ...rest] = props.cells;
  return (
    <Text wrap="truncate" inverse={props.selected}>
      <Text color={STATE_COLORS[props.state]}>{id}</Text>
      {rest.map((cell, index) => (
        <React.Fragment key={index}>
          {GAP}
          {index + 1 === props.grayColumn ? <Text color="gray">{cell}</Text> : cell}
        </React.Fragment>
      ))}
    </Text>
  );
}

/** The shown project names, with the configured `shortName` when set. */
const projectName = makeProjectNameResolver();

export function TopView(props: TopViewProps) {
  const nowMs = props.nowMs ?? Date.now;
  const redrawMs = props.redrawMs ?? 1000;
  const openPane = props.openPane ?? defaultOpenPane;
  const runTmux = props.runTmux ?? defaultRunTmux;
  const { exit } = useApp();
  const { columns, rows: height } = useWindowSize();
  const [all, setAll] = useState(props.initialAll);
  const [source, setSource] = useState<ViewSource | undefined>(undefined);
  const [, setVersion] = useState(0);
  const [selection, setSelection] = useState<Selection>({ id: undefined, index: 0 });
  const [message, setMessage] = useState<string | undefined>(undefined);
  // The key handler reads the rows and the selection of the last frame.
  const rowsRef = useRef<SessionRow[]>([]);
  const selectedRef = useRef<string | undefined>(undefined);

  // Start the live data for the scope, and stop it when the scope changes
  // or the view ends.
  useEffect(() => {
    let active = true;
    let current: ViewSource | undefined;
    setSource(undefined);
    void props.start(all).then((started) => {
      if (!active) {
        started.stop();
        return;
      }
      current = started;
      started.onChange(() => {
        if (active) setVersion((version) => version + 1);
      });
      setSource(started);
    });
    return () => {
      active = false;
      current?.stop();
    };
  }, [all]);

  // Redraw once per second, so that the elapsed and last times age.
  useEffect(() => {
    const timer = setInterval(() => setVersion((version) => version + 1), redrawMs);
    return () => clearInterval(timer);
  }, [redrawMs]);

  const now = nowMs();
  const rows = source === undefined ? [] : source.model.rows(now);
  rowsRef.current = rows;
  const selected = resolveSelection(rows, selection);
  selectedRef.current = selected.id;

  useInput((input, key) => {
    const current = rowsRef.current;
    if (input === "q") {
      exit();
      return;
    }
    if (input === "j" || key.downArrow) {
      setSelection((old) => moveSelection(current, old, 1));
      setMessage(undefined);
    } else if (input === "k" || key.upArrow) {
      setSelection((old) => moveSelection(current, old, -1));
      setMessage(undefined);
    } else if (input === "o") {
      const id = selectedRef.current;
      if (id === undefined) {
        setMessage("no session selected");
        return;
      }
      const claude = claudeRowFor(current, id);
      if (claude !== undefined) {
        const action = claudeOpenAction(claude, process.cwd(), { columns, rows: height });
        if (action.kind === "note") {
          setMessage(action.text);
          return;
        }
        void runTmux(action.argv).then((result) => {
          if (result === undefined) setMessage(action.outside);
          else if (result.ok) setMessage(action.opened);
          else setMessage(`tmux error: ${result.error}  ${action.fallback}`);
        });
        return;
      }
      // The footer shows the result; the view stays usable while the pane
      // opens.
      void openPane(id, { columns, rows: height }).then((result) => {
        if (result === undefined) {
          setMessage(`attach with: ${attachCommand(id)}`);
        } else if (result.ok) {
          setMessage(`attached ${sessionCode(id)} in a new tmux pane`);
        } else {
          setMessage(`tmux error: ${result.error}  attach with: ${attachCommand(id)}`);
        }
      });
    } else if (input === "a") {
      setAll((old) => !old);
      setMessage(undefined);
    }
  });

  const layout = screenLayout(height);
  const width = Math.max(20, columns);
  const table = padTable(rows, { showProject: all, projectName, width });
  const costColumn = table.headers.indexOf("cost");
  const first = firstVisibleRow(rows.length, selected.index, layout.tableRows);
  const visible = rows.slice(first, first + layout.tableRows);
  const detail = selected.id === undefined || source === undefined ? undefined : source.model.session(selected.id);
  const lines = detailLines(detail, layout.detailLines);
  const footer = footerLines({
    servers: source?.servers() ?? [],
    rows,
    all,
    scopeLabel: props.scopeLabel,
    message,
  });

  return (
    <Box flexDirection="column" width={width}>
      <Text wrap="truncate" bold>
        {table.header.join(GAP)}
      </Text>
      <Box flexDirection="column" height={layout.tableRows}>
        {source === undefined ? (
          <Text color="gray">loading the servers ...</Text>
        ) : rows.length === 0 ? (
          <Text color="gray">no sessions</Text>
        ) : (
          visible.map((row, offset) => (
            <TableRow
              key={row.sessionId}
              cells={table.rows[first + offset] ?? []}
              state={row.state}
              selected={first + offset === selected.index}
              grayColumn={row.costKind === "apiEquivalent" ? costColumn : undefined}
            />
          ))
        )}
      </Box>
      <Text color="gray" wrap="truncate">
        {"─".repeat(width)}
      </Text>
      <Box flexDirection="column" height={layout.detailLines}>
        {lines.map((line, index) => (
          <Text key={index} wrap="truncate" color={TONE_COLORS[line.tone]} bold={line.tone === "head"}>
            {line.text}
          </Text>
        ))}
      </Box>
      <Text wrap="truncate" color="gray">
        {footer[0]}
      </Text>
      <Text wrap="truncate">{footer[1]}</Text>
      <Text wrap="truncate" color={message === undefined ? "gray" : "cyan"}>
        {footer[2]}
      </Text>
    </Box>
  );
}
