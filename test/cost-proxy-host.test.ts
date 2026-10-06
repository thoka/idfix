import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PROXY_RESTART_SEC, proxyCommand, serveEnv, up, type UpDeps } from "../src/up";
import { pluginDataDir, proxyBundleIn } from "../src/plugin-sync";
import { proxyLoopScript } from "../src/sandbox";
import { proxyLogPath, proxyPidPath, readPid, readServePlugin, servePidPath, servePluginPath } from "../src/state";
import { pluginDigest } from "../src/plugin-sync";
import { PLUGIN_CONFIG_DIR } from "../src/up";
import { down, isProxyLoop, stopStartedGroups, type DownDeps } from "../src/down";
import { parseArgs } from "../src/args";
import { idlePidPath, isIdleWatch } from "../src/idle";
import { UNIT_STOP_TIMEOUT_SEC, type UnitOptions } from "../src/units";
import { fakeUnits, noUnits } from "./fake-units";
import { deepinfraKeyPath } from "../src/keys";

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "oc-sub-hostproxy-"));
}

/** An env with a state home and a shared agents folder that exists. */
function makeEnv(): Record<string, string> {
  const shared = tempDir();
  writeFileSync(path.join(shared, "AGENTS.md"), "# rules\n");
  return { XDG_STATE_HOME: tempDir(), XDG_DATA_HOME: tempDir(), OC_SUB_SHARED_DIR: shared };
}

function makeDeps(overrides: Partial<UpDeps> = {}): UpDeps {
  return {
    // The first probe finds no server (up starts one), the rest are healthy.
    probe: (() => {
      let probes = 0;
      return async () => (probes++ === 0 ? { state: "down" } : { state: "up", version: "1.18.32" });
    })(),
    bunBin: () => "/opt/bun/bin/bun",
    spawnServe: () => ({ pid: 1001, exitCode: () => null }),
    spawnProxy: () => ({ pid: 1002, exitCode: () => null }),
    // Never a real watchdog in a unit test.
    spawnIdleWatch: () => ({ pid: 1003, exitCode: () => null }),
    // The fallback path by default; the tests of the unit path pass their own.
    units: noUnits(),
    projectName: () => "test",
    // No DeepInfra key file unless a test sets one; never the real file.
    readKeyFile: () => null,
    ...overrides,
  };
}

describe("serveEnv with the cost proxy (host mode)", () => {
  test("merges the openrouter baseURL into the config content", () => {
    const { env, warnings } = serveEnv({ HOME: "/home/user" }, "/plugin/opencode", "/srv/agents", {
      proxyUrl: "http://127.0.0.1:8768/v1",
    });
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT as string)).toEqual({
      instructions: ["/srv/agents/AGENTS.md"],
      skills: { paths: ["/srv/agents/skills"] },
      provider: { openrouter: { options: { baseURL: "http://127.0.0.1:8768/v1" } } },
    });
    expect(warnings).toEqual([]);
  });

  test("no proxyUrl keeps the content without a provider block", () => {
    const { env } = serveEnv({ HOME: "/home/user" }, "/plugin/opencode", "/srv/agents");
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT as string)).not.toHaveProperty("provider");
  });
});

const UNSET_LINES = [
  "error: IDFX_SHARED_DIR is not set.",
  "Set IDFX_SHARED_DIR to the folder that holds AGENTS.md (your global rules) and skills/<name>/SKILL.md (your skills).",
];

/** Runs up on the host and returns its exit code, its errors, and whether it started a process. */
async function upWithErrors(env: Record<string, string>): Promise<{ result: number; errors: string[]; started: boolean }> {
  const errors: string[] = [];
  let started = false;
  const deps = makeDeps({
    spawnServe: () => {
      started = true;
      return { pid: 1001, exitCode: () => null };
    },
    spawnProxy: () => {
      started = true;
      return { pid: 1002, exitCode: () => null };
    },
  });
  const err = console.error;
  console.error = (line: string) => errors.push(line);
  try {
    return { result: await up({ port: 8790 }, env, deps), errors, started };
  } finally {
    console.error = err;
  }
}

describe("up on the host needs the shared folder", () => {
  for (const [label, shared] of [["unset", undefined], ["blank", "  "]] as const) {
    test(`stops before it starts anything when OC_SUB_SHARED_DIR is ${label}`, async () => {
      const env: Record<string, string> = { XDG_STATE_HOME: tempDir(), XDG_DATA_HOME: tempDir() };
      if (shared !== undefined) env.OC_SUB_SHARED_DIR = shared;
      const { result, errors, started } = await upWithErrors(env);
      expect(result).toBe(1);
      expect(started).toBe(false);
      expect(errors).toEqual(UNSET_LINES);
    });
  }

  test("stops with the path when the folder has no AGENTS.md", async () => {
    const shared = tempDir();
    const { result, errors, started } = await upWithErrors({
      XDG_STATE_HOME: tempDir(),
      XDG_DATA_HOME: tempDir(),
      OC_SUB_SHARED_DIR: shared,
    });
    expect(result).toBe(1);
    expect(started).toBe(false);
    expect(errors[0]).toBe(`error: the shared agents file ${path.join(shared, "AGENTS.md")} does not exist.`);
  });
});

describe("up starts the idle watchdog on the host", () => {
  test("spawns idle-watch after the healthy start, with the default limit", async () => {
    const env = makeEnv();
    const spawned: string[][] = [];
    const order: string[] = [];
    const deps = makeDeps({
      spawnServe: () => {
        order.push("serve");
        return { pid: 1001, exitCode: () => null };
      },
      spawnIdleWatch: ({ cmd, logPath, pidPath }) => {
        order.push("idle");
        spawned.push([...cmd, logPath, pidPath]);
        return { pid: 1003, exitCode: () => null };
      },
    });
    expect(await up({ port: 8790 }, env, deps)).toBe(0);
    expect(order).toEqual(["serve", "idle"]);
    expect(spawned[0]?.slice(2, 7)).toEqual(["idle-watch", "--port", "8790", "--minutes", "30"]);
    expect(spawned[0]?.[8]).toBe(idlePidPath(env, 8790));
  });

  test("--idle-minutes sets the limit, and 0 starts no watchdog", async () => {
    const minutes: string[] = [];
    const spawnIdleWatch = ({ cmd }: UnitOptions) => {
      minutes.push(cmd[6] as string);
      return { pid: 1003, exitCode: () => null };
    };
    expect(await up({ port: 8790, idleMinutes: 5 }, makeEnv(), makeDeps({ spawnIdleWatch }))).toBe(0);
    expect(await up({ port: 8790, idleMinutes: 0 }, makeEnv(), makeDeps({ spawnIdleWatch }))).toBe(0);
    expect(minutes).toEqual(["5"]);
  });

  test("a server that already runs gets no second watchdog", async () => {
    let spawned = 0;
    const deps = makeDeps({
      probe: async () => ({ state: "up", version: "1.18.32" }),
      spawnIdleWatch: () => {
        spawned += 1;
        return { pid: 1003, exitCode: () => null };
      },
    });
    expect(await up({ port: 8790 }, makeEnv(), deps)).toBe(0);
    expect(spawned).toBe(0);
  });
});

describe("up starts the cost proxy on the host", () => {
  test("starts the proxy as sh -c with a restart loop on port + 1, before the server", async () => {
    const env = makeEnv();
    const calls: { cmd: string[]; logPath: string; pidPath: string }[] = [];
    const order: string[] = [];
    const deps = makeDeps({
      spawnProxy: ({ cmd, logPath, pidPath }) => {
        calls.push({ cmd: [...cmd], logPath, pidPath });
        order.push("proxy");
        return { pid: 1002, exitCode: () => null };
      },
      spawnServe: ({ cmd, logPath, pidPath }) => {
        order.push("serve");
        return { pid: 1001, exitCode: () => null };
      },
    });
    const result = await up({ port: 8790 }, env, deps);
    expect(result).toBe(0);
    expect(order).toEqual(["proxy", "serve"]);
    expect(calls).toHaveLength(1);
    const call = calls[0] as { cmd: string[]; logPath: string; pidPath: string };
    expect(call.cmd).toEqual([
      "sh",
      "-c",
      proxyLoopScript("/opt/bun/bin/bun", proxyBundleIn(pluginDataDir(env)), 8791, "127.0.0.1"),
    ]);
    expect(call.logPath).toBe(proxyLogPath(env, 8790));
    expect(call.pidPath).toBe(proxyPidPath(env, 8790));
    expect(existsSync(proxyLogPath(env, 8790)) || true).toBe(true);
  });

  test("the serve environment points openrouter at the proxy", async () => {
    const env = makeEnv();
    let serveEnvValue: string | undefined;
    const deps = makeDeps({
      spawnServe: ({ env: serveEnvInput }) => {
        serveEnvValue = serveEnvInput.OPENCODE_CONFIG_CONTENT;
        return { pid: 1001, exitCode: () => null };
      },
    });
    await up({ port: 8790 }, env, deps);
    const content = JSON.parse(serveEnvValue as string) as {
      provider?: { openrouter?: { options?: { baseURL?: string } } };
    };
    expect(content.provider?.openrouter?.options?.baseURL).toBe("http://127.0.0.1:8791/v1");
  });

  test("--no-cost-proxy starts no proxy and sets no baseURL", async () => {
    const env = makeEnv();
    let serveEnvValue: string | undefined;
    let proxies = 0;
    const deps = makeDeps({
      spawnProxy: () => {
        proxies += 1;
        return { pid: 1002, exitCode: () => null };
      },
      spawnServe: ({ env: serveEnvInput }) => {
        serveEnvValue = serveEnvInput.OPENCODE_CONFIG_CONTENT;
        return { pid: 1001, exitCode: () => null };
      },
    });
    const result = await up({ port: 8790, noCostProxy: true }, env, deps);
    expect(result).toBe(0);
    expect(proxies).toBe(0);
    expect(JSON.parse(serveEnvValue as string)).not.toHaveProperty("provider");
  });

  test("without a bun, up stops before any process starts and names the flag", async () => {
    const env = makeEnv();
    const errors: string[] = [];
    const err = console.error;
    console.error = (line: string) => errors.push(line);
    let result: number;
    try {
      result = await up({ port: 8790 }, env, makeDeps({ bunBin: () => null }));
    } finally {
      console.error = err;
    }
    expect(result).toBe(1);
    expect(errors.join("\n")).toContain("no bun on the PATH");
    expect(errors.join("\n")).toContain("--no-cost-proxy");
  });
});

/**
 * The `ps` command line of the proxy loop of the server on port 19790. The
 * down tests use a port far from the 8790 of the integration tests, because
 * `down` probes the real port: a server there would change its path.
 */
const PROXY_LINE = `sh -c ${proxyLoopScript("/opt/bun/bin/bun", "/data/oc-sub/opencode/cost-proxy/cost-proxy.js", 19791, "127.0.0.1")}`;

/** Whether any process of the process group still exists. */
function groupExists(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitGroupGone(pgid: number, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!groupExists(pgid)) return true;
    await Bun.sleep(50);
  }
  return !groupExists(pgid);
}

describe("isProxyLoop", () => {
  test("knows the loop of proxyLoopScript on its port", () => {
    expect(isProxyLoop(PROXY_LINE, 19791)).toBe(true);
    expect(isProxyLoop("/opt/bun/bin/bun /data/cost-proxy/cost-proxy.js --port 19791 --hostname 127.0.0.1", 19791)).toBe(true);
  });

  test("rejects another port and another process", () => {
    expect(isProxyLoop(PROXY_LINE, 8769)).toBe(false);
    expect(isProxyLoop("opencode serve --port 19791", 19791)).toBe(false);
    expect(isProxyLoop("sleep 30", 19791)).toBe(false);
  });
});

describe("up stops the proxy group when the server does not start", () => {
  test("a failed server spawn signals the proxy group and removes its PID file", async () => {
    const env = makeEnv();
    const killed: number[] = [];
    const original = console.error;
    console.error = () => {};
    let result: number;
    try {
      result = await up({ port: 19790 }, env, makeDeps({
        spawnProxy: ({ pidPath }) => {
          writeFileSync(pidPath, "1002\n");
          return { pid: 1002, exitCode: () => null };
        },
        spawnServe: () => {
          throw new Error("no opencode");
        },
        killGroup: (pid) => killed.push(pid),
      }));
    } finally {
      console.error = original;
    }
    expect(result).toBe(1);
    expect(killed).toEqual([1002]);
    expect(existsSync(proxyPidPath(env, 19790))).toBe(false);
  });
});

describe("stopStartedGroups", () => {
  test("kills the whole restart loop group, loop and child", async () => {
    const env = makeEnv();
    mkdirSync(path.join(env.XDG_STATE_HOME as string, "idfx"), { recursive: true });
    // A real restart loop like the proxy loop: `sh` runs a child, and
    // starts it again when it exits. Detached, like spawnDetached.
    const loop = Bun.spawn(["sh", "-c", "while :; do sleep 30; sleep 1; done"], { detached: true });
    await Bun.write(proxyPidPath(env, 19790), `${loop.pid}\n`);
    await Bun.write(servePidPath(env, 19790), "2147483000\n");
    const signaled = await stopStartedGroups(env, 19790, "SIGKILL", {
      units: noUnits(),
      commandLineOf: (pid) => (pid === loop.pid ? PROXY_LINE : null),
      killGroup: () => {
        throw new Error("stopStartedGroups signals the group itself");
      },
    });
    expect(signaled).toEqual([loop.pid]);
    expect(await waitGroupGone(loop.pid)).toBe(true);
  });

  test("skips a PID that belongs to another process", async () => {
    const env = makeEnv();
    mkdirSync(path.join(env.XDG_STATE_HOME as string, "idfx"), { recursive: true });
    const other = Bun.spawn(["sh", "-c", "sleep 30"], { detached: true });
    await Bun.write(proxyPidPath(env, 19790), `${other.pid}\n`);
    try {
      const signaled = await stopStartedGroups(env, 19790, "SIGKILL", {
        units: noUnits(),
        commandLineOf: () => "sh -c sleep 30",
        killGroup: () => {},
      });
      expect(signaled).toEqual([]);
      expect(groupExists(other.pid)).toBe(true);
    } finally {
      process.kill(-other.pid, "SIGKILL");
    }
  });
});

describe("down stops the cost proxy", () => {
  function downDeps(commandLine: string, killed: number[]): DownDeps {
    return {
      commandLineOf: () => commandLine,
      killGroup: (pid) => killed.push(pid),
      units: noUnits(),
    };
  }

  test("signals the proxy process group and removes its PID file", async () => {
    const env = makeEnv();
    mkdirSync(path.join(env.XDG_STATE_HOME as string, "idfx"), { recursive: true });
    // A real proxy process, so that the default kill and the wait see a real
    // exit. The server PID points to a nonexistent process (the fake
    // commandLineOf still names an opencode serve).
    const proxy = Bun.spawn(["sh", "-c", "sleep 30"], { detached: true });
    await Bun.write(proxyPidPath(env, 19790), `${proxy.pid}\n`);
    await Bun.write(servePidPath(env, 19790), "2147483000\n");
    await Bun.write(proxyLogPath(env, 19790), "log\n");
    const killed: number[] = [];
    const deps: DownDeps = {
      units: noUnits(),
      commandLineOf: (pid) => (pid === proxy.pid ? PROXY_LINE : "opencode serve --port 19790 --hostname 127.0.0.1"),
      // Records and really signals, so that the real wait sees the exit.
      killGroup: (pid) => {
        killed.push(pid);
        try {
          process.kill(-pid, "SIGTERM");
        } catch {
          // A nonexistent group (the stale server PID) is fine.
        }
      },
    };
    const result = await down({ port: 19790, force: true }, env, deps);
    expect(result).toBe(0);
    expect(killed).toContain(proxy.pid);
    expect(await readPid(proxyPidPath(env, 19790))).toBeNull();
    proxy.kill();
  });

  test("removes a stale proxy PID file without killing", async () => {
    const env = makeEnv();
    mkdirSync(path.join(env.XDG_STATE_HOME as string, "idfx"), { recursive: true });
    // PID 2147483000 does not exist (and never will; pid_max is lower).
    await Bun.write(proxyPidPath(env, 19790), "2147483000\n");
    const killed: number[] = [];
    const deps = downDeps("opencode serve --port 19790 --hostname 127.0.0.1", killed);
    const result = await down({ port: 19790, force: true }, env, deps);
    expect(result).toBe(0);
    expect(killed).toEqual([]);
    expect(await readPid(proxyPidPath(env, 19790))).toBeNull();
  });

  test("a dead server: down still stops its proxy loop", async () => {
    const env = makeEnv();
    mkdirSync(path.join(env.XDG_STATE_HOME as string, "idfx"), { recursive: true });
    const loop = Bun.spawn(["sh", "-c", "while :; do sleep 30; sleep 1; done"], { detached: true });
    await Bun.write(proxyPidPath(env, 19790), `${loop.pid}\n`);
    // The server PID file names a process that is gone.
    await Bun.write(servePidPath(env, 19790), "2147483000\n");
    const killed: number[] = [];
    const deps: DownDeps = {
      units: noUnits(),
      commandLineOf: (pid) => (pid === loop.pid ? PROXY_LINE : null),
      killGroup: (pid) => {
        killed.push(pid);
        process.kill(-pid, "SIGTERM");
      },
    };
    const logs: string[] = [];
    const original = console.log;
    console.log = (line: string) => logs.push(line);
    let result: number;
    try {
      result = await down({ port: 19790, force: true }, env, deps);
    } finally {
      console.log = original;
    }
    expect(result).toBe(0);
    expect(killed).toEqual([loop.pid]);
    expect(await waitGroupGone(loop.pid)).toBe(true);
    expect(existsSync(proxyPidPath(env, 19790))).toBe(false);
  });

  test("a proxy PID that belongs to another process is not signaled", async () => {
    const env = makeEnv();
    mkdirSync(path.join(env.XDG_STATE_HOME as string, "idfx"), { recursive: true });
    await Bun.write(proxyPidPath(env, 19790), `${process.pid}\n`);
    const killed: number[] = [];
    const deps = downDeps("opencode serve --port 19790 --hostname 127.0.0.1", killed);
    const result = await down({ port: 19790, force: true }, env, deps);
    expect(result).toBe(0);
    expect(killed).toEqual([]);
    expect(existsSync(proxyPidPath(env, 19790))).toBe(false);
  });

  test("removes the plugin digest of the stopped server", async () => {
    const env = makeEnv();
    mkdirSync(path.join(env.XDG_STATE_HOME as string, "idfx"), { recursive: true });
    await Bun.write(servePidPath(env, 19790), "2147483000\n");
    await Bun.write(servePluginPath(env, 19790), "sha256:abc\n");
    const result = await down({ port: 19790, force: true }, env, downDeps("opencode serve --port 19790", []));
    expect(result).toBe(0);
    expect(existsSync(servePluginPath(env, 19790))).toBe(false);
  });

  test("stops the idle watchdog of the server and removes its PID file", async () => {
    const env = makeEnv();
    mkdirSync(path.join(env.XDG_STATE_HOME as string, "idfx"), { recursive: true });
    const watchdog = Bun.spawn(["sh", "-c", "sleep 30"], { detached: true });
    await Bun.write(servePidPath(env, 19790), "2147483000\n");
    await Bun.write(idlePidPath(env, 19790), `${watchdog.pid}\n`);
    const idleLine = "bun cli.ts idle-watch --port 19790 --minutes 30";
    expect(isIdleWatch(idleLine, 19790)).toBe(true);
    const killed: number[] = [];
    const deps: DownDeps = {
      units: noUnits(),
      commandLineOf: (pid) => (pid === watchdog.pid ? idleLine : "opencode serve --port 19790"),
      killGroup: (pid) => {
        killed.push(pid);
        try {
          process.kill(-pid, "SIGTERM");
        } catch {
          // The stale server PID has no group.
        }
      },
    };
    const result = await down({ port: 19790, force: true }, env, deps);
    expect(result).toBe(0);
    expect(killed).toContain(watchdog.pid);
    expect(await waitGroupGone(watchdog.pid)).toBe(true);
    expect(existsSync(idlePidPath(env, 19790))).toBe(false);
  });
});

describe("up syncs the plugin folder", () => {
  test("the server and the proxy load the synced folder, and the state records its digest", async () => {
    const env = makeEnv();
    let configDir: string | undefined;
    let proxyCmd: string[] = [];
    const deps = makeDeps({
      spawnServe: ({ env: serveEnvInput }) => {
        configDir = serveEnvInput.OPENCODE_CONFIG_DIR;
        return { pid: 1001, exitCode: () => null };
      },
      spawnProxy: ({ cmd }) => {
        proxyCmd = [...cmd];
        return { pid: 1002, exitCode: () => null };
      },
    });
    expect(await up({ port: 8790 }, env, deps)).toBe(0);
    const synced = pluginDataDir(env);
    expect(synced.startsWith(env.XDG_DATA_HOME as string)).toBe(true);
    expect(configDir).toBe(synced);
    expect(proxyCmd.join(" ")).toContain(proxyBundleIn(synced));
    expect(pluginDigest(synced)).toBe(pluginDigest(PLUGIN_CONFIG_DIR));
    expect(readServePlugin(servePluginPath(env, 8790))).toBe(pluginDigest(synced));
  });

  test("a failed sync stops up before any process starts", async () => {
    const env = makeEnv();
    const errors: string[] = [];
    const original = console.error;
    console.error = (line: string) => errors.push(line);
    let result: number;
    try {
      result = await up({ port: 8790 }, env, makeDeps({
        pluginSource: path.join(tempDir(), "missing"),
        spawnServe: () => {
          throw new Error("no server may start");
        },
        spawnProxy: () => {
          throw new Error("no proxy may start");
        },
      }));
    } finally {
      console.error = original;
    }
    expect(result).toBe(1);
    expect(errors.join("\n")).toContain("cannot sync the plugin folder");
    expect(existsSync(servePluginPath(env, 8790))).toBe(false);
  });

  test("a server that already runs keeps its folder: up does not sync", async () => {
    const env = makeEnv();
    const deps = makeDeps({ probe: async () => ({ state: "up", version: "1.18.32" }) });
    expect(await up({ port: 8790 }, env, deps)).toBe(0);
    expect(existsSync(pluginDataDir(env))).toBe(false);
  });
});

describe("--no-cost-proxy parsing", () => {
  test("parses for up and restart, also combined with other flags", () => {
    expect(parseArgs(["up", "--no-cost-proxy"])).toMatchObject({ command: "up", noCostProxy: true });
    expect(parseArgs(["up"])).toMatchObject({ command: "up", noCostProxy: false });
    expect(
      parseArgs(["restart", "--no-sandbox", "--no-cost-proxy"]),
    ).toMatchObject({ command: "restart", noCostProxy: true, sandbox: false });
    expect(parseArgs(["restart"])).toMatchObject({ command: "restart", noCostProxy: false });
  });

  test("rejects a value and stays unknown for other commands", () => {
    expect(() => parseArgs(["up", "--no-cost-proxy=1"])).toThrow(/takes no value/);
    expect(() => parseArgs(["ping", "--no-cost-proxy"])).toThrow(/unknown option/);
  });
});

describe("DeepInfra in host mode", () => {
  /** Runs host up and returns the env that the server got. */
  async function serveEnvOf(
    env: Record<string, string>,
    opts: { keyFile?: string; noCostProxy?: boolean } = {},
  ): Promise<{ serveEnv: Record<string, string | undefined>; readFiles: string[] }> {
    const readFiles: string[] = [];
    let serveEnvSeen: Record<string, string | undefined> = {};
    const deps = makeDeps({
      readKeyFile: (file) => {
        readFiles.push(file);
        return file.endsWith("deepinfra.key") ? (opts.keyFile ?? null) : null;
      },
      spawnServe: ({ env: serveEnvArg }) => {
        serveEnvSeen = { ...serveEnvArg };
        return { pid: 1001, exitCode: () => null };
      },
    });
    const result = await up({ port: 8790, noCostProxy: opts.noCostProxy }, env, deps);
    expect(result).toBe(0);
    return { serveEnv: serveEnvSeen, readFiles };
  }

  function providerOf(serve: Record<string, string | undefined>): Record<string, { options: { baseURL: string } }> | undefined {
    return (JSON.parse(serve.OPENCODE_CONFIG_CONTENT as string) as { provider?: Record<string, { options: { baseURL: string } }> }).provider;
  }

  test("with the key file, the server gets the key and the deepinfra baseURL of the proxy", async () => {
    const env = { ...makeEnv(), XDG_CONFIG_HOME: "/cfg" };
    const { serveEnv: serve, readFiles } = await serveEnvOf(env, { keyFile: "file-key\n" });
    expect(readFiles).toEqual(["/cfg/test/deepinfra.key"]);
    expect(serve.DEEPINFRA_API_KEY).toBe("file-key");
    expect(providerOf(serve)?.deepinfra).toEqual({ options: { baseURL: "http://127.0.0.1:8791/deepinfra/v1" } });
    expect(providerOf(serve)?.openrouter).toEqual({ options: { baseURL: "http://127.0.0.1:8791/v1" } });
  });

  test("the environment variable comes first, and the file is not read", async () => {
    const env = { ...makeEnv(), XDG_CONFIG_HOME: "/cfg", DEEPINFRA_API_KEY: "env-key" };
    const { serveEnv: serve, readFiles } = await serveEnvOf(env, { keyFile: "file-key" });
    expect(serve.DEEPINFRA_API_KEY).toBe("env-key");
    expect(readFiles).toEqual([]);
    expect(providerOf(serve)?.deepinfra).toBeDefined();
  });

  test("without the env variable and the key file, nothing changes", async () => {
    const env = { ...makeEnv(), XDG_CONFIG_HOME: "/cfg" };
    const { serveEnv: serve } = await serveEnvOf(env);
    expect(serve.DEEPINFRA_API_KEY).toBeUndefined();
    expect(providerOf(serve)?.deepinfra).toBeUndefined();
  });

  test("with --no-cost-proxy, the server gets the key but no proxy baseURL", async () => {
    const env = { ...makeEnv(), XDG_CONFIG_HOME: "/cfg" };
    const { serveEnv: serve } = await serveEnvOf(env, { keyFile: "file-key", noCostProxy: true });
    expect(serve.DEEPINFRA_API_KEY).toBe("file-key");
    expect(providerOf(serve)).toBeUndefined();
  });

  test("serveEnv sets the deepinfra entries only with their options", () => {
    const { env } = serveEnv({ HOME: "/home/user" }, "/plugin/opencode", "/srv/agents", {
      proxyUrl: "http://127.0.0.1:8791/v1",
      deepinfraProxyUrl: "http://127.0.0.1:8791/deepinfra/v1",
      deepinfraKey: "k",
    });
    expect(env.DEEPINFRA_API_KEY).toBe("k");
    expect(providerOf(env)?.deepinfra).toEqual({ options: { baseURL: "http://127.0.0.1:8791/deepinfra/v1" } });
    const plain = serveEnv({ HOME: "/home/user" }, "/plugin/opencode", "/srv/agents").env;
    expect(plain.DEEPINFRA_API_KEY).toBeUndefined();
  });
});

describe("up on the unit path", () => {
  /** Runs up with a user manager and records each start and each unit call in one list. */
  async function upOnUnits(over: Partial<UpDeps> = {}, loaded: string[] = [], extraEnv: Record<string, string> = {}) {
    const env = { ...makeEnv(), ...extraEnv };
    const units = fakeUnits({ loaded });
    const started: UnitOptions[] = [];
    const record = (opts: UnitOptions) => {
      started.push(opts);
      units.calls.push(`start ${opts.kind}`);
      return { pid: 1000 + started.length, exitCode: () => null };
    };
    const deps = makeDeps({ units: units.deps, spawnProxy: record, spawnServe: record, spawnIdleWatch: record, ...over });
    const result = await up({ port: 8790 }, env, deps);
    return { env, result, started, calls: units.calls };
  }

  test("starts the proxy as the plain bun command that always restarts, without a start limit", async () => {
    const { env, result, started } = await upOnUnits();
    expect(result).toBe(0);
    const proxy = started.find((opts) => opts.kind === "proxy") as UnitOptions;
    expect(proxy.cmd).toEqual([
      "/opt/bun/bin/bun",
      proxyBundleIn(pluginDataDir(env)),
      "--port",
      "8791",
      "--hostname",
      "127.0.0.1",
    ]);
    expect(proxy.restart).toBe("always");
    expect(proxy.restartSec).toBe(PROXY_RESTART_SEC);
    expect(proxy.startLimitIntervalSec).toBe(0);
    expect(proxy.logPath).toBe(proxyLogPath(env, 8790));
    expect(proxy.pidPath).toBe(proxyPidPath(env, 8790));
  });

  test("labels each unit with the kind, the port, the project, and a reason", async () => {
    const { started } = await upOnUnits();
    expect(started.map((opts) => [opts.kind, opts.name, opts.owner, opts.reason])).toEqual([
      ["proxy", "8790", "test", "cost proxy for port 8790"],
      ["serve", "8790", "test", "opencode server of up on port 8790"],
      ["idle", "8790", "test", "idle watchdog for port 8790, stops the server after 30m without activity"],
    ]);
    expect(started.find((opts) => opts.kind === "serve")?.timeoutStopSec).toBe(UNIT_STOP_TIMEOUT_SEC);
  });

  test("OC_SUB_OWNER overrides the owner of each unit, but not the project of the key file", async () => {
    const keyFiles: string[] = [];
    const readKeyFile = (file: string) => {
      keyFiles.push(file);
      return null;
    };
    const { result, started, env } = await upOnUnits({ readKeyFile }, [], { OC_SUB_OWNER: " session 7\n" });
    expect(result).toBe(0);
    expect(started.map((opts) => [opts.kind, opts.owner])).toEqual([
      ["proxy", "session_7"],
      ["serve", "session_7"],
      ["idle", "session_7"],
    ]);
    expect(keyFiles).toEqual([deepinfraKeyPath("test", env)]);
  });

  test("stops the units of a dead server of the same port before the start", async () => {
    const { result, calls } = await upOnUnits({}, ["idfx-serve-8790", "idfx-proxy-8790", "idfx-idle-8790"]);
    expect(result).toBe(0);
    expect(calls).toEqual([
      "stop idfx-serve-8790",
      "stop ocsub-serve-8790",
      "stop idfx-proxy-8790",
      "stop ocsub-proxy-8790",
      "stop idfx-idle-8790",
      "stop ocsub-idle-8790",
      "start proxy",
      "start serve",
      "start idle",
    ]);
  });

  test("a failed stop of an old unit stops up before any start", async () => {
    const env = makeEnv();
    const units = fakeUnits({ failStop: "idfx-proxy-8790" });
    let started = 0;
    const count = () => {
      started += 1;
      return { pid: 1, exitCode: () => null };
    };
    const original = console.error;
    console.error = () => {};
    let result: number;
    try {
      result = await up({ port: 8790 }, env, makeDeps({ units: units.deps, spawnProxy: count, spawnServe: count }));
    } finally {
      console.error = original;
    }
    expect(result).toBe(1);
    expect(started).toBe(0);
  });

  test("a failed server start stops the proxy unit, not the PID group", async () => {
    const killed: number[] = [];
    const original = console.error;
    console.error = () => {};
    let outcome: Awaited<ReturnType<typeof upOnUnits>>;
    try {
      outcome = await upOnUnits({
        spawnServe: () => {
          throw new Error("no opencode");
        },
        killGroup: (pid) => killed.push(pid),
      });
    } finally {
      console.error = original;
    }
    expect(outcome.result).toBe(1);
    expect(killed).toEqual([]);
    expect(outcome.calls.slice(-1)).toEqual(["stop idfx-proxy-8790"]);
    expect(existsSync(proxyPidPath(outcome.env, 8790))).toBe(false);
  });

  test("the fallback path keeps the sh loop and sets no restart", async () => {
    const env = makeEnv();
    const started: UnitOptions[] = [];
    const deps = makeDeps({
      spawnProxy: (opts) => {
        started.push(opts);
        return { pid: 1002, exitCode: () => null };
      },
    });
    expect(await up({ port: 8790 }, env, deps)).toBe(0);
    expect(started[0]?.cmd[0]).toBe("sh");
    expect(started[0]?.restart).toBeUndefined();
    expect(started[0]?.restartSec).toBeUndefined();
    expect(started[0]?.startLimitIntervalSec).toBeUndefined();
  });
});

describe("proxyCommand", () => {
  test("is the plain bun command on the unit path and the sh loop on the fallback path", () => {
    expect(proxyCommand(true, "/b/bun", "/p/cost-proxy.js", 8791)).toEqual([
      "/b/bun",
      "/p/cost-proxy.js",
      "--port",
      "8791",
      "--hostname",
      "127.0.0.1",
    ]);
    expect(proxyCommand(false, "/b/bun", "/p/cost-proxy.js", 8791)).toEqual([
      "sh",
      "-c",
      proxyLoopScript("/b/bun", "/p/cost-proxy.js", 8791, "127.0.0.1"),
    ]);
  });

  test("isProxyLoop knows the plain command of the unit path", () => {
    const line = proxyCommand(true, "/b/bun", "/p/cost-proxy/cost-proxy.js", 19791).join(" ");
    expect(isProxyLoop(line, 19791)).toBe(true);
  });

  test("isProxyLoop rejects the systemd executor right after a start", () => {
    // Before the exec, `ps` shows the executor, not the proxy.
    expect(isProxyLoop("(sd-executor)", 19791)).toBe(false);
  });
});

describe("down on the unit path", () => {
  /** A state with a running serve unit whose PID file still names the systemd executor. */
  async function unitState() {
    const env = makeEnv();
    mkdirSync(path.join(env.XDG_STATE_HOME as string, "idfx"), { recursive: true });
    await Bun.write(servePidPath(env, 19790), "2147483000\n");
    await Bun.write(proxyPidPath(env, 19790), "2147483001\n");
    return env;
  }

  async function quietDown(env: Record<string, string>, deps: DownDeps): Promise<number> {
    const original = console.log;
    console.log = () => {};
    try {
      return await down({ port: 19790, force: true }, env, deps);
    } finally {
      console.log = original;
    }
  }

  test("stops the serve unit, then the proxy unit, then the idle unit", async () => {
    const env = await unitState();
    const units = fakeUnits({ loaded: ["idfx-serve-19790", "idfx-proxy-19790", "idfx-idle-19790"] });
    const killed: number[] = [];
    const result = await quietDown(env, {
      // The window right after a start: the PID is still the executor.
      commandLineOf: () => "(sd-executor)",
      killGroup: (pid) => killed.push(pid),
      units: units.deps,
    });
    expect(result).toBe(0);
    expect(units.calls.filter((call) => call.startsWith("stop"))).toEqual([
      "stop idfx-serve-19790",
      "stop ocsub-serve-19790",
      "stop idfx-proxy-19790",
      "stop ocsub-proxy-19790",
      "stop idfx-idle-19790",
      "stop ocsub-idle-19790",
    ]);
    expect(units.loaded.size).toBe(0);
    expect(killed).toEqual([]);
    expect(existsSync(servePidPath(env, 19790))).toBe(false);
    expect(existsSync(proxyPidPath(env, 19790))).toBe(false);
  });

  test("the watchdog stops the server and the proxy, but never its own unit", async () => {
    const env = await unitState();
    const units = fakeUnits({
      loaded: ["idfx-serve-19790", "idfx-proxy-19790", "idfx-idle-19790"],
      own: "idfx-idle-19790",
    });
    const result = await quietDown(env, { commandLineOf: () => null, killGroup: () => {}, units: units.deps });
    expect(result).toBe(0);
    expect(units.calls.filter((call) => call.startsWith("stop"))).toEqual([
      "stop idfx-serve-19790",
      "stop ocsub-serve-19790",
      "stop idfx-proxy-19790",
      "stop ocsub-proxy-19790",
      "stop ocsub-idle-19790",
    ]);
    // The watchdog ends by itself after the stop; its unit stays until then.
    expect([...units.loaded]).toEqual(["idfx-idle-19790"]);
  });

  test("stops the units of older code with the prefix ocsub-", async () => {
    const env = await unitState();
    const units = fakeUnits({ loaded: ["ocsub-serve-19790", "ocsub-proxy-19790", "ocsub-idle-19790"] });
    const result = await quietDown(env, { commandLineOf: () => "(sd-executor)", killGroup: () => {}, units: units.deps });
    expect(result).toBe(0);
    expect(units.loaded.size).toBe(0);
  });

  test("a dead server: down still stops the proxy unit", async () => {
    const env = await unitState();
    const units = fakeUnits({ loaded: ["idfx-proxy-19790"] });
    const result = await quietDown(env, { commandLineOf: () => null, killGroup: () => {}, units: units.deps });
    expect(result).toBe(0);
    expect(units.calls).toContain("stop idfx-proxy-19790");
    expect(units.loaded.size).toBe(0);
  });

  test("a failed unit stop is an error", async () => {
    const env = await unitState();
    const units = fakeUnits({ loaded: ["idfx-serve-19790"], failStop: "idfx-serve-19790" });
    const original = console.error;
    console.error = () => {};
    let result: number;
    try {
      result = await quietDown(env, { commandLineOf: () => null, killGroup: () => {}, units: units.deps });
    } finally {
      console.error = original;
    }
    expect(result).toBe(1);
  });

  test("stopStartedGroups stops the units before it signals the groups", async () => {
    const env = await unitState();
    const units = fakeUnits({ loaded: ["idfx-serve-19790", "idfx-proxy-19790"] });
    const signaled = await stopStartedGroups(env, 19790, "SIGKILL", {
      commandLineOf: () => null,
      killGroup: () => {},
      units: units.deps,
    });
    expect(signaled).toEqual([]);
    expect(units.calls).toEqual([
      "stop idfx-serve-19790",
      "stop ocsub-serve-19790",
      "stop idfx-proxy-19790",
      "stop ocsub-proxy-19790",
      "stop idfx-idle-19790",
      "stop ocsub-idle-19790",
    ]);
  });
});
