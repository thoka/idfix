/**
 * `oc-sub worktree` and `oc-sub fetch`: the run worktrees of sandbox clone
 * mode. The worktree of a run lives only inside the in-container clone of
 * the sandbox, not on the host, so every git step goes through
 * `sbx exec NAME ...` with the runner (like `upSandbox`). The host only
 * fetches the finished branches from the `sandbox-<name>` remote that
 * `sbx` manages (run-isolation.md section 2.4). The clone itself fetches
 * new host commits from the read-only host repository through its remote
 * `host`, never through `origin`. Both commands work only in
 * sandbox mode: without a sandbox state file for the project they stop with
 * an error. All `sbx` calls go through a runner, so the tests replace it
 * with a fake and never call the real `sbx`.
 */
import path from "node:path";
import { assertOk, errorMessage, makeClient } from "./client";
import type { Env } from "./config";
import { projectRootOfRun, projectNameOf } from "./keys";
import { projectSetupCommand } from "./project-config";
import {
  defaultRunner,
  listsCloneRemote,
  miseBin,
  miseInstallsDir,
  projectToolPath,
  readSandboxState,
  sandboxMiseBinDir,
  sandboxMiseEnv,
  sandboxStatePath,
  sandboxToolPathEntry,
  shellQuote,
  sbxBin,
  type Runner,
  type SandboxState,
} from "./sandbox";

/** The parts of the worktree and fetch commands that the tests replace. */
export type CloneDeps = {
  /** Runs the `sbx` and host `git` commands. */
  runner: Runner;
  /** The sandbox state of a project, or null without a state file. */
  sandboxState: (project: string) => SandboxState | null;
  /** The project name of a directory. */
  projectName: (directory: string) => string;
  /** The `setup` command of a project root, or undefined without one. */
  setupCommand: (root: string) => string | undefined;
  /** Disposes the opencode instance of a directory. Rejects when the server does not answer. */
  dispose: (baseUrl: string, directory: string) => Promise<void>;
  /** Waits for a delay, so the retry pause of `worktreeRm` is testable. */
  sleep: (ms: number) => Promise<void>;
};

export const defaultCloneDeps: CloneDeps = {
  runner: defaultRunner,
  sandboxState: (project) => readSandboxState(sandboxStatePath(process.env as Env, project)),
  projectName: projectNameOf,
  setupCommand: projectSetupCommand,
  dispose: async (baseUrl, directory) => {
    assertOk(await makeClient(baseUrl, process.env as Env).instance.dispose({ query: { directory } }), "dispose instance");
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

function mergeDeps(overrides: Partial<CloneDeps>): CloneDeps {
  return { ...defaultCloneDeps, ...overrides };
}

/** The state of the project of `--dir`, or null in host mode. */
function stateFor(
  args: { dir?: string },
  env: Env,
  deps: CloneDeps,
): { root: string; state: SandboxState; project: string } | null {
  const dir = path.resolve(args.dir ?? process.cwd());
  const project = deps.projectName(projectRootOfRun(dir));
  const state = deps.sandboxState(project);
  // The sandbox was created from the main checkout root, and the clone in
  // the sandbox lies at that same absolute path. Git therefore runs with
  // `-C state.root`, never with the folder of `--dir` itself.
  return state === null ? null : { root: state.root, state, project };
}

const HOST_MODE_ERROR =
  "oc-sub worktree and oc-sub fetch work only in sandbox mode. Run oc-sub up for the project first.";

function fail(message: string): number {
  console.error(`error: ${message}`);
  return 1;
}

/** The worktree folder of a step inside the clone: `<root>/.worktrees/<step>`. */
export function runWorktreePath(root: string, step: string): string {
  return path.join(root, ".worktrees", step);
}

/**
 * The read-only host repository inside a clone-mode sandbox. The clone
 * fetches new host commits from here.
 */
export const HOST_SOURCE = "/run/sandbox/source";

/** The remote of the clone that points to `HOST_SOURCE`. */
export const HOST_REMOTE = "host";

/**
 * The base branches that `oc-sub worktree` tries without `--base`, in this
 * order. `alpha` holds the finished features; a repository without it
 * works on `main`.
 */
export const DEFAULT_BASES = ["alpha", "main", "master"] as const;

/**
 * `oc-sub worktree STEP [--dir ROOT] [--base BRANCH] [--no-setup]`: create
 * the worktree of a run inside the sandbox clone. It makes sure that the
 * remote `host` of the clone points to the read-only host repository at
 * `/run/sandbox/source`, fetches new host commits from it, sets the git
 * identity of the host repository in the clone (a fresh clone has none),
 * and creates `feature/STEP` from `host/BASE`. Without `--base`, BASE is the
 * first of `DEFAULT_BASES` that exists on the host. A missing base stops
 * with an error that names it. It does not fetch `origin`:
 * the clone copies the remotes of the host, so `origin` can be an SSH URL
 * that the sandbox cannot reach (run-isolation.md section 9). When the
 * worktree already exists and git knows it, it says so and exits 0. A
 * folder that exists but is not a registered worktree is stale: it stops
 * with an error that names the folder and `oc-sub worktree rm`.
 *
 * When the project sets a `setup` command in `.opencode/oc-sub.json`, it
 * runs that command inside the new worktree after a successful `git
 * worktree add` (for example `bun install`, because the worktree holds
 * only tracked files and no `node_modules`). With a sandbox mise, `mise
 * install` runs first in the same `sh -c`, so a tool that only the `mise.toml`
 * of the worktree names exists before the setup command. Without a setup
 * command, a sandbox mise still runs `mise install`. `--no-setup` skips all
 * of it. On a failing command it prints the output, tells how to run it by
 * hand, keeps the worktree, and exits 1.
 */
export async function worktree(
  args: { step: string; dir?: string; base?: string; noSetup?: boolean },
  env: Env = process.env,
  depsOverrides: Partial<CloneDeps> = {},
): Promise<number> {
  const deps = mergeDeps(depsOverrides);
  const found = stateFor(args, env, deps);
  if (found === null) return fail(HOST_MODE_ERROR);
  const { root, state } = found;
  const bin = sbxBin(env);
  const { name } = state;
  const run = (cmd: readonly string[], opts?: { cwd?: string }) => deps.runner(cmd, opts);
  const sbxGit = (...gitArgs: readonly string[]) => run([bin, "exec", name, "git", "-C", root, ...gitArgs]);
  const worktreePath = runWorktreePath(root, args.step);

  if (run([bin, "exec", name, "test", "-d", worktreePath]).exitCode === 0) {
    // The folder exists, but only a registered worktree counts: opencode can
    // leave a stale folder behind when it still wrote into it during a
    // `git worktree remove`. Git then knows nothing about the folder.
    const registered = run([bin, "exec", name, "git", "-C", worktreePath, "rev-parse", "--git-dir"]);
    if (registered.exitCode === 0) {
      await disposeFresh(deps, state.port, worktreePath);
      console.log(`worktree already exists: ${worktreePath}`);
      return 0;
    }
    return fail(
      `${worktreePath} exists but is not a registered worktree (stale leftover of an earlier run). Remove it with: oc-sub worktree rm ${args.step}`,
    );
  }

  // Add the remote `host`, or set its URL when it exists already.
  const hasHost = sbxGit("remote", "get-url", HOST_REMOTE).exitCode === 0;
  const remote = hasHost
    ? sbxGit("remote", "set-url", HOST_REMOTE, HOST_SOURCE)
    : sbxGit("remote", "add", HOST_REMOTE, HOST_SOURCE);
  if (remote.exitCode !== 0) return fail(`git remote ${hasHost ? "set-url" : "add"} ${HOST_REMOTE} failed in the clone of ${name}`);

  const fetch = sbxGit("fetch", "-q", HOST_REMOTE);
  if (fetch.exitCode !== 0) return fail(`git fetch ${HOST_REMOTE} failed in the clone of ${name}`);

  // A fresh clone has no user.name and no user.email, so a commit inside
  // would fail or carry the sandbox identity. Copy the identity of the host
  // repository, so the commits of the agent carry the name of the user.
  for (const key of ["user.name", "user.email"]) {
    const value = run(["git", "-C", root, "config", key]).stdout.trim();
    if (value.length === 0) continue;
    const set = sbxGit("config", key, value);
    if (set.exitCode !== 0) return fail(`git config ${key} failed in the clone of ${name}`);
  }

  // The base branch must exist on the host. Without `--base`, take the first
  // of DEFAULT_BASES that exists: a repository can have only `main`.
  const hasBase = (branch: string) =>
    sbxGit("rev-parse", "--verify", "--quiet", `refs/remotes/${HOST_REMOTE}/${branch}`).exitCode === 0;
  let base: string;
  if (args.base !== undefined) {
    if (!hasBase(args.base)) return fail(`the base branch ${args.base} does not exist in the host repository ${root}`);
    base = args.base;
  } else {
    const found = DEFAULT_BASES.find(hasBase);
    if (found === undefined) {
      return fail(
        `none of the default base branches ${DEFAULT_BASES.join(", ")} exists in the host repository ${root}; name one with --base BRANCH`,
      );
    }
    base = found;
    if (base !== DEFAULT_BASES[0]) console.log(`base: ${base} (no ${DEFAULT_BASES[0]} branch)`);
  }
  const add =sbxGit("worktree", "add", "-b", `feature/${args.step}`, worktreePath, `${HOST_REMOTE}/${base}`);
  if (add.exitCode !== 0) return fail(`git worktree add failed in the clone of ${name}`);
  await disposeFresh(deps, state.port, worktreePath);

  // The worktree holds only tracked files, so it has no `node_modules`. The
  // project can set a setup command in `.opencode/oc-sub.json`; run it once
  // inside the new worktree. First `mise install` installs the tools of the
  // `mise.toml` of the worktree (a worktree can name a tool that the host
  // never installed), then the setup command runs in the same `sh -c`. The
  // PATH puts the tool folders of the project and the bin folder of the
  // sandbox mise in front, and the `sandboxMiseEnv` variables give the
  // sandbox mise its settings, like the holder command in `upSandbox`. With
  // `--no-setup` nothing runs; without a sandbox mise the old behavior
  // stays: only the setup command, with the tool PATH of the host.
  if (args.noSetup !== true) {
    const setup = deps.setupCommand(root);
    const toolPath = projectToolPath(
      run([miseBin(env), "env", "-C", root, "--json"], { cwd: root }).stdout,
      miseInstallsDir(env),
    );
    const miseBinDir = sandboxMiseBinDir(run, env, root);
    const inner =
      miseBinDir !== undefined
        ? setup !== undefined
          ? `exec 2>&1; mise install && ${setup}`
          : "exec 2>&1; mise install"
        : setup !== undefined
          ? `exec 2>&1; ${setup}`
          : undefined;
    if (inner !== undefined) {
      console.log(`setup: ${setup ?? "mise install"}`);
      const setupCmd = [
        bin,
        "exec",
        "-w",
        worktreePath,
        "-e",
        sandboxToolPathEntry(toolPath, miseBinDir),
        ...sandboxMiseEnv(miseInstallsDir(env), root).flatMap((entry) => ["-e", entry]),
        name,
        "sh",
        "-c",
        inner,
      ];
      const setupRun = run(setupCmd);
      if (setupRun.exitCode !== 0) {
        if (setupRun.stdout.length > 0) console.error(setupRun.stdout);
        console.error(`error: the setup command failed in ${worktreePath} (exit ${setupRun.exitCode})`);
        console.error(`run it again by hand: ${setupCmd.map(shellQuote).join(" ")}`);
        return 1;
      }
    }
  }

  console.log(`worktree: ${worktreePath}`);
  console.log(`start the run with: oc-sub run --dir ${worktreePath} ...`);
  return 0;
}

/**
 * Dispose the cached opencode instance of a new worktree. opencode keeps
 * one instance per directory. When a run reached the folder before it
 * existed, that instance stays broken, and every later prompt there fails
 * with "NotFound: FileSystem.realPath" before any model call. A failed
 * dispose is only a warning: the server may be down.
 */
async function disposeFresh(deps: CloneDeps, port: number, worktreePath: string): Promise<void> {
  try {
    await deps.dispose(`http://127.0.0.1:${port}`, worktreePath);
  } catch (error) {
    console.error(`warning: could not reset the opencode instance of ${worktreePath}: ${errorMessage(error)}`);
  }
}

/**
 * `oc-sub worktree rm STEP [--dir ROOT]`: remove the worktree of the step
 * inside the clone and delete its branch there. The branch only exists in
 * the clone; the host reviews it through the `sandbox-<name>` remote.
 *
 * Order of the steps:
 *  1. dispose the opencode instance of the folder, so that opencode stops
 *     writing into it (a failed dispose is only a warning: the server may
 *     be down),
 *  2. `git worktree remove --force`; on failure print the stderr, wait two
 *     seconds, and try once more,
 *  3. when the folder still exists, `rm -rf` it inside the sandbox and run
 *     `git worktree prune`,
 *  4. delete the branch,
 *  5. verify: a leftover folder or branch fails with exit 1, and so does a
 *     removal that needed the fallback.
 */
export async function worktreeRm(
  args: { step: string; dir?: string },
  env: Env = process.env,
  depsOverrides: Partial<CloneDeps> = {},
): Promise<number> {
  const deps = mergeDeps(depsOverrides);
  const found = stateFor(args, env, deps);
  if (found === null) return fail(HOST_MODE_ERROR);
  const { root, state } = found;
  const bin = sbxBin(env);
  const { name } = state;
  const run = (cmd: readonly string[]) => deps.runner(cmd);
  const sbxGit = (...gitArgs: readonly string[]) => run([bin, "exec", name, "git", "-C", root, ...gitArgs]);
  const worktreePath = runWorktreePath(root, args.step);

  // opencode runs a background package install in every config folder and
  // keeps writing into it. Dispose the instance first, so the folder is
  // quiet when git removes it. A failed dispose is only a warning: the
  // server may be down, and then nothing holds the folder open.
  try {
    await deps.dispose(`http://127.0.0.1:${state.port}`, worktreePath);
  } catch (error) {
    console.error(`warning: disposing the opencode instance of ${worktreePath} failed (${errorMessage(error)}). Continuing.`);
  }

  let removed = false;
  let remove = sbxGit("worktree", "remove", "--force", worktreePath);
  if (remove.exitCode !== 0) {
    if (remove.stderr !== undefined && remove.stderr.length > 0) console.error(remove.stderr);
    await deps.sleep(2000);
    remove = sbxGit("worktree", "remove", "--force", worktreePath);
    removed = remove.exitCode === 0;
  } else {
    removed = true;
  }

  if (run([bin, "exec", name, "test", "-d", worktreePath]).exitCode === 0) {
    const rmrf = run([bin, "exec", name, "rm", "-rf", worktreePath]);
    if (rmrf.exitCode !== 0) console.error(rmrf.stderr ?? `rm -rf ${worktreePath} failed`);
    sbxGit("worktree", "prune");
  }

  const branch = sbxGit("branch", "-D", `feature/${args.step}`);
  if (branch.exitCode !== 0 && branch.stderr !== undefined && branch.stderr.length > 0) console.error(branch.stderr);

  const leftovers: string[] = [];
  if (run([bin, "exec", name, "test", "-d", worktreePath]).exitCode === 0) leftovers.push(`folder ${worktreePath}`);
  if (sbxGit("branch", "--list", `feature/${args.step}`).stdout.trim().length > 0) leftovers.push(`branch feature/${args.step}`);
  if (leftovers.length > 0) {
    return fail(`worktree removal left ${leftovers.join(" and ")} behind in the clone of ${name}`);
  }
  if (!removed) {
    // The fallback cleaned the folder and the branch, but the removal did
    // not succeed cleanly: report it, so callers (the probe runner) can
    // count the step as failed.
    return fail(`git worktree remove failed twice in the clone of ${name}; the rm -rf fallback removed the folder and the branch`);
  }

  console.log(`removed worktree ${worktreePath} and branch feature/${args.step}`);
  return 0;
}

/** The hint of a failed fetch when the remote of the sandbox is missing. Pure. */
export function stoppedSandboxHint(name: string): string {
  return `the sandbox ${name} is stopped. Start it with oc-sub up, then fetch again.`;
}

/**
 * `oc-sub fetch [--dir ROOT]`: fetch the branches of the sandbox clone on
 * the host (`git fetch sandbox-NAME`), then list every fetched
 * `feature/*` branch with its commit count over `alpha` and the review
 * commands. Pure host git, no `sbx exec`.
 */
export function fetch(
  args: { dir?: string },
  env: Env = process.env,
  depsOverrides: Partial<CloneDeps> = {},
): number {
  const deps = mergeDeps(depsOverrides);
  const found = stateFor(args, env, deps);
  if (found === null) return fail(HOST_MODE_ERROR);
  const { root, state } = found;
  const remote = `sandbox-${state.name}`;
  const git = (...gitArgs: readonly string[]) => deps.runner(["git", "-C", root, ...gitArgs]);

  const fetchResult = git("fetch", remote);
  if (fetchResult.exitCode !== 0) {
    const code = fail(`git fetch ${remote} failed`);
    // `sbx stop` removes the remote, and the next start adds it again
    // (lesson sbx-stop-removes-clone-remote). A missing remote means that
    // the sandbox is stopped, for example by the idle watchdog.
    if (!listsCloneRemote(git("remote").stdout, state.name)) {
      console.error(stoppedSandboxHint(state.name));
    }
    return code;
  }

  const listing = git("for-each-ref", `refs/remotes/${remote}/feature/`, "--format=%(refname:short)");
  if (listing.exitCode !== 0) return fail(`git for-each-ref failed for ${remote}`);
  const branches = listing.stdout.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  if (branches.length === 0) {
    console.log(`no feature branches on ${remote}`);
    return 0;
  }
  for (const branch of branches) {
    const count = git("rev-list", "--count", `alpha..${branch}`).stdout.trim();
    console.log(`${branch} (+${count} over alpha)`);
    console.log(`review: git diff alpha...${branch}`);
    console.log(`merge:  git merge --squash ${branch}`);
  }
  return 0;
}
