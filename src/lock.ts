/**
 * The server lock: one lock per server port, `serve-<port>.lock` in the
 * state folder. `idfx run` holds it from its health check until the
 * prompt of the new session is sent. The idle watchdog holds it from its
 * final check through the stop. So the watchdog never stops a server while
 * a run starts a session on it, and two runs do not start the same sandbox
 * server twice.
 *
 * The lock is `proper-lockfile`: an atomic `mkdir` of the lock path, with an
 * mtime that the holder refreshes. A lock whose mtime is older than
 * `STALE_MS` belongs to a dead process, and the next caller takes it over.
 */
import { mkdirSync } from "node:fs";
import lockfile from "proper-lockfile";
import type { Env } from "./config";
import { serveLockPath, stateDir } from "./state";

/** A held lock. The call releases it; a second call does nothing. */
export type Release = () => Promise<void>;

/** Takes a lock on a path, or throws when another holder keeps it. */
export type AcquireLock = (lockPath: string, options: LockOptions) => Promise<Release>;

/** How long a caller waits for a held lock. */
export type LockOptions = { retries: number; minTimeoutMs: number; maxTimeoutMs: number };

/** After this time without a refresh, a lock counts as stale. */
export const STALE_MS = 10_000;

/**
 * The wait of `run` for a held lock: up to about one minute, because the
 * other holder can be a run that starts a sandbox server.
 */
export const RUN_LOCK_WAIT: LockOptions = { retries: 30, minTimeoutMs: 200, maxTimeoutMs: 2_000 };

/** The wait of the watchdog: none. A held lock means a run starts now. */
export const NO_WAIT: LockOptions = { retries: 0, minTimeoutMs: 0, maxTimeoutMs: 0 };

/** The real lock of `proper-lockfile`. */
export const acquireLock: AcquireLock = async (lockPath, options) => {
  const release = await lockfile.lock(lockPath, {
    lockfilePath: lockPath,
    // The lock path itself does not need to exist: it is created as the lock.
    realpath: false,
    stale: STALE_MS,
    retries: {
      retries: options.retries,
      minTimeout: options.minTimeoutMs,
      maxTimeout: options.maxTimeoutMs,
      factor: 1.5,
    },
    // The default throws inside a timer and ends the process. A lost lock
    // only weakens the guard, so a warning is enough.
    onCompromised: (error) => console.error(`warning: the lock ${lockPath} was lost: ${error.message}`),
  });
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await release().catch(() => undefined);
  };
};

/** Takes the lock of the server on `port`, with the state folder created first. */
export async function lockServer(
  env: Env,
  port: number,
  options: LockOptions,
  acquire: AcquireLock = acquireLock,
): Promise<Release> {
  mkdirSync(stateDir(env), { recursive: true });
  return acquire(serveLockPath(env, port), options);
}

/** Like `lockServer`, but null instead of an error when another holder keeps the lock. */
export async function tryLockServer(
  env: Env,
  port: number,
  acquire: AcquireLock = acquireLock,
): Promise<Release | null> {
  try {
    return await lockServer(env, port, NO_WAIT, acquire);
  } catch {
    return null;
  }
}
