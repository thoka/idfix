import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { downAll, pidFilePorts } from "../src/down-all";
import { listsRunning, sandboxStatePath, writeSandboxState, type Runner } from "../src/sandbox";
import { servePidPath, stateDir } from "../src/state";

const SBX_LS = [
  "SANDBOX          AGENT      STATUS    PORTS                       WORKSPACE",
  "oc-sub-alpha     opencode   running   127.0.0.1:18768->4096/tcp4  /w/alpha",
  "oc-sub-beta      opencode   stopped                               /w/beta",
].join("\n");

function makeEnv(): Record<string, string> {
  const env = { XDG_STATE_HOME: mkdtempSync(path.join(tmpdir(), "oc-sub-down-all-")) };
  mkdirSync(stateDir(env), { recursive: true });
  return env;
}

async function addSandbox(env: Record<string, string>, project: string, port: number): Promise<void> {
  await writeSandboxState(sandboxStatePath(env, project), { name: `oc-sub-${project}`, root: `/w/${project}`, port });
}

function fakeRunner(stopExitCode = 0): { calls: string[][]; runner: Runner } {
  const calls: string[][] = [];
  const runner: Runner = (cmd) => {
    calls.push([...cmd]);
    if (cmd[1] === "ls") return { stdout: SBX_LS, exitCode: 0 };
    return { stdout: "", exitCode: cmd[1] === "stop" ? stopExitCode : 0 };
  };
  return { calls, runner };
}

/** Run the body with console output silenced. */
async function quiet<T>(body: () => Promise<T>): Promise<T> {
  const { log, error } = console;
  console.log = () => {};
  console.error = () => {};
  try {
    return await body();
  } finally {
    console.log = log;
    console.error = error;
  }
}

describe("listsRunning", () => {
  test("matches the name and the status running only", () => {
    expect(listsRunning(SBX_LS, "oc-sub-alpha")).toBe(true);
    expect(listsRunning(SBX_LS, "oc-sub-beta")).toBe(false);
    expect(listsRunning(SBX_LS, "oc-sub-gamma")).toBe(false);
    expect(listsRunning("", "oc-sub-alpha")).toBe(false);
  });
});

describe("pidFilePorts", () => {
  test("lists the ports of the serve PID files, sorted", () => {
    const env = makeEnv();
    for (const name of ["serve-8790.pid", "serve-8767.pid", "serve-8767.log", "proxy-8768.pid"]) {
      writeFileSync(path.join(stateDir(env), name), "1\n");
    }
    expect(pidFilePorts(env)).toEqual([8767, 8790]);
  });

  test("gives no ports without a state folder", () => {
    expect(pidFilePorts({ XDG_STATE_HOME: path.join(tmpdir(), "oc-sub-missing-state") })).toEqual([]);
  });
});

describe("downAll", () => {
  test("stops only the running sandboxes and leaves the PID file of a stopped one", async () => {
    const env = makeEnv();
    await addSandbox(env, "alpha", 18768);
    await addSandbox(env, "beta", 18769);
    // A stale holder PID file of the stopped sandbox is not a host server.
    writeFileSync(servePidPath(env, 18769), "999999\n");
    const { calls, runner } = fakeRunner();
    const result = await quiet(() => downAll({ force: false }, env, { runner, probe: async () => ({ state: "down" }) }));
    expect(result).toBe(0);
    expect(calls).toEqual([["sbx", "ls"], ["sbx", "stop", "oc-sub-alpha"]]);
    expect(existsSync(servePidPath(env, 18769))).toBe(true);
  });

  test("stops the host servers with a PID file", async () => {
    const env = makeEnv();
    // Port 1 has no server, and the PID belongs to no opencode serve, so
    // down only removes the stale state files.
    writeFileSync(servePidPath(env, 1), "999999\n");
    const commandLines: number[] = [];
    const result = await quiet(() =>
      downAll({ force: false }, env, {}, {
        commandLineOf: (pid) => {
          commandLines.push(pid);
          return null;
        },
      }),
    );
    expect(result).toBe(0);
    expect(commandLines).toEqual([999999]);
    expect(existsSync(servePidPath(env, 1))).toBe(false);
  });

  test("a failed stop gives code 1, and the other sandboxes still stop", async () => {
    const env = makeEnv();
    await addSandbox(env, "alpha", 18768);
    const { calls, runner } = fakeRunner(1);
    const result = await quiet(() => downAll({ force: true }, env, { runner }));
    expect(result).toBe(1);
    expect(calls).toEqual([["sbx", "ls"], ["sbx", "stop", "oc-sub-alpha"]]);
  });

  test("calls no sbx without sandbox state files", async () => {
    const env = makeEnv();
    const { calls, runner } = fakeRunner();
    const result = await quiet(() => downAll({ force: false }, env, { runner }));
    expect(result).toBe(0);
    expect(calls).toEqual([]);
  });
});
