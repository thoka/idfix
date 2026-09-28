/**
 * Per-user state of the servers that `oc-sub up` starts. One server serves
 * many project directories, so its PID file, its log, and the list of
 * directories with runs live in one place per user, not in the current
 * directory: `$XDG_STATE_HOME/oc-sub/`, default `~/.local/state/oc-sub/`.
 */
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

/** The directories that `oc-sub run` sent sessions to, one per line. */
export function serveDirsPath(env: Env, port: number): string {
  return path.join(stateDir(env), `serve-${port}.dirs`);
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
