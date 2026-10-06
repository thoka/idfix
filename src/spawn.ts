/**
 * The detached spawn of a long-lived process, without a systemd unit. It is
 * the fallback path of `startUnit` in `units.ts`, for a host without a user
 * manager. It lives in its own module, so that `units.ts` and `sandbox.ts`
 * import it without an import cycle.
 */
import { closeSync, openSync, writeFileSync } from "node:fs";
import type { Env } from "./config";

/** A detached holder process, like `up` starts its server. */
export type ServeProcess = {
  pid: number;
  /** The exit code, or null while the process still runs. */
  exitCode: () => number | null;
};

/**
 * Spawn a detached process with its output in a log file and a PID file.
 * `detached: true` makes bun call `setsid`, so the process leads a new
 * session and process group, and its PID is the group ID. A caller stops it
 * and all its children with `process.kill(-pid, signal)`. The process works
 * in `cwd`, default the current folder. With `env`, the process gets exactly
 * that environment; without it, it inherits the environment of this process.
 */
export function spawnDetached(
  cmd: readonly string[],
  logPath: string,
  pidPath: string,
  cwd: string = process.cwd(),
  env?: Env,
): ServeProcess {
  // The process keeps running after this one exits, so its output goes to
  // a file: fd numbers are inherited by the child and closed here again.
  // The file opens in append mode, so the proxy `end` lines of older runs
  // stay in the log and `idfx log` of an older run keeps the real cost.
  const logFd = openSync(logPath, "a");
  let proc: Bun.Subprocess;
  try {
    proc = Bun.spawn({
      cmd: [...cmd],
      cwd,
      ...(env === undefined ? {} : { env: { ...env } }),
      stdin: "ignore",
      stdout: logFd,
      stderr: logFd,
      detached: true,
    });
  } finally {
    closeSync(logFd);
  }
  proc.unref();
  writeFileSync(pidPath, `${proc.pid}\n`);
  return { pid: proc.pid, exitCode: () => proc.exitCode };
}
