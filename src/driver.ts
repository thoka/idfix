/**
 * The driver layer: one object per agent CLI that idfx can drive. A driver
 * holds the write and command members of idfx (`run`, `say`, `abort`,
 * `watch`, `log`). Each member takes the arguments of its command and
 * returns the exit code.
 *
 * The read members of the design (`list`, `events`, `usage`, design section
 * 2.6 of the driver layer) are not part of this interface yet. The read side
 * of Claude Code sessions lives in `src/claude/` and feeds `top` and
 * `status` directly.
 *
 * A new CLI (for example Codex) adds its name to `DriverName` and a plain
 * object that implements `Driver` to the registry.
 */
import type { Env } from "./config";
import { abort } from "./abort";
import { log } from "./log";
import { run } from "./run";
import { loadRunRecord, recordDriver, type RunRecord } from "./runs";
import { say } from "./say";
import { watch } from "./watch";

/** The agent CLIs that a session can run on. */
export type DriverName = "opencode" | "claude-glm" | "claude";

export type Driver = {
  name: DriverName;
  /** Start a run and write its record. */
  run(args: Parameters<typeof run>[0]): Promise<number>;
  /** Send a follow-up message into a session. */
  say(args: Parameters<typeof say>[0]): Promise<number>;
  /** Abort a running session. */
  abort(args: Parameters<typeof abort>[0]): Promise<number>;
  /** Follow the events of a session until it ends or needs attention. */
  watch(args: Parameters<typeof watch>[0]): Promise<number>;
  /** Print the final text and the cost of a session. */
  log(args: Parameters<typeof log>[0]): Promise<number>;
};

/** The registry of the drivers. A name without an entry has no write side yet. */
export type DriverRegistry = Partial<Record<string, Driver>>;

/** The `opencode` driver: the existing commands, unchanged. */
export const opencodeDriver: Driver = {
  name: "opencode",
  run: (args) => run(args),
  say: (args) => say(args),
  abort: (args) => abort(args),
  watch: (args) => watch(args),
  log: (args) => log(args),
};

export const DRIVERS: DriverRegistry = { opencode: opencodeDriver };

/** The driver of a name, or undefined when idfx cannot drive it yet. Pure function. */
export function lookupDriver(registry: DriverRegistry, name: string): Driver | undefined {
  return Object.hasOwn(registry, name) ? registry[name] : undefined;
}

/** The error line for a session whose driver has no implementation. */
export function unknownDriverLine(name: string): string {
  return `idfx cannot drive ${name} sessions yet`;
}

export type SessionDriverDeps = {
  registry: DriverRegistry;
  load: (sessionId: string, cwd: string, env: Env) => Promise<RunRecord | null>;
};

const defaultDeps: SessionDriverDeps = { registry: DRIVERS, load: loadRunRecord };

/**
 * The driver of a session, from its run record in `cwd` or the state folder.
 * No record, a record without `driver`, or a failed lookup means `opencode`.
 * Returns the error line when the record names a driver without an entry.
 */
export async function sessionDriver(
  sessionId: string,
  cwd: string,
  env: Env,
  deps: SessionDriverDeps = defaultDeps,
): Promise<Driver | string> {
  let name: string = "opencode";
  try {
    const record = await deps.load(sessionId, cwd, env);
    if (record !== null) name = recordDriver(record);
  } catch {
    // The lookup must never break the opencode path.
  }
  return lookupDriver(deps.registry, name) ?? unknownDriverLine(name);
}

/**
 * Run one session command through the driver of the session. Prints the
 * error line and returns 1 when idfx cannot drive the session.
 */
export async function dispatchSession(
  args: { session: string; dir?: string },
  call: (driver: Driver) => Promise<number>,
  env: Env = process.env,
  deps: SessionDriverDeps = defaultDeps,
): Promise<number> {
  const driver = await sessionDriver(args.session, args.dir ?? process.cwd(), env, deps);
  if (typeof driver === "string") {
    console.error(driver);
    return 1;
  }
  return call(driver);
}
