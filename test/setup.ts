/**
 * Test preload (bunfig.toml): point the XDG data and state folders of this
 * process at fresh temporary folders. A code path that falls back to
 * `process.env` then never writes into the real `~/.local/share/oc-sub` or
 * `~/.local/state/oc-sub`. Tests that pass their own env still set their own
 * folders.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.XDG_DATA_HOME = mkdtempSync(path.join(tmpdir(), "oc-sub-test-data-"));
process.env.XDG_STATE_HOME = mkdtempSync(path.join(tmpdir(), "oc-sub-test-state-"));
