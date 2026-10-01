/**
 * The synced plugin folder (step 15c). Every server that `oc-sub up` starts
 * loads the plugin config (agents, `opencode.json`, the cost proxy bundle)
 * from one fixed real folder: `$XDG_DATA_HOME/oc-sub/opencode/`, default
 * `~/.local/share/oc-sub/opencode/`. `up` copies the `opencode/` folder of
 * the current plugin into it before it starts a server, and the state
 * records a content digest of the folder for each server. The `server-plugin`
 * check of `doctor` compares the digests.
 *
 * A sandbox mount holds the folder itself, not its path, so the sync replaces
 * content in place and never renames or removes the folder. New content in a
 * mounted real folder appears inside the sandbox at once (tested with sbx
 * 0.45.1). A symlink as mount source would be resolved only once, at create
 * time.
 */
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { Env } from "./config";
import { dataHome } from "./keys";

/**
 * Top-level entries that opencode itself writes into a config folder: it
 * installed `@opencode-ai/plugin` there with a `package.json`, a lock file,
 * and `node_modules/`, and it expects a `.gitignore` that lists them. They
 * are not part of the plugin. The sync neither copies nor removes them, and
 * the digest ignores them, so a server can keep its install in the synced
 * folder. The sync writes a missing `.gitignore` itself (see
 * `OPENCODE_GITIGNORE`).
 */
export const OPENCODE_OWNED = new Set(["node_modules", "package.json", "package-lock.json", "bun.lock", ".gitignore"]);

/**
 * The exact content of the `.gitignore` that opencode writes into a config
 * folder. Source: opencode 1.18.32, `packages/opencode/src/config/config.ts:317`
 * (see `docs/research/OPENCODE_CONFIG_WRITES.md`, short answers 1 and 2). The
 * sync writes this file when missing, because a sandbox server with a
 * read-only config folder fails every request with EROFS when opencode tries
 * to write it itself.
 */
export const OPENCODE_GITIGNORE = "node_modules\npackage.json\npackage-lock.json\nbun.lock\n.gitignore";

/** The synced plugin folder: `<dataHome>/oc-sub/opencode`. */
export function pluginDataDir(env: Env): string {
  return path.join(dataHome(env, env.HOME ?? homedir()), "oc-sub", "opencode");
}

/** The cost proxy bundle inside a plugin config folder. */
export function proxyBundleIn(pluginDir: string): string {
  return path.join(pluginDir, "cost-proxy", "cost-proxy.js");
}

function lstatOrNull(file: string): Stats | null {
  try {
    return lstatSync(file);
  } catch {
    return null;
  }
}

/** The kind of a file system entry, as the sync and the digest see it. */
function kindOf(stat: Stats): "dir" | "file" | "link" | "other" {
  if (stat.isSymbolicLink()) return "link";
  if (stat.isDirectory()) return "dir";
  if (stat.isFile()) return "file";
  return "other";
}

/** The sorted entry names of a folder, without the opencode-owned ones at the top level. */
function pluginEntries(dir: string, topLevel: boolean): string[] {
  const names = readdirSync(dir).sort();
  return topLevel ? names.filter((name) => !OPENCODE_OWNED.has(name)) : names;
}

/**
 * The SHA-256 content digest of a plugin folder, as `sha256:<hex>`, or null
 * when the folder does not exist. It covers the relative path, the kind, and
 * the content (the target for a symlink) of every entry in sorted order, and
 * skips the opencode-owned top-level entries. Equal content gives an equal
 * digest in any folder, so the digest of the source and of the synced copy
 * can be compared directly.
 */
export function pluginDigest(dir: string): string | null {
  const root = lstatOrNull(dir);
  if (root === null || !root.isDirectory()) return null;
  const hash = createHash("sha256");
  const walk = (folder: string, rel: string) => {
    for (const name of pluginEntries(folder, rel === "")) {
      const full = path.join(folder, name);
      const relPath = rel === "" ? name : `${rel}/${name}`;
      const stat = lstatSync(full);
      const kind = kindOf(stat);
      hash.update(`${kind}\0${relPath}\0`);
      if (kind === "file") hash.update(readFileSync(full));
      else if (kind === "link") hash.update(readlinkSync(full));
      hash.update("\0");
      if (kind === "dir") walk(full, relPath);
    }
  };
  walk(dir, "");
  return `sha256:${hash.digest("hex")}`;
}

/**
 * Removes every entry of `dest` that `src` does not have with the same kind,
 * recursively. The opencode-owned top-level entries stay.
 */
function removeStale(src: string, dest: string, topLevel: boolean): void {
  for (const name of pluginEntries(dest, topLevel)) {
    const target = path.join(dest, name);
    const destStat = lstatSync(target);
    const srcStat = lstatOrNull(path.join(src, name));
    if (srcStat === null || kindOf(srcStat) !== kindOf(destStat)) {
      rmSync(target, { recursive: true, force: true });
    } else if (kindOf(destStat) === "dir") {
      removeStale(path.join(src, name), target, false);
    }
  }
}

/**
 * Makes `dest` hold the same plugin content as `src` and returns the digest
 * of the result. It creates `dest` when missing. When the digests already
 * match, it still writes a missing `.gitignore` first (see
 * `OPENCODE_GITIGNORE`), because a read-only sandbox server cannot write it.
 * When the digests already match otherwise, it writes nothing. Otherwise it
 * removes the entries that `src` no longer has, then copies `src` over
 * `dest` with `cpSync`. It never renames or removes `dest` itself, because a
 * sandbox mount holds that folder. The opencode-owned top-level entries are
 * neither copied nor removed, and an existing `.gitignore` is never
 * overwritten, because a host server writes the same file itself.
 */
export function syncPluginDir(src: string, dest: string): { digest: string; changed: boolean } {
  const want = pluginDigest(src);
  if (want === null) throw new Error(`the plugin folder ${src} does not exist`);
  mkdirSync(dest, { recursive: true });
  if (!existsSync(path.join(dest, ".gitignore"))) writeFileSync(path.join(dest, ".gitignore"), OPENCODE_GITIGNORE);
  if (pluginDigest(dest) === want) return { digest: want, changed: false };
  removeStale(src, dest, true);
  for (const name of pluginEntries(src, true)) {
    cpSync(path.join(src, name), path.join(dest, name), { recursive: true, force: true, verbatimSymlinks: true });
  }
  const got = pluginDigest(dest);
  if (got !== want) throw new Error(`the sync of ${src} into ${dest} left different content`);
  return { digest: want, changed: true };
}
