/**
 * Test preload (bunfig.toml). It gives each test run one temporary folder,
 * `oc-sub-test-run-*` in the system temp folder, and removes it after the
 * last test. `TMPDIR` points at it, so every `mkdtempSync(tmpdir())` of a
 * test lands inside it and goes away with it. Before, each run left about 200
 * folders in /tmp, and the tmpfs ran out of inodes.
 *
 * A run that was killed cannot remove its folder. So the preload also removes
 * run folders older than STALE_MS.
 *
 * The XDG data and state folders of this process also point into the run
 * folder. A code path that falls back to `process.env` then never writes into
 * the real `~/.local/share/oc-sub` or `~/.local/state/oc-sub`. Tests that pass
 * their own env still set their own folders.
 *
 * The Claude Code root and the XDG cache folder point into the run folder
 * too, so `status` never lists the real Claude sessions of the machine and
 * never downloads or reads the real price cache.
 *
 * The preload also removes the repository-local git variables (GIT_DIR,
 * GIT_INDEX_FILE, and the others of `git rev-parse --local-env-vars`). A git
 * hook sets them, for example the pre-push hook of lefthook.yml. Every git
 * command that a test starts inherits `process.env`, so without this step a
 * `git init` or `git rev-parse` in a temp folder acts on the idfix
 * repository itself (meta lesson git-hook-env-leaks-into-other-repos).
 *
 * The preload also guards the real user manager. `up`, `down`, and the
 * watchdog start and stop `ocsub-<kind>-<port>` units, and a unit test that
 * forgets its fake `UnitDeps` would stop the real server of another session
 * on the same port. So the real runner of `units.ts` refuses a start or a
 * stop of any unit other than `ocsub-test-*` (the live test of units.ts)
 * and the units of the ports of the integration tests, and throws instead.
 *
 * Bun 1.4 has a trap here: `Bun.spawn` and `Bun.spawnSync` without an `env`
 * option pass the environment of the process start, not the current
 * `process.env`. A deleted or changed variable does not reach the child. So
 * the preload wraps both functions: a call without `env` gets
 * `process.env`. This also makes TMPDIR and the XDG folders below reach the
 * children. `node:child_process` already reads `process.env`.
 */
import { afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultUnitDeps } from "../src/units";

export const RUN_PREFIX = "oc-sub-test-run-";
const STALE_MS = 6 * 60 * 60 * 1000;

/** The fallback list, from git 2.5x, if git is missing. */
const LOCAL_GIT_ENV_VARS = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_OBJECT_DIRECTORY",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_REPLACE_REF_BASE",
  "GIT_PREFIX",
  "GIT_SHALLOW_FILE",
  "GIT_COMMON_DIR",
];

/** The names that `git rev-parse --local-env-vars` prints, or the fallback list. */
export function localGitEnvVars(): string[] {
  try {
    const proc = Bun.spawnSync(["git", "rev-parse", "--local-env-vars"], { stdout: "pipe", stderr: "ignore" });
    const names = proc.stdout.toString().split("\n").filter((name) => name.length > 0);
    if (proc.exitCode === 0 && names.length > 0) return [...new Set([...names, ...LOCAL_GIT_ENV_VARS])];
  } catch {
    // git is missing.
  }
  return LOCAL_GIT_ENV_VARS;
}

/** Remove the repository-local git variables from `env`. */
export function clearLocalGitEnv(env: Record<string, string | undefined> = process.env): void {
  for (const name of localGitEnvVars()) delete env[name];
}

type SpawnOptions = { env?: Record<string, string | undefined> } & Record<string, unknown>;

/** Wrap a Bun spawn function so that a call without `env` passes `process.env`. */
function withCurrentEnv<F extends (...args: never[]) => unknown>(spawn: F): F {
  const wrapped = (first: unknown, second?: SpawnOptions) => {
    // The form spawn({ cmd, ...options }).
    if (!Array.isArray(first) && typeof first === "object" && first !== null) {
      const options = first as SpawnOptions;
      return (spawn as unknown as (o: unknown) => unknown)({ ...options, env: options.env ?? process.env });
    }
    // The form spawn(cmd, options).
    return (spawn as unknown as (c: unknown, o: unknown) => unknown)(first, { ...second, env: second?.env ?? process.env });
  };
  return wrapped as unknown as F;
}

Bun.spawn = withCurrentEnv(Bun.spawn);
Bun.spawnSync = withCurrentEnv(Bun.spawnSync);

clearLocalGitEnv();

/** The ports of the servers of test/integration.test.ts. */
export const INTEGRATION_PORTS = { first: 8790, last: 8900 } as const;

/** Whether a test may start or stop this real unit. Pure. */
export function testMayTouchUnit(unit: string): boolean {
  const name = unit.replace(/\.service$/, "");
  if (name.startsWith("ocsub-test-")) return true;
  const match = /^ocsub-[a-z]+-(\d+)$/.exec(name);
  if (match === null) return false;
  const port = Number(match[1]);
  return port >= INTEGRATION_PORTS.first && port <= INTEGRATION_PORTS.last;
}

/** The unit that a `systemd-run` or `systemctl stop` call starts or stops, or null. Pure. */
export function unitOfCall(cmd: readonly string[]): string | null {
  if (cmd[0] === "systemd-run") {
    const flag = cmd.find((arg) => arg.startsWith("--unit="));
    return flag === undefined ? null : flag.slice("--unit=".length);
  }
  if (cmd[0] === "systemctl" && cmd.includes("stop")) return cmd[cmd.length - 1] ?? null;
  return null;
}

const realUnitRun = defaultUnitDeps.run;
defaultUnitDeps.run = (cmd, opts) => {
  const unit = unitOfCall(cmd);
  if (unit !== null && !testMayTouchUnit(unit)) {
    throw new Error(`a test reached the real user manager for ${unit}; pass a fake UnitDeps (test/fake-units.ts)`);
  }
  return realUnitRun(cmd, opts);
};

const systemTmp = tmpdir();

for (const name of readdirSync(systemTmp)) {
  if (!name.startsWith(RUN_PREFIX)) continue;
  const dir = path.join(systemTmp, name);
  try {
    if (Date.now() - statSync(dir).mtimeMs > STALE_MS) rmSync(dir, { recursive: true, force: true });
  } catch {
    // Another run removed it first.
  }
}

const runDir = mkdtempSync(path.join(systemTmp, RUN_PREFIX));
process.env.TMPDIR = runDir;
// bun test does not emit the "exit" event, but a global afterAll in the
// preload runs once after the last test file.
afterAll(() => rmSync(runDir, { recursive: true, force: true }));

process.env.XDG_DATA_HOME = path.join(runDir, "xdg-data");
process.env.XDG_STATE_HOME = path.join(runDir, "xdg-state");
process.env.XDG_CACHE_HOME = path.join(runDir, "xdg-cache");
process.env.CLAUDE_CONFIG_DIR = path.join(runDir, "claude");
mkdirSync(process.env.XDG_DATA_HOME);
mkdirSync(process.env.XDG_STATE_HOME);
mkdirSync(process.env.XDG_CACHE_HOME);
mkdirSync(process.env.CLAUDE_CONFIG_DIR);
