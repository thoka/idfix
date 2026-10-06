/**
 * Per-user state of the servers that `idfx up` starts. One server serves
 * many project directories, so its PID file, its log, and the list of
 * directories with runs live in one place per user, not in the current
 * directory: `$XDG_STATE_HOME/idfx/`, default `~/.local/state/idfx/`.
 *
 * Before step 24.3 the folder was `$XDG_STATE_HOME/oc-sub/`. While that old
 * path is a real folder (not a symlink), `stateDir` keeps using it, so one
 * state stays in one place and a running server keeps its PID file. The
 * `state-names` check of `doctor` warns, and `doctor --fix` runs
 * `migrateStateDir`: it moves the entries into the new folder and links the
 * old path to it, for processes of older code.
 */
import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, symlinkSync } from "node:fs";
import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { Env } from "./config";

/** The name of the state folder. */
export const STATE_NAME = "idfx";
/** The name of the state folder before step 24.3. */
export const OLD_STATE_NAME = "oc-sub";

/** The base of the state folders: `$XDG_STATE_HOME` when it is absolute, else `~/.local/state`. Pure. */
export function stateBase(env: Env, home: string = homedir()): string {
  return env.XDG_STATE_HOME !== undefined && path.isAbsolute(env.XDG_STATE_HOME)
    ? env.XDG_STATE_HOME
    : path.join(home, ".local", "state");
}

/** The new state folder `<base>/idfx`, whatever is on disk. Pure. */
export function newStateDir(env: Env, home: string = homedir()): string {
  return path.join(stateBase(env, home), STATE_NAME);
}

/** The old state folder `<base>/oc-sub`, whatever is on disk. Pure. */
export function oldStateDir(env: Env, home: string = homedir()): string {
  return path.join(stateBase(env, home), OLD_STATE_NAME);
}

/** Whether the path is a real folder: it exists, and it is not a symlink. */
export function isRealFolder(file: string): boolean {
  try {
    const info = lstatSync(file);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * The old state folder while it is a real folder, else null. Then
 * `stateDir` uses it, and `doctor` warns.
 */
export function legacyStateDir(env: Env, home: string = homedir()): string | null {
  const old = oldStateDir(env, home);
  return isRealFolder(old) ? old : null;
}

/**
 * The state folder: the old folder `<base>/oc-sub` while it is a real
 * folder, else the new folder `<base>/idfx`.
 */
export function stateDir(env: Env, home: string = homedir()): string {
  return legacyStateDir(env, home) ?? newStateDir(env, home);
}

/** The result of `migrateStateDir`. */
export type StateMigration = {
  /** True when the old path is now a link to the new folder, or was one already, or is missing. */
  ok: boolean;
  /** One line for the user: what happened, or why nothing happened. */
  note: string;
  /** The entries that moved into the new folder. */
  moved: string[];
  /** The entries that exist in both folders and stay in the old one. */
  skipped: string[];
};

/** The lock folders of `run` and the watchdog (`serveLockPath`). */
const SERVE_LOCK = /^serve-\d+\.lock$/;

/**
 * Moves the old state folder into the new one (the fix of the `state-names`
 * check of `doctor`). Steps:
 *
 * 1. When the old path is missing or a symlink, nothing is to do.
 * 2. When a `serve-<port>.lock` exists in the old folder, a run starts or the
 *    watchdog stops a server now, so nothing moves.
 * 3. Each entry of the old folder moves into the new folder with a rename.
 *    On one file system a rename keeps open files valid, so a running
 *    server keeps writing its log. An entry whose name exists in the new
 *    folder too stays, and the result names it.
 * 4. When the old folder is empty, it goes away, and the old path becomes a
 *    relative symlink to the new folder.
 *
 * A second run finds the link and does nothing.
 */
export function migrateStateDir(env: Env, home: string = homedir()): StateMigration {
  const oldDir = oldStateDir(env, home);
  const newDir = newStateDir(env, home);
  const none = { moved: [], skipped: [] };
  let info;
  try {
    info = lstatSync(oldDir);
  } catch {
    return { ok: true, note: `no old state folder ${oldDir}`, ...none };
  }
  if (info.isSymbolicLink()) return { ok: true, note: `${oldDir} is a link already`, ...none };
  if (!info.isDirectory()) return { ok: false, note: `${oldDir} is not a folder; move it away by hand`, ...none };
  const entries = readdirSync(oldDir).sort();
  const locks = entries.filter((entry) => SERVE_LOCK.test(entry));
  if (locks.length > 0) {
    return {
      ok: false,
      note: `${locks.join(", ")} in ${oldDir}: a run or the idle watchdog works now. Nothing moved; try again later`,
      ...none,
    };
  }
  mkdirSync(newDir, { recursive: true });
  const moved: string[] = [];
  const skipped: string[] = [];
  for (const entry of entries) {
    const target = path.join(newDir, entry);
    let taken = true;
    try {
      lstatSync(target);
    } catch {
      taken = false;
    }
    if (taken) {
      skipped.push(entry);
      continue;
    }
    renameSync(path.join(oldDir, entry), target);
    moved.push(entry);
  }
  if (skipped.length > 0) {
    return {
      ok: false,
      note: `moved ${moved.length} entr${moved.length === 1 ? "y" : "ies"}; ${skipped.join(", ")} exist(s) in both ${oldDir} and ${newDir}. Merge or remove them by hand, then run idfx doctor --fix again`,
      moved,
      skipped,
    };
  }
  rmdirSync(oldDir);
  symlinkSync(STATE_NAME, oldDir);
  return {
    ok: true,
    note: `moved ${moved.length} entr${moved.length === 1 ? "y" : "ies"} into ${newDir}, and ${oldDir} links to it now`,
    moved,
    skipped,
  };
}

export function servePidPath(env: Env, port: number): string {
  return path.join(stateDir(env), `serve-${port}.pid`);
}

export function serveLogPath(env: Env, port: number): string {
  return path.join(stateDir(env), `serve-${port}.log`);
}

/** The directories that `idfx run` sent sessions to, one per line. */
export function serveDirsPath(env: Env, port: number): string {
  return path.join(stateDir(env), `serve-${port}.dirs`);
}

/**
 * The lock of the server on `port` (`lock.ts`). `idfx run` holds it while
 * it starts a session, and the idle watchdog holds it while it stops the
 * server. It is a folder, because `proper-lockfile` locks with `mkdir`.
 */
export function serveLockPath(env: Env, port: number): string {
  return path.join(stateDir(env), `serve-${port}.lock`);
}

/**
 * The plugin digest of the server on `port`: the content digest of the
 * synced plugin folder (`pluginDigest` in `plugin-sync.ts`) at the moment
 * `up` started the server. Both modes write it, because both keep the PID of
 * their server process in `serve-<port>.pid`. The `server-plugin` check of
 * `doctor` compares it with the folder now.
 */
export function servePluginPath(env: Env, port: number): string {
  return path.join(stateDir(env), `serve-${port}.plugin`);
}

/** The recorded plugin digest of a server, or null without a valid record. */
export function readServePlugin(file: string): string | null {
  try {
    const text = readFileSync(file, "utf8").trim();
    return text.startsWith("sha256:") ? text : null;
  } catch {
    return null;
  }
}

/**
 * The PID file of the cost proxy that `idfx up` starts next to the server
 * on the port of the server plus one (host mode only; in sandbox mode the
 * proxy lives in the holder process).
 */
export function proxyPidPath(env: Env, port: number): string {
  return path.join(stateDir(env), `proxy-${port}.pid`);
}

/** The log file of the cost proxy of the server on `port` (host mode only). */
export function proxyLogPath(env: Env, port: number): string {
  return path.join(stateDir(env), `proxy-${port}.log`);
}

/**
 * The marker line that every start of a server or proxy writes into its log
 * first. A reader sees from it where a new start begins; the proxy readers
 * skip the line, because it is not JSON. Pure.
 */
export function logMarkerLine(label: string, now: Date = new Date()): string {
  return `--- idfx ${label} ${now.toISOString()} ---`;
}

/**
 * True when the line is a start marker of `logMarkerLine`. It also accepts
 * the marker `--- oc-sub ...` of older code, because the logs append and
 * keep old lines. Pure.
 */
export function isLogMarkerLine(line: string): boolean {
  return /^--- (?:idfx|oc-sub) \S+ \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(line.trim());
}

/**
 * The lines of a log text after its last start marker, without the marker
 * and without empty lines: the output of the newest start. A text without
 * a marker has no start to name, so it gives an empty list. Pure.
 */
export function logSinceLastMarker(text: string): string[] {
  const lines = text.split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (isLogMarkerLine(lines[i] as string)) start = i;
  }
  if (start === -1) return [];
  return lines.slice(start + 1).filter((line) => line.trim().length > 0);
}

/**
 * Append one start marker line to a log file, creating it if needed. The
 * logs open in append mode, so a start must mark where its lines begin.
 */
export async function appendLogMarker(file: string, label: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${logMarkerLine(label)}\n`);
}

/**
 * The output of the newest start of a log file, for an error message after
 * a failed start. At most `maxLines` lines, with a note about the cut. An
 * unreadable file gives an empty list.
 */
export async function readLogTail(file: string, maxLines = 50): Promise<string[]> {
  let lines: string[];
  try {
    lines = logSinceLastMarker(await readFile(file, "utf8"));
  } catch {
    return [];
  }
  if (lines.length <= maxLines) return lines;
  return [...lines.slice(-maxLines), `(${lines.length - maxLines} earlier lines cut)`];
}

/** The PID from a PID file, or null when the file is missing or invalid. */
export async function readPid(file: string): Promise<number | null> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return null;
  }
  const pid = Number(text.trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** Unique, non-empty lines of a directory list, in first-seen order. */
export function parseDirs(text: string): string[] {
  const seen = new Set<string>();
  for (const line of text.split("\n")) {
    const dir = line.trim();
    if (dir.length > 0) seen.add(dir);
  }
  return [...seen];
}

export async function readDirs(file: string): Promise<string[]> {
  try {
    return parseDirs(await readFile(file, "utf8"));
  } catch {
    return [];
  }
}

export async function addDir(file: string, directory: string): Promise<void> {
  if ((await readDirs(file)).includes(directory)) return;
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${directory}\n`);
}

export async function removeFiles(...files: string[]): Promise<void> {
  await Promise.all(files.map((file) => rm(file, { force: true })));
}
