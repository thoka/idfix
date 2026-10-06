/**
 * Per-user state of the servers that `idfx up` starts. One server serves
 * many project directories, so its PID file, its log, and the list of
 * directories with runs live in one place per user, not in the current
 * directory: `$XDG_STATE_HOME/oc-sub/`, default `~/.local/state/oc-sub/`.
 */
import { readFileSync } from "node:fs";
import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { Env } from "./config";

export function stateDir(env: Env, home: string = homedir()): string {
  const base = env.XDG_STATE_HOME !== undefined && path.isAbsolute(env.XDG_STATE_HOME)
    ? env.XDG_STATE_HOME
    : path.join(home, ".local", "state");
  return path.join(base, "oc-sub");
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
  return `--- oc-sub ${label} ${now.toISOString()} ---`;
}

/** True when the line is a start marker of `logMarkerLine`. Pure. */
export function isLogMarkerLine(line: string): boolean {
  return /^--- oc-sub \S+ \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(line.trim());
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
