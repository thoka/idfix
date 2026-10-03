/**
 * The tmux pane opener of `oc-sub top`: the key `o` opens the attach of the
 * selected session in a new tmux pane when the view runs inside tmux. The
 * argv builders and the split flag are pure, so they have unit tests; the
 * opener runs the argv with `Bun.spawn` and reports the result, so the
 * view can show it in the footer.
 */

/**
 * The split direction from the aspect ratio of the pane of `top`, in
 * terminal cells. A cell is about twice as high as it is wide, so a pane
 * with `columns > 2 * rows` is wide and the new pane sits side by side
 * (`-h`); otherwise it sits below (`-v`).
 */
export function splitFlag(columns: number, rows: number): "-h" | "-v" {
  return columns > 2 * rows ? "-h" : "-v";
}

/**
 * The argv of the tmux command that opens the attach pane: a split in
 * `cwd` with the direction from the pane size, which runs the same CLI
 * that runs `top` (for example bun and the path of `src/cli.ts`), then
 * `attach` and the full session ID.
 */
export function tmuxAttachArgv(
  cli: readonly string[],
  sessionId: string,
  cwd: string,
  size: { columns: number; rows: number },
): string[] {
  return ["tmux", "split-window", splitFlag(size.columns, size.rows), "-c", cwd, ...cli, "attach", sessionId];
}

/** The result of the pane opener. */
export type PaneResult = { ok: true } | { ok: false; error: string };

/**
 * Open a tmux pane that attaches to `sessionId`, and wait for the tmux
 * command to end. tmux closes the pane by itself when attach ends. The
 * pane does not inherit the stdin of the Ink view, and stderr is captured
 * for the error text.
 */
export async function openAttachPane(
  cli: readonly string[],
  sessionId: string,
  cwd: string,
  size: { columns: number; rows: number },
): Promise<PaneResult> {
  const argv = tmuxAttachArgv(cli, sessionId, cwd, size);
  const proc = Bun.spawn(argv, {
    cwd,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (exitCode === 0) return { ok: true };
  const text = stderr.trim();
  return { ok: false, error: text.length > 0 ? text : `tmux split-window failed (exit ${exitCode})` };
}

/**
 * The default pane opener of the view: it opens a tmux pane when `$TMUX`
 * is set, and otherwise reports nothing, so that the footer falls back to
 * the attach command. It starts the same CLI that runs `top`
 * (`process.argv[0]` and `process.argv[1]`) in the current folder.
 */
export function defaultOpenPane(
  sessionId: string,
  size: { columns: number; rows: number },
): Promise<PaneResult | undefined> {
  if (process.env.TMUX === undefined) return Promise.resolve(undefined);
  const cli = [process.argv[0] ?? "bun", process.argv[1] ?? "src/cli.ts"];
  return openAttachPane(cli, sessionId, process.cwd(), size);
}
