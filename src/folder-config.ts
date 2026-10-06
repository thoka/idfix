/**
 * The optional folder configuration `<folder>/.idfix.toml`. The folder is
 * the main folder of a project (the folder that gives a session its
 * project name). Today it has one key:
 *
 *   session_names = ["lead", "reviewer"]
 *
 * A name in that list is a valid session name in that folder, next to the
 * naming rule of `SessionUnnamed` (`<project>` or `<project>-<step>`).
 * Unknown keys are ignored, so the file can grow later.
 *
 * No file or no key gives an empty list. A bad TOML or a value that is not
 * an array of non-empty strings gives an empty list and a problem.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

/** The config file in the main folder of a project. */
export const FOLDER_CONFIG = ".idfix.toml";

/** The extra session names of a folder, and the problem of the config, if any. */
export type SessionNames = { names: string[]; problem?: string };

/**
 * Reads the key `session_names` of `<folder>/.idfix.toml`. `readText`
 * returns the content of a file, or null when it does not exist or cannot
 * be read; a null counts as no config file.
 */
export function readSessionNames(folder: string, readText: (file: string) => string | null): SessionNames {
  const file = path.join(folder, FOLDER_CONFIG);
  const text = readText(file);
  if (text === null) return { names: [] };
  let data: Record<string, unknown>;
  try {
    data = Bun.TOML.parse(text) as Record<string, unknown>;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { names: [], problem: `bad ${file}: ${reason}` };
  }
  const value = data.session_names;
  if (value === undefined) return { names: [] };
  if (!Array.isArray(value) || !value.every((name) => typeof name === "string" && name.trim().length > 0)) {
    return { names: [], problem: `bad ${file}: session_names is not an array of non-empty strings` };
  }
  return { names: value as string[] };
}

/** The extra session names of a folder, for one poll. */
export type SessionNamesReader = (folder: string) => readonly string[];

/** A reader without extra names. */
export const noSessionNames: SessionNamesReader = () => [];

/** The content of a file, or null when it is missing or unreadable. */
export function readTextSync(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/**
 * A source of session name readers. `forTick` gives a reader for one poll:
 * it reads the file of each folder at most once. Each problem goes to
 * `report` once per folder and problem text, not at each poll.
 */
export function sessionNamesSource(
  readText: (file: string) => string | null = readTextSync,
  report: (line: string) => void = () => {},
): { forTick(): SessionNamesReader } {
  const reported = new Set<string>();
  return {
    forTick() {
      const cache = new Map<string, readonly string[]>();
      return (folder) => {
        const cached = cache.get(folder);
        if (cached !== undefined) return cached;
        const { names, problem } = readSessionNames(folder, readText);
        if (problem !== undefined) {
          const key = `${folder}\u0000${problem}`;
          if (!reported.has(key)) {
            reported.add(key);
            report(problem);
          }
        }
        cache.set(folder, names);
        return names;
      };
    },
  };
}
