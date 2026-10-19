/**
 * The cross-process port reservation of the integration tests.
 *
 * `idfx up --port N` binds the port N for the server and the port N + 1 for
 * the cost proxy. Two test runs can run at the same time, for example two
 * jobs of the queue. A bind probe alone is not enough: it frees the port at
 * once, so two runs can pick the same port before either one binds it.
 *
 * So each run reserves a pair (N, N + 1) with an exclusive lock file
 * `port-<N>.lock` in a folder that all runs share. The file holds the PID of
 * the owner. The candidates step by 2 from the first port of the range, so
 * two pairs never overlap. Both ports of a pair must also pass a bind probe,
 * because a process outside the tests can use them.
 *
 * A lock whose PID is dead is stale: its run was killed. A reservation takes
 * it over by renaming it to a private name first. Only one process can win
 * that rename. The winner then checks that it renamed the stale file and not
 * a fresh lock of another run. If it renamed a fresh lock, it puts the lock
 * back and skips the port.
 *
 * The locks are released by `release()`, and at the exit of the process.
 */
import { closeSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import net from "node:net";
import path from "node:path";

/** The ports that a reservation may use, both ends included. */
export type PortRange = { first: number; last: number };

/** A reserved pair: `port` for the server and `port + 1` for the proxy. */
export type PortPair = { port: number; release: () => void };

export type ReserveOptions = {
  /** The lock folder that all test runs share. */
  dir: string;
  range: PortRange;
  /** Whether a port is free to bind. Default: a bind probe on 127.0.0.1. */
  isFree?: (port: number) => Promise<boolean>;
};

/** A lock file that has no PID yet is fresh for this long: its owner is between open and write. */
const EMPTY_LOCK_GRACE_MS = 10_000;

/** The lock file of the pair that starts at `port`. Pure. */
export function lockPath(dir: string, port: number): string {
  return path.join(dir, `port-${port}.lock`);
}

/** Whether the port is free to bind on 127.0.0.1 now. */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, "127.0.0.1");
  });
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists, but it belongs to another user.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readOrNull(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** Whether the content of a lock file names a dead owner. An empty file is stale only when it is old. */
function isStale(file: string, content: string): boolean {
  const pid = Number(content.trim());
  if (content.trim() === "" || !Number.isInteger(pid) || pid <= 0) {
    try {
      return Date.now() - statSync(file).mtimeMs > EMPTY_LOCK_GRACE_MS;
    } catch {
      return false;
    }
  }
  return !pidAlive(pid);
}

/** Creates the lock file with the PID of this process. False when it exists. */
function createLock(file: string): boolean {
  let fd: number;
  try {
    fd = openSync(file, "wx");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
  try {
    writeSync(fd, `${process.pid}\n`);
  } finally {
    closeSync(fd);
  }
  return true;
}

/**
 * Removes a stale lock file whose content was `seen`. Only one process wins
 * the rename. If the renamed file is not the stale one, another run took the
 * lock in between: the lock goes back, and the port counts as taken.
 */
function removeStale(file: string, seen: string): boolean {
  const aside = `${file}.stale-${process.pid}-${Math.random().toString(36).slice(2)}`;
  try {
    renameSync(file, aside);
  } catch {
    // Another process renamed or released it first.
    return false;
  }
  const content = readOrNull(aside);
  if (content === seen) {
    unlinkSync(aside);
    return true;
  }
  try {
    // A link never overwrites, so a lock that a third run made stays.
    linkSync(aside, file);
  } catch {
    // A third run holds the port now.
  }
  unlinkSync(aside);
  return false;
}

/** Takes the lock of the pair at `port`, also from a dead owner. False when a live run holds it. */
function tryLock(file: string): boolean {
  if (createLock(file)) return true;
  const seen = readOrNull(file);
  if (seen === null || !isStale(file, seen)) return false;
  if (!removeStale(file, seen)) return false;
  return createLock(file);
}

/** Removes the lock file when it still names this process. */
function unlock(file: string): void {
  const content = readOrNull(file);
  if (content === null || content.trim() !== String(process.pid)) return;
  try {
    unlinkSync(file);
  } catch {
    // It is already gone.
  }
}

/** The lock files of this process, so that the exit releases them. */
const held = new Set<string>();
let exitHookSet = false;

function releaseAllAtExit(): void {
  if (exitHookSet) return;
  exitHookSet = true;
  process.on("exit", () => {
    for (const file of held) unlock(file);
    held.clear();
  });
}

/**
 * Reserves the first free pair (port, port + 1) of the range for this
 * process. It throws when no pair is free.
 */
export async function reservePortPair(options: ReserveOptions): Promise<PortPair> {
  const { dir, range } = options;
  const isFree = options.isFree ?? isPortFree;
  mkdirSync(dir, { recursive: true });
  releaseAllAtExit();
  for (let port = range.first; port + 1 <= range.last; port += 2) {
    const file = lockPath(dir, port);
    if (!tryLock(file)) continue;
    if (!(await isFree(port)) || !(await isFree(port + 1))) {
      unlock(file);
      continue;
    }
    held.add(file);
    return {
      port,
      release: () => {
        held.delete(file);
        unlock(file);
      },
    };
  }
  throw new Error(`no free port pair between ${range.first} and ${range.last}`);
}
