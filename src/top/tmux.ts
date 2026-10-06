/**
 * The tmux pane opener of `idfx top`: the key `o` opens the attach of the
 * selected session in a new tmux pane when the view runs inside tmux. For
 * an interactive Claude Code session in tmux, it switches to its pane. The
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

/**
 * The argv of the tmux command that opens a background Claude Code session:
 * a split like `tmuxAttachArgv` that runs `claude attach <jobId>`. The job
 * ID is the short ID of `claude agents --json` (the folder name under
 * `~/.claude/jobs/`), which `claude attach <id>` takes.
 */
export function claudeAttachArgv(jobId: string, cwd: string, size: { columns: number; rows: number }): string[] {
  return ["tmux", "split-window", splitFlag(size.columns, size.rows), "-c", cwd, "claude", "attach", jobId];
}

/**
 * The pane of the `tmux` field of a Claude session file, which has the
 * form `<session>:@<window>.%<pane>` (for example `5:@5.%40` gives `%40`).
 * Undefined when the field is missing or has another form.
 */
export function tmuxPaneOf(field: string | undefined): string | undefined {
  const match = field === undefined ? null : /^[^:]+:@\d+\.(%\d+)$/.exec(field.trim());
  return match?.[1];
}

/**
 * The argv that moves the tmux client of `top` to `pane`. A pane target
 * also selects its window and its session.
 */
export function tmuxSwitchArgv(pane: string): string[] {
  return ["tmux", "switch-client", "-t", pane];
}

/** The result of the pane opener. */
export type PaneResult = { ok: true } | { ok: false; error: string };

/**
 * Run one tmux command and wait for it to end. It does not inherit the
 * stdin of the Ink view, and stderr is captured for the error text.
 */
export async function runTmux(argv: readonly string[], cwd: string): Promise<PaneResult> {
  const proc = Bun.spawn([...argv], {
    cwd,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (exitCode === 0) return { ok: true };
  const text = stderr.trim();
  return { ok: false, error: text.length > 0 ? text : `tmux ${argv[1] ?? ""} failed (exit ${exitCode})` };
}

/**
 * Open a tmux pane that attaches to `sessionId`, and wait for the tmux
 * command to end. tmux closes the pane by itself when attach ends.
 */
export function openAttachPane(
  cli: readonly string[],
  sessionId: string,
  cwd: string,
  size: { columns: number; rows: number },
): Promise<PaneResult> {
  return runTmux(tmuxAttachArgv(cli, sessionId, cwd, size), cwd);
}

/**
 * The default tmux runner of the view for Claude rows: it runs the argv in
 * the current folder when `$TMUX` is set, and otherwise reports nothing,
 * so that the footer falls back to a note.
 */
export function defaultRunTmux(argv: readonly string[]): Promise<PaneResult | undefined> {
  if (process.env.TMUX === undefined) return Promise.resolve(undefined);
  return runTmux(argv, process.cwd());
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
