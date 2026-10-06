/**
 * `oc-sub doctor`: a registry of named health checks. The fast checks 1 to 6
 * only stat and list directories (except check 6, which reads the frontmatter
 * of a project agent file), so `up` and `run` run them on every invocation.
 * The slow checks need a git call, `sbx` calls, or the KVM device, so only
 * `oc-sub doctor` runs them. The design is in `.plan/research/doctor.md`.
 * Every dependency is injected, so the tests use fakes like in
 * `test/sandbox.test.ts`.
 */
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { Env } from "./config";
import { defaultKvmDeps, execFailedMessage, hostRefsKeepingCommit, KVM_CHMOD_COMMAND, kvmAccessCheck, miseBin as miseBinOf, miseInstallsDir, missingCloneMessage, missingMountsMessage, parseFeatureBranches, parseWorktrees, readSandboxState, RECREATE_REF_FORMAT, recreateSandbox, sandboxName, sandboxRecreateCase, sandboxRecreateFix, sandboxStatePath, defaultRunner, type KvmDeps, type Runner, type SandboxState } from "./sandbox";
import { deepinfraKeyPath, projectRootOfRun } from "./keys";
import { PLAN_CONFIG, readPlanDir } from "./plan-dir";
import { parseResearchHead, recheckState, todayString } from "./research-head";
import { SHARED_DIR_UNSET, sharedAgentsDir } from "./shared";
import { PLUGIN_CONFIG_DIR } from "./up";
import { LOCK_FILE, lockHolder, watchStateDir, type LockHolder } from "./watch/log";
import { pluginDataDir, pluginDigest, syncPluginDir } from "./plugin-sync";
import { idfxVersion, TOOL } from "./protocol";
import { defaultUnitDeps, listUnits, orphanedUnits, parseUnitLabel, stopUnit, type LoadedUnit, type UnitDeps } from "./units";
import { busyCheck, busyCheckNote, findRunningServers, restartServer, serverLabel, type BusyCheck, type RunningServer } from "./server-plugin";

/**
 * The result of one check. `error` means that the check did not run: it
 * threw. Then `error` holds the message of the throw.
 */
export type CheckResult = {
  name: string;
  status: "pass" | "warn" | "fail" | "skip" | "error";
  message: string;
  fix?: string;
  error?: string;
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
  sharedDir: string | undefined;
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
  /** The name of the `mise` binary, for the `opencode-version` check. */
  miseBin: string;
  /** The runner for the `mise` calls. */
  miseRunner: Runner;
  /** The global mise configuration file, named in the fix of `opencode-version`. */
  globalMiseConfig: string;
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
   * first, then `sbx rm --force NAME`, then `oc-sub up`.
   */
  recreateSandbox: (name: string, root: string, stopServer: boolean) => Promise<FixOutcome>;
  /** The optional DeepInfra key file of the project. */
  deepinfraKeyFile: string;
  /** The permission bits of a file, or null when it does not exist. Never reads content. */
  fileMode: (file: string) => number | null;
  /** Writes a text file in the project (the fix of `agent-copies` and `opencode-version`). */
  writeText: (file: string, content: string) => void;
  /** Deletes a file in the project (the fix of `agent-copies` without a permission block). */
  deleteFile: (file: string) => void;
  /**
   * The git state of one file in the project: "clean" means
   * tracked and unmodified (`git ls-files --error-unmatch` succeeds and
   * `git status --porcelain -- FILE` prints nothing), "modified" means
   * tracked with uncommitted changes, "untracked" means not tracked (also
   * when ignored), and "error" means a git call failed. A fix that writes
   * or deletes a project file runs only on a clean file, so git holds the
   * old content.
   */
  gitFileState: (file: string) => "clean" | "modified" | "untracked" | "error";
  /**
   * Today as YYYY-MM-DD, for the `research-due` check. Optional; the real
   * deps leave it unset and the check uses the current local date.
   */
  today?: string;
  /**
   * The processes of the host, for the `top-memory` and
   * `orphan-processes` checks. Null means the platform has no `/proc`, and
   * both checks skip. A process that ends during the scan is left out.
   */
  listProcesses: () => ProcessInfo[] | null;
  /** The process ID of this doctor process. The fixes never kill it. */
  selfPid: number;
  /** The user ID of this doctor process. The checks look only at own processes. */
  uid: number;
  /** Sends a signal to a process; false when the process is gone. */
  killProcess: (pid: number, signal: "SIGTERM" | "SIGKILL") => boolean;
  /** Waits the given milliseconds (the fix of `orphan-processes` waits 5 s). */
  wait: (ms: number) => Promise<void>;
  /** The lock file of `idfx watch --all`, named in the `watch-running` check. */
  watchLockFile: string;
  /** The holder of that lock: none, a live watcher, or a stale lock (PID plus start time). */
  watchLock: () => LockHolder;
  /** The version of idfx in the `--json` object, see `src/protocol.ts`. */
  toolVersion: () => string;
  /**
   * The user manager, for the `units` check: it lists the `ocsub-*` units
   * and its fix stops the orphaned ones. The tests pass a fake.
   */
  units: UnitDeps;
};

/** One process of the host, as the process checks see it. */
export type ProcessInfo = {
  pid: number;
  ppid: number;
  uid: number;
  rssBytes: number;
  /** The command line, split on NUL, without empty entries. */
  args: string[];
  /** The target of `/proc/<pid>/cwd`, or null. A deleted folder ends in " (deleted)". */
  cwd: string | null;
};

/**
 * The real process scan: reads `/proc` with `node:fs`. `/proc/<pid>/status`
 * gives the parent PID, the real UID (the first of the `Uid` line), and
 * VmRSS in kB; `cmdline` gives the arguments split on NUL; `readlink` of
 * `cwd` gives the working folder, with the suffix " (deleted)" when the
 * folder no longer exists. A process that ends during the scan, or whose
 * files cannot be read, is left out, never a throw. Null without `/proc`.
 */
export function readProcProcesses(): ProcessInfo[] | null {
  if (process.platform !== "linux") return null;
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return null;
  }
  const out: ProcessInfo[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    try {
      const status = readFileSync(`/proc/${pid}/status`, "utf8");
      const ppid = Number(status.match(/^PPid:\s+(\d+)$/m)?.[1] ?? "-1");
      const uid = Number(status.match(/^Uid:\s+(\d+)/m)?.[1] ?? "-1");
      const rssKb = Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] ?? "0");
      const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
      const args = cmdline.split("\0").filter((arg) => arg.length > 0);
      let cwd: string | null = null;
      try {
        cwd = readlinkSync(`/proc/${pid}/cwd`);
      } catch {
        cwd = null;
      }
      out.push({ pid, ppid, uid, rssBytes: rssKb * 1024, args, cwd });
    } catch {
      continue;
    }
  }
  return out;
}

/** The default kill: `process.kill`; false when the process is already gone. */
export function defaultKillProcess(pid: number, signal: "SIGTERM" | "SIGKILL"): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

/** A runner whose child process shares the terminal of this process. */
export type RootRunner = (cmd: readonly string[]) => { exitCode: number };

/** The real root runner: one synchronous subprocess with inherited stdio. */
export const defaultRootRunner: RootRunner = (cmd) => {
  const proc = Bun.spawnSync([...cmd], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  return { exitCode: proc.exitCode ?? 1 };
};

/** The check of `installed_plugins.json` and the fix for an old install. */
export const PLUGIN_MARKETPLACE = "idfix";
export const PLUGIN_KEY = "idfix@idfix";
export const PLUGIN_UPDATE_FIX = "claude plugin marketplace update idfix && claude plugin update idfix@idfix";
/**
 * The key of the plugin before the rename to idfix (2026-10-05). An install
 * under this key needs a new install by hand, because `plugin update` cannot
 * change the name of a plugin or a marketplace.
 */
export const OLD_PLUGIN_KEY = "opencode-subagents@opencode-subagents";
export const OLD_PLUGIN_REINSTALL_FIX =
  "claude plugin uninstall opencode-subagents@opencode-subagents && claude plugin marketplace remove opencode-subagents && claude plugin marketplace add thoka/idfix && claude plugin install idfix@idfix";
const OLD_PLUGIN_MESSAGE = `the plugin is installed under the old name ${OLD_PLUGIN_KEY}`;

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

/**
 * The global mise configuration file: `MISE_GLOBAL_CONFIG_FILE`, else
 * `$XDG_CONFIG_HOME/mise/config.toml`, else `~/.config/mise/config.toml`.
 */
export function globalMiseConfigPath(env: Env): string {
  const file = env.MISE_GLOBAL_CONFIG_FILE;
  if (file !== undefined && file.length > 0) return file;
  const configHome = env.XDG_CONFIG_HOME !== undefined && env.XDG_CONFIG_HOME.length > 0 ? env.XDG_CONFIG_HOME : path.join(env.HOME ?? homedir(), ".config");
  return path.join(configHome, "mise", "config.toml");
}

/** The default dependencies, with the real file system, git, `sbx`, and `mise`. */
export function makeDoctorDeps(env: Env, dir: string, overrides: Partial<DoctorDeps> = {}): DoctorDeps {
  // A worktree belongs to its project: the key files and the sandbox state use the name of the main checkout.
  const root = projectRootOfRun(path.resolve(dir));
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
    miseBin: miseBinOf(env),
    miseRunner: defaultRunner,
    globalMiseConfig: globalMiseConfigPath(env),
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
    deepinfraKeyFile: deepinfraKeyPath(path.basename(root), env),
    fileMode: (file) => {
      try {
        return statSync(file).mode & 0o777;
      } catch {
        return null;
      }
    },
    writeText: (file, content) => writeFileSync(file, content),
    deleteFile: (file) => rmSync(file, { force: true }),
    gitFileState: (file) => {
      const tracked = Bun.spawnSync(["git", "ls-files", "--error-unmatch", file], { cwd: root, stdout: "pipe", stderr: "pipe" });
      if (tracked.exitCode !== 0) return "untracked";
      const status = Bun.spawnSync(["git", "status", "--porcelain", "--", file], { cwd: root, stdout: "pipe", stderr: "pipe" });
      if (status.exitCode !== 0) return "error";
      return status.stdout.toString().trim().length === 0 ? "clean" : "modified";
    },
    listProcesses: readProcProcesses,
    selfPid: process.pid,
    uid: process.getuid?.() ?? -1,
    killProcess: defaultKillProcess,
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    watchLockFile: path.join(watchStateDir(env), LOCK_FILE),
    watchLock: () => lockHolder(watchStateDir(env)),
    toolVersion: idfxVersion,
    units: defaultUnitDeps,
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
 * empty body after the frontmatter (see `.plan/research/agent-merge.md`).
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
  if (deps.sharedDir === undefined) {
    return result(
      "global-rules",
      "warn",
      `${SHARED_DIR_UNSET} There is no shared rules file.`,
      "set OC_SUB_SHARED_DIR to the folder that holds AGENTS.md (your global rules) and skills/<name>/SKILL.md (your skills)",
    );
  }
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
    "delete the file, the plugin serves the agent, or keep only a permission block (.plan/research/agent-merge.md)",
  );
}

/**
 * The permission block of an agent file, byte for byte: the `permission`
 * entry of the front matter with its indented lines, wrapped in `---`.
 * Null when the file has no front matter or no `permission` entry.
 * Pure, so the tests use it directly.
 */
export function permissionBlockOf(text: string): string | null {
  if (!text.startsWith("---\n")) return null;
  const end = text.indexOf("\n---", 4);
  if (end === -1) return null;
  const lines = text.slice(4, end).split("\n");
  const start = lines.findIndex((line) => /^permission:/.test(line));
  if (start === -1) return null;
  const block: string[] = [];
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]!;
    if (i === start || line.startsWith(" ") || line.startsWith("\t")) block.push(line);
    else break;
  }
  return `---\n${block.join("\n")}\n---\n`;
}

/**
 * The fix of `agent-copies` (writes the project): for each project
 * agent file that is not permission-only, keep only its `permission` block
 * in the front matter and drop the description, model, prompt body, and
 * other keys. A file without a `permission` block is deleted. Because the
 * fix removes content, it needs `--force` (or `--renovate`, which implies
 * it). Each target file must be clean in git (tracked and unmodified), so
 * git holds the old content; a file that is not clean is not touched, and
 * the note names the file, its state, and the step by hand.
 */
export function agentCopiesFix(deps: DoctorDeps, _result: CheckResult, ctx: { force: boolean }): FixOutcome {
  if (ctx.force !== true) {
    return {
      ok: false,
      note: "rewriting an agent file removes its description, model, and prompt. Run oc-sub doctor --fix --force or oc-sub doctor --renovate",
    };
  }
  const agentsDir = path.join(deps.root, ".opencode", "agents");
  const notes: string[] = [];
  let ok = true;
  for (const name of AGENT_NAMES) {
    const file = path.join(agentsDir, `${name}.md`);
    const text = deps.readText(file);
    if (text === null || isPermissionOnlyAgent(text)) continue;
    const state = deps.gitFileState(file);
    if (state !== "clean") {
      ok = false;
      notes.push(fileNotCleanNote(file, state));
      continue;
    }
    const block = permissionBlockOf(text);
    if (block === null) {
      deps.deleteFile(file);
      notes.push(`deleted .opencode/agents/${name}.md (it had no permission block)`);
    } else {
      deps.writeText(file, block);
      notes.push(`kept only the permission block in .opencode/agents/${name}.md`);
    }
  }
  if (notes.length === 0) return { ok: true, note: "the agent files are already permission-only or absent" };
  return { ok, note: notes.join(", ") };
}

/**
 * The note for a project file that a fix does not touch because git does
 * not hold its old content: the note names the file, its git state, and
 * the step by hand. It names no flag, so it fits `--fix` and `--renovate`.
 */
function fileNotCleanNote(file: string, state: "modified" | "untracked" | "error"): string {
  if (state === "untracked") {
    return `${file} is not tracked by git, so a rewrite would lose its content; edit it by hand`;
  }
  if (state === "modified") {
    return `${file} has uncommitted changes; commit or stash them first, or edit the file by hand`;
  }
  return `git failed for ${file}, so the old content is not proven; edit it by hand`;
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
    const old = (plugins as Record<string, unknown>)[OLD_PLUGIN_KEY];
    if (Array.isArray(old) && old.length > 0) {
      return result("plugin-fresh", "warn", OLD_PLUGIN_MESSAGE, OLD_PLUGIN_REINSTALL_FIX);
    }
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
 * non-zero exit is a failed fix, with the command in the note. An install
 * under the old name is a failed fix that names the reinstall commands, and
 * nothing runs.
 */
export function pluginFreshFix(deps: DoctorDeps, res: CheckResult, _ctx: { force: boolean }): FixOutcome {
  // An install under the old name changes the plugin configuration of the
  // user, so the fix leaves it to the user and names the commands.
  if (res.message === OLD_PLUGIN_MESSAGE) {
    return { ok: false, note: `reinstall the plugin by hand: ${OLD_PLUGIN_REINSTALL_FIX}` };
  }
  const marketplaceUpdate = [deps.claudeBin, "plugin", "marketplace", "update", PLUGIN_MARKETPLACE];
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
  if (deps.sharedDir === undefined) return { ok: false, note: `${SHARED_DIR_UNSET} Nothing changed` };
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
 * The fix of `sandbox-mounts`: recreate the sandbox with
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
 * Whether the servers run the current plugin. Every server loads
 * the synced plugin folder, and its state records the digest of that folder
 * at its start. The check warns when the synced folder differs from the
 * plugin folder of this oc-sub (a plugin update since the last `up`), or
 * when a running server started with other content than the synced folder
 * holds now. A server without a record started before the synced plugin folder, so its
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
      problems.push(`the ${serverLabel(server)} has no plugin record (started by an older oc-sub)`);
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

/**
 * The `opencode` tool entry of a mise configuration file: a string, or the
 * `version` of a table such as `{ version = "1.18.32" }`. Null when the file
 * is missing, is not valid TOML, or has no such entry.
 */
export function miseToolVersion(text: string | null, tool: string): string | null {
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(text);
  } catch {
    return null;
  }
  const tools = (parsed as Record<string, unknown>).tools;
  if (typeof tools !== "object" || tools === null) return null;
  const entry = (tools as Record<string, unknown>)[tool];
  if (typeof entry === "string") return entry;
  if (typeof entry === "object" && entry !== null) {
    const version = (entry as Record<string, unknown>).version;
    if (typeof version === "string") return version;
  }
  return null;
}

/**
 * Whether the project runs the opencode version that oc-sub is tested with.
 * The tested version is the `opencode` pin in the `mise.toml` of this
 * repository. The version of the project is what `mise current opencode`
 * resolves in the project root, so a pin in the project `mise.toml` and the
 * fallback of the global mise configuration (often "latest") both count.
 * A pin other than the tested one (the project pin, else the global pin)
 * warns even when it resolves to the tested version today, because the
 * next release changes it silently.
 *
 * Both server modes start `opencode` from PATH. In sandbox mode, `up` runs
 * `mise env -C <root> --json` on the host and puts the tool folders of the
 * project (inside the mounted mise installs folder) in front of the sandbox
 * PATH, so the sandbox server runs the opencode that mise resolves for the
 * project. Only when that folder is missing from the tool PATH does the
 * opencode of the sandbox image run. In host mode, the server runs the
 * opencode of the PATH of the shell that calls `oc-sub up`.
 *
 * The fix action is `opencodeVersionFix`.
 */
function opencodeVersionCheck(deps: DoctorDeps): CheckResult {
  const testedFile = path.join(deps.pluginRepoRoot, "mise.toml");
  const tested = miseToolVersion(deps.readText(testedFile), "opencode");
  if (tested === null) return result("opencode-version", "skip", `no opencode pin in ${testedFile}`);
  const current = deps.miseRunner([deps.miseBin, "current", "opencode"], { cwd: deps.root });
  const resolved = current.stdout.trim().split(/\s+/)[0] ?? "";
  if (current.exitCode !== 0) {
    return result("opencode-version", "skip", `${deps.miseBin} current opencode exited with code ${current.exitCode}`);
  }
  if (resolved.length === 0) return result("opencode-version", "skip", `${deps.miseBin} current opencode printed no version`);
  const projectFile = path.join(deps.root, "mise.toml");
  const projectPin = miseToolVersion(deps.readText(projectFile), "opencode");
  const globalPin = projectPin === null ? miseToolVersion(deps.readText(deps.globalMiseConfig), "opencode") : null;
  // The pin that decides the version: the project pin, else the global pin.
  const pin = projectPin ?? globalPin;
  const file = projectPin !== null ? projectFile : deps.globalMiseConfig;
  const source = projectPin !== null
    ? `the pin opencode = "${projectPin}" in ${projectFile}`
    : globalPin !== null
      ? `the pin opencode = "${globalPin}" in the global mise configuration ${deps.globalMiseConfig}`
      : `the global mise configuration ${deps.globalMiseConfig}`;
  const fix = `set opencode = "${tested}" in ${file} and run mise install`;
  // A pin other than the tested one (for example "latest") warns even when it
  // resolves to the tested version today: the next release breaks it silently.
  if (pin !== null && pin !== tested) {
    return result(
      "opencode-version",
      "warn",
      `${source} resolves to opencode ${resolved} now, but oc-sub is tested only with ${tested}; the next release can change it`,
      fix,
    );
  }
  if (resolved === tested) return result("opencode-version", "pass", `the project runs opencode ${resolved}, the tested version`);
  return result(
    "opencode-version",
    "warn",
    `the project runs opencode ${resolved} (from ${source}), but oc-sub is tested with ${tested}`,
    fix,
  );
}

/**
 * The fix of `opencode-version` (writes the project): when the
 * deciding pin sits in the project `mise.toml`, set it to the tested
 * version, keep the rest of the file byte for byte, and run `mise install`
 * in the project root. The file must be clean in git (tracked and
 * unmodified), so git holds the old content; otherwise nothing changes and
 * the note names the state and the step by hand. When the deciding pin sits
 * in the global mise configuration of the user, nothing changes: the global
 * file belongs to the user, and the fix names the line to set by hand. It
 * runs under plain `--fix` (no `--force` needed), because git holds the old
 * file.
 */
export function opencodeVersionFix(deps: DoctorDeps, _result: CheckResult, _ctx: { force: boolean }): FixOutcome {
  const testedFile = path.join(deps.pluginRepoRoot, "mise.toml");
  const tested = miseToolVersion(deps.readText(testedFile), "opencode");
  if (tested === null) return { ok: false, note: `no opencode pin in ${testedFile}, nothing changed` };
  const projectFile = path.join(deps.root, "mise.toml");
  const text = deps.readText(projectFile);
  const projectPin = miseToolVersion(text, "opencode");
  if (projectPin === null) {
    return {
      ok: false,
      note: `the global mise configuration belongs to the user: set opencode = "${tested}" in ${deps.globalMiseConfig} by hand`,
    };
  }
  if (projectPin === tested) return { ok: true, note: `${projectFile} already pins the tested version ${tested}` };
  const state = deps.gitFileState(projectFile);
  if (state !== "clean") return { ok: false, note: fileNotCleanNote(projectFile, state) };
  // A string pin (`opencode = "x"`) or a table pin (`opencode = { version = "x" }`).
  const pin = new RegExp(`^(\\s*opencode\\s*=\\s*)(?:"[^"]*"|\\{\\s*version\\s*=\\s*"[^"]*"\\s*\\})(.*)$`, "m");
  if (text === null || !pin.test(text)) {
    return { ok: false, note: `cannot find the opencode pin line in ${projectFile}, nothing changed` };
  }
  deps.writeText(projectFile, text.replace(pin, `$1"${tested}"$2`));
  const install = deps.miseRunner([deps.miseBin, "install"], { cwd: deps.root });
  if (install.exitCode !== 0) {
    return {
      ok: false,
      note: `set opencode = "${tested}" in ${projectFile}, but ${deps.miseBin} install exited with code ${install.exitCode}`,
    };
  }
  return { ok: true, note: `set opencode = "${tested}" in ${projectFile} and ran ${deps.miseBin} install` };
}

/**
 * The record of the last opencode release review in `opencode-review.json`
 * of the plugin repository. Null when the file is missing or broken.
 */
type OpencodeReview = { reviewed: string; date: string; decision?: string; notes?: string };

/**
 * The reviewed version and date of the last opencode release review, or null.
 * A missing or broken review file counts as "nothing reviewed".
 */
export function parseOpencodeReview(text: string | null): OpencodeReview | null {
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (typeof parsed.reviewed !== "string" || parsed.reviewed.length === 0) return null;
    if (typeof parsed.date !== "string" || parsed.date.length === 0) return null;
    return { reviewed: parsed.reviewed, date: parsed.date };
  } catch {
    return null;
  }
}

/**
 * Whether the latest opencode release needs a review. It returns "pass" when
 * the latest version is not newer than the tested version, and also when it
 * is not newer than the reviewed version of the last review (a newer release
 * than the pin but already reviewed is fine). Without a review file, only a
 * latest that equals the tested version passes. "warn" means: review the
 * release, then either move the pin or record the decision.
 */
function opencodeReviewCheck(deps: DoctorDeps): CheckResult {
  const testedFile = path.join(deps.pluginRepoRoot, "mise.toml");
  const tested = miseToolVersion(deps.readText(testedFile), "opencode");
  if (tested === null) return result("opencode-release", "skip", `no opencode pin in ${testedFile}`);
  const review = parseOpencodeReview(deps.readText(path.join(deps.pluginRepoRoot, "opencode-review.json")));
  const latestRun = deps.miseRunner([deps.miseBin, "latest", "opencode"]);
  const latest = latestRun.stdout.trim().split(/\s+/)[0] ?? "";
  if (latestRun.exitCode !== 0) {
    return result("opencode-release", "skip", `${deps.miseBin} latest opencode exited with code ${latestRun.exitCode}`);
  }
  if (latest.length === 0) return result("opencode-release", "skip", `${deps.miseBin} latest opencode printed no version`);
  // Pass when the latest version is not newer than the tested version, or not
  // newer than the reviewed version of the last review. Without a review file,
  // only a latest that equals the tested version passes.
  if (Bun.semver.order(latest, tested) <= 0 || (review !== null && Bun.semver.order(latest, review.reviewed) <= 0)) {
    return result("opencode-release", "pass", review === null ? `the latest opencode release is ${latest}, the tested version` : `the latest opencode release is ${latest}, already reviewed on ${review.date}`);
  }
  if (review === null) {
    return result(
      "opencode-release",
      "warn",
      `opencode ${latest} is out; oc-sub is tested with ${tested}, last review none`,
      `read the release notes of opencode ${latest}, then either raise the pin in the mise.toml of oc-sub and run the tests, or record the decision in opencode-review.json`,
    );
  }
  return result(
    "opencode-release",
    "warn",
    `opencode ${latest} is out; oc-sub is tested with ${tested}, last review ${review.reviewed} on ${review.date}`,
    `read the release notes of opencode ${latest}, then either raise the pin in the mise.toml of oc-sub and run the tests, or record the decision in opencode-review.json`,
  );
}

/**
 * The `deepinfra-key` check: the optional DeepInfra key file of the project.
 * Absent is a skip (DeepInfra stays off), mode 600 or stricter is a pass, and
 * a mode that lets the group or other users read it is a warn. It only looks
 * at the mode and never reads the content.
 */
export function deepinfraKeyCheck(deps: DoctorDeps): CheckResult {
  const file = deps.deepinfraKeyFile;
  const mode = deps.fileMode(file);
  if (mode === null) return result("deepinfra-key", "skip", `no DeepInfra key file ${file}; DeepInfra is off`);
  const octal = mode.toString(8).padStart(3, "0");
  if ((mode & 0o077) === 0) return result("deepinfra-key", "pass", `${file} exists with mode ${octal}`);
  return result(
    "deepinfra-key",
    "warn",
    `${file} has mode ${octal}; other users may read the key`,
    `chmod 600 ${file}`,
  );
}

/**
 * The fix text of `research-due`: a recheck is work with a researcher run,
 * not something the doctor can do itself.
 */
export const RESEARCH_DUE_FIX = "Recheck the facts with a researcher run, then set `checked` to today";

/** The fix text of `research-due` when `.handover.toml` has a bad `plan_dir`. */
export const PLAN_DIR_FIX = `Set plan_dir in ${PLAN_CONFIG} to a relative folder inside the project, for example ".plan", or remove the key`;

/**
 * The `research-due` check: every report in
 * `<plan_dir>/research/` of the project root can start with a recheck head
 * (`checked`, `recheck`, `decisions`, see `src/research-head.ts`). The plan
 * folder is `plan_dir` of `.handover.toml` (default `docs`, see
 * `src/plan-dir.ts`). The check warns when one or more reports are due (the
 * due date is today or earlier) or have an invalid head, and names each
 * report, its due date, and its decisions. A trigger (`on ...`) is never due
 * by date and is only information. Reports without a head do not count.
 * Without any head the check passes with the note "no report has a recheck
 * head". A bad `plan_dir` makes the check read `docs` and warn with the
 * problem. It never fails. `deps.today` replaces the real date in the tests.
 */
export function researchDueCheck(deps: DoctorDeps): CheckResult {
  const { planDir, problem } = readPlanDir(deps.root, deps.readText);
  const shown = `${planDir}/research`;
  const done = (status: CheckResult["status"], message: string, fix?: string): CheckResult =>
    problem === undefined
      ? result("research-due", status, message, fix)
      : result("research-due", "warn", `${problem}, so the check read ${shown}; ${message}`, fix ?? PLAN_DIR_FIX);
  const folder = path.join(deps.root, planDir, "research");
  const entries = deps.readdir(folder);
  if (entries === null) return done("pass", `no ${shown} folder, so no report has a recheck head`);
  const today = deps.today ?? todayString();
  const names = entries.filter((name) => name.endsWith(".md")).sort();
  const due: string[] = [];
  const invalid: string[] = [];
  const triggers: string[] = [];
  let heads = 0;
  for (const name of names) {
    const text = deps.readText(path.join(folder, name));
    if (text === null) continue;
    const head = parseResearchHead(text);
    if (head === null) continue;
    heads++;
    const state = recheckState(head, today);
    const decisions = head.decisions.length > 0 ? ` (decisions: ${head.decisions.join("; ")})` : "";
    if (state.kind === "due") due.push(`${name} was due on ${state.due}${decisions}`);
    else if (state.kind === "invalid") invalid.push(`${name}: ${state.problem}`);
    else if (state.kind === "trigger") triggers.push(`${name} rechecks ${head.recheck}`);
  }
  if (heads === 0) return done("pass", `no report in ${shown} has a recheck head`);
  if (due.length > 0 || invalid.length > 0) {
    const lines = [...invalid, ...due].join("; and ");
    return done("warn", lines, RESEARCH_DUE_FIX);
  }
  if (triggers.length > 0) return done("pass", `no report in ${shown} is due; ${triggers.join(", ")}`);
  return done("pass", `no report in ${shown} is due`);
}

/** The RSS limit of the `top-memory` check: 1 GiB. */
export const TOP_RSS_LIMIT = 1024 * 1024 * 1024;

/**
 * Whether the command line runs the oc-sub CLI: one argument ends with the
 * CLI entry, `src/cli.ts` (a run from the repository, as `top` starts it) or
 * `dist/cli.js` (an installed build). A `top` of another program does not
 * match, because its command line holds neither.
 */
export function isOcSubCli(args: readonly string[]): boolean {
  return args.some((arg) => arg.endsWith("src/cli.ts") || arg.endsWith("dist/cli.js"));
}

/**
 * Whether the command line runs the `top` command of oc-sub: the
 * argument right after the CLI entry is `top`, so a `top` in a later
 * argument, for example in the text of `say`, does not match.
 */
export function isOcSubTop(args: readonly string[]): boolean {
  const entry = args.findIndex((arg) => arg.endsWith("src/cli.ts") || arg.endsWith("dist/cli.js"));
  return entry >= 0 && args[entry + 1] === "top";
}

/**
 * The selection of `top-memory`: each process of the current user that runs
 * the `top` command of oc-sub with an RSS above 1 GiB, except doctor itself.
 * Pure apart from the injected scan, so the fix uses the same rule.
 */
export function leakyTopProcesses(deps: DoctorDeps): ProcessInfo[] {
  const processes = deps.listProcesses();
  if (processes === null) return [];
  return processes.filter(
    (p) => p.uid === deps.uid && p.pid !== deps.selfPid && isOcSubTop(p.args) && p.rssBytes > TOP_RSS_LIMIT,
  );
}

/**
 * The `top-memory` check: a `top` of oc-sub that leaked keeps its
 * whole table in memory, and one process can hold gigabytes. It warns with
 * the PID and the RSS in MB of each process over 1 GiB. The fix needs
 * `--force`, because it ends a view of the user: it sends SIGTERM to each
 * listed process, never to doctor itself.
 */
export function topMemoryCheck(deps: DoctorDeps): CheckResult {
  const processes = deps.listProcesses();
  if (processes === null) return result("top-memory", "skip", "no /proc on this platform");
  const leaky = leakyTopProcesses(deps);
  if (leaky.length === 0) return result("top-memory", "pass", "no oc-sub top process over 1 GiB");
  const listed = leaky.map((p) => `${p.pid} (${Math.round(p.rssBytes / (1024 * 1024))} MB)`);
  return result(
    "top-memory",
    "warn",
    `${leaky.length} oc-sub top process(es) over 1 GiB: ${listed.join(", ")}`,
    "run oc-sub doctor --fix --force: it sends SIGTERM to each listed process",
  );
}

/**
 * The fix of `top-memory`: without `--force` nothing runs, because it ends a
 * view of the user. With `--force` it re-scans the processes and sends
 * SIGTERM to each match, never to doctor itself. A process that ended since
 * the check is skipped.
 */
export function topMemoryFix(deps: DoctorDeps, _result: CheckResult, ctx: { force: boolean }): FixOutcome {
  if (ctx.force !== true) {
    return {
      ok: false,
      note: "ending an oc-sub top process needs --force. Run oc-sub doctor --fix --force",
    };
  }
  const leaky = leakyTopProcesses(deps);
  let stopped = 0;
  for (const p of leaky) {
    if (deps.killProcess(p.pid, "SIGTERM")) stopped++;
  }
  if (leaky.length === 0) return { ok: true, note: "no oc-sub top process over 1 GiB" };
  return { ok: true, note: `sent SIGTERM to ${stopped} oc-sub top process(es)` };
}

/**
 * The parent of an orphan: PID 1, or a parent whose command line is `/init`
 * (the WSL init, which adopts orphaned processes).
 */
function parentIsInit(processes: readonly ProcessInfo[], ppid: number): boolean {
  if (ppid === 1) return true;
  const parent = processes.find((p) => p.pid === ppid);
  return parent !== undefined && parent.args.length > 0 && parent.args[0] === "/init";
}

/**
 * The selection of `orphan-processes`: each process of the current user
 * whose parent is PID 1 or `/init` and whose working folder is deleted, except
 * doctor itself. Pure apart from the injected scan, so the fix uses it too.
 */
export function orphanProcesses(deps: DoctorDeps): ProcessInfo[] {
  const processes = deps.listProcesses();
  if (processes === null) return [];
  return processes.filter(
    (p) =>
      p.uid === deps.uid &&
      p.pid !== deps.selfPid &&
      parentIsInit(processes, p.ppid) &&
      p.cwd !== null &&
      p.cwd.endsWith(" (deleted)"),
  );
}

/** How many `PID command (cwd)` entries the `orphan-processes` message lists. */
const ORPHAN_LIST_LIMIT = 10;

/** The `orphan-processes` check: see `orphanProcesses`. */
export function orphanProcessesCheck(deps: DoctorDeps): CheckResult {
  const processes = deps.listProcesses();
  if (processes === null) return result("orphan-processes", "skip", "no /proc on this platform");
  const orphans = orphanProcesses(deps);
  if (orphans.length === 0) return result("orphan-processes", "pass", "no process runs in a deleted folder");
  const listed = orphans.slice(0, ORPHAN_LIST_LIMIT).map((p) => `${p.pid} ${p.args.join(" ")} (${p.cwd})`);
  const prefix = orphans.length > ORPHAN_LIST_LIMIT ? `${orphans.length} orphaned process(es), first ${ORPHAN_LIST_LIMIT}: ` : `${orphans.length} orphaned process(es): `;
  return result(
    "orphan-processes",
    "warn",
    `${prefix}${listed.join(", ")}`,
    "run oc-sub doctor --fix --force: it sends SIGTERM to each listed process, then SIGKILL after 5 s",
  );
}

/**
 * The orphans plus all their descendants of the current user. Without the
 * descendants, a stopped orphan leaves its children behind as new orphans,
 * for example the `bun` child of a `sh -c "while :; do bun ...; done"` loop.
 */
export function withDescendants(all: readonly ProcessInfo[], roots: readonly ProcessInfo[], deps: DoctorDeps): ProcessInfo[] {
  const out = [...roots];
  const seen = new Set(roots.map((p) => p.pid));
  for (let i = 0; i < out.length; i++) {
    const parent = out[i];
    if (parent === undefined) continue;
    for (const child of all) {
      if (child.ppid !== parent.pid || seen.has(child.pid)) continue;
      if (child.uid !== deps.uid || child.pid === deps.selfPid) continue;
      seen.add(child.pid);
      out.push(child);
    }
  }
  return out;
}

/** How long the fix of `orphan-processes` waits between SIGTERM and SIGKILL. */
export const ORPHAN_KILL_WAIT_MS = 5000;

/**
 * The fix of `orphan-processes`: without `--force` nothing runs, because it
 * ends processes. With `--force` it sends SIGTERM to each match and to all
 * its descendants of the current user, waits up to
 * 5 seconds, and sends SIGKILL to each process that still runs. A process
 * that ended on the SIGTERM is not killed again. It returns ok with the
 * count of stopped processes.
 */
export async function orphanProcessesFix(deps: DoctorDeps, _result: CheckResult, ctx: { force: boolean }): Promise<FixOutcome> {
  if (ctx.force !== true) {
    return {
      ok: false,
      note: "stopping orphaned processes needs --force. Run oc-sub doctor --fix --force",
    };
  }
  const all = deps.listProcesses() ?? [];
  const orphans = withDescendants(all, orphanProcesses(deps), deps);
  if (orphans.length === 0) return { ok: true, note: "no process runs in a deleted folder" };
  let alive = 0;
  for (const p of orphans) {
    if (deps.killProcess(p.pid, "SIGTERM")) alive++;
  }
  await deps.wait(ORPHAN_KILL_WAIT_MS);
  const after = deps.listProcesses();
  let killed = 0;
  if (after !== null) {
    const pids = new Set(after.map((p) => p.pid));
    for (const p of orphans) {
      if (pids.has(p.pid) && deps.killProcess(p.pid, "SIGKILL")) killed++;
    }
  }
  const stopped = alive - killed;
  return { ok: true, note: `stopped ${stopped} orphaned process(es), SIGKILL after 5 s for ${killed}` };
}

/** How many unit entries the `units` message lists. */
const UNIT_LIST_LIMIT = 10;

/** The hint of the `units` check when it finds an orphaned unit. */
export const UNITS_FIX = "run oc-sub doctor --fix --force: it stops each orphaned unit";

/** One unit as `<unit> (owner <owner>: <reason>)`, or `<unit> (no owner: <description>)`. Pure. */
export function unitEntry(u: LoadedUnit): string {
  const { owner, reason } = parseUnitLabel(u.description);
  return owner.length > 0 ? `${u.unit} (owner ${owner}: ${reason})` : `${u.unit} (no owner: ${reason})`;
}

/** At most `UNIT_LIST_LIMIT` entries, joined with ", ", and a note on the rest. Pure. */
function limitedList(entries: readonly string[]): string {
  const shown = entries.slice(0, UNIT_LIST_LIMIT).join(", ");
  const rest = entries.length - UNIT_LIST_LIMIT;
  return rest > 0 ? `${shown}, and ${rest} more` : shown;
}

/**
 * The `units` check: it lists the loaded `ocsub-*` systemd user units with
 * owner and reason, and warns for each orphaned unit (see `orphanedUnits` in
 * `src/units.ts`): its folder is gone, or it is a proxy or idle unit of a
 * port without a serve or holder unit. It skips without a user manager. It
 * does not ask whether a named owner session still lives.
 */
export function unitsCheck(deps: DoctorDeps): CheckResult {
  const units = listUnits(deps.units);
  if (units === null) return result("units", "skip", "no systemd user manager");
  if (units.length === 0) return result("units", "pass", "no ocsub unit is loaded");
  const orphans = orphanedUnits(units, deps.exists);
  if (orphans.length === 0) {
    return result("units", "pass", `${units.length} ocsub unit(s): ${limitedList(units.map(unitEntry))}`);
  }
  return result(
    "units",
    "warn",
    `${orphans.length} of ${units.length} ocsub unit(s) orphaned: ${limitedList(orphans.map((u) => `${unitEntry(u)}: ${u.cause}`))}`,
    UNITS_FIX,
  );
}

/**
 * The fix of `units`: without `--force` nothing runs, because it stops
 * processes. With `--force` it lists the units again and stops each orphaned
 * unit with `systemctl --user stop`, never the unit of doctor itself. A unit
 * that is no longer loaded counts as done. The fix fails when a stop fails.
 */
export function unitsFix(deps: DoctorDeps, _result: CheckResult, ctx: { force: boolean }): FixOutcome {
  if (ctx.force !== true) {
    return { ok: false, note: "stopping an orphaned unit needs --force. Run oc-sub doctor --fix --force" };
  }
  const units = listUnits(deps.units);
  if (units === null) return { ok: true, note: "no systemd user manager" };
  const own = deps.units.ownUnit();
  const orphans = orphanedUnits(units, deps.exists).filter((u) => u.unit !== own);
  if (orphans.length === 0) return { ok: true, note: "no orphaned ocsub unit" };
  let stopped = 0;
  const failed: string[] = [];
  for (const u of orphans) {
    try {
      if (stopUnit(u.unit, deps.units)) stopped++;
    } catch (error) {
      failed.push(`${u.unit}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failed.length > 0) {
    return { ok: false, note: `stopped ${stopped} orphaned unit(s), ${failed.length} failed: ${limitedList(failed)}` };
  }
  return { ok: true, note: `stopped ${stopped} orphaned unit(s)` };
}

/** The command that installs and starts the watcher as a systemd user service. */
export const WATCH_SERVICE_FIX =
  "systemctl --user enable --now idfx-watch.service (link the unit contrib/systemd/idfx-watch.service into ~/.config/systemd/user/ first)";

/**
 * The `watch-running` check (design .plan/design/idfx-watch.md, section 6):
 * a pass when the holder of `events.lock` lives (its PID exists and its
 * start time matches), else a warn. There is no automatic fix, because
 * the user installs the unit.
 */
export function watchRunningCheck(deps: DoctorDeps): CheckResult {
  const holder = deps.watchLock();
  if (holder.state === "live") return result("watch-running", "pass", `idfx watch --all runs (pid ${holder.pid})`);
  const why =
    holder.state === "stale"
      ? `the lock ${deps.watchLockFile} names pid ${holder.pid}, which no longer runs`
      : `no lock ${deps.watchLockFile}`;
  return result("watch-running", "warn", `no idfx watch --all runs: ${why}; the supervisor gets no wake-up`, WATCH_SERVICE_FIX);
}

/** The fast checks: `up` and `run` run them on every invocation. */
export const FAST_CHECKS: Check[] = [
  { name: "env-files", run: envFilesCheck },
  { name: "claude-md", run: claudeMdCheck },
  { name: "agents-md", run: agentsMdCheck },
  { name: "global-rules", run: globalRulesCheck, fix: globalRulesFix },
  { name: "skill-links", run: skillLinksCheck },
  { name: "agent-copies", run: agentCopiesCheck, fix: agentCopiesFix },
];

/** The slow checks: only `oc-sub doctor` runs them. */
export const SLOW_CHECKS: Check[] = [
  // First: it only spawns mise, and no other check or fix depends on it.
  { name: "opencode-version", run: opencodeVersionCheck, fix: opencodeVersionFix },
  { name: "opencode-release", run: opencodeReviewCheck },
  { name: "plugin-fresh", run: pluginFreshCheck, fix: pluginFreshFix },
  // After plugin-fresh, so a plugin update comes before the sync and the restart.
  { name: "server-plugin", run: serverPluginCheck, fix: serverPluginFix },
  // Before sandbox-mounts: without KVM access, the sandbox cannot start.
  { name: "kvm-access", run: (deps) => kvmAccessCheck(deps.kvm), rootFix: kvmAccessRootFix },
  { name: "sandbox-mounts", run: sandboxMountsCheck, fix: sandboxMountsFix },
  { name: "deepinfra-key", run: deepinfraKeyCheck },
  { name: "research-due", run: researchDueCheck },
  { name: "watch-running", run: watchRunningCheck },
  // Last: they scan /proc, and a fix must run after the plugin and sandbox fixes.
  { name: "top-memory", run: topMemoryCheck, fix: topMemoryFix },
  { name: "orphan-processes", run: orphanProcessesCheck, fix: orphanProcessesFix },
  // After orphan-processes: it asks the user manager, not /proc.
  { name: "units", run: unitsCheck, fix: unitsFix },
];

/** All checks in their fixed order. */
export const ALL_CHECKS: Check[] = [...FAST_CHECKS, ...SLOW_CHECKS];

/**
 * Run one check. A check that throws gives the status `error` with the
 * message of the throw, so one broken check never stops the doctor.
 */
export function runCheck(check: Check, deps: DoctorDeps): CheckResult {
  try {
    return check.run(deps);
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    return { name: check.name, status: "error", message: `the check did not run: ${text}`, error: text };
  }
}

/** Run the given checks in order and return their results. */
export function runChecks(checks: readonly Check[], deps: DoctorDeps): CheckResult[] {
  return checks.map((check) => runCheck(check, deps));
}

/** The stable key of a check in the tool protocol: `urn:dv:idfx:doctor:<name>`. */
export function checkType(name: string): string {
  return `urn:dv:${TOOL}:doctor:${name}`;
}

/** One check in the `--json` object: the result plus its `type`. */
export type ProtocolCheck = CheckResult & { type: string };

/** The `doctor --json` object of the tool protocol, version 0. `fixes` exists only with `--fix`. */
export type DoctorReport = {
  tool: string;
  version: string;
  status: "pass" | "warn" | "fail";
  checks: ProtocolCheck[];
  fixes?: FixRecord[];
};

/**
 * The top-level status: `fail` when a check fails, else `warn` when a check
 * warns or did not run (`error`), else `pass`.
 */
export function overallStatus(results: readonly CheckResult[]): DoctorReport["status"] {
  if (results.some((check) => check.status === "fail")) return "fail";
  if (results.some((check) => check.status === "warn" || check.status === "error")) return "warn";
  return "pass";
}

/** The `--json` object of the results, with the fix records of `--fix`. */
export function doctorReport(results: readonly CheckResult[], version: string, fixes?: FixRecord[]): DoctorReport {
  const checks = results.map((check) => {
    const { name, status, message, fix, error } = check;
    return {
      name,
      status,
      type: checkType(name),
      message,
      ...(fix === undefined ? {} : { fix }),
      ...(error === undefined ? {} : { error }),
    };
  });
  return {
    tool: TOOL,
    version,
    status: overallStatus(results),
    checks,
    ...(fixes === undefined ? {} : { fixes }),
  };
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
  if (status === "fail") return "FAIL";
  if (status === "error") return "ERROR";
  return status;
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
  const errors = count("error");
  console.log(
    `${count("pass")} pass, ${count("warn")} warn, ${count("fail")} fail, ${count("skip")} skip${errors > 0 ? `, ${errors} error` : ""}`,
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
    } else if (check.status === "warn" || check.status === "error") {
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

/**
 * `oc-sub doctor`: run all checks and print the results. With `--json`,
 * stdout holds exactly one object of the tool protocol (`doctorReport`):
 * `{tool, version, status, checks, fixes?}`; all other lines go to stderr.
 *
 * Exit codes: 0 when all checks pass or some warn; 1 when a check fails or
 * a fix failed; 2 when the doctor itself cannot run (Nagios "unknown"). A
 * usage error also gives 2, in `src/cli.ts`.
 */
export async function doctor(
  args: { dir?: string; json?: boolean; fix?: boolean; force?: boolean; fixAsRoot?: boolean; renovate?: boolean },
  env: Env = process.env,
  overrides: Partial<DoctorDeps> = {},
): Promise<number> {
  try {
    return await runDoctor(args, env, overrides);
  } catch (error) {
    // Nothing goes to stdout here: in JSON mode, an empty stdout and code 2 mean "unknown".
    console.error(`doctor cannot run: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}

async function runDoctor(
  args: { dir?: string; json?: boolean; fix?: boolean; force?: boolean; fixAsRoot?: boolean; renovate?: boolean },
  env: Env,
  overrides: Partial<DoctorDeps>,
): Promise<number> {
  const deps = makeDoctorDeps(env, args.dir ?? process.cwd(), overrides);
  const results = runChecks(ALL_CHECKS, deps);
  // --renovate lifts the project to the current standard: it implies --fix
  // and runs the fix pass with force, so the fixes that need --force (for
  // example the recreate of sandbox-mounts and the agent-copies rewrite)
  // run too. The guards inside a fix still block, also with --renovate.
  // --fix-as-root implies --fix and also runs the root fixes.
  const fix = args.fix === true || args.fixAsRoot === true || args.renovate === true;
  if (fix) {
    // With --json, stdout holds only the JSON object, so the fix lines go to stderr.
    const print = args.json === true ? console.error : console.log;
    const fixes = await runFixes(
      ALL_CHECKS,
      deps,
      results,
      { force: args.force === true || args.renovate === true, asRoot: args.fixAsRoot === true },
      print,
    );
    const rerun = runChecks(ALL_CHECKS, deps);
    if (args.json === true) {
      console.log(JSON.stringify(doctorReport(rerun, deps.toolVersion(), fixes), null, 2));
    } else {
      printResults(rerun);
    }
    const anyFail = rerun.some((check) => check.status === "fail");
    const fixFailed = fixes.some((fix) => !fix.ok);
    return anyFail || fixFailed ? 1 : 0;
  }
  if (args.json === true) {
    console.log(JSON.stringify(doctorReport(results, deps.toolVersion()), null, 2));
  } else {
    printResults(results);
  }
  return results.some((check) => check.status === "fail") ? 1 : 0;
}
