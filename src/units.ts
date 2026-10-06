/**
 * Long-lived processes as transient systemd user services, with an owner and
 * a reason.
 *
 * idfx starts processes that outlive it: the host server, the cost proxy,
 * the holder of sandbox mode, and the idle watchdog. Before this module they
 * ran as plain detached processes, so a forgotten one carried no label, and
 * a tool could find it only with a guess. `startUnit` starts such a command
 * under the user manager with `systemd-run --user`:
 *
 * - The unit name `ocsub-<kind>-<name>.service` is the handle.
 * - The description `owner=<owner> reason=<reason>` carries the label as
 *   data, and the slice `ocsub.slice` groups all units.
 * - `--collect` unloads the unit after it ends, also after a failure.
 * - `systemctl --user stop <unit>` stops the whole cgroup, also a child that
 *   detached or double-forked (`stopUnit`).
 *
 * Every child also gets `OCSUB_OWNER` and `OCSUB_REASON` in its environment,
 * so a tool can read the label from `/proc/<pid>/environ` on both paths.
 *
 * The environment of the child can hold API keys, so no value goes on the
 * command line of `systemd-run`, where `ps` shows it. Each variable goes as
 * `--setenv=NAME` without a value, and `systemd-run` runs with the child
 * environment as its own environment. systemd then copies the value of the
 * variable with the same name from the environment of `systemd-run`.
 *
 * On a host without a user manager (macOS, a container, a WSL VM without
 * systemd), `startUnit` falls back to the detached spawn of `spawn.ts`
 * with the same two label variables, and the handle has no unit. When the
 * manager answers but `systemd-run` fails, for example because a unit with
 * the name exists already, `startUnit` throws with the stderr of
 * `systemd-run` and does not fall back.
 *
 * Every process call goes through an injectable runner, so the unit tests
 * need no systemd. Research: `.plan/research/process-labels.md`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Env } from "./config";
import type { RunnerResult } from "./sandbox";
import { spawnDetached, type ServeProcess } from "./spawn";

/** The prefix of every unit that idfx starts. */
export const UNIT_PREFIX = "ocsub-";
/** The slice that holds every unit that idfx starts. */
export const UNIT_SLICE = "ocsub.slice";
/**
 * How long a stop of a server unit waits after SIGTERM before SIGKILL, in
 * seconds. `down` waits as long on the fallback path (`stopGroup`).
 */
export const UNIT_STOP_TIMEOUT_SEC = 15;
/** The longest unit name without the `.service` suffix (systemd allows 255 with it). */
export const MAX_UNIT_NAME = 200;

/** What to start, and the label of it. */
export type UnitOptions = {
  /** The kind of process, for example "serve", "proxy", "holder", or "idle". */
  kind: string;
  /** What tells two units of one kind apart, for example the port or the project. */
  name: string;
  /** Who needs the process: a project or a session. */
  owner: string;
  /** Why the process runs, as free text. */
  reason: string;
  /** The command and its arguments. */
  cmd: readonly string[];
  /** The working folder of the process. */
  cwd: string;
  /** The full environment of the child. */
  env: Env;
  /** The log file; stdout and stderr are appended to it. */
  logPath: string;
  /** The PID file; it gets the main PID of the process. */
  pidPath: string;
  /**
   * With "on-failure", the manager starts the process again after a failure.
   * With "always", it also starts it again after a clean exit. A stop with
   * `systemctl stop` never starts it again.
   */
  restart?: "on-failure" | "always";
  /** The wait in seconds before a restart of `restart` (systemd `RestartSec`). */
  restartSec?: number;
  /**
   * The interval of the start limit in seconds (systemd
   * `StartLimitIntervalSec`). 0 turns the start limit off, so the manager
   * never gives up on the restarts of `restart`.
   */
  startLimitIntervalSec?: number;
  /** The manager stops the unit after this many seconds. */
  runtimeMaxSec?: number;
  /**
   * How long a stop waits for the end after SIGTERM, in seconds, before the
   * manager sends SIGKILL (systemd `TimeoutStopSec`, default 90).
   */
  timeoutStopSec?: number;
};

/**
 * The kinds of unit that `up` starts, one of each per port: the host
 * server, the cost proxy, the holder of sandbox mode, and the idle watchdog.
 * The name of each unit is the port of its server, so `ocsub-serve-4096`.
 */
export const PORT_UNIT_KINDS = ["serve", "proxy", "holder", "idle"] as const;
export type PortUnitKind = (typeof PORT_UNIT_KINDS)[number];

/** The unit name of a process of the server on `port`, for example `ocsub-proxy-4096`. Pure. */
export function portUnitName(kind: PortUnitKind, port: number): string {
  return unitName(kind, String(port));
}

/**
 * A started process. `pid` leads its own session and process group on both
 * paths, so `process.kill(-pid, signal)` reaches the whole group.
 *
 * `exitCode()` gives null while the process runs. On the unit path, it asks
 * the manager: null while the unit is active, activating (also between two
 * starts of `Restart=`), or deactivating. After the end, it gives
 * the exit status of the main process while the unit is still loaded, and -1
 * when the manager unloaded the unit already (`--collect`) and the real code
 * is lost. The log file keeps the output.
 */
export type UnitHandle = ServeProcess & {
  /** The unit name without `.service`, or null on the fallback path. */
  unit: string | null;
};

/** One synchronous process call with an optional own environment. */
export type UnitRunner = (cmd: readonly string[], opts?: { env?: Env }) => RunnerResult;

/** Everything that `startUnit` and `stopUnit` reach outside this module. */
export type UnitDeps = {
  /** Runs `systemd-run` and `systemctl`. */
  run: UnitRunner;
  /** Whether a user manager answers. The default caches the probe per process. */
  available: () => boolean;
  /** The environment that `systemctl` and `systemd-run` need to reach the user bus. */
  busEnv: () => Env;
  /** The detached spawn of the fallback path. */
  spawnFallback: (cmd: readonly string[], logPath: string, pidPath: string, cwd: string, env: Env) => ServeProcess;
  /** Writes the PID file. */
  writePid: (pidPath: string, pid: number) => void;
  /**
   * The `ocsub-*` unit that holds this process, without `.service`, or null.
   * The idle watchdog uses it, so that it never stops its own unit.
   */
  ownUnit: () => string | null;
};

/**
 * Makes a string safe for a unit name. systemd allows ASCII letters, digits,
 * and `:_.\-` in a unit name. This keeps letters, digits, `_`, `.`, and `-`,
 * and replaces each run of other characters with one `_`, so `my project`
 * becomes `my_project`. It leaves out `:` and `\` on purpose: `\` starts an
 * escape in systemd, and both read badly in a unit name. An empty result
 * becomes `_`. Pure.
 */
export function sanitizeUnitPart(part: string): string {
  const clean = part.replace(/[^A-Za-z0-9_.-]+/g, "_");
  return clean.length === 0 ? "_" : clean;
}

/** The unit name `ocsub-<kind>-<name>`, without `.service`, at most `MAX_UNIT_NAME` long. Pure. */
export function unitName(kind: string, name: string): string {
  return `${UNIT_PREFIX}${sanitizeUnitPart(kind)}-${sanitizeUnitPart(name)}`.slice(0, MAX_UNIT_NAME);
}

/**
 * The description of a unit: `owner=<owner> reason=<reason>`. Control
 * characters such as a newline become a space, because the description is
 * one line in `systemctl` output. Pure.
 */
export function unitDescription(owner: string, reason: string): string {
  const line = (text: string) => text.replace(/[\u0000-\u001f\u007f]+/g, " ");
  return `owner=${line(owner)} reason=${line(reason)}`;
}

/** The environment variable that overrides the owner of the units of `up` and the watchdog. */
export const OWNER_ENV = "OC_SUB_OWNER";

/**
 * The owner of the units that `up` and the watchdog start: the value of
 * `OC_SUB_OWNER` when it is set and not blank, else `project`. The tests
 * set `OC_SUB_OWNER=test`, and a session can put its own name there. The
 * owner is one word in the description `owner=<owner> reason=<reason>`, so
 * each run of white space or control characters in the value becomes one
 * `_`. Pure.
 */
export function unitOwner(env: Env, project: string): string {
  const value = (env[OWNER_ENV] ?? "").trim().replace(/[\s\u0000-\u001f\u007f]+/g, "_");
  return value.length === 0 ? project : value;
}

/** The child environment with the two label variables. Undefined values are left out. Pure. */
export function labelledEnv(env: Env, owner: string, reason: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (value !== undefined) out[key] = value;
  out.OCSUB_OWNER = owner;
  out.OCSUB_REASON = reason;
  return out;
}

/**
 * The argv of `systemd-run` for a unit. It holds the names of the child
 * variables, never their values. Pure.
 */
export function systemdRunArgv(opts: UnitOptions, childEnv: Record<string, string>): string[] {
  const argv = [
    "systemd-run",
    "--user",
    "--quiet",
    `--unit=${unitName(opts.kind, opts.name)}`,
    `--description=${unitDescription(opts.owner, opts.reason)}`,
    `--slice=${UNIT_SLICE}`,
    "--collect",
    `--working-directory=${path.resolve(opts.cwd)}`,
    `--property=StandardOutput=append:${path.resolve(opts.logPath)}`,
    `--property=StandardError=append:${path.resolve(opts.logPath)}`,
  ];
  if (opts.restart !== undefined) argv.push(`--property=Restart=${opts.restart}`);
  if (opts.startLimitIntervalSec !== undefined) {
    const value = opts.startLimitIntervalSec;
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`startLimitIntervalSec must be a whole number of 0 or more, got ${value}`);
    }
    argv.push(`--property=StartLimitIntervalSec=${value}`);
  }
  const seconds: Array<[keyof UnitOptions, string]> = [
    ["restartSec", "RestartSec"],
    ["runtimeMaxSec", "RuntimeMaxSec"],
    ["timeoutStopSec", "TimeoutStopSec"],
  ];
  for (const [option, property] of seconds) {
    const value = opts[option];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
      throw new Error(`${option} must be a positive whole number, got ${String(value)}`);
    }
    argv.push(`--property=${property}=${value}`);
  }
  for (const key of Object.keys(childEnv)) argv.push(`--setenv=${key}`);
  argv.push("--", ...opts.cmd);
  return argv;
}

/**
 * The environment that reaches the user bus. WSL and a plain `su` can leave
 * out `XDG_RUNTIME_DIR` and `DBUS_SESSION_BUS_ADDRESS`; this fills them from
 * the uid when they are missing (`/run/user/<uid>` and its `bus` socket).
 * Pure.
 */
export function busEnv(base: Env, uid: number): Env {
  const runtime = base.XDG_RUNTIME_DIR ?? `/run/user/${uid}`;
  return {
    ...base,
    XDG_RUNTIME_DIR: runtime,
    DBUS_SESSION_BUS_ADDRESS: base.DBUS_SESSION_BUS_ADDRESS ?? `unix:path=${runtime}/bus`,
  };
}

/**
 * Whether a user manager answers: `systemctl --user is-system-running`
 * prints `running` or `degraded`. It exits with a code other than 0 for
 * `degraded`, so only the output counts. A missing `systemctl` gives false.
 */
export function probeUserManager(run: UnitRunner, env: Env): boolean {
  const res = run(["systemctl", "--user", "is-system-running"], { env });
  const state = res.stdout.trim();
  return state === "running" || state === "degraded";
}

/** The real runner: one synchronous subprocess per call. A missing binary gives exit code 127. */
export const defaultUnitRunner: UnitRunner = (cmd, opts = {}) => {
  try {
    const proc = Bun.spawnSync([...cmd], {
      stdout: "pipe",
      stderr: "pipe",
      ...(opts.env === undefined ? {} : { env: { ...opts.env } }),
    });
    return { stdout: proc.stdout.toString(), exitCode: proc.exitCode ?? 1, stderr: proc.stderr.toString() };
  } catch (error) {
    return { stdout: "", exitCode: 127, stderr: error instanceof Error ? error.message : String(error) };
  }
};

/**
 * The `ocsub-*` unit in the text of `/proc/<pid>/cgroup`, without
 * `.service`, or null. The cgroup v2 line is `0::/user.slice/.../ocsub.slice/ocsub-idle-4096.service`.
 * Pure.
 */
export function unitOfCgroup(text: string): string | null {
  for (const line of text.split("\n")) {
    const last = line.trim().split("/").pop() ?? "";
    const match = /^(ocsub-.+)\.service$/.exec(last);
    if (match !== null) return match[1] ?? null;
  }
  return null;
}

/** The `ocsub-*` unit of this process, from `/proc/self/cgroup`. Null without one or without `/proc`. */
export function readOwnUnit(): string | null {
  try {
    return unitOfCgroup(readFileSync("/proc/self/cgroup", "utf8"));
  } catch {
    return null;
  }
}

function processBusEnv(): Env {
  return busEnv(process.env, process.getuid?.() ?? 0);
}

let cachedAvailable: boolean | undefined;

/** The default dependencies, with the real `systemd-run` and `systemctl`. */
export const defaultUnitDeps: UnitDeps = {
  run: defaultUnitRunner,
  available: () => {
    cachedAvailable ??= probeUserManager(defaultUnitRunner, processBusEnv());
    return cachedAvailable;
  },
  busEnv: processBusEnv,
  spawnFallback: (cmd, logPath, pidPath, cwd, env) => spawnDetached(cmd, logPath, pidPath, cwd, env),
  writePid: (pidPath, pid) => writeFileSync(pidPath, `${pid}\n`),
  ownUnit: readOwnUnit,
};

/**
 * Whether `startUnit` takes the unit path: a user manager answers. `up`
 * asks this first, because the cost proxy has another command on each path.
 */
export function unitsAvailable(deps: UnitDeps = defaultUnitDeps): boolean {
  return deps.available();
}

/** The stderr of a call, or its stdout when stderr is empty, or its exit code. */
function failureText(res: RunnerResult): string {
  const text = (res.stderr ?? "").trim() || res.stdout.trim();
  return text.length > 0 ? text : `exit code ${res.exitCode}`;
}

/** The `--value` lines of `systemctl --user show` for the given properties, in their order. */
function showUnit(deps: UnitDeps, unit: string, properties: readonly string[]): string[] | null {
  const res = deps.run(
    ["systemctl", "--user", "show", ...properties.map((p) => `--property=${p}`), "--value", `${unit}.service`],
    { env: deps.busEnv() },
  );
  if (res.exitCode !== 0) return null;
  return res.stdout.split("\n");
}

const RUNNING_STATES = new Set(["active", "activating", "deactivating", "reloading", "refreshing"]);

/**
 * The exit code of a unit for `UnitHandle.exitCode`: null while it runs,
 * the exit status of the main process while it is loaded, -1 after the
 * manager unloaded it.
 */
export function unitExitCode(deps: UnitDeps, unit: string): number | null {
  const lines = showUnit(deps, unit, ["LoadState", "ActiveState", "ExecMainStatus"]);
  if (lines === null) return -1;
  const [load = "", active = "", status = ""] = lines.map((line) => line.trim());
  if (RUNNING_STATES.has(active)) return null;
  if (load !== "loaded") return -1;
  const code = Number.parseInt(status, 10);
  return Number.isNaN(code) ? -1 : code;
}

/**
 * Starts `opts.cmd` as the transient user service `ocsub-<kind>-<name>`, or
 * detached without a unit when no user manager answers. Writes the main PID
 * into `opts.pidPath` on both paths, so the readers of PID files keep
 * working.
 *
 * systemd starts the main process of a service with `setsid`, so the main
 * PID leads its own session and process group, like the detached spawn.
 * `process.kill(-pid, signal)` in `down` therefore still reaches the group.
 */
export function startUnit(opts: UnitOptions, deps: UnitDeps = defaultUnitDeps): UnitHandle {
  const childEnv = labelledEnv(opts.env, opts.owner, opts.reason);
  if (!deps.available()) {
    const proc = deps.spawnFallback(opts.cmd, opts.logPath, opts.pidPath, opts.cwd, childEnv);
    return { pid: proc.pid, unit: null, exitCode: proc.exitCode };
  }
  const unit = unitName(opts.kind, opts.name);
  const argv = systemdRunArgv(opts, childEnv);
  // systemd-run reads each `--setenv=NAME` value from its own environment.
  // It also needs the bus variables, which the child may not have.
  const res = deps.run(argv, { env: { ...deps.busEnv(), ...childEnv } });
  if (res.exitCode !== 0) throw new Error(`systemd-run cannot start ${unit}: ${failureText(res)}`);
  const lines = showUnit(deps, unit, ["MainPID"]);
  const pid = lines === null ? 0 : Number.parseInt((lines[0] ?? "").trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    // A PID of 0 must never reach a PID file: `process.kill(-0)` would
    // signal the group of the caller.
    throw new Error(`${unit} has no main process; it ended at once. See ${opts.logPath}`);
  }
  deps.writePid(opts.pidPath, pid);
  return { pid, unit, exitCode: () => unitExitCode(deps, unit) };
}

/**
 * Stops a unit and its whole cgroup with `systemctl --user stop`. Gives true
 * when the unit stopped, and false when no such unit is loaded. Throws on
 * any other failure. `unit` may carry the `.service` suffix or not.
 */
export function stopUnit(unit: string, deps: UnitDeps = defaultUnitDeps): boolean {
  const full = unit.endsWith(".service") ? unit : `${unit}.service`;
  const res = deps.run(["systemctl", "--user", "stop", full], { env: deps.busEnv() });
  if (res.exitCode === 0) return true;
  // systemctl exits with 5 when the unit is not loaded.
  if (res.exitCode === 5 || /not loaded/i.test(res.stderr ?? "")) return false;
  throw new Error(`systemctl cannot stop ${full}: ${failureText(res)}`);
}

/**
 * Whether a unit runs: the manager answers, and the unit is active,
 * activating (also between two starts of `Restart=`), or
 * deactivating. Without a user manager, no unit runs.
 */
export function unitActive(unit: string, deps: UnitDeps = defaultUnitDeps): boolean {
  if (!deps.available()) return false;
  const lines = showUnit(deps, unit, ["ActiveState"]);
  return lines !== null && RUNNING_STATES.has((lines[0] ?? "").trim());
}

/**
 * Stops the units of the given kinds of the server on `port`, in the given
 * order, and gives the names of the units that stopped. A unit that is not
 * loaded is no error. Without a user manager, it does nothing. It never
 * stops the unit of the calling process (`ownUnit`): a stop of the own
 * cgroup would end the caller in the middle of its work. Throws when
 * `systemctl` fails for another reason.
 */
export function stopPortUnits(
  port: number,
  kinds: readonly PortUnitKind[],
  deps: UnitDeps = defaultUnitDeps,
): string[] {
  if (!deps.available()) return [];
  const own = deps.ownUnit();
  const stopped: string[] = [];
  for (const kind of kinds) {
    const unit = portUnitName(kind, port);
    if (unit === own) continue;
    if (stopUnit(unit, deps)) stopped.push(unit);
  }
  return stopped;
}

/** A loaded `ocsub-*` unit, as `systemctl --user show` gives it. */
export type LoadedUnit = {
  /** The unit name without `.service`. */
  unit: string;
  /** The description, normally `owner=<owner> reason=<reason>`. */
  description: string;
  /** The working folder of the unit, or "" when the manager gives none. */
  workingDirectory: string;
  /** The active state, for example `active` or `failed`, or "" when the query did not ask for it. */
  activeState: string;
};

/**
 * The units in the output of `systemctl --user show 'ocsub-*'
 * --property=Id,Description,WorkingDirectory,ActiveState`: one block of
 * `Key=value` lines per unit, and a blank line between two blocks. The unit
 * name has no `.service` suffix. A missing property gives "". Pure.
 */
export function parseUnitShow(text: string): LoadedUnit[] {
  const units: LoadedUnit[] = [];
  for (const block of text.split(/\n\s*\n/)) {
    const fields = new Map<string, string>();
    for (const line of block.split("\n")) {
      const at = line.indexOf("=");
      if (at > 0) fields.set(line.slice(0, at), line.slice(at + 1));
    }
    const id = fields.get("Id");
    if (id === undefined || id.length === 0) continue;
    units.push({
      unit: id.replace(/\.service$/, ""),
      description: fields.get("Description") ?? "",
      workingDirectory: fields.get("WorkingDirectory") ?? "",
      activeState: fields.get("ActiveState") ?? "",
    });
  }
  return units;
}

/**
 * The owner and the reason in a description that `unitDescription` wrote:
 * `owner=<owner> reason=<reason>`. The owner is one word, and the reason is
 * the rest of the line. A description in another form gives the owner "" and
 * the whole text as the reason. Pure.
 */
export function parseUnitLabel(description: string): { owner: string; reason: string } {
  const match = /^owner=(\S*) reason=(.*)$/s.exec(description);
  if (match === null) return { owner: "", reason: description };
  return { owner: match[1] ?? "", reason: match[2] ?? "" };
}

/** The properties that `listUnits` asks for. */
export const LIST_UNIT_PROPERTIES = ["Id", "Description", "WorkingDirectory", "ActiveState"] as const;

/**
 * The loaded `ocsub-*` units, with one call `systemctl --user show
 * 'ocsub-*'`. Gives null when no user manager answers or the call fails, and
 * an empty list when no unit is loaded.
 */
export function listUnits(deps: UnitDeps = defaultUnitDeps): LoadedUnit[] | null {
  if (!deps.available()) return null;
  const res = deps.run(
    ["systemctl", "--user", "show", `${UNIT_PREFIX}*`, `--property=${LIST_UNIT_PROPERTIES.join(",")}`],
    { env: deps.busEnv() },
  );
  if (res.exitCode !== 0) return null;
  return parseUnitShow(res.stdout);
}

/** An orphaned unit and the cause, as short text. */
export type OrphanedUnit = LoadedUnit & { cause: string };

/**
 * The orphaned units in a list of loaded units. A unit is orphaned when:
 *
 * - its working folder does not exist (a removed worktree or a renamed
 *   project), or
 * - it is a helper unit (`proxy` or `idle`, name `ocsub-<kind>-<port>`) of a
 *   port where no server unit (`serve` or `holder`) is in the list.
 *
 * An empty working folder counts as unknown, not as missing. The check does
 * not ask whether a named owner session still lives. Pure apart from
 * `exists`.
 */
export function orphanedUnits(units: readonly LoadedUnit[], exists: (dir: string) => boolean): OrphanedUnit[] {
  const portOf = (unit: string, kinds: readonly string[]): string | null => {
    const match = /^ocsub-([a-z]+)-(\d+)$/.exec(unit);
    if (match === null || !kinds.includes(match[1] ?? "")) return null;
    return match[2] ?? null;
  };
  const serverPorts = new Set<string>();
  for (const u of units) {
    const port = portOf(u.unit, ["serve", "holder"]);
    if (port !== null) serverPorts.add(port);
  }
  const orphans: OrphanedUnit[] = [];
  for (const u of units) {
    if (u.workingDirectory.length > 0 && !exists(u.workingDirectory)) {
      orphans.push({ ...u, cause: `its folder ${u.workingDirectory} is gone` });
      continue;
    }
    const port = portOf(u.unit, ["proxy", "idle"]);
    if (port !== null && !serverPorts.has(port)) {
      orphans.push({ ...u, cause: `no serve or holder unit runs on port ${port}` });
    }
  }
  return orphans;
}
