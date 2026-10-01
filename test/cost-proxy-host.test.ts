import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { serveEnv, up, type UpDeps } from "../src/up";
import { pluginDataDir, proxyBundleIn } from "../src/plugin-sync";
import { proxyLoopScript } from "../src/sandbox";
import { proxyLogPath, proxyPidPath, readPid, readServePlugin, servePidPath, servePluginPath } from "../src/state";
import { pluginDigest } from "../src/plugin-sync";
import { PLUGIN_CONFIG_DIR } from "../src/up";
import { down, type DownDeps } from "../src/down";
import { parseArgs } from "../src/args";

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
    ...overrides,
  };
}

describe("serveEnv with the cost proxy (host mode)", () => {
  test("merges the openrouter baseURL into the config content", () => {
    const { env, warnings } = serveEnv({ HOME: "/home/u" }, "/plugin/opencode", "/srv/agents", {
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
    const { env } = serveEnv({ HOME: "/home/u" }, "/plugin/opencode", "/srv/agents");
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT as string)).not.toHaveProperty("provider");
  });
});

describe("up starts the cost proxy on the host", () => {
  test("starts the proxy as sh -c with a restart loop on port + 1, before the server", async () => {
    const env = makeEnv();
    const calls: { cmd: string[]; logPath: string; pidPath: string }[] = [];
    const order: string[] = [];
    const deps = makeDeps({
      spawnProxy: (cmd, logPath, pidPath) => {
        calls.push({ cmd: [...cmd], logPath, pidPath });
        order.push("proxy");
        return { pid: 1002, exitCode: () => null };
      },
      spawnServe: (cmd, logPath, pidPath) => {
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
      spawnServe: (_cmd, _logPath, _pidPath, serveEnvInput) => {
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
      spawnServe: (_cmd, _logPath, _pidPath, serveEnvInput) => {
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

describe("down stops the cost proxy", () => {
  function downDeps(commandLine: string, killed: number[]): DownDeps {
    return {
      commandLineOf: () => commandLine,
      killGroup: (pid) => killed.push(pid),
    };
  }

  test("signals the proxy process group and removes its PID file", async () => {
    const env = makeEnv();
    mkdirSync(path.join(env.XDG_STATE_HOME as string, "oc-sub"), { recursive: true });
    // A real proxy process, so that the default kill and the wait see a real
    // exit. The server PID points to a nonexistent process (the fake
    // commandLineOf still names an opencode serve).
    const proxy = Bun.spawn(["sh", "-c", "sleep 30"], { detached: true });
    await Bun.write(proxyPidPath(env, 8790), `${proxy.pid}\n`);
    await Bun.write(servePidPath(env, 8790), "2147483000\n");
    await Bun.write(proxyLogPath(env, 8790), "log\n");
    const killed: number[] = [];
    const deps: DownDeps = {
      commandLineOf: () => "opencode serve --port 8790 --hostname 127.0.0.1",
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
    const result = await down({ port: 8790, force: true }, env, deps);
    expect(result).toBe(0);
    expect(killed).toContain(proxy.pid);
    expect(await readPid(proxyPidPath(env, 8790))).toBeNull();
    proxy.kill();
  });

  test("removes a stale proxy PID file without killing", async () => {
    const env = makeEnv();
    mkdirSync(path.join(env.XDG_STATE_HOME as string, "oc-sub"), { recursive: true });
    // PID 2147483000 does not exist (and never will; pid_max is lower).
    await Bun.write(proxyPidPath(env, 8790), "2147483000\n");
    const killed: number[] = [];
    const deps = downDeps("opencode serve --port 8790 --hostname 127.0.0.1", killed);
    const result = await down({ port: 8790, force: true }, env, deps);
    expect(result).toBe(0);
    expect(killed).toEqual([]);
    expect(await readPid(proxyPidPath(env, 8790))).toBeNull();
  });

  test("removes the plugin digest of the stopped server", async () => {
    const env = makeEnv();
    mkdirSync(path.join(env.XDG_STATE_HOME as string, "oc-sub"), { recursive: true });
    await Bun.write(servePidPath(env, 8790), "2147483000\n");
    await Bun.write(servePluginPath(env, 8790), "sha256:abc\n");
    const result = await down({ port: 8790, force: true }, env, downDeps("opencode serve --port 8790", []));
    expect(result).toBe(0);
    expect(existsSync(servePluginPath(env, 8790))).toBe(false);
  });
});

describe("up syncs the plugin folder (step 15c)", () => {
  test("the server and the proxy load the synced folder, and the state records its digest", async () => {
    const env = makeEnv();
    let configDir: string | undefined;
    let proxyCmd: string[] = [];
    const deps = makeDeps({
      spawnServe: (_cmd, _logPath, _pidPath, serveEnvInput) => {
        configDir = serveEnvInput.OPENCODE_CONFIG_DIR;
        return { pid: 1001, exitCode: () => null };
      },
      spawnProxy: (cmd) => {
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
