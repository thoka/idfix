/**
 * `oc-sub doctor`: a registry of named health checks. The fast checks 1 to 6
 * only stat and list directories (except check 6, which reads the frontmatter
 * of a project agent file), so `up` and `run` run them on every invocation.
 * The slow checks 7 and 8 need a git call or an `sbx ls` call, so only
 * `oc-sub doctor` runs them. The design is in `docs/research/DOCTOR.md`.
 * Every dependency is injected, so the tests use fakes like in
 * `test/sandbox.test.ts`.
 */
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { Env } from "./config";
import { miseInstallsDir, readSandboxState, requiredSandboxMounts, sandboxName, sandboxStatePath, listsMounts, listsName, defaultRunner, type Runner, type SandboxState } from "./sandbox";
import { sharedAgentsDir } from "./shared";
import { PLUGIN_CONFIG_DIR } from "./up";

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
  /** The content of a text file, or null. Used only for agent files. */
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
    projectName: path.basename(root),
    pluginRepoRoot: path.resolve(import.meta.dir, ".."),
    installedPluginsFile: path.join(env.HOME ?? homedir(), ".claude", "plugins", "installed_plugins.json"),
    originAlphaSha: () => defaultOriginAlphaSha(path.resolve(import.meta.dir, "..")),
    sandboxState: () => readSandboxState(sandboxStatePath(env, path.basename(root))),
    sandboxBin: env.SBX_BIN !== undefined && env.SBX_BIN.length > 0 ? env.SBX_BIN : "sbx",
    runner: defaultRunner,
  };
  return { ...deps, ...overrides };
}

/** One named check. */
export type Check = { name: string; run: (deps: DoctorDeps) => CheckResult };

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

function globalRulesCheck(deps: DoctorDeps): CheckResult {
  const paths = [
    path.join(deps.home, ".claude", "CLAUDE.md"),
    path.join(deps.home, ".config", "opencode", "AGENTS.md"),
    path.join(deps.home, ".codex", "AGENTS.md"),
  ];
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

function sandboxMountsCheck(deps: DoctorDeps): CheckResult {
  const state = deps.sandboxState();
  if (state === null) return result("sandbox-mounts", "skip", "no sandbox state file for this project");
  const ls = deps.runner([deps.sandboxBin, "ls"]).stdout;
  const name = sandboxName(deps.projectName);
  if (!listsName(ls, name)) {
    return result("sandbox-mounts", "skip", `no sandbox ${name} in sbx ls (it is stopped or removed)`);
  }
  const mounts = requiredSandboxMounts(PLUGIN_CONFIG_DIR, deps.installsDir, deps.sharedDir);
  if (listsMounts(ls, name, mounts)) {
    return result("sandbox-mounts", "pass", `the sandbox ${name} has all required mounts`);
  }
  return result(
    "sandbox-mounts",
    "fail",
    `the sandbox ${name} lacks the plugin, the mise installs, or the shared agents mount`,
    `Remove it with: sbx rm ${name}, then run oc-sub up. It creates the sandbox again with all three mounts.`,
  );
}

/** The fast checks: `up` and `run` run them on every invocation. */
export const FAST_CHECKS: Check[] = [
  { name: "env-files", run: envFilesCheck },
  { name: "claude-md", run: claudeMdCheck },
  { name: "agents-md", run: agentsMdCheck },
  { name: "global-rules", run: globalRulesCheck },
  { name: "skill-links", run: skillLinksCheck },
  { name: "agent-copies", run: agentCopiesCheck },
];

/** The slow checks: only `oc-sub doctor` runs them. */
export const SLOW_CHECKS: Check[] = [
  { name: "plugin-fresh", run: pluginFreshCheck },
  { name: "sandbox-mounts", run: sandboxMountsCheck },
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
  const fast = runFastChecksFor(env, args.dir ?? process.cwd(), overrides);
  return gateFastChecks(fast.results, fast.ms);
}

/** `oc-sub doctor`: run all checks and print the results. */
export function doctor(
  args: { dir?: string; json?: boolean },
  env: Env = process.env,
  overrides: Partial<DoctorDeps> = {},
): number {
  const deps = makeDoctorDeps(env, args.dir ?? process.cwd(), overrides);
  const results = runChecks(ALL_CHECKS, deps);
  if (args.json === true) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    printResults(results);
  }
  return results.some((check) => check.status === "fail") ? 1 : 0;
}
