/**
 * `oc-sub doctor`: a registry of named health checks. The fast checks 1 to 6
 * only stat and list directories (except check 6, which reads the frontmatter
 * of a project agent file), so `up` and `run` run them on every invocation.
 * The slow checks need a git call, `sbx` calls, or the KVM device, so only
 * `oc-sub doctor` runs them. The design is in `docs/research/DOCTOR.md`.
 * Every dependency is injected, so the tests use fakes like in
 * `test/sandbox.test.ts`.
 */
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { Env } from "./config";
import { defaultKvmDeps, execFailedMessage, hostRefsKeepingCommit, KVM_CHMOD_COMMAND, kvmAccessCheck, miseInstallsDir, missingCloneMessage, missingMountsMessage, parseFeatureBranches, parseWorktrees, readSandboxState, RECREATE_REF_FORMAT, recreateSandbox, sandboxName, sandboxRecreateCase, sandboxRecreateFix, sandboxStatePath, defaultRunner, type KvmDeps, type Runner, type SandboxState } from "./sandbox";
import { projectRootOfRun } from "./keys";
import { sharedAgentsDir } from "./shared";
import { PLUGIN_CONFIG_DIR } from "./up";
import { pluginDataDir, pluginDigest, syncPluginDir } from "./plugin-sync";
import { busyCheck, busyCheckNote, findRunningServers, restartServer, serverLabel, type BusyCheck, type RunningServer } from "./server-plugin";

/** The result of one check. */
export type CheckResult = {
  name: string;
  status: "pass" | "warn" | "fail" | "skip";
  message: string;
  fix?: string;
};

/**
 * The file system and environment of the checks. The injected functions
 * return null instead of throwing, so a missing path is a normal case.
 */
export type DoctorDeps = {
  /** The metadata of a path, or null when it does not exist. */
  lstat: (file: string) => { isSymbolicLink: boolean } | null;
  /** The target of a symlink, or null when it fails. */
  readlink: (file: string) => string | null;
  /** The entry names of a folder, or null when it does not exist. */
  readdir: (folder: string) => string[] | null;
  /** Whether a path exists. Never reads content. */
  exists: (file: string) => boolean;
  /** The content of a text file, or null. Used for agent files and the global rule files. */
  readText: (file: string) => string | null;
  /** The real path of a path with all symlinks resolved, or null. */
  realpath: (file: string) => string | null;
  /** The home folder of the user. */
  home: string;
  /** The project folder that the checks examine. */
  root: string;
  /** The shared agents folder (the source of the global rules). */
  sharedDir: string;
  /** The mise installs folder, for the sandbox mount check. */
  installsDir: string;
  /** The plugin folder of this oc-sub, the source of the sync. */
  pluginSource: string;
  /** The synced plugin folder that the servers load and the sandboxes mount. */
  pluginDir: string;
  /** The project name, used in fix messages. */
  projectName: string;
  /** The repository folder of the plugin (above `src/`). */
  pluginRepoRoot: string;
  /** The installed plugins file of Claude Code. */
  installedPluginsFile: string;
  /** The commit of `origin/alpha` in the plugin repository, or null. */
  originAlphaSha: () => string | null;
  /** The sandbox state of the project, or null without a state file. */
  sandboxState: () => SandboxState | null;
  /** The name of the `sbx` binary. */
  sandboxBin: string;
  /** The runner for the `sbx` calls. */
  runner: Runner;
  /** The name of the `claude` binary, for the plugin update commands. */
  claudeBin: string;
  /** The runner for the `claude` calls of the fix actions. */
  claudeRunner: Runner;
  /**
   * Replace the file at `file` with a symlink to `target`. Writes the new
   * link under a temp name in the same folder and renames it over the old
   * file, so the swap is atomic.
   */
  replaceWithSymlink: (file: string, target: string) => void;
  /** The platform, the stat, and the access test of the `kvm-access` check. */
  kvm: KvmDeps;
  /**
   * The runner of the root fixes. It runs the command with stdin, stdout, and
   * stderr inherited from the terminal, so that sudo can ask for the
   * password. The tests replace it, so they never call sudo.
   */
  rootRunner: RootRunner;
  /** Whether stdin is a terminal. Without one, a root fix runs `sudo -n`. */
  stdinIsTTY: boolean;
  /** The content digest of a plugin folder, or null when it does not exist. */
  pluginDigest: (dir: string) => string | null;
  /** Syncs the plugin folder in place and returns the new digest. */
  syncPlugin: (source: string, dest: string) => string;
  /** The running servers of the project with their recorded plugin digests. */
  runningServers: () => RunningServer[];
  /** Restarts one server if all its sessions are idle (the fix of `server-plugin`). */
  restartServer: (server: RunningServer) => Promise<FixOutcome>;
  /** The shared busy check of a server: unauthorized, a failed check, or a busy session blocks. */
  serverBusy: (server: RunningServer) => Promise<BusyCheck>;
  /**
   * Recreates the sandbox of a project: with `stopServer`, `oc-sub down`
   * first, then `sbx rm --force NAME`, then `oc-sub up` (step 15d).
   */
  recreateSandbox: (name: string, root: string, stopServer: boolean) => Promise<FixOutcome>;
};

/** A runner whose child process shares the terminal of this process. */
export type RootRunner = (cmd: readonly string[]) => { exitCode: number };

/** The real root runner: one synchronous subprocess with inherited stdio. */
export const defaultRootRunner: RootRunner = (cmd) => {
  const proc = Bun.spawnSync([...cmd], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  return { exitCode: proc.exitCode ?? 1 };
};

/** The check of `installed_plugins.json` and the fix for an old install. */
export const PLUGIN_KEY = "opencode-subagents@opencode-subagents";
export const PLUGIN_UPDATE_FIX = "claude plugin marketplace update opencode-subagents && claude plugin update opencode-subagents@opencode-subagents";

/** The real git call: `git rev-parse origin/alpha` in the plugin repository. */
export function defaultOriginAlphaSha(repoRoot: string): string | null {
  const proc = Bun.spawnSync(["git", "rev-parse", "origin/alpha"], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const sha = proc.stdout.toString().trim();
  return proc.exitCode === 0 && sha.length > 0 ? sha : null;
}

/**
 * The real atomic symlink swap: write the new link under a temp name in the
 * same folder, then rename it over the old file.
 */
export function defaultReplaceWithSymlink(file: string, target: string): void {
  const tmp = `${file}.oc-sub-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  symlinkSync(target, tmp);
  renameSync(tmp, file);
}

/** The default dependencies, with the real file system, git, and `sbx`. */
export function makeDoctorDeps(env: Env, dir: string, overrides: Partial<DoctorDeps> = {}): DoctorDeps {
  const root = path.resolve(dir);
  const stat = (file: string) => {
    try {
      const info = lstatSync(file);
      return { isSymbolicLink: info.isSymbolicLink() };
    } catch {
      return null;
    }
  };
  const deps: DoctorDeps = {
    lstat: stat,
    readlink: (file) => {
      try {
        return readlinkSync(file);
      } catch {
        return null;
      }
    },
    readdir: (folder) => {
      try {
        return readdirSync(folder);
      } catch {
        return null;
      }
    },
    exists: existsSync,
    readText: (file) => {
      try {
        return readFileSync(file, "utf8");
      } catch {
        return null;
      }
    },
    realpath: (file) => {
      try {
        return realpathSync(file);
      } catch {
        return null;
      }
    },
    home: env.HOME ?? homedir(),
    root,
    sharedDir: sharedAgentsDir(env),
    installsDir: miseInstallsDir(env),
    pluginSource: PLUGIN_CONFIG_DIR,
    pluginDir: pluginDataDir(env),
    projectName: path.basename(root),
    pluginRepoRoot: path.resolve(import.meta.dir, ".."),
    installedPluginsFile: path.join(env.HOME ?? homedir(), ".claude", "plugins", "installed_plugins.json"),
    originAlphaSha: () => defaultOriginAlphaSha(path.resolve(import.meta.dir, "..")),
    sandboxState: () => readSandboxState(sandboxStatePath(env, path.basename(root))),
    sandboxBin: env.SBX_BIN !== undefined && env.SBX_BIN.length > 0 ? env.SBX_BIN : "sbx",
    runner: defaultRunner,
    claudeBin: env.CLAUDE_BIN !== undefined && env.CLAUDE_BIN.length > 0 ? env.CLAUDE_BIN : "claude",
    claudeRunner: defaultRunner,
    replaceWithSymlink: defaultReplaceWithSymlink,
    kvm: defaultKvmDeps,
    rootRunner: defaultRootRunner,
    stdinIsTTY: process.stdin.isTTY === true,
    pluginDigest,
    syncPlugin: (source, dest) => syncPluginDir(source, dest).digest,
    runningServers: () => findRunningServers(env, readSandboxState(sandboxStatePath(env, path.basename(root)))),
    restartServer: (server) => restartServer(server, env),
    serverBusy: (server) => busyCheck(server, env),
    recreateSandbox: (name, rootDir, stopServer) => recreateSandbox(name, rootDir, stopServer, env),
  };
  return { ...deps, ...overrides };
}

/** The outcome of one fix action. */
export type FixOutcome = { ok: boolean; note: string };

/** One fix run of the `--fix` pass, for the JSON output. */
export type FixRecord = { name: string; ok: boolean; note: string };

/** One named check, with an optional safe fix action. */
export type Check = {
  name: string;
  run: (deps: DoctorDeps) => CheckResult;
  /**
   * Runs only when `--fix` is set and the check result is `warn` or `fail`.
   * `ctx.force` is the `--force` flag. Most fixes ignore it; the recreate
   * fix of `sandbox-mounts` runs only with it, because it ends all sessions
   * of the sandbox. The action returns the outcome, or a promise of it when
   * it must wait for a server or a subprocess. A throw or a rejection counts
   * as a failed fix.
   */
  fix?: (deps: DoctorDeps, result: CheckResult, ctx: { force: boolean }) => FixOutcome | Promise<FixOutcome>;
  /**
   * A fix that needs root. Only `--fix-as-root` runs it, never `--fix`
   * alone, and only a root fix may call sudo. Same contract as `fix`.
   */
  rootFix?: (deps: DoctorDeps, result: CheckResult, ctx: { force: boolean }) => FixOutcome;
};

function result(name: string, status: CheckResult["status"], message: string, fix?: string): CheckResult {
  return { name, status, message, fix };
}

/**
 * Whether the file holds only a permission block: a frontmatter with the
 * `permission` key, none of `description`, `model`, or `prompt`, and an
 * empty body after the frontmatter (see `docs/research/AGENT_MERGE.md`).
 * Pure, so the tests use it directly.
 */
export function isPermissionOnlyAgent(text: string): boolean {
  if (!text.startsWith("---\n")) return false;
  const end = text.indexOf("\n---", 4);
  if (end === -1) return false;
  const frontmatter = text.slice(4, end);
  const body = text.slice(end + 4);
  const keys = frontmatter
    .split("\n")
    .map((line) => (line.match(/^([A-Za-z][\w-]*):/) ?? [])[1])
    .filter((key) => key !== undefined);
  const hasPermission = keys.includes("permission");
  const hasBody = ["description", "model", "prompt"].some((key) => keys.includes(key));
  return hasPermission && !hasBody && body.trim().length === 0;
}

/** Names that end in `.example` or `.sample` are templates, not secrets. */
function isEnvTemplate(name: string): boolean {
  return name.endsWith(".example") || name.endsWith(".sample");
}

function envFilesCheck(deps: DoctorDeps): CheckResult {
  const bad: string[] = [];
  const scan = (folder: string, label: string) => {
    const entries = deps.readdir(folder);
    if (entries === null) return;
    for (const entry of entries) {
      if (/^\.env(\..*)?$/.test(entry) && !isEnvTemplate(entry)) bad.push(`${label}/${entry}`);
    }
  };
  scan(deps.root, ".");
  const worktrees = deps.readdir(path.join(deps.root, ".worktrees"));
  if (worktrees !== null) {
    for (const entry of worktrees) scan(path.join(deps.root, ".worktrees", entry), `.worktrees/${entry}`);
  }
  if (bad.length === 0) return result("env-files", "pass", "no .env file in the project or its worktrees");
  return result(
    "env-files",
    "fail",
    `real .env files found: ${bad.join(", ")}`,
    `move the keys to ${path.join(deps.home, ".config", deps.projectName, "openrouter.key")} and delete the files`,
  );
}

function claudeMdCheck(deps: DoctorDeps): CheckResult {
  const found = ["CLAUDE.md", "CLAUDE.local.md"].filter((name) => deps.exists(path.join(deps.root, name)));
  if (found.length === 0) return result("claude-md", "pass", "no CLAUDE.md in the project root");
  return result(
    "claude-md",
    "fail",
    `found ${found.join(", ")} in the project root`,
    "rename it to AGENTS.md",
  );
}

function agentsMdCheck(deps: DoctorDeps): CheckResult {
  if (deps.exists(path.join(deps.root, "AGENTS.md"))) {
    return result("agents-md", "pass", "the project root has AGENTS.md");
  }
  return result(
    "agents-md",
    "warn",
    "the project root has no AGENTS.md",
    "create AGENTS.md with the rules of the project, so the agent reads them",
  );
}

/** The three global rule paths that must be symlinks to the shared file. */
export function globalRulePaths(deps: DoctorDeps): string[] {
  return [
    path.join(deps.home, ".claude", "CLAUDE.md"),
    path.join(deps.home, ".config", "opencode", "AGENTS.md"),
    path.join(deps.home, ".codex", "AGENTS.md"),
  ];
}

function globalRulesCheck(deps: DoctorDeps): CheckResult {
  const paths = globalRulePaths(deps);
  const sharedFile = path.join(deps.sharedDir, "AGENTS.md");
  const sharedReal = deps.realpath(sharedFile);
  if (sharedReal === null) {
    return result(
      "global-rules",
      "warn",
      `the shared rules file ${sharedFile} is missing`,
      "create it, or set OC_SUB_SHARED_DIR to the folder that holds AGENTS.md",
    );
  }
  const missing: string[] = [];
  const broken: string[] = [];
  const copies: string[] = [];
  for (const link of paths) {
    const stat = deps.lstat(link);
    if (stat === null) {
      missing.push(link);
      continue;
    }
    if (!stat.isSymbolicLink) {
      copies.push(link);
      continue;
    }
    const target = deps.realpath(link);
    if (target === null || target !== sharedReal) broken.push(`${link} -> ${deps.readlink(link) ?? "?"}`);
  }
  if (broken.length > 0) {
    return result(
      "global-rules",
      "fail",
      `links that do not point to ${sharedReal}: ${broken.join(", ")}`,
      `replace each one with a symlink: ln -sfn ${sharedFile} <path>`,
    );
  }
  if (copies.length > 0) {
    return result(
      "global-rules",
      "fail",
      `regular files instead of symlinks (a copy drifts from the source): ${copies.join(", ")}`,
      `replace each one with a symlink: ln -sfn ${sharedFile} <path>`,
    );
  }
  if (missing.length > 0) {
    return result(
      "global-rules",
      "warn",
      `missing (the tool may not be installed): ${missing.join(", ")}`,
      `symlink each one to ${sharedFile} when you install the tool`,
    );
  }
  return result("global-rules", "pass", "all global rule files are symlinks to the shared AGENTS.md");
}

function skillLinksCheck(deps: DoctorDeps): CheckResult {
  const folders = [path.join(deps.home, ".claude", "skills"), path.join(deps.home, ".agents", "skills")];
  const broken: string[] = [];
  let found = false;
  for (const folder of folders) {
    const entries = deps.readdir(folder);
    if (entries === null) continue;
    found = true;
    for (const entry of entries) {
      const stat = deps.lstat(path.join(folder, entry));
      if (stat === null || !stat.isSymbolicLink) continue;
      if (deps.realpath(path.join(folder, entry)) === null) broken.push(`${folder}/${entry}`);
    }
  }
  if (!found) return result("skill-links", "skip", "no skills folder exists");
  if (broken.length > 0) {
    return result(
      "skill-links",
      "fail",
      `broken skill links: ${broken.join(", ")}`,
      "remove the broken link, or point it back to the skill folder",
    );
  }
  return result("skill-links", "pass", "every skill symlink resolves");
}

const AGENT_NAMES = ["coder", "researcher", "reader"];

function agentCopiesCheck(deps: DoctorDeps): CheckResult {
  const agentsDir = path.join(deps.root, ".opencode", "agents");
  const bad: string[] = [];
  for (const name of AGENT_NAMES) {
    const file = path.join(agentsDir, `${name}.md`);
    const text = deps.readText(file);
    if (text === null) continue;
    if (!isPermissionOnlyAgent(text)) bad.push(`.opencode/agents/${name}.md`);
  }
  if (bad.length === 0) {
    return result("agent-copies", "pass", "the project agent files are permission-only or absent");
  }
  return result(
    "agent-copies",
    "fail",
    `project agent files with their own description, model, or prompt: ${bad.join(", ")}`,
    "delete the file, the plugin serves the agent, or keep only a permission block (docs/research/AGENT_MERGE.md)",
  );
}

function pluginFreshCheck(deps: DoctorDeps): CheckResult {
  const text = deps.readText(deps.installedPluginsFile);
  if (text === null) return result("plugin-fresh", "skip", `no ${deps.installedPluginsFile}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return result("plugin-fresh", "skip", "the installed plugins file is not valid JSON");
  }
  // The file has the shape {"version": 2, "plugins": {"<plugin>@<marketplace>": [...]}}.
  const plugins = (parsed as Record<string, unknown>).plugins;
  if (typeof plugins !== "object" || plugins === null) {
    return result("plugin-fresh", "skip", "the installed plugins file has no plugins object");
  }
  const list = (plugins as Record<string, unknown>)[PLUGIN_KEY];
  if (!Array.isArray(list) || list.length === 0) {
    return result("plugin-fresh", "skip", `no ${PLUGIN_KEY} entry in the installed plugins file`);
  }
  const sha = (list[0] as Record<string, unknown>)?.gitCommitSha;
  if (typeof sha !== "string" || sha.length === 0) {
    return result("plugin-fresh", "skip", "the installed plugins file has no gitCommitSha");
  }
  const origin = deps.originAlphaSha();
  if (origin === null) return result("plugin-fresh", "skip", "cannot read origin/alpha of the plugin repository");
  if (sha === origin) return result("plugin-fresh", "pass", "the installed plugin commit matches origin/alpha");
  return result(
    "plugin-fresh",
    "warn",
    `the installed plugin commit ${sha.slice(0, 8)} differs from origin/alpha ${origin.slice(0, 8)}`,
    PLUGIN_UPDATE_FIX,
  );
}

/**
 * The fix of `plugin-fresh`: update the marketplace metadata, then update the
 * plugin from it. The second command runs only when the first exited 0. A
 * non-zero exit is a failed fix, with the command in the note.
 */
export function pluginFreshFix(deps: DoctorDeps, _result: CheckResult, _ctx: { force: boolean }): FixOutcome {
  const marketplaceUpdate = [deps.claudeBin, "plugin", "marketplace", "update", "opencode-subagents"];
  const first = deps.claudeRunner(marketplaceUpdate);
  if (first.exitCode !== 0) {
    return { ok: false, note: `${marketplaceUpdate.join(" ")} exited with code ${first.exitCode}` };
  }
  const pluginUpdate = [deps.claudeBin, "plugin", "update", PLUGIN_KEY];
  const second = deps.claudeRunner(pluginUpdate);
  if (second.exitCode !== 0) {
    return { ok: false, note: `${pluginUpdate.join(" ")} exited with code ${second.exitCode}` };
  }
  return { ok: true, note: pluginUpdate.join(" ") };
}

/**
 * The fix of `global-rules`: turn copies and broken or wrong symlinks into
 * symlinks to the shared AGENTS.md. A copy whose content differs from the
 * shared file is left alone (the fix fails and names it), so the fix never
 * destroys unmerged edits. A missing path is not created.
 */
export function globalRulesFix(deps: DoctorDeps, _result: CheckResult, _ctx: { force: boolean }): FixOutcome {
  const sharedFile = path.join(deps.sharedDir, "AGENTS.md");
  const sharedReal = deps.realpath(sharedFile);
  const sharedContent = sharedReal === null ? null : deps.readText(sharedFile);
  if (sharedReal === null || sharedContent === null) {
    return { ok: false, note: `the shared rules file ${sharedFile} is missing, nothing changed` };
  }
  const replaced: string[] = [];
  const differing: string[] = [];
  for (const link of globalRulePaths(deps)) {
    const stat = deps.lstat(link);
    if (stat === null) continue;
    if (stat.isSymbolicLink) {
      // A broken or wrong symlink holds no content, so re-pointing it loses nothing.
      if (deps.realpath(link) === sharedReal) continue;
      deps.replaceWithSymlink(link, sharedFile);
      replaced.push(link);
      continue;
    }
    const content = deps.readText(link);
    if (content === null || content !== sharedContent) {
      differing.push(link);
      continue;
    }
    deps.replaceWithSymlink(link, sharedFile);
    replaced.push(link);
  }
  if (differing.length > 0) {
    let note = `content differs, not changed: ${differing.join(", ")}`;
    if (replaced.length > 0) note += `; replaced with symlinks: ${replaced.join(", ")}`;
    return { ok: false, note };
  }
  return {
    ok: true,
    note: replaced.length > 0 ? `replaced with symlinks to ${sharedFile}: ${replaced.join(", ")}` : "already up to date",
  };
}

function sandboxMountsCheck(deps: DoctorDeps): CheckResult {
  const state = deps.sandboxState();
  if (state === null) return result("sandbox-mounts", "skip", "no sandbox state file for this project");
  const name = sandboxName(deps.projectName);
  // The classifier of the check and of its fix. It probes in the order of
  // `up`: `sbx ls` for the mounts, then the clone (its `sbx exec` starts a
  // stopped sandbox), then the `sandbox-<name>` remote for clone mode.
  const bad = sandboxRecreateCase(deps.runner, {
    bin: deps.sandboxBin,
    name,
    root: state.root,
    pluginDir: deps.pluginDir,
    installsDir: deps.installsDir,
    sharedDir: deps.sharedDir,
  });
  if (bad === null) return result("sandbox-mounts", "pass", `the sandbox ${name} has all required mounts, clone mode, and a clone`);
  switch (bad.reason) {
    case "not-listed":
      return result("sandbox-mounts", "skip", `no sandbox ${name} in sbx ls (it is stopped or removed)`);
    case "missing-mount":
      return result("sandbox-mounts", "fail", missingMountsMessage(name, bad.missing, deps.pluginDir), sandboxRecreateFix(name));
    case "exec-failed":
      // The sandbox did not start, so a recreate would not help.
      return result(
        "sandbox-mounts",
        "fail",
        execFailedMessage(name, bad.exitCode, bad.stderr),
        `run ${deps.sandboxBin} diagnose for the cause; check kvm-access first`,
      );
    case "missing-clone":
      return result("sandbox-mounts", "fail", missingCloneMessage(name, state.root), sandboxRecreateFix(name));
    case "not-clone-mode":
      return result(
        "sandbox-mounts",
        "fail",
        `the sandbox ${name} is not in clone mode (the project has no sandbox-<name> git remote)`,
        sandboxRecreateFix(name),
      );
  }
}

/**
 * The unfetched-work guard of the recreate fix: it proves that no work in
 * the clone would be lost. First it finds out whether the sandbox is in
 * clone mode: `sbx exec NAME test -d /run/sandbox/source` (only a clone-mode
 * sandbox has that path, and the exec also starts a stopped sandbox). Exit 1
 * means a direct mount: the sandbox mounts the host repository itself, so
 * nothing lives in the clone alone and a dirty host tree is no reason to
 * block. The guard skips. Another non-zero exit blocks, because then the fix
 * cannot prove that no work is lost. The `sandbox-<name>` remote is no proof
 * of clone mode, because `sbx stop` removes it.
 *
 * In a clone-mode sandbox, a local `feature/*` branch is safe only when a
 * host ref outside `refs/remotes/sandbox-<name>/` and
 * `refs/sandboxes/<name>/` contains its commit: `git -C ROOT for-each-ref
 * --contains SHA --format=%(refname)` on the host. `git cat-file -e` is not
 * enough, because `sbx rm` removes the remote and git then deletes those
 * refs, so the last ref of a fetched but unmerged branch would go. A failed
 * command blocks too. The note names the three ways out: merge the branch,
 * keep it with `git branch`, or remove it in the clone with
 * `oc-sub worktree rm`. A squash merge does not contain the feature commits,
 * so after a squash merge the user runs `oc-sub worktree rm`.
 *
 * It also lists the worktrees of the clone and blocks on uncommitted
 * changes. Null means the guard is clear.
 */
function sandboxUnfetchedWorkGuard(deps: DoctorDeps, name: string, root: string): string | null {
  const bin = deps.sandboxBin;
  // Clone mode or direct mount? Only a clone-mode sandbox holds
  // /run/sandbox/source. A direct mount exposes the host repository itself,
  // so the host branches and worktrees below are the host's own state and no
  // reason to block.
  const sourceArgs = [bin, "exec", name, "test", "-d", "/run/sandbox/source"];
  const source = deps.runner(sourceArgs);
  if (source.exitCode === 1) return null;
  if (source.exitCode !== 0) {
    return `cannot prove that no work is lost: ${sourceArgs.slice(1).join(" ")} failed with code ${source.exitCode}. Check the sandbox with ${bin} diagnose`;
  }
  const refArgs = [bin, "exec", name, "git", "-C", root, "for-each-ref", `--format=${RECREATE_REF_FORMAT}`];
  const refs = deps.runner(refArgs);
  if (refs.exitCode !== 0) {
    return `cannot prove that no work is lost: ${refArgs.slice(1).join(" ")} failed with code ${refs.exitCode}. Fetch and push the work first (oc-sub fetch)`;
  }
  for (const { sha, branch } of parseFeatureBranches(refs.stdout)) {
    const containsArgs = ["git", "-C", root, "for-each-ref", "--contains", sha, "--format=%(refname)"];
    const contains = deps.runner(containsArgs);
    if (contains.exitCode !== 0) {
      return `cannot prove that no work is lost: ${containsArgs.slice(1).join(" ")} failed with code ${contains.exitCode} for ${branch}. Fetch and push the work first (oc-sub fetch, branch ${branch})`;
    }
    if (hostRefsKeepingCommit(contains.stdout, name).length === 0) {
      return `the branch ${branch} of the clone ${name} holds commits that the host would lose with sbx rm (its only refs sit under sandbox-${name}). Merge the branch, keep it with git branch ${branch} sandbox-${name}/${branch}, or remove it in the clone with oc-sub worktree rm ${branch.slice("feature/".length)}. A squash merge does not contain the feature commits, so after a squash merge run oc-sub worktree rm ${branch.slice("feature/".length)}`;
    }
  }
  const wtArgs = [bin, "exec", name, "git", "-C", root, "worktree", "list", "--porcelain"];
  const worktrees = deps.runner(wtArgs);
  if (worktrees.exitCode !== 0) {
    return `cannot prove that no work is lost: ${wtArgs.slice(1).join(" ")} failed with code ${worktrees.exitCode}. Fetch and push the work first (oc-sub fetch)`;
  }
  for (const worktree of parseWorktrees(worktrees.stdout)) {
    const status = deps.runner([bin, "exec", name, "git", "-C", worktree, "status", "--porcelain"]);
    if (status.exitCode !== 0) {
      return `cannot prove that no work is lost: git status in the worktree ${worktree} failed with code ${status.exitCode}. Commit and push the work first (oc-sub fetch)`;
    }
    if (status.stdout.trim().length > 0) {
      return `the worktree ${worktree} of the clone ${name} has uncommitted changes. Commit and push them first (oc-sub fetch, worktree ${worktree})`;
    }
  }
  return null;
}

/**
 * The fix of `sandbox-mounts` (step 15d): recreate the sandbox with
 * `sbx rm --force NAME` and `oc-sub up`. The classifier decides whether a
 * recreate helps; in the `exec-failed` case it does not, because the sandbox
 * does not start. Without `--force` nothing runs, because a recreate ends
 * all sessions of the sandbox. Two guards always block, also with
 * `--force`: a busy session on the sandbox server (the same shared busy
 * check as the restart of `server-plugin`), and unfetched or uncommitted
 * work in the clone. With `--force`, a failing step of the recreate returns
 * `ok: false` with its exit code.
 */
export async function sandboxMountsFix(deps: DoctorDeps, _result: CheckResult, ctx: { force: boolean }): Promise<FixOutcome> {
  const state = deps.sandboxState();
  if (state === null) return { ok: false, note: "no sandbox state file for this project, nothing changed" };
  const name = sandboxName(deps.projectName);
  const bad = sandboxRecreateCase(deps.runner, {
    bin: deps.sandboxBin,
    name,
    root: state.root,
    pluginDir: deps.pluginDir,
    installsDir: deps.installsDir,
    sharedDir: deps.sharedDir,
  });
  if (bad === null) return { ok: true, note: `the sandbox ${name} has all required mounts, clone mode, and a clone` };
  if (bad.reason === "not-listed") return { ok: false, note: `no sandbox ${name} in sbx ls, nothing changed` };
  if (bad.reason === "exec-failed") {
    return {
      ok: false,
      note: `a recreate does not help: ${execFailedMessage(name, bad.exitCode, bad.stderr)}. For the cause, run ${deps.sandboxBin} diagnose`,
    };
  }
  if (ctx.force !== true) {
    return {
      ok: false,
      note: `a recreate of the sandbox ${name} ends all sessions of the sandbox. Run oc-sub doctor --fix --force to recreate it`,
    };
  }
  // Guard 1: a busy session on the sandbox server. The same shared probe and
  // busy check as the restart of `server-plugin`.
  const server = deps.runningServers().find((candidate) => candidate.mode === "sandbox");
  if (server !== undefined) {
    const busy = await deps.serverBusy(server);
    if (busy.kind !== "clear") {
      return {
        ok: false,
        note: `${busyCheckNote(busy, server)}. The sandbox ${name} is not recreated. End the sessions with oc-sub abort or oc-sub down, then run oc-sub doctor --fix --force again`,
      };
    }
  }
  // Guard 2: unfetched or uncommitted work in the clone. A missing clone
  // holds no work, so the guard runs only when the clone exists.
  if (bad.reason !== "missing-clone") {
    const blocked = sandboxUnfetchedWorkGuard(deps, name, state.root);
    if (blocked !== null) return { ok: false, note: blocked };
  }
  return deps.recreateSandbox(name, state.root, server !== undefined);
}

/**
 * The root fix of `kvm-access`: `sudo chmod 0666 /dev/kvm`. In a terminal,
 * sudo may ask for the password. Without a terminal, `sudo -n` fails instead
 * of waiting for a password that nobody can type. Mode 0666 works at once,
 * without a new login for a group membership. The fix lasts until WSL
 * creates /dev/kvm again (the next WSL restart); a permanent fix is a task
 * of the machine setup.
 */
export function kvmAccessRootFix(deps: DoctorDeps, _result: CheckResult, _ctx: { force: boolean }): FixOutcome {
  const plain = ["sudo", ...KVM_CHMOD_COMMAND];
  const cmd = deps.stdinIsTTY ? plain : ["sudo", "-n", ...KVM_CHMOD_COMMAND];
  const { exitCode } = deps.rootRunner(cmd);
  if (exitCode === 0) return { ok: true, note: `${cmd.join(" ")} (lasts until the next WSL restart)` };
  if (!deps.stdinIsTTY) {
    return {
      ok: false,
      note: `${cmd.join(" ")} exited with code ${exitCode}; sudo needs a password, run in a terminal: ${plain.join(" ")}`,
    };
  }
  return { ok: false, note: `${cmd.join(" ")} exited with code ${exitCode}` };
}

/** The fix text of `server-plugin`. */
export const SERVER_PLUGIN_FIX =
  "run oc-sub doctor --fix: it syncs the folder and restarts each idle server. A busy server needs oc-sub abort or oc-sub down first";

/**
 * Whether the servers run the current plugin (step 15c). Every server loads
 * the synced plugin folder, and its state records the digest of that folder
 * at its start. The check warns when the synced folder differs from the
 * plugin folder of this oc-sub (a plugin update since the last `up`), or
 * when a running server started with other content than the synced folder
 * holds now. A server without a record started before step 15c, so its
 * content is unknown and it counts as stale. Without a running server, a
 * missing synced folder passes: the next `up` creates it.
 */
function serverPluginCheck(deps: DoctorDeps): CheckResult {
  const source = deps.pluginDigest(deps.pluginSource);
  if (source === null) return result("server-plugin", "skip", `the plugin folder ${deps.pluginSource} does not exist`);
  const synced = deps.pluginDigest(deps.pluginDir);
  const servers = deps.runningServers();
  const problems: string[] = [];
  if (synced === null) {
    if (servers.length > 0) problems.push(`the synced plugin folder ${deps.pluginDir} does not exist`);
  } else if (synced !== source) {
    problems.push(`the synced plugin folder ${deps.pluginDir} differs from the plugin ${deps.pluginSource}`);
  }
  for (const server of servers) {
    if (server.digest === null) {
      problems.push(`the ${serverLabel(server)} has no plugin record (started before oc-sub step 15c)`);
    } else if (server.digest !== synced) {
      problems.push(`the ${serverLabel(server)} started with other plugin content than the synced folder holds`);
    }
  }
  if (problems.length > 0) return result("server-plugin", "warn", problems.join(", and "), SERVER_PLUGIN_FIX);
  if (servers.length === 0) {
    return result("server-plugin", "pass", synced === null ? "no server runs, the next oc-sub up syncs the plugin folder" : "the synced plugin folder matches the plugin, no server runs");
  }
  return result("server-plugin", "pass", `the synced plugin folder matches the plugin, and ${servers.length} running server(s) use it`);
}

/**
 * The fix of `server-plugin`: sync the plugin folder in place, then restart
 * every running server whose recorded digest differs from the new one. A
 * restart happens only when all sessions of the server are idle; a busy
 * server stays as it is, and the fix fails with a note that names
 * `oc-sub abort` and `oc-sub down`. No `--force` is needed, because an idle
 * server loses no work.
 */
export async function serverPluginFix(deps: DoctorDeps, _result: CheckResult, _ctx: { force: boolean }): Promise<FixOutcome> {
  const digest = deps.syncPlugin(deps.pluginSource, deps.pluginDir);
  const stale = deps.runningServers().filter((server) => server.digest !== digest);
  const notes = [`synced ${deps.pluginDir}`];
  let ok = true;
  for (const server of stale) {
    const outcome = await deps.restartServer(server);
    ok = ok && outcome.ok;
    notes.push(outcome.note);
  }
  return { ok, note: notes.join(", ") };
}

/** The fast checks: `up` and `run` run them on every invocation. */
export const FAST_CHECKS: Check[] = [
  { name: "env-files", run: envFilesCheck },
  { name: "claude-md", run: claudeMdCheck },
  { name: "agents-md", run: agentsMdCheck },
  { name: "global-rules", run: globalRulesCheck, fix: globalRulesFix },
  { name: "skill-links", run: skillLinksCheck },
  { name: "agent-copies", run: agentCopiesCheck },
];

/** The slow checks: only `oc-sub doctor` runs them. */
export const SLOW_CHECKS: Check[] = [
  { name: "plugin-fresh", run: pluginFreshCheck, fix: pluginFreshFix },
  // After plugin-fresh, so a plugin update comes before the sync and the restart.
  { name: "server-plugin", run: serverPluginCheck, fix: serverPluginFix },
  // Before sandbox-mounts: without KVM access, the sandbox cannot start.
  { name: "kvm-access", run: (deps) => kvmAccessCheck(deps.kvm), rootFix: kvmAccessRootFix },
  { name: "sandbox-mounts", run: sandboxMountsCheck, fix: sandboxMountsFix },
];

/** All checks in their fixed order. */
export const ALL_CHECKS: Check[] = [...FAST_CHECKS, ...SLOW_CHECKS];

/** Run the given checks in order and return their results. */
export function runChecks(checks: readonly Check[], deps: DoctorDeps): CheckResult[] {
  return checks.map((check) => check.run(deps));
}

/** The fast checks with their duration in milliseconds. */
export function runFastChecks(deps: DoctorDeps): { results: CheckResult[]; ms: number } {
  const start = performance.now();
  const results = runChecks(FAST_CHECKS, deps);
  return { results, ms: performance.now() - start };
}

/** The fast checks for one project folder, for `up` and `run`. */
export function runFastChecksFor(
  env: Env,
  dir: string,
  overrides: Partial<DoctorDeps> = {},
): { results: CheckResult[]; ms: number } {
  return runFastChecks(makeDoctorDeps(env, dir, overrides));
}

/** The label of a status in the printed line. */
function label(status: CheckResult["status"]): string {
  return status === "fail" ? "FAIL" : status;
}

/** Print one line per result, and the fix on the next line. */
export function printResults(results: readonly CheckResult[]): void {
  for (const check of results) {
    console.log(`${label(check.status).padEnd(5)} ${check.name}: ${check.message}`);
    if (check.fix !== undefined && check.status !== "pass" && check.status !== "skip") {
      console.log(`      fix: ${check.fix}`);
    }
  }
  const count = (status: CheckResult["status"]) => results.filter((check) => check.status === status).length;
  console.log(
    `${count("pass")} pass, ${count("warn")} warn, ${count("fail")} fail, ${count("skip")} skip`,
  );
}

/**
 * Print the failed fast checks to stderr with their fixes and the hint, and
 * return false when a check failed, so the caller stops. A warn prints one
 * line and the command continues.
 */
export function gateFastChecks(
  results: readonly CheckResult[],
  ms: number,
  print: (line: string) => void = console.error,
): boolean {
  if (ms > 50) print(`warning: the fast health checks took ${ms.toFixed(0)} ms (over 50 ms)`);
  let ok = true;
  for (const check of results) {
    if (check.status === "fail") {
      print(`FAIL ${check.name}: ${check.message}`);
      if (check.fix !== undefined) print(`fix: ${check.fix}`);
      ok = false;
    } else if (check.status === "warn") {
      print(`warning: ${check.name}: ${check.message}`);
    }
  }
  if (!ok) print("run oc-sub doctor for details");
  return ok;
}

/**
 * The fast-check gate of the commands. `main` calls it once before it
 * dispatches `up`, `restart`, and `run`, so a fail stops the command before
 * anything changes state and before any paid call. The checks examine the
 * project of `--dir` when the command names one (sandbox mode of `up` and
 * `restart`, and every `run`), else the current folder (host mode).
 */
export function gateForCommand(
  args: { dir?: string },
  env: Env = process.env,
  overrides: Partial<DoctorDeps> = {},
): boolean {
  // A run folder of sandbox clone mode exists only inside the sandbox, so
  // the checks examine the project root of the folder instead (keys.ts,
  // `projectRootOfRun`). For a folder on the host, the mapping is identity.
  const target = projectRootOfRun(args.dir ?? process.cwd());
  const fast = runFastChecksFor(env, target, overrides);
  return gateFastChecks(fast.results, fast.ms);
}

/**
 * Run the fix actions of the checks whose result is `warn` or `fail`, in the
 * order of the given check list. It prints `fixing <name>: <fix text>` before
 * each action and `fixed <name>: <note>` or `fix failed (<name>): <note>`
 * after it. An action that throws counts as a failed fix with the error
 * message as note, and the other actions still run. A root fix runs only
 * with `ctx.asRoot` (`--fix-as-root`); without it, the line
 * `needs --fix-as-root (<name>): ...` names the flag, and nothing runs.
 */
export async function runFixes(
  checks: readonly Check[],
  deps: DoctorDeps,
  results: readonly CheckResult[],
  ctx: { force: boolean; asRoot?: boolean },
  print: (line: string) => void = console.log,
): Promise<FixRecord[]> {
  const records: FixRecord[] = [];
  const apply = async (check: Check, res: CheckResult, action: NonNullable<Check["fix"]>) => {
    print(`fixing ${check.name}: ${res.fix ?? res.message}`);
    let outcome: FixOutcome;
    try {
      outcome = await action(deps, res, { force: ctx.force });
    } catch (error) {
      outcome = { ok: false, note: error instanceof Error ? error.message : String(error) };
    }
    records.push({ name: check.name, ok: outcome.ok, note: outcome.note });
    print(outcome.ok ? `fixed ${check.name}: ${outcome.note}` : `fix failed (${check.name}): ${outcome.note}`);
  };
  for (let i = 0; i < checks.length; i++) {
    const check = checks[i];
    const res = results[i];
    if (check === undefined || res === undefined) continue;
    if (res.status !== "warn" && res.status !== "fail") continue;
    if (check.fix !== undefined) await apply(check, res, check.fix);
    if (check.rootFix !== undefined) {
      if (ctx.asRoot === true) {
        await apply(check, res, check.rootFix);
      } else {
        print(`needs --fix-as-root (${check.name}): this fix runs sudo; run oc-sub doctor --fix-as-root`);
      }
    }
  }
  return records;
}

/** `oc-sub doctor`: run all checks and print the results. */
export async function doctor(
  args: { dir?: string; json?: boolean; fix?: boolean; force?: boolean; fixAsRoot?: boolean },
  env: Env = process.env,
  overrides: Partial<DoctorDeps> = {},
): Promise<number> {
  const deps = makeDoctorDeps(env, args.dir ?? process.cwd(), overrides);
  const results = runChecks(ALL_CHECKS, deps);
  // --fix-as-root implies --fix and also runs the root fixes.
  if (args.fix === true || args.fixAsRoot === true) {
    // With --json, stdout holds only the JSON object, so the fix lines go to stderr.
    const print = args.json === true ? console.error : console.log;
    const fixes = await runFixes(
      ALL_CHECKS,
      deps,
      results,
      { force: args.force === true, asRoot: args.fixAsRoot === true },
      print,
    );
    const rerun = runChecks(ALL_CHECKS, deps);
    if (args.json === true) {
      console.log(JSON.stringify({ fixes, results: rerun }, null, 2));
    } else {
      printResults(rerun);
    }
    const anyFail = rerun.some((check) => check.status === "fail");
    const fixFailed = fixes.some((fix) => !fix.ok);
    return anyFail || fixFailed ? 1 : 0;
  }
  if (args.json === true) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    printResults(results);
  }
  return results.some((check) => check.status === "fail") ? 1 : 0;
}
