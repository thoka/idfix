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
 * A test that passes its own env without `XDG_STATE_HOME`, for example `{}`,
 * makes the code fall back to `homedir()`. Bun reads the home folder once at
 * the start of the process, so a change of `process.env.HOME` does not reach
 * `homedir()`. So the preload replaces `homedir` of `node:os` with
 * `<run folder>/home` (`TEST_HOME`). No test then reads or writes
 * `~/.local/state/idfx` or another folder in the real home. `HOME` of the
 * process points there too, so a child process also gets the test home.
 *
 * The inference guard: no test may cause inference costs. Before, a child
 * got the real `HOME`, `PATH`, and keys, so it could reach the real
 * `claude`, its login, or a paid model route. Now the preload:
 *
 * - puts the folder `<run folder>/guard-bin` (`GUARD_BIN`) first on PATH.
 *   Its fake `claude` and `claude-glm` print `idfx test guard: ...` on
 *   stderr and exit with 97. Its `opencode` refuses `opencode run` the same
 *   way and runs the real opencode for every other command, so
 *   `opencode serve` of the integration tests still works.
 * - drops each key variable from the environment (`isKeyVariable`: a fixed
 *   list and each name that ends in `_API_KEY`, `_TOKEN`, `_SECRET`, or
 *   `_ACCESS_KEY`).
 * - points `HOME`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME`, `XDG_DATA_HOME`,
 *   `XDG_CACHE_HOME`, and `CLAUDE_CONFIG_DIR` into the run folder. A key
 *   file such as `~/.config/idfix/openrouter.key` is then out of reach.
 * - gives git a test identity: `GIT_CONFIG_GLOBAL` names
 *   `<run folder>/gitconfig`, and no test reads the real `~/.gitconfig`.
 * - keeps the shared bun install cache (`BUN_INSTALL_CACHE_DIR`, computed
 *   before the move of `HOME`), so bun and opencode download no npm
 *   package again.
 * - makes a `fetch` of the test process to a model provider host
 *   (`MODEL_PROVIDER_HOSTS`) throw.
 *
 * A unit that `up` starts under the user manager gets the environment of
 * the CLI as `--setenv` names (`src/units.ts`), so it also gets the test
 * home and no key. The user manager itself holds no key variable.
 *
 * A test that must call a model is `live`: it uses `liveTest` or
 * `liveDescribe` and runs only when the run starts with `IDFX_LIVE=1`. The
 * push gate never sets it. The preload deletes `IDFX_LIVE`, so no child
 * sees it, and `LIVE_ENV` gives a live test the environment of the start.
 * The static check test/no-inference.test.ts fails on a provider host or a
 * model CLI command in a test file without a reason. The guard does not
 * block the network of a child at the kernel level.
 *
 * The preload also changes the current folder of the process to
 * `<run folder>/cwd` (`TEST_CWD`). Code that falls back to
 * `process.cwd()`, for example the run records in `.opencode/runs/` that
 * `status` loads, then never sees the folders of the repository. A spawn
 * without a `cwd` option still starts in the repository root (`REPO_ROOT`),
 * so `bun run src/cli.ts` and other relative commands keep working.
 *
 * The preload also removes the repository-local git variables (GIT_DIR,
 * GIT_INDEX_FILE, and the others of `git rev-parse --local-env-vars`). A git
 * hook sets them, for example the pre-push hook of lefthook.yml. Every git
 * command that a test starts inherits `process.env`, so without this step a
 * `git init` or `git rev-parse` in a temp folder acts on the idfix
 * repository itself (meta lesson git-hook-env-leaks-into-other-repos).
 *
 * The preload also guards the real user manager. `up`, `down`, and the
 * watchdog start and stop `idfx-<kind>-<port>` units (`ocsub-` of older code), and a unit test that
 * forgets its fake `UnitDeps` would stop the real server of another session
 * on the same port. So the real runner of `units.ts` refuses a start, a
 * stop, or another change (`CHANGING_VERBS`, for example `enable` or
 * `restart`) of any unit other than `idfx-test-*` (the live test of
 * units.ts) and the units of the ports of the integration tests, and throws
 * instead. This also covers the installed unit `idfx-proxy` of `doctor`.
 *
 * After the last test, the preload also reaps the units that a test left
 * loaded, like the Ryuk container of Testcontainers. The integration tests
 * start their units with `IDFX_OWNER=test`, and their teardown stops them
 * and fails when one is left. A test run that crashed or was killed cannot
 * do that, so the global `afterAll` lists the loaded units of idfx and
 * stops each unit that matches all of these:
 *
 * - its description starts with `owner=test `,
 * - `testMayTouchUnit` allows its name (a port of the integration tests or
 *   `idfx-test-*`, and both with the old prefix `ocsub-`),
 * - its working folder lies in a test run folder `oc-sub-test-run-*`, and
 *   that run is this run, or a run whose bun process is gone.
 *
 * The last rule keeps the units of a second test run that works at the same
 * time, for example in another worktree. Each stopped unit gives one warning
 * line. A unit with another owner is never touched. Without a user manager,
 * the reaper does nothing.
 *
 * Bun 1.4 has a trap here: `Bun.spawn` and `Bun.spawnSync` without an `env`
 * option pass the environment of the process start, not the current
 * `process.env`. A deleted or changed variable does not reach the child. So
 * the preload wraps both functions: a call without `env` gets
 * `process.env`. This also makes TMPDIR and the XDG folders below reach the
 * children. `node:child_process` already reads `process.env`.
 */
import { afterAll, describe, mock, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultUnitDeps, listUnits, stopUnit, type LoadedUnit } from "../src/units";

/**
 * The time limit of each test. Many tests start a fresh `bun run src/cli.ts`
 * child, which takes about 0.2 s on an idle machine but more than the default
 * 5 s when the heavy queue runs other suites beside this one (a doctor test
 * failed so on 2026-10-19 after 6.8 s). A test with its own limit keeps it.
 */
export const TEST_TIMEOUT_MS = 30_000;
setDefaultTimeout(TEST_TIMEOUT_MS);

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

/** The repository root: the current folder of the process before the preload changes it. */
export const REPO_ROOT = process.cwd();

/**
 * Wrap a Bun spawn function so that a call without `env` passes
 * `process.env`, and a call without `cwd` starts in `REPO_ROOT`.
 */
function withCurrentEnv<F extends (...args: never[]) => unknown>(spawn: F): F {
  const wrapped = (first: unknown, second?: SpawnOptions) => {
    // The form spawn({ cmd, ...options }).
    if (!Array.isArray(first) && typeof first === "object" && first !== null) {
      const options = first as SpawnOptions;
      return (spawn as unknown as (o: unknown) => unknown)({
        ...options,
        env: options.env ?? process.env,
        cwd: options.cwd ?? REPO_ROOT,
      });
    }
    // The form spawn(cmd, options).
    return (spawn as unknown as (c: unknown, o: unknown) => unknown)(first, {
      ...second,
      env: second?.env ?? process.env,
      cwd: second?.cwd ?? REPO_ROOT,
    });
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
  if (name.startsWith("idfx-test-") || name.startsWith("ocsub-test-")) return true;
  const match = /^(?:idfx|ocsub)-[a-z]+-(\d+)$/.exec(name);
  if (match === null) return false;
  const port = Number(match[1]);
  return port >= INTEGRATION_PORTS.first && port <= INTEGRATION_PORTS.last;
}

/**
 * The `systemctl` verbs that change a unit. A read such as `show` or
 * `is-active` stays allowed, and so does `daemon-reload`, which names no unit.
 */
export const CHANGING_VERBS: ReadonlySet<string> = new Set([
  "start",
  "stop",
  "restart",
  "try-restart",
  "reload",
  "reload-or-restart",
  "try-reload-or-restart",
  "kill",
  "enable",
  "disable",
  "reenable",
  "mask",
  "unmask",
  "link",
  "revert",
  "preset",
]);

/**
 * The unit that a `systemd-run` call starts, or that a `systemctl` call with
 * a changing verb (`CHANGING_VERBS`) changes, or null. Pure.
 */
export function unitOfCall(cmd: readonly string[]): string | null {
  if (cmd[0] === "systemd-run") {
    const flag = cmd.find((arg) => arg.startsWith("--unit="));
    return flag === undefined ? null : flag.slice("--unit=".length);
  }
  if (cmd[0] === "systemctl" && cmd.some((arg) => CHANGING_VERBS.has(arg))) return cmd[cmd.length - 1] ?? null;
  return null;
}

/** The owner that the integration tests give their units (`IDFX_OWNER`). */
export const TEST_OWNER = "test";

/** The test run folder (`<tmp>/oc-sub-test-run-*`) that holds the absolute path `dir`, or null. Pure. */
export function runFolderOf(dir: string, systemTmp: string): string | null {
  // A relative path, also "", would resolve against the current folder.
  if (!path.isAbsolute(dir)) return null;
  const rel = path.relative(systemTmp, dir);
  if (rel.length === 0 || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  const first = rel.split(path.sep)[0] ?? "";
  return first.startsWith(RUN_PREFIX) ? path.join(systemTmp, first) : null;
}

/**
 * The units that the reaper stops: the owner is `test`, a test may touch
 * the unit, and its working folder lies in a run folder that `mayReap`
 * accepts (this run, or a run that is gone). Never a unit with another
 * owner. Pure.
 */
export function unitsToReap(
  units: readonly LoadedUnit[],
  systemTmp: string,
  mayReap: (runFolder: string) => boolean,
): LoadedUnit[] {
  return units.filter((u) => {
    if (!u.description.startsWith(`owner=${TEST_OWNER} `) || !testMayTouchUnit(u.unit)) return false;
    const run = runFolderOf(u.workingDirectory, systemTmp);
    return run !== null && mayReap(run);
  });
}

/** The file in a run folder that names the PID of its bun process. */
const RUN_PID_FILE = "run.pid";

/** Whether the bun process of a test run folder still runs. A missing or bad PID file means no. */
function runAlive(runFolder: string): boolean {
  try {
    const pid = Number.parseInt(readFileSync(path.join(runFolder, RUN_PID_FILE), "utf8"), 10);
    if (!Number.isInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Stops the test units that this run, or a run that is gone, left loaded,
 * and prints one warning line for each. Without a user manager, it does
 * nothing. A failed `systemctl` call gives a warning and no error.
 */
export function reapTestUnits(thisRun: string, systemTmp: string): string[] {
  const units = listUnits(defaultUnitDeps);
  if (units === null) return [];
  const stopped: string[] = [];
  for (const u of unitsToReap(units, systemTmp, (run) => run === thisRun || !runAlive(run))) {
    try {
      if (stopUnit(u.unit)) {
        stopped.push(u.unit);
        console.warn(`warning: a test left the unit ${u.unit} (${u.description}); the test preload stopped it`);
      }
    } catch (error) {
      console.warn(`warning: cannot stop the test unit ${u.unit}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return stopped;
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
writeFileSync(path.join(runDir, RUN_PID_FILE), `${process.pid}\n`);
process.env.TMPDIR = runDir;
// bun test does not emit the "exit" event, but a global afterAll in the
// preload runs once after the last test file. The reaper runs first, so
// that it still finds the PID file of this run.
afterAll(() => {
  reapTestUnits(runDir, systemTmp);
  rmSync(runDir, { recursive: true, force: true });
});

/** Whether this run was started with `IDFX_LIVE=1`, the opt-in for the `live` tests. */
export const LIVE = process.env.IDFX_LIVE === "1";
/**
 * The environment of the start of the run, for a `live` test only. It is
 * undefined unless the run was started with `IDFX_LIVE=1`, so no other test
 * can reach the real home, PATH, or keys through it.
 */
export const LIVE_ENV: Readonly<Record<string, string | undefined>> | undefined = LIVE
  ? Object.freeze({ ...process.env })
  : undefined;
delete process.env.IDFX_LIVE;

/** A test that calls a real model and costs money. It runs only with `IDFX_LIVE=1`, never in the push gate. */
export const liveTest = test.if(LIVE);
/** A group of `live` tests, see `liveTest`. */
export const liveDescribe = describe.if(LIVE);

/** The text that every refusal of the inference guard starts with. */
export const GUARD_MESSAGE = "idfx test guard";

/** The hosts of paid model providers. A test reaches none of them (test/no-inference.test.ts). */
export const MODEL_PROVIDER_HOSTS: readonly string[] = [
  "api.anthropic.com",
  "openrouter.ai",
  "api.z.ai",
  "open.bigmodel.cn",
  "api.deepinfra.com",
  "api.together.xyz",
  "generativelanguage.googleapis.com",
  "aiplatform.googleapis.com",
  "api.openai.com",
  "api.groq.com",
  "api.mistral.ai",
  "api.fireworks.ai",
  "api.x.ai",
];

/** Whether `url` names a host of a paid model provider (or a subdomain of one). Pure. */
export function isProviderUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return MODEL_PROVIDER_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

/** The key variables that the guard always drops, also when the pattern of `isKeyVariable` misses one. */
const KEY_VARIABLES: ReadonlySet<string> = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENROUTER_API_KEY",
  "ZAI_API_KEY",
  "Z_AI_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "DEEPINFRA_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
]);

/** Whether an env variable holds a key, a token, or a secret. Pure. */
export function isKeyVariable(name: string): boolean {
  return KEY_VARIABLES.has(name) || /(_API_KEY|_TOKEN|_SECRET|_SECRET_KEY|_ACCESS_KEY|_ACCESS_KEY_ID)$/.test(name);
}

/**
 * The bun install cache of the start of the run, by the order of bun:
 * `BUN_INSTALL_CACHE_DIR`, `$BUN_INSTALL/install/cache`,
 * `$XDG_CACHE_HOME/.bun/install/cache`, `$HOME/.bun/install/cache`. Pure.
 */
export function bunCacheDir(env: Record<string, string | undefined>, home: string): string {
  if (env.BUN_INSTALL_CACHE_DIR) return env.BUN_INSTALL_CACHE_DIR;
  if (env.BUN_INSTALL) return path.join(env.BUN_INSTALL, "install", "cache");
  if (env.XDG_CACHE_HOME) return path.join(env.XDG_CACHE_HOME, ".bun", "install", "cache");
  return path.join(home, ".bun", "install", "cache");
}

// The moved HOME and XDG_CACHE_HOME must not make bun or opencode download
// the npm packages again: keep the shared bun cache of the user.
process.env.BUN_INSTALL_CACHE_DIR = bunCacheDir(process.env, process.env.HOME ?? os.homedir());

for (const name of Object.keys(process.env)) if (isKeyVariable(name)) delete process.env[name];

/** The folder of the fake model CLIs, first on PATH. */
export const GUARD_BIN = path.join(runDir, "guard-bin");
mkdirSync(GUARD_BIN);

/** A shell script that refuses with the guard message and exit code 97. */
function refusal(name: string): string {
  return (
    `echo "${GUARD_MESSAGE}: a test ran the real ${name} ($*). No test may cause inference costs. ` +
    `Pass a fake, or mark the test live (liveTest of test/setup.ts, IDFX_LIVE=1)." >&2\nexit 97\n`
  );
}

for (const name of ["claude", "claude-glm"]) {
  writeFileSync(path.join(GUARD_BIN, name), `#!/bin/sh\n${refusal(name)}`, { mode: 0o755 });
}
// `opencode serve` and the other commands stay real, only `opencode run` sends a prompt.
const realOpencode = Bun.which("opencode");
if (realOpencode !== null) {
  writeFileSync(
    path.join(GUARD_BIN, "opencode"),
    `#!/bin/sh\nif [ "$1" = run ]; then\n${refusal("opencode run")}fi\nexec ${JSON.stringify(realOpencode)} "$@"\n`,
    { mode: 0o755 },
  );
}
process.env.PATH = `${GUARD_BIN}:${process.env.PATH ?? ""}`;
// Like Bun.spawn, Bun.which reads the PATH of the process start by default.
const realWhich = Bun.which;
Bun.which = ((command: string, options?: { PATH?: string; cwd?: string }) =>
  realWhich(command, { PATH: process.env.PATH, ...options })) as typeof Bun.which;

// A fetch of the test process to a model provider throws. A child is not
// covered; the fake CLIs and the dropped keys guard it.
const realFetch = globalThis.fetch;
const guardedFetch = (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (isProviderUrl(url)) {
    return Promise.reject(new Error(`${GUARD_MESSAGE}: a test fetched the model provider ${url}. Pass a fake fetch.`));
  }
  return realFetch(input, init);
};
globalThis.fetch = Object.assign(guardedFetch, { preconnect: realFetch.preconnect }) as typeof fetch;

// git of a child reads a test identity, never the real ~/.gitconfig.
process.env.GIT_CONFIG_GLOBAL = path.join(runDir, "gitconfig");
writeFileSync(process.env.GIT_CONFIG_GLOBAL, "[user]\n\tname = idfx test\n\temail = idfx-test@example.invalid\n");

process.env.XDG_CONFIG_HOME = path.join(runDir, "xdg-config");
mkdirSync(process.env.XDG_CONFIG_HOME);
process.env.XDG_DATA_HOME = path.join(runDir, "xdg-data");
process.env.XDG_STATE_HOME = path.join(runDir, "xdg-state");
process.env.XDG_CACHE_HOME = path.join(runDir, "xdg-cache");
process.env.CLAUDE_CONFIG_DIR = path.join(runDir, "claude");
mkdirSync(process.env.XDG_DATA_HOME);
mkdirSync(process.env.XDG_STATE_HOME);
mkdirSync(process.env.XDG_CACHE_HOME);
mkdirSync(process.env.CLAUDE_CONFIG_DIR);

/** The home folder that `homedir()` gives in a test. */
export const TEST_HOME = path.join(runDir, "home");
/** The current folder of the process in a test. */
export const TEST_CWD = path.join(runDir, "cwd");
mkdirSync(TEST_HOME);
mkdirSync(TEST_CWD);
process.env.HOME = TEST_HOME;
const realOs = { ...os };
mock.module("node:os", () => ({
  ...realOs,
  homedir: () => TEST_HOME,
  default: { ...realOs, homedir: () => TEST_HOME },
}));
process.chdir(TEST_CWD);
