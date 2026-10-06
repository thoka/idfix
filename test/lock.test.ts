/** Tests for the server lock of `run` and the idle watchdog. */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { lockServer, NO_WAIT, RUN_LOCK_WAIT, tryLockServer, type AcquireLock } from "../src/lock";
import { serveLockPath, stateDir } from "../src/state";

function tempEnv(): Record<string, string> {
  return { XDG_STATE_HOME: mkdtempSync(path.join(tmpdir(), "oc-sub-lock-")) };
}

describe("serveLockPath", () => {
  test("is serve-<port>.lock in the state folder", () => {
    const env = tempEnv();
    expect(serveLockPath(env, 18770)).toBe(path.join(stateDir(env), "serve-18770.lock"));
  });
});

describe("the server lock", () => {
  test("a second real lock attempt fails while the first holds it, and works after the release", async () => {
    const env = tempEnv();
    const first = await lockServer(env, 18770, NO_WAIT);
    expect(existsSync(serveLockPath(env, 18770))).toBe(true);
    expect(await tryLockServer(env, 18770)).toBeNull();
    // Another port has its own lock.
    const other = await tryLockServer(env, 18771);
    expect(other).not.toBeNull();
    await other?.();
    await first();
    expect(existsSync(serveLockPath(env, 18770))).toBe(false);
    const second = await tryLockServer(env, 18770);
    expect(second).not.toBeNull();
    await second?.();
  });

  test("a release twice does nothing the second time", async () => {
    const env = tempEnv();
    const release = await lockServer(env, 18772, NO_WAIT);
    await release();
    const again = await lockServer(env, 18772, NO_WAIT);
    // The first release must not remove the lock of the second holder.
    await release();
    expect(await tryLockServer(env, 18772)).toBeNull();
    await again();
  });

  test("lockServer creates the state folder and passes the wait of the caller", async () => {
    const env = tempEnv();
    const seen: Array<{ lockPath: string; retries: number }> = [];
    const fake: AcquireLock = async (lockPath, options) => {
      seen.push({ lockPath, retries: options.retries });
      return async () => undefined;
    };
    await lockServer(env, 18773, RUN_LOCK_WAIT, fake);
    expect(existsSync(stateDir(env))).toBe(true);
    expect(seen).toEqual([{ lockPath: serveLockPath(env, 18773), retries: RUN_LOCK_WAIT.retries }]);
  });

  test("tryLockServer gives null when the acquire fails, and never waits", async () => {
    const env = tempEnv();
    const waits: number[] = [];
    const held: AcquireLock = async (_lockPath, options) => {
      waits.push(options.retries);
      throw new Error("Lock file is already being held");
    };
    expect(await tryLockServer(env, 18774, held)).toBeNull();
    expect(waits).toEqual([0]);
  });
});
