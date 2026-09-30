/**
 * `oc-sub worktree` and `oc-sub fetch`: the run worktrees of sandbox clone
 * mode. The worktree of a run lives only inside the in-container clone of
 * the sandbox, not on the host, so every git step goes through
 * `sbx exec NAME ...` with the runner (like `upSandbox`). The host only
 * fetches the finished branches from the `sandbox-<name>` remote that
 * `sbx` manages (RUN_ISOLATION.md section 2.4). The clone itself fetches
 * new host commits from the read-only host repository through its remote
 * `host`, never through `origin`. Both commands work only in
 * sandbox mode: without a sandbox state file for the project they stop with
 * an error. All `sbx` calls go through a runner, so the tests replace it
 * with a fake and never call the real `sbx`.
 */
import path from "node:path";
import type { Env } from "./config";
import { projectRootOfRun, projectNameOf } from "./keys";
import { projectSetupCommand } from "./project-config";
import {
  defaultRunner,
  miseBin,
  miseInstallsDir,
  projectToolPath,
  readSandboxState,
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
};

export const defaultCloneDeps: CloneDeps = {
  runner: defaultRunner,
  sandboxState: (project) => readSandboxState(sandboxStatePath(process.env as Env, project)),
  projectName: projectNameOf,
  setupCommand: projectSetupCommand,
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
 * `oc-sub worktree STEP [--dir ROOT] [--base BRANCH] [--no-setup]`: create
 * the worktree of a run inside the sandbox clone. It makes sure that the
 * remote `host` of the clone points to the read-only host repository at
 * `/run/sandbox/source`, fetches new host commits from it, sets the git
 * identity of the host repository in the clone (a fresh clone has none),
 * and creates `feature/STEP` from `host/BASE`. It does not fetch `origin`:
 * the clone copies the remotes of the host, so `origin` can be an SSH URL
 * that the sandbox cannot reach (RUN_ISOLATION.md section 9). When the
 * worktree already exists, it says so and exits 0.
 *
 * When the project sets a `setup` command in `.opencode/oc-sub.json`, it
 * runs that command inside the new worktree after a successful `git
 * worktree add` (for example `bun install`, because the worktree holds
 * only tracked files and no `node_modules`). `--no-setup` skips it. On a
 * failing setup it prints the output, tells how to run the command by
 * hand, keeps the worktree, and exits 1.
 */
export function worktree(
  args: { step: string; dir?: string; base?: string; noSetup?: boolean },
  env: Env = process.env,
  depsOverrides: Partial<CloneDeps> = {},
): number {
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
    console.log(`worktree already exists: ${worktreePath}`);
    return 0;
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

  const base = args.base ?? "alpha";
  const add = sbxGit("worktree", "add", "-b", `feature/${args.step}`, worktreePath, `${HOST_REMOTE}/${base}`);
  if (add.exitCode !== 0) return fail(`git worktree add failed in the clone of ${name}`);

  // The worktree holds only tracked files, so it has no `node_modules`. The
  // project can set a setup command in `.opencode/oc-sub.json`; run it once
  // inside the new worktree, with the PATH of the sandbox server, so that
  // the mise tools of the project (bun) are found. `mise install` already
  // ran in `upSandbox`, so `worktree` only reads the tool folders here.
  const setup = args.noSetup === true ? undefined : deps.setupCommand(root);
  if (setup !== undefined) {
    console.log(`setup: ${setup}`);
    const toolPath = projectToolPath(
      run([miseBin(env), "env", "-C", root, "--json"], { cwd: root }).stdout,
      miseInstallsDir(env),
    );
    const setupCmd = [
      bin,
      "exec",
      "-w",
      worktreePath,
      "-e",
      sandboxToolPathEntry(toolPath),
      name,
      "sh",
      "-c",
      `exec 2>&1; ${setup}`,
    ];
    const setupRun = run(setupCmd);
    if (setupRun.exitCode !== 0) {
      if (setupRun.stdout.length > 0) console.error(setupRun.stdout);
      console.error(`error: the setup command failed in ${worktreePath} (exit ${setupRun.exitCode})`);
      console.error(`run it again by hand: ${setupCmd.map(shellQuote).join(" ")}`);
      return 1;
    }
  }

  console.log(`worktree: ${worktreePath}`);
  console.log(`start the run with: oc-sub run --dir ${worktreePath} ...`);
  return 0;
}

/**
 * `oc-sub worktree rm STEP [--dir ROOT]`: remove the worktree of the step
 * inside the clone and delete its branch there. The branch only exists in
 * the clone; the host reviews it through the `sandbox-<name>` remote.
 */
export function worktreeRm(
  args: { step: string; dir?: string },
  env: Env = process.env,
  depsOverrides: Partial<CloneDeps> = {},
): number {
  const deps = mergeDeps(depsOverrides);
  const found = stateFor(args, env, deps);
  if (found === null) return fail(HOST_MODE_ERROR);
  const { root, state } = found;
  const bin = sbxBin(env);
  const { name } = state;
  const sbxGit = (...gitArgs: readonly string[]) => deps.runner([bin, "exec", name, "git", "-C", root, ...gitArgs]);
  const worktreePath = runWorktreePath(root, args.step);

  const remove = sbxGit("worktree", "remove", "--force", worktreePath);
  if (remove.exitCode !== 0) return fail(`git worktree remove failed in the clone of ${name}`);
  const branch = sbxGit("branch", "-D", `feature/${args.step}`);
  if (branch.exitCode !== 0) return fail(`git branch -D failed in the clone of ${name}`);

  console.log(`removed worktree ${worktreePath} and branch feature/${args.step}`);
  return 0;
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
  if (fetchResult.exitCode !== 0) return fail(`git fetch ${remote} failed`);

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
