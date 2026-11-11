/**
 * Tests for the declaration IDFX_NO_SANDBOX: the doctor skips by name, and
 * each code path that creates or starts a sandbox refuses before its first
 * `sbx` call. No test calls the real `sbx`.
 */
import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { claudeRun } from "../src/claude/run";
import { claudeSay } from "../src/claude/session";
import { worktree, worktreeRm } from "../src/clone";
import { kvmAccessRootFix, sandboxMountsFix, SLOW_CHECKS, type DoctorDeps } from "../src/doctor";
import { noSandboxReason, noSandboxRefusal, noSandboxSkipText } from "../src/env-names";
import { run } from "../src/run";
import { kvmAccessCheck, upSandbox, type KvmDeps } from "../src/sandbox";
import { stateDir } from "../src/state";

const REASON = "no KVM on this machine";
const DECLARED = { IDFX_NO_SANDBOX: REASON };

/** A host with a usable KVM device or with none, plus the declaration of the env. */
function kvm(env: Record<string, string>, device: boolean): KvmDeps {
  return {
    platform: "linux",
    statDevice: () => (device ? { mode: 0o20666, uid: 0, gid: 990 } : null),
    canReadWrite: () => device,
    noSandbox: noSandboxReason(env),
  };
}

/** Runs the body with console.error captured. */
async function quietly<T>(body: () => Promise<T>): Promise<{ value: T; text: string }> {
  const lines: string[] = [];
  const spy = spyOn(console, "error").mockImplementation((...parts: unknown[]) => {
    lines.push(parts.map(String).join(" "));
  });
  try {
    return { value: await body(), text: lines.join("\n") };
  } finally {
    spy.mockRestore();
  }
}

/** Dependencies that fail the test on the first touch: nothing may run before the refusal. */
function untouchable(touched: string[]): never {
  return new Proxy({}, {
    get: (_target, key) => (..._args: unknown[]) => {
      touched.push(String(key));
      throw new Error(`touched ${String(key)}`);
    },
  }) as never;
}

describe("the declaration", () => {
  test("a reason text declares, an absent name or an empty or blank value does not", () => {
    expect(noSandboxReason(DECLARED)).toBe(REASON);
    expect(noSandboxReason({})).toBeUndefined();
    expect(noSandboxReason({ IDFX_NO_SANDBOX: "" })).toBeUndefined();
    expect(noSandboxReason({ IDFX_NO_SANDBOX: "  " })).toBeUndefined();
    expect(noSandboxRefusal({})).toBeNull();
    expect(noSandboxRefusal(DECLARED)).toContain("IDFX_NO_SANDBOX");
  });
});

describe("kvm-access with the declaration", () => {
  test("declared and no device: skip with the named text and the reason", () => {
    const check = kvmAccessCheck(kvm(DECLARED, false));
    expect(check.status).toBe("skip");
    expect(check.message).toContain("skipped: host declares no sandbox");
    expect(check.message).toContain(REASON);
    expect(check.message).toBe(noSandboxSkipText(REASON));
  });

  test("declared and a device: still a skip, never a pass", () => {
    expect(kvmAccessCheck(kvm(DECLARED, true)).status).toBe("skip");
  });

  test("not declared and no device: fail", () => {
    expect(kvmAccessCheck(kvm({}, false)).status).toBe("fail");
  });

  test("not declared and a device: pass", () => {
    expect(kvmAccessCheck(kvm({}, true)).status).toBe("pass");
  });

  test("an absent name stays a fail on a host with no device", () => {
    expect(kvmAccessCheck(kvm({ OTHER: "x" }, false)).status).toBe("fail");
  });

  test("an empty value stays a fail on a host with no device", () => {
    expect(kvmAccessCheck(kvm({ IDFX_NO_SANDBOX: "" }, false)).status).toBe("fail");
  });
});

describe("the other checks and the fixes on a declaring host", () => {
  const deps = {
    kvm: kvm(DECLARED, false),
    rootRunner: () => {
      throw new Error("sudo ran");
    },
    runner: () => {
      throw new Error("sbx ran");
    },
    sandboxState: () => ({ name: "x", root: "/r", port: 1 }),
    projectName: "proj",
  } as unknown as DoctorDeps;

  test("sandbox-mounts gives the same named skip", () => {
    const check = SLOW_CHECKS.find((c) => c.name === "sandbox-mounts")!;
    const result = check.run(deps);
    expect(result.status).toBe("skip");
    expect(result.message).toBe(noSandboxSkipText(REASON));
  });

  test("the fix actions do nothing", async () => {
    expect(kvmAccessRootFix(deps, { name: "kvm-access", status: "skip", message: "" }, { force: true }).ok).toBe(true);
    const fixed = await sandboxMountsFix(deps, { name: "sandbox-mounts", status: "skip", message: "" }, { force: true });
    expect(fixed.ok).toBe(true);
  });
});

describe("each sandbox start refuses on a declaring host", () => {
  test("upSandbox (sbx create and the start of the opencode server)", async () => {
    const calls: string[][] = [];
    const runner = (cmd: readonly string[]) => {
      calls.push([...cmd]);
      return { exitCode: 0, stdout: "" };
    };
    const { value, text } = await quietly(() => upSandbox({}, DECLARED, { runner }));
    expect(value).toBe(1);
    expect(text).toContain("IDFX_NO_SANDBOX");
    expect(calls).toEqual([]);
  });

  test("claudeRun (ensureClaudeSandbox: sbx create, and the sbx exec of the run)", async () => {
    const touched: string[] = [];
    const { value, text } = await quietly(() => claudeRun({ dir: "/w", text: "x" }, DECLARED, untouchable(touched)));
    expect(value).toBe(1);
    expect(text).toContain("IDFX_NO_SANDBOX");
    expect(touched).toEqual([]);
  });

  test("claudeSay (the sbx exec of a follow-up turn)", async () => {
    const touched: string[] = [];
    const { value, text } = await quietly(() => claudeSay({ session: "s", text: "x" }, DECLARED, untouchable(touched)));
    expect(value).toBe(1);
    expect(text).toContain("IDFX_NO_SANDBOX");
    expect(touched).toEqual([]);
  });

  test("worktree and worktreeRm (the sbx exec in the clone)", async () => {
    const touched: string[] = [];
    const deps = untouchable(touched);
    const created = await quietly(() => worktree({ step: "a" }, DECLARED, deps));
    const removed = await quietly(() => worktreeRm({ step: "a" }, DECLARED, deps));
    expect(created.value).toBe(1);
    expect(removed.value).toBe(1);
    expect(created.text).toContain("IDFX_NO_SANDBOX");
    expect(touched).toEqual([]);
  });

  test("run with a sandbox state (the start of a down server)", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "idfx-no-sandbox-"));
    const env = { ...DECLARED, XDG_STATE_HOME: path.join(base, "state"), XDG_CONFIG_HOME: path.join(base, "config") };
    mkdirSync(stateDir(env), { recursive: true });
    writeFileSync(path.join(stateDir(env), "sandbox-proj.json"), JSON.stringify({ name: "idfx-proj", root: "/h/proj", port: 1 }));
    const touched: string[] = [];
    const deps = untouchable(touched) as never as Parameters<typeof run>[2];
    const patched = { ...(deps as object), projectName: () => "proj" } as never;
    const { value, text } = await quietly(() => run({ agent: "coder", dir: "/h/proj", text: "hi" }, env, patched));
    expect(value).toBe(1);
    expect(text).toContain("IDFX_NO_SANDBOX");
    expect(touched).toEqual([]);
  });
});
