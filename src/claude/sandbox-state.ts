/**
 * The state folder of Claude Code for one sbx sandbox (option D of the
 * Claude sandbox design). Each sandbox gets one writable host folder,
 * `<state base>/idfx/sbx/<sandbox>/claude/`, mounted at create time.
 * Inside the sandbox, Claude Code uses it as `CLAUDE_CONFIG_DIR`, so its
 * transcripts land on the host live.
 *
 * Before each run, idfix syncs the host configuration into the folder, with
 * links followed:
 *
 * - `CLAUDE.md` from the host Claude config folder.
 * - `skills/` from the host, without dot folders such as `.trash`.
 * - `plugins-src/<name>/` from the `installPath` of each enabled plugin.
 * - `settings.json`, written by idfix: the permission values of the claude
 *   kit plus the host `model` and `env`. No hooks and no `statusLine`,
 *   because their programs do not exist in the sandbox.
 *
 * The sync owns only these four entries. Everything else in the folder
 * (`projects/`, `.credentials.json`, the session files) belongs to Claude
 * Code in the sandbox and stays. The sync never reads the host
 * `.credentials.json`: the exec command copies the static sentinel of the
 * kit inside the sandbox (`claudeExecArgs`).
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, chmodSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { Env } from "../config";
import { newStateDir } from "../state";
import { SANDBOX_HOME, shellQuote } from "../sandbox";

/**
 * The state folder of one sandbox: `<state base>/idfx/sbx/<sandbox>/claude`.
 * It uses the new state folder name, never the legacy one, because the mount
 * path is fixed at create time and must not change with a later migration.
 * Pure.
 */
export function claudeStateDir(env: Env, sandbox: string, home: string = env.HOME ?? homedir()): string {
  return path.join(newStateDir(env, home), "sbx", sandbox, "claude");
}

/**
 * Whether a path lies in `/tmp/claude-<uid>`, the temp folder of Claude Code.
 * A mount there makes sbx create that folder as root inside the VM, and then
 * Claude Code refuses to start. Pure.
 */
export function inClaudeTmp(dir: string, uid: number): boolean {
  const tmp = `/tmp/claude-${uid}`;
  const resolved = path.resolve(dir);
  return resolved === tmp || resolved.startsWith(`${tmp}/`);
}

/** The current user ID, or -1 where the platform has none. */
function currentUid(): number {
  return typeof process.getuid === "function" ? process.getuid() : -1;
}

/**
 * Creates the state folder with mode 700, and sets the mode again when the
 * folder exists. It throws for a path in `/tmp/claude-<uid>`.
 */
export function ensureClaudeStateDir(dir: string, uid: number = currentUid()): void {
  if (inClaudeTmp(dir, uid)) {
    throw new Error(`the Claude state folder ${dir} lies in /tmp/claude-${uid}; Claude Code in the sandbox cannot start then`);
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

/** The host Claude config folder: `$CLAUDE_CONFIG_DIR`, else `~/.claude`. Pure. */
export function hostClaudeDir(env: Env, home: string = env.HOME ?? homedir()): string {
  const dir = env.CLAUDE_CONFIG_DIR;
  return dir !== undefined && path.isAbsolute(dir) ? dir : path.join(home, ".claude");
}

/** One enabled plugin: its short name and its install folder on the host. */
export type EnabledPlugin = { name: string; installPath: string };

function parseObject(text: string | undefined): Record<string, unknown> {
  if (text === undefined) return {};
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** A plugin name that is safe as one folder name. */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * The enabled plugins with their install folders. `installedText` is the
 * text of `plugins/installed_plugins.json` (shape
 * `{"version": 2, "plugins": {"<plugin>@<marketplace>": [{scope, installPath, ...}]}}`),
 * `settingsText` the text of the host `settings.json` with `enabledPlugins`
 * (`{"<plugin>@<marketplace>": true}`). Of the install entries, it takes the
 * first one with the scope `user`. A plugin without such an entry, with an
 * unsafe name, or with a name that an earlier plugin already has is left
 * out. The result is sorted by name. Pure.
 */
export function enabledPlugins(installedText: string | undefined, settingsText: string | undefined): EnabledPlugin[] {
  const installed = parseObject(installedText).plugins;
  const enabled = parseObject(settingsText).enabledPlugins;
  if (typeof installed !== "object" || installed === null) return [];
  if (typeof enabled !== "object" || enabled === null) return [];
  const result: EnabledPlugin[] = [];
  const seen = new Set<string>();
  for (const key of Object.keys(enabled).sort()) {
    if ((enabled as Record<string, unknown>)[key] !== true) continue;
    const entries = (installed as Record<string, unknown>)[key];
    if (!Array.isArray(entries)) continue;
    const entry = entries.find(
      (item): item is { installPath: string } =>
        typeof item === "object" && item !== null && item.scope === "user" && typeof item.installPath === "string" && path.isAbsolute(item.installPath),
    );
    const name = key.split("@")[0] ?? "";
    if (entry === undefined || !SAFE_NAME.test(name) || seen.has(name)) continue;
    seen.add(name);
    result.push({ name, installPath: entry.installPath });
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

/** Env names that the sandbox sets itself, so the host value must not win. */
const SANDBOX_OWNED_ENV = new Set(["CLAUDE_CONFIG_DIR"]);

/**
 * The `settings.json` of the sandbox: the kit values
 * `permissions.defaultMode: bypassPermissions` and
 * `skipDangerousModePermissionPrompt: true`, plus the host `model` (a
 * string) and the host `env` (its string values, without
 * `CLAUDE_CONFIG_DIR`). Hooks, `statusLine`, and all other host keys stay
 * out. Pure.
 */
export function sandboxSettings(hostSettingsText: string | undefined): Record<string, unknown> {
  const host = parseObject(hostSettingsText);
  const settings: Record<string, unknown> = {
    permissions: { defaultMode: "bypassPermissions" },
    skipDangerousModePermissionPrompt: true,
  };
  if (typeof host.model === "string" && host.model.length > 0) settings.model = host.model;
  if (typeof host.env === "object" && host.env !== null && !Array.isArray(host.env)) {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(host.env)) {
      if (typeof value === "string" && !SANDBOX_OWNED_ENV.has(key)) env[key] = value;
    }
    if (Object.keys(env).length > 0) settings.env = env;
  }
  return settings;
}

function readOrUndefined(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Replaces `target` with a copy of `source`, links followed. The copy goes to
 * a sibling temp folder first and replaces the old folder only when it is
 * complete. A dangling link is skipped. `skip` gets the base name of each
 * entry directly below `source` and leaves it out when it returns true.
 */
function replaceTree(source: string, target: string, skip: (name: string) => boolean = () => false): void {
  const temp = `${target}.sync-${process.pid}`;
  rmSync(temp, { recursive: true, force: true });
  mkdirSync(temp, { recursive: true });
  if (existsSync(source)) {
    cpSync(source, temp, {
      recursive: true,
      dereference: true,
      filter: (src) => {
        if (path.dirname(src) === source && skip(path.basename(src))) return false;
        return existsSync(src);
      },
    });
  }
  rmSync(target, { recursive: true, force: true });
  renameSync(temp, target);
}

/** The result of `syncClaudeState`. */
export type ClaudeStateSync = {
  /** The folders for `--plugin-dir`, one per enabled plugin, sorted by name. */
  pluginDirs: string[];
  /** The plugins that were enabled but had no install folder on the host. */
  missingPlugins: string[];
};

/**
 * Syncs the host Claude configuration from `hostDir` into the state folder
 * `stateDir` (see the module comment). Links are followed, and stale files
 * of the four synced entries go away. The function creates the state folder
 * with mode 700 and throws for a path in `/tmp/claude-<uid>`.
 */
export function syncClaudeState(hostDir: string, stateDir: string, uid: number = currentUid()): ClaudeStateSync {
  ensureClaudeStateDir(stateDir, uid);

  const rules = path.join(hostDir, "CLAUDE.md");
  const rulesTarget = path.join(stateDir, "CLAUDE.md");
  rmSync(rulesTarget, { force: true });
  if (existsSync(rules)) copyFileSync(rules, rulesTarget);

  replaceTree(path.join(hostDir, "skills"), path.join(stateDir, "skills"), (name) => name.startsWith("."));

  const settingsText = readOrUndefined(path.join(hostDir, "settings.json"));
  const plugins = enabledPlugins(readOrUndefined(path.join(hostDir, "plugins", "installed_plugins.json")), settingsText);
  const pluginsRoot = path.join(stateDir, "plugins-src");
  const pluginsTemp = `${pluginsRoot}.sync-${process.pid}`;
  rmSync(pluginsTemp, { recursive: true, force: true });
  mkdirSync(pluginsTemp, { recursive: true });
  const pluginDirs: string[] = [];
  const missingPlugins: string[] = [];
  for (const plugin of plugins) {
    if (!existsSync(plugin.installPath)) {
      missingPlugins.push(plugin.name);
      continue;
    }
    replaceTree(plugin.installPath, path.join(pluginsTemp, plugin.name));
    pluginDirs.push(path.join(pluginsRoot, plugin.name));
  }
  rmSync(pluginsRoot, { recursive: true, force: true });
  renameSync(pluginsTemp, pluginsRoot);

  const settingsTarget = path.join(stateDir, "settings.json");
  writeFileSync(`${settingsTarget}.tmp`, `${JSON.stringify(sandboxSettings(settingsText), null, 2)}\n`, { mode: 0o600 });
  renameSync(`${settingsTarget}.tmp`, settingsTarget);

  return { pluginDirs, missingPlugins };
}

/**
 * The `sbx create` command of a Claude sandbox in clone mode: the repository
 * as workspace and the state folder as one writable mount at its host path.
 * `--skills=off` keeps the sbx skills store out, because the state folder
 * is the source of the skills. Pure.
 */
export function claudeCreateArgs(bin: string, sandbox: string, repo: string, stateDir: string): string[] {
  return [bin, "create", "--clone", "--skills=off", "--name", sandbox, "claude", repo, stateDir];
}

/** The credentials file of the kit inside the sandbox; it holds only a static sentinel pair. */
export const KIT_CREDENTIALS = `${SANDBOX_HOME}/.claude/.credentials.json`;

/**
 * The `sbx exec` command of one Claude run. It sets `CLAUDE_CONFIG_DIR` to
 * the state folder, copies the sentinel credentials of the kit into it once
 * (mode 600), changes to `worktree`, and runs `claude` with `claudeArgs`
 * and one `--plugin-dir` per plugin folder. Every value is shell quoted.
 * Pure.
 */
export function claudeExecArgs(
  bin: string,
  sandbox: string,
  stateDir: string,
  worktree: string,
  pluginDirs: readonly string[],
  claudeArgs: readonly string[],
): string[] {
  const copy = `test -f "$CLAUDE_CONFIG_DIR/.credentials.json" || install -m 600 ${shellQuote(KIT_CREDENTIALS)} "$CLAUDE_CONFIG_DIR/.credentials.json"`;
  const claude = ["claude", ...claudeArgs, ...pluginDirs.flatMap((dir) => ["--plugin-dir", dir])].map(shellQuote).join(" ");
  const script = `${copy} && cd ${shellQuote(worktree)} && exec ${claude}`;
  return [bin, "exec", "-e", `CLAUDE_CONFIG_DIR=${stateDir}`, sandbox, "bash", "-lc", script];
}
