/**
 * The entry of the live view of `oc-sub top`: it renders `TopView` in the
 * alternate screen of the terminal and waits until the user quits. `top` in
 * `src/top/load.ts` imports this module only when the view runs, so that
 * `top --once` does not load Ink and React.
 */
import path from "node:path";
import { homedir } from "node:os";
import { render } from "ink";
import React from "react";
import type { Env } from "../config";
import type { StatusDeps } from "../status";
import { startLive } from "./live";
import type { TopArgs } from "./load";
import { TopView } from "./view";

/** A folder with the home directory shown as `~`. */
export function tildeFolder(folder: string, home: string): string {
  if (home.length > 0 && (folder === home || folder.startsWith(`${home}/`))) return `~${folder.slice(home.length)}`;
  return folder;
}

/**
 * Whether an unhandled rejection is the abort of an event stream. The SSE
 * client of `@opencode-ai/sdk` 1.18.32 calls `void reader.cancel()` when the
 * signal aborts. Under bun, the same signal has already errored the fetch
 * body, so `cancel()` rejects with an `AbortError` that no code can catch.
 * `live.stop()` aborts the streams on every scope switch (`a`) and on quit.
 */
export function isStreamAbort(reason: unknown): boolean {
  return reason instanceof Error ? reason.name === "AbortError" : (reason as { name?: unknown } | null)?.name === "AbortError";
}

/** Run the full-screen view until `q` or Ctrl-C; the terminal is restored on exit. */
export async function runTopView(args: TopArgs, env: Env, deps: StatusDeps): Promise<number> {
  // Only the stream aborts are ignored; any other rejection is printed.
  const onRejection = (reason: unknown) => {
    if (!isStreamAbort(reason)) console.error(reason);
  };
  process.on("unhandledRejection", onRejection);
  const directory = path.resolve(args.dir ?? process.cwd());
  // The key `a` switches the scope; without --all, the scope is the folder
  // of --dir (default: the current folder) and its worktrees.
  const start = (all: boolean) => startLive({ url: args.url, dir: all ? undefined : directory, all }, env, deps);
  const instance = render(
    <TopView start={start} initialAll={args.all} scopeLabel={tildeFolder(directory, homedir())} />,
    { alternateScreen: true },
  );
  try {
    await instance.waitUntilExit();
  } finally {
    process.off("unhandledRejection", onRejection);
  }
  return 0;
}
