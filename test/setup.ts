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
 */
import { afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const RUN_PREFIX = "oc-sub-test-run-";
const STALE_MS = 6 * 60 * 60 * 1000;

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
mkdirSync(process.env.XDG_DATA_HOME);
mkdirSync(process.env.XDG_STATE_HOME);
