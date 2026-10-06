/**
 * Tests for the start of a down sandbox server in `oc-sub run` and for the
 * server lock that `run` holds. No test starts a sandbox or calls `sbx`: the
 * start, the health check, and the lock are fakes.
 */
import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ServerState } from "../src/client";
import type { AcquireLock } from "../src/lock";
import { run, sandboxTarget, startSandboxIfDown, type RunDeps } from "../src/run";
import { serveLockPath, stateDir } from "../src/state";

const PROJECT = "proj-a";
const DIR = "/h/proj-a";

function capture(): { logs: string[]; errors: string[]; restore: () => void } {
  const logs: string[] = [];
  const errors: string[] = [];
  const log = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
  const err = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  });
  return { logs, errors, restore: () => { log.mockRestore(); err.mockRestore(); } };
}

/** A state folder, with a sandbox state of PROJECT on `port` when given. */
function makeEnv(port?: number): Record<string, string> {
  const base = mkdtempSync(path.join(tmpdir(), "oc-sub-run-start-"));
  const env = { XDG_STATE_HOME: path.join(base, "state"), XDG_CONFIG_HOME: path.join(base, "config") };
  mkdirSync(stateDir(env), { recursive: true });
  if (port !== undefined) {
    writeFileSync(
      path.join(stateDir(env), `sandbox-${PROJECT}.json`),
      JSON.stringify({ name: `oc-sub-${PROJECT}`, root: DIR, port }),
    );
  }
  return env;
}

/** The record of one test: what the fakes saw, in order. */
type Trace = string[];

function fakeDeps(trace: Trace, opts: { health?: ServerState["state"]; startCode?: number; lockFails?: boolean } = {}): RunDeps {
  const acquireLock: AcquireLock = async (lockPath) => {
    trace.push(`lock ${path.basename(lockPath)}`);
    if (opts.lockFails === true) throw new Error("Lock file is already being held");
    return async () => {
      trace.push("release");
    };
  };
  return {
    fetch: async () => Response.json({ data: {} }),
    projectName: () => PROJECT,
    worktreesOf: (d) => [d],
    exists: () => true,
    cwd: mkdtempSync(path.join(tmpdir(), "oc-sub-run-start-cwd-")),
    existsInSandbox: () => {
      trace.push("sbx exec test -d");
      return true;
    },
    probe: async (url) => {
      trace.push(`probe ${new URL(url).port}`);
      const state = opts.health ?? "up";
      return state === "up" ? { state, version: "1" } : ({ state } as ServerState);
    },
    startSandbox: async (directory) => {
      trace.push(`start ${directory}`);
      return opts.startCode ?? 0;
    },
    acquireLock,
  };
}

/** A fake opencode server that records the requests that change state. */
function fakeServer(trace: Trace, opts: { failCreate?: boolean } = {}) {
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/global/health") return Response.json({ healthy: true, version: "1.0.0" });
      if (url.pathname === "/session" && request.method === "POST") {
        trace.push("create session");
        return opts.failCreate === true ? new Response("boom", { status: 500 }) : Response.json({ id: "ses_started" });
      }
      if (url.pathname.endsWith("/prompt_async")) {
        trace.push("send prompt");
        return new Response(null, { status: 200 });
      }
      return new Response("not found", { status: 404 });
    },
  });
}

describe("sandboxTarget", () => {
  test("is the sandbox state without --url and OC_SUB_URL, else null", () => {
    const env = makeEnv(18770);
    const name = () => PROJECT;
    expect(sandboxTarget({ dir: DIR }, env, name)?.port).toBe(18770);
    expect(sandboxTarget({ dir: DIR, url: "http://127.0.0.1:1" }, env, name)).toBeNull();
    expect(sandboxTarget({ dir: DIR }, { ...env, OC_SUB_URL: "http://127.0.0.1:1" }, name)).toBeNull();
    expect(sandboxTarget({ dir: DIR }, makeEnv(), name)).toBeNull();
  });
});

describe("startSandboxIfDown", () => {
  const URL = "http://127.0.0.1:18770";

  test("starts the sandbox server when it is down, and names it in one line", async () => {
    const trace: Trace = [];
    const captured = capture();
    try {
      expect(await startSandboxIfDown({ dir: DIR }, makeEnv(18770), fakeDeps(trace, { health: "down" }), URL)).toBe(0);
    } finally {
      captured.restore();
    }
    expect(trace).toEqual(["probe 18770", `start ${DIR}`]);
    expect(captured.errors).toEqual([`started the sandbox server of ${PROJECT} (it was down)`]);
    expect(captured.logs).toEqual([]);
  });

  test("does not start a server that answers, also not an unauthorized one", async () => {
    for (const health of ["up", "unauthorized"] as const) {
      const trace: Trace = [];
      expect(await startSandboxIfDown({ dir: DIR }, makeEnv(18770), fakeDeps(trace, { health }), URL)).toBe(0);
      expect(trace).toEqual(["probe 18770"]);
    }
  });

  test("never probes or starts with --url, with OC_SUB_URL, or without a sandbox state", async () => {
    const trace: Trace = [];
    const deps = fakeDeps(trace, { health: "down" });
    expect(await startSandboxIfDown({ dir: DIR, url: URL }, makeEnv(18770), deps, URL)).toBe(0);
    expect(await startSandboxIfDown({ dir: DIR }, { ...makeEnv(18770), OC_SUB_URL: URL }, deps, URL)).toBe(0);
    expect(await startSandboxIfDown({ dir: DIR }, makeEnv(), deps, URL)).toBe(0);
    expect(trace).toEqual([]);
  });

  test("gives the exit code of a failed start, without the start line", async () => {
    const trace: Trace = [];
    const captured = capture();
    try {
      expect(
        await startSandboxIfDown({ dir: DIR }, makeEnv(18770), fakeDeps(trace, { health: "down", startCode: 1 }), URL),
      ).toBe(1);
    } finally {
      captured.restore();
    }
    expect(captured.errors).toEqual([]);
  });
});

describe("oc-sub run with a down sandbox server", () => {
  test("takes the lock, starts the server before the folder check, and releases the lock after the prompt", async () => {
    const trace: Trace = [];
    const server = fakeServer(trace);
    const port = server.port;
    const env = makeEnv(port);
    const captured = capture();
    try {
      expect(await run({ agent: "coder", dir: DIR, text: "hi" }, env, fakeDeps(trace, { health: "down" }))).toBe(0);
    } finally {
      captured.restore();
      server.stop(true);
    }
    expect(trace).toEqual([
      `lock serve-${port}.lock`,
      `probe ${port}`,
      `start ${DIR}`,
      "sbx exec test -d",
      "create session",
      "send prompt",
      "release",
    ]);
    // The session ID stays the first line on stdout.
    expect(captured.logs[0]).toBe("ses_started");
    expect(captured.errors).toContain(`started the sandbox server of ${PROJECT} (it was down)`);
  });

  test("a failed start ends the run with its exit code, creates no session, and releases the lock", async () => {
    const trace: Trace = [];
    const server = fakeServer(trace);
    const port = server.port;
    const env = makeEnv(port);
    const captured = capture();
    try {
      expect(await run({ agent: "coder", dir: DIR, text: "hi" }, env, fakeDeps(trace, { health: "down", startCode: 1 }))).toBe(1);
    } finally {
      captured.restore();
      server.stop(true);
    }
    expect(trace).toEqual([`lock serve-${port}.lock`, `probe ${port}`, `start ${DIR}`, "release"]);
  });

  test("a run with --url takes the lock of its port, and never probes or starts a sandbox", async () => {
    const trace: Trace = [];
    const server = fakeServer(trace);
    const port = server.port;
    const env = makeEnv(18770);
    const captured = capture();
    try {
      const url = `http://127.0.0.1:${server.port}`;
      expect(await run({ agent: "coder", dir: DIR, text: "hi", url }, env, fakeDeps(trace, { health: "down" }))).toBe(0);
    } finally {
      captured.restore();
      server.stop(true);
    }
    expect(trace).toEqual([`lock serve-${port}.lock`, "create session", "send prompt", "release"]);
  });

  test("releases the lock when the run fails with an error", async () => {
    const trace: Trace = [];
    const server = fakeServer(trace, { failCreate: true });
    const captured = capture();
    try {
      const url = `http://127.0.0.1:${server.port}`;
      await expect(run({ agent: "coder", dir: DIR, text: "hi", url }, makeEnv(), fakeDeps(trace))).rejects.toThrow();
    } finally {
      captured.restore();
      server.stop(true);
    }
    expect(trace.at(-1)).toBe("release");
    expect(trace).not.toContain("send prompt");
  });

  test("a held lock fails the run with an error that names the lock file, before any health check", async () => {
    const trace: Trace = [];
    const env = makeEnv(18770);
    await expect(
      run({ agent: "coder", dir: DIR, text: "hi" }, env, fakeDeps(trace, { health: "down", lockFails: true })),
    ).rejects.toThrow(serveLockPath(env, 18770));
    expect(trace).toEqual(["lock serve-18770.lock"]);
  });
});
