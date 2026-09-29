import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  placeholderKeyScript,
  listsOpenRouterSecret,
  listsPublishedPort,
  deniesNetwork,
  downSandbox,
  EXA_HOST,
  listsMounts,
  listsName,
  miseBin,
  miseInstallsDir,
  NETWORK_DENY_HOSTS,
  parseSandboxState,
  pickPort,
  projectRoot,
  projectToolPath,
  readSandboxState,
  relativeMount,
  resolveCommandUrl,
  sandboxConfigContent,
  sandboxName,
  sandboxUrlFor,
  SANDBOX_BASH_AGENTS,
  SANDBOX_PATH,
  shellQuote,
  upSandbox,
  usedSandboxPorts,
  sandboxStatePath,
  writeSandboxState,
  type Runner,
  type SandboxDeps,
} from "../src/sandbox";
import { PLUGIN_CONFIG_DIR } from "../src/up";

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "oc-sub-sandbox-"));
}

function makeEnv(): Record<string, string> {
  return { XDG_STATE_HOME: tempDir(), XDG_CONFIG_HOME: tempDir(), HOME: tempDir() };
}

type Call = { cmd: string[]; cwd?: string };

/** The mounts of a sandbox of the tests, as the WORKSPACE column shows them. */
const PLUGIN_MOUNT = `${PLUGIN_CONFIG_DIR}:ro`;

function installsMount(env: Record<string, string>): string {
  return `${miseInstallsDir(env)}:ro`;
}

/** The `sbx ls` output with both mounts, in the real column format. */
function lsWorkspace(name: string, env: Record<string, string>): string {
  return `NAME     STATUS     WORKSPACE\n${name}   running   /repo, ${PLUGIN_MOUNT}, ${installsMount(env)}\n`;
}

/** What `sbx policy check network` prints for a denied target. */
const DENIED = { stdout: "Denied: host.docker.internal:8767\n" };

/** A fake runner whose answers come from a per-subcommand script. */
function fakeRunner(answer: (cmd: readonly string[]) => { stdout?: string; exitCode?: number }): {
  calls: Call[];
  runner: Runner;
} {
  const calls: Call[] = [];
  const runner: Runner = (cmd, opts) => {
    calls.push({ cmd: [...cmd], cwd: opts?.cwd });
    const { stdout = "", exitCode = 0 } = answer(cmd);
    return { stdout, exitCode };
  };
  return { calls, runner };
}

function isSubcommand(cmd: readonly string[], name: string): boolean {
  return cmd[1] === name;
}

function subcommands(calls: Call[]): string[] {
  // The fake runner also carries the `mise` calls. The key names the binary,
  // the value the subcommand of `sbx` (mise has none).
  return calls.map((call) => (call.cmd[0] === "sbx" ? (call.cmd[1] as string) : (call.cmd[0] as string)));
}

function makeDeps(overrides: Partial<SandboxDeps> = {}): SandboxDeps {
  return {
    runner: () => ({ stdout: "", exitCode: 0 }),
    keyExists: () => true,
    isPortFree: () => true,
    probe: async () => ({ state: "down" }),
    spawnServe: () => ({ pid: 4242, exitCode: () => null }),
    projectName: () => "test",
    rootOf: () => "/repo",
    healthTimeoutMs: 500,
    healthIntervalMs: 1,
    ...overrides,
  };
}

describe("sandboxName", () => {
  test("prefixes oc-sub- and keeps safe characters", () => {
    expect(sandboxName("terminator")).toBe("oc-sub-terminator");
    expect(sandboxName("a.b_c-d")).toBe("oc-sub-a.b_c-d");
  });

  test("lowercases and replaces every unsafe character", () => {
    expect(sandboxName("My Repo!")).toBe("oc-sub-my-repo-");
    expect(sandboxName("Wörk/Space")).toBe("oc-sub-w-rk-space");
  });
});

describe("sandboxUrlFor and resolveCommandUrl", () => {
  async function writeState(env: Record<string, string>, project: string, port: number): Promise<void> {
    await writeSandboxState(sandboxStatePath(env, project), { name: `oc-sub-${project}`, root: "/repo", port });
  }

  test("returns the sandbox URL from the state file", async () => {
    const env = makeEnv();
    await writeState(env, "test", 18780);
    expect(sandboxUrlFor("/somewhere/test", env, () => "test")).toBe("http://127.0.0.1:18780");
  });

  test("returns undefined without a state file", () => {
    expect(sandboxUrlFor("/somewhere/test", makeEnv(), () => "test")).toBeUndefined();
  });

  test("a worktree directory finds the state file of the project", async () => {
    const env = makeEnv();
    await writeState(env, "proj", 18781);
    // A worktree such as <repo>/.worktrees/x belongs to project proj. The
    // test replaces the git call with the projectName parameter.
    const projectName = (directory: string) => (directory.startsWith("/repo/") ? "proj" : path.basename(directory));
    expect(sandboxUrlFor("/repo/.worktrees/x", env, projectName)).toBe("http://127.0.0.1:18781");
  });

  test("resolveCommandUrl: the flag wins over everything", async () => {
    const env = makeEnv();
    await writeState(env, "test", 18782);
    expect(resolveCommandUrl("http://127.0.0.1:9000", env, "/d", () => "test")).toBe("http://127.0.0.1:9000");
  });

  test("resolveCommandUrl: OC_SUB_URL wins over the state file", async () => {
    const env = makeEnv();
    await writeState(env, "test", 18783);
    expect(resolveCommandUrl(undefined, { ...env, OC_SUB_URL: "http://127.0.0.1:9001" }, "/d", () => "test")).toBe(
      "http://127.0.0.1:9001",
    );
  });

  test("resolveCommandUrl: the state file wins over the default", async () => {
    const env = makeEnv();
    await writeState(env, "test", 18784);
    expect(resolveCommandUrl(undefined, env, "/d", () => "test")).toBe("http://127.0.0.1:18784");
  });

  test("resolveCommandUrl: no state file gives the default", () => {
    expect(resolveCommandUrl(undefined, makeEnv(), "/d", () => "test")).toBe("http://127.0.0.1:8767");
  });

  test("resolveCommandUrl: without a directory it uses the current folder", async () => {
    const env = makeEnv();
    await writeState(env, "cwd-test", 18785);
    expect(resolveCommandUrl(undefined, env, undefined, () => "cwd-test")).toBe("http://127.0.0.1:18785");
  });
});

describe("projectRoot", () => {
  function spawnResult(exitCode: number, stdout: string): ReturnType<typeof Bun.spawnSync> {
    return { exitCode, stdout: Buffer.from(stdout) } as unknown as ReturnType<typeof Bun.spawnSync>;
  }

  test("is the folder of the main repository", () => {
    const spy = spyOn(Bun, "spawnSync").mockImplementation(
      (() => spawnResult(0, "/home/u/dv/proj/.git\n")) as unknown as typeof Bun.spawnSync,
    );
    try {
      expect(projectRoot("/home/u/dv/proj/.worktrees/step")).toBe("/home/u/dv/proj");
    } finally {
      spy.mockRestore();
    }
  });

  test("is the directory itself without git", () => {
    const spy = spyOn(Bun, "spawnSync").mockImplementation(
      (() => spawnResult(128, "")) as unknown as typeof Bun.spawnSync,
    );
    try {
      expect(projectRoot("/home/u/dv/other/repo-x")).toBe("/home/u/dv/other/repo-x");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("sandbox state file", () => {
  test("parses a valid state and rejects invalid content", () => {
    expect(parseSandboxState(`{"name":"oc-sub-t","root":"/r","port":18768}`)).toEqual({
      name: "oc-sub-t",
      root: "/r",
      port: 18768,
    });
    expect(parseSandboxState("not json")).toBeNull();
    expect(parseSandboxState("[]")).toBeNull();
    expect(parseSandboxState(`{"name":"","root":"/r","port":1}`)).toBeNull();
    expect(parseSandboxState(`{"name":"n","root":"","port":1}`)).toBeNull();
    expect(parseSandboxState(`{"name":"n","root":"/r","port":0}`)).toBeNull();
    expect(parseSandboxState(`{"name":"n","root":"/r","port":70000}`)).toBeNull();
    expect(parseSandboxState(`{"name":"n","root":"/r"}`)).toBeNull();
  });

  test("reads null for a missing file and round-trips through write", async () => {
    const file = path.join(tempDir(), "sandbox-test.json");
    expect(readSandboxState(file)).toBeNull();
    await writeSandboxState(file, { name: "oc-sub-test", root: "/repo", port: 18790 });
    expect(readSandboxState(file)).toEqual({ name: "oc-sub-test", root: "/repo", port: 18790 });
  });

  test("usedSandboxPorts collects the ports of the other projects", () => {
    const env = makeEnv();
    const stateHome = path.join(env.XDG_STATE_HOME as string, "oc-sub");
    mkdirSync(stateHome, { recursive: true });
    writeFileSync(path.join(stateHome, "sandbox-other.json"), `{"name":"o","root":"/o","port":20000}`);
    writeFileSync(path.join(stateHome, "sandbox-broken.json"), "not json");
    writeFileSync(path.join(stateHome, "sandbox-test.json"), `{"name":"t","root":"/t","port":21000}`);
    expect(usedSandboxPorts(env, "test")).toEqual(new Set([20000]));
  });
});

describe("pickPort", () => {
  test("returns the first free port from 18768 upward", async () => {
    expect(await pickPort(new Set(), () => true)).toBe(18768);
  });

  test("skips used ports", async () => {
    expect(await pickPort(new Set([18768, 18769]), () => true)).toBe(18770);
  });

  test("skips busy ports", async () => {
    expect(await pickPort(new Set(), (port) => port !== 18768)).toBe(18769);
    expect(await pickPort(new Set([18768]), (port) => port === 18768 || port === 18769 ? false : true)).toBe(18770);
  });
});

describe("shellQuote and relativeMount", () => {
  test("shellQuote quotes and escapes", () => {
    expect(shellQuote("/a/key")).toBe("'/a/key'");
    expect(shellQuote("/a b'c")).toBe(`'/a b'\\''c'`);
  });

  test("relativeMount returns a relative path from the plugin parent", () => {
    const parent = path.dirname(PLUGIN_CONFIG_DIR);
    expect(relativeMount(parent, PLUGIN_CONFIG_DIR)).toBe("./opencode");
    expect(relativeMount("/p", "/p")).toBe(".");
  });

  test("listsName matches whole words on one line", () => {
    expect(listsName("oc-sub-test\nother\n", "oc-sub-test")).toBe(true);
    expect(listsName("oc-sub-test-2\n", "oc-sub-test")).toBe(false);
  });

  test("listsOpenRouterSecret reads the scope and name columns of sbx 0.45.1", () => {
    const header = "SCOPE     TYPE      NAME         SECRET\n";
    expect(listsOpenRouterSecret(`${header}oc-sub-test   service   openrouter   (stored)\n`, "oc-sub-test")).toBe(true);
    expect(listsOpenRouterSecret(`${header}oc-test   service   openrouter   (stored)\n`, "oc-sub-test")).toBe(false);
    expect(listsOpenRouterSecret(`${header}oc-sub-test   service   github   (stored)\n`, "oc-sub-test")).toBe(false);
    expect(listsOpenRouterSecret("No secrets found.\n", "oc-sub-test")).toBe(false);
  });

  test("listsPublishedPort reads the host and sandbox port columns of sbx 0.45.1", () => {
    const out = "HOST IP     HOST PORT   SANDBOX PORT   PROTOCOL\n127.0.0.1   18767       4096           tcp4\n";
    expect(listsPublishedPort(out, 18767)).toBe(true);
    expect(listsPublishedPort(out, 18768)).toBe(false);
    expect(listsPublishedPort("HOST IP     HOST PORT   SANDBOX PORT   PROTOCOL\n127.0.0.1   4096       18767           tcp4\n", 18767)).toBe(false);
  });
});

describe("mise helpers", () => {
  test("miseBin comes from MISE_BIN, else mise", () => {
    expect(miseBin({})).toBe("mise");
    expect(miseBin({ MISE_BIN: "/opt/mise" })).toBe("/opt/mise");
  });

  test("miseInstallsDir honors MISE_DATA_DIR", () => {
    expect(miseInstallsDir({ MISE_DATA_DIR: "/data/mise" })).toBe("/data/mise/installs");
  });

  test("miseInstallsDir falls back to XDG_DATA_HOME/mise", () => {
    expect(miseInstallsDir({ XDG_DATA_HOME: "/home/u/.local/data" })).toBe("/home/u/.local/data/mise/installs");
  });

  test("miseInstallsDir falls back to ~/.local/share/mise", () => {
    expect(miseInstallsDir({ HOME: "/home/u" })).toBe("/home/u/.local/share/mise/installs");
  });

  test("projectToolPath keeps only the entries inside the installs folder, in order", () => {
    const json = JSON.stringify({
      PATH: "/home/u/.local/bin:/home/u/.local/share/mise/installs/bun/1.4.2/bin:/usr/local/bin:/home/u/.local/share/mise/installs/node/22/bin:/home/u/.local/share/mise/installs2/x/bin:/usr/bin",
    });
    expect(projectToolPath(json, "/home/u/.local/share/mise/installs")).toBe(
      "/home/u/.local/share/mise/installs/bun/1.4.2/bin:/home/u/.local/share/mise/installs/node/22/bin",
    );
  });

  test("projectToolPath returns the empty string for no JSON and no PATH string", () => {
    expect(projectToolPath("not json", "/installs")).toBe("");
    expect(projectToolPath("{}", "/installs")).toBe("");
    expect(projectToolPath('{"PATH":"x"}', "/installs")).toBe("");
    expect(projectToolPath('{"PATH":["/installs/a"]}', "/installs")).toBe("");
  });

  test("deniesNetwork reads the first line of the policy check", () => {
    expect(deniesNetwork("Denied: host.docker.internal:8767\n")).toBe(true);
    expect(deniesNetwork("Allowed: host.docker.internal:8767\n")).toBe(false);
    expect(deniesNetwork("")).toBe(false);
  });

  test("listsMounts needs the sandbox name and every mount on one line", () => {
    const out = "NAME   STATUS   WORKSPACE\noc-sub-t   running   /repo, /home/u/p/opencode:ro, /home/u/.local/share/mise/installs:ro\n";
    expect(listsMounts(out, "oc-sub-t", ["/home/u/p/opencode:ro", "/home/u/.local/share/mise/installs:ro"])).toBe(true);
    expect(listsMounts(out, "oc-sub-t", ["/home/u/p/opencode:ro"])).toBe(true);
    expect(listsMounts(out, "oc-sub-t", ["/home/u/p/opencode:ro", "/other:ro"])).toBe(false);
    expect(listsMounts(out, "other", ["/home/u/p/opencode:ro"])).toBe(false);
  });
});

describe("placeholderKeyScript", () => {
  test("writes proxy-managed into the key file of the project in the sandbox home", () => {
    expect(placeholderKeyScript("my proj")).toBe(
      `mkdir -p "$HOME/.config/"'my proj' && chmod 700 "$HOME/.config/"'my proj' && printf %s proxy-managed > "$HOME/.config/"'my proj'/openrouter.key`,
    );
  });
});

describe("sandboxConfigContent", () => {
  test("is JSON with exactly the sandbox agents, each with bash allow", () => {
    const parsed = JSON.parse(sandboxConfigContent()) as {
      agent: Record<string, { permission: { bash: string } }>;
    };
    expect(Object.keys(parsed.agent).sort()).toEqual([...SANDBOX_BASH_AGENTS].sort());
    for (const agent of SANDBOX_BASH_AGENTS) {
      expect(parsed.agent[agent]).toEqual({ permission: { bash: "allow" } });
    }
  });

  test("turns the MCP gateway of the sbx kit off", () => {
    const parsed = JSON.parse(sandboxConfigContent()) as { mcp: Record<string, { enabled: boolean }> };
    expect(parsed.mcp["mcp-gateway"]).toEqual({ enabled: false });
  });

  test("the holder command names both -e options before the sandbox name", async () => {
    const env = makeEnv();
    const { runner } = fakeRunner((cmd) => {
      if (isSubcommand(cmd, "ls")) return { stdout: lsWorkspace("oc-sub-test", env) };
      if (isSubcommand(cmd, "secret") && cmd[2] === "ls") return { stdout: "SCOPE     TYPE      NAME         SECRET\noc-sub-test   service   openrouter   (stored)\n" };
      if (isSubcommand(cmd, "ports")) return { stdout: "HOST IP     HOST PORT   SANDBOX PORT   PROTOCOL\n127.0.0.1   18768       4096           tcp4\n" };
      if (isSubcommand(cmd, "policy") && cmd[2] === "check") return DENIED;
      return DENIED;
    });
    const holderCommands: string[][] = [];
    // The first probe finds no server, so up starts the holder.
    let probes = 0;
    const result = await upSandbox({}, env, makeDeps({
      runner,
      probe: async () => (probes++ === 0 ? { state: "down" } : { state: "up", version: "1.18.32" }),
      spawnServe: (cmd) => {
        holderCommands.push([...cmd]);
        return { pid: 4242, exitCode: () => null };
      },
    }));
    expect(result).toBe(0);
    expect(holderCommands).toHaveLength(1);
    const cmd = holderCommands[0] ?? [];
    const nameIndex = cmd.indexOf("oc-sub-test");
    const contentFlag = cmd.indexOf(`OPENCODE_CONFIG_CONTENT=${sandboxConfigContent()}`);
    const sshFlag = cmd.indexOf("SSH_AUTH_SOCK=");
    expect(sshFlag).toBe(contentFlag + 2);
    expect(contentFlag).toBeLessThan(nameIndex);
    expect(sshFlag).toBeLessThan(nameIndex);
  });

  test("a set host OPENCODE_CONFIG_CONTENT gives a warning on stderr", async () => {
    const env = { ...makeEnv(), OPENCODE_CONFIG_CONTENT: '{"agent":{}}' };
    const { runner } = fakeRunner((cmd) => {
      if (isSubcommand(cmd, "ls")) return { stdout: lsWorkspace("oc-sub-test", env) };
      if (isSubcommand(cmd, "secret") && cmd[2] === "ls") return { stdout: "SCOPE     TYPE      NAME         SECRET\noc-sub-test   service   openrouter   (stored)\n" };
      if (isSubcommand(cmd, "ports")) return { stdout: "HOST IP     HOST PORT   SANDBOX PORT   PROTOCOL\n127.0.0.1   18768       4096           tcp4\n" };
      return DENIED;
    });
    const errors: string[] = [];
    const err = console.error;
    console.error = (line: string) => errors.push(line);
    try {
      await upSandbox({}, env, makeDeps({
        runner,
        probe: async () => ({ state: "up", version: "1.18.32" }),
        spawnServe: () => ({ pid: 4242, exitCode: () => null }),
      }));
    } finally {
      console.error = err;
    }
    expect(errors.some((line) => line.includes("OPENCODE_CONFIG_CONTENT") && line.includes("sandbox"))).toBe(true);
  });
});

describe("upSandbox", () => {
  const PORTS_HEADER = "HOST IP     HOST PORT   SANDBOX PORT   PROTOCOL\n";

  test("a publish that fails is fine when a second list shows the port", async () => {
    const env = makeEnv();
    let lists = 0;
    const { calls, runner } = fakeRunner((cmd) => {
      if (isSubcommand(cmd, "ls")) return { stdout: lsWorkspace("oc-sub-test", env) };
      if (isSubcommand(cmd, "secret")) return { stdout: "oc-sub-test   service   openrouter   (stored)\n" };
      if (isSubcommand(cmd, "ports") && cmd.includes("--publish")) return { stdout: "", exitCode: 1 };
      if (isSubcommand(cmd, "ports")) {
        lists += 1;
        return { stdout: lists === 1 ? PORTS_HEADER : `${PORTS_HEADER}127.0.0.1   18768       4096           tcp4\n` };
      }
      return DENIED;
    });
    const result = await upSandbox({}, env, makeDeps({ runner, probe: async () => ({ state: "up", version: "1.18.32" }) }));
    expect(result).toBe(0);
    expect(subcommands(calls)).toEqual(["mise", "mise", "ls", "secret", "exec", "ports", "ports", "ports", "policy", "policy"]);
  });

  test("a publish that fails without the port in a second list is an error", async () => {
    const env = makeEnv();
    const { runner } = fakeRunner((cmd) => {
      if (isSubcommand(cmd, "ls")) return { stdout: lsWorkspace("oc-sub-test", env) };
      if (isSubcommand(cmd, "secret")) return { stdout: "oc-sub-test   service   openrouter   (stored)\n" };
      if (isSubcommand(cmd, "ports") && cmd.includes("--publish")) return { stdout: "", exitCode: 1 };
      return { stdout: PORTS_HEADER };
    });
    const result = await upSandbox({}, env, makeDeps({ runner, probe: async () => ({ state: "up", version: "1.18.32" }) }));
    expect(result).toBe(1);
  });

  test("a failed placeholder write stops up before the port", async () => {
    const env = makeEnv();
    const { calls, runner } = fakeRunner((cmd) => {
      if (isSubcommand(cmd, "ls")) return { stdout: lsWorkspace("oc-sub-test", env) };
      if (isSubcommand(cmd, "secret")) return { stdout: "oc-sub-test   service   openrouter   (stored)\n" };
      if (isSubcommand(cmd, "exec")) return { stdout: "", exitCode: 1 };
      return DENIED;
    });
    const result = await upSandbox({}, env, makeDeps({ runner }));
    expect(result).toBe(1);
    expect(subcommands(calls)).toEqual(["mise", "mise", "ls", "secret", "exec"]);
  });

  test("refuses without the project key file and calls no sbx", async () => {
    const { calls, runner } = fakeRunner(() => ({ stdout: "" }));
    const result = await upSandbox({}, makeEnv(), makeDeps({ runner, keyExists: () => false }));
    expect(result).toBe(1);
    expect(calls).toHaveLength(0);
  });

  test("a first up creates the sandbox, sets the rules, the secret, the port, and execs", async () => {
    const env = makeEnv();
    const toolBin = `${miseInstallsDir(env)}/bun/1.4.2/bin`;
    const { calls, runner } = fakeRunner((cmd) => {
      if (isSubcommand(cmd, "ls")) return { stdout: "other-sb\n" };
      if (isSubcommand(cmd, "secret") && cmd[2] === "ls") return { stdout: "github\n" };
      if (isSubcommand(cmd, "ports")) return { stdout: "" };
      // `mise env -C ROOT --json`: the real format is one JSON object.
      if (cmd[0] === "mise" && cmd[1] === "env") {
        return { stdout: JSON.stringify({ PATH: `${toolBin}:/usr/local/bin` }) };
      }
      if (isSubcommand(cmd, "policy") && cmd[2] === "check") return DENIED;
      return { stdout: "", exitCode: 0 };
    });
    const execCommands: string[][] = [];
    const result = await upSandbox({}, env, makeDeps({
      runner,
      spawnServe: (cmd) => {
        execCommands.push([...cmd]);
        return { pid: 4242, exitCode: () => 1 };
      },
    }));
    // The fake holder exits immediately, so up reports the failure.
    expect(result).toBe(1);

    expect(subcommands(calls)).toEqual([
      "mise", "mise", "ls", "create", "policy", "policy", "policy",
      "secret", "secret", "exec", "ports", "ports", "policy", "policy",
    ]);
    // `mise install` and `mise env` run in the project root.
    expect(calls[0]?.cmd).toEqual([miseBin(env), "install"]);
    expect(calls[0]?.cwd).toBe("/repo");
    expect(calls[1]?.cmd).toEqual([miseBin(env), "env", "-C", "/repo", "--json"]);
    expect(calls[1]?.cwd).toBe("/repo");
    // The create runs with the working directory `/` and mounts the plugin
    // folder and the mise installs folder read-only, both relative from `/`.
    expect(calls[3]?.cmd).toEqual([
      "sbx",
      "create",
      "--name",
      "oc-sub-test",
      "opencode",
      "/repo",
      `${relativeMount("/", PLUGIN_CONFIG_DIR)}:ro`,
      `${relativeMount("/", miseInstallsDir(env))}:ro`,
    ]);
    expect(calls[3]?.cwd).toBe("/");
    expect(calls[4]?.cmd).toEqual([
      "sbx", "policy", "allow", "network", "--sandbox", "oc-sub-test", "**", "--method", "GET,HEAD",
    ]);
    expect(calls[5]?.cmd).toEqual([
      "sbx", "policy", "allow", "network", "--sandbox", "oc-sub-test", EXA_HOST,
    ]);
    expect(calls[6]?.cmd).toEqual([
      "sbx", "policy", "deny", "network", "--sandbox", "oc-sub-test", NETWORK_DENY_HOSTS.join(","),
    ]);
    expect(calls[8]?.cmd).toEqual([
      "sbx",
      "secret",
      "set",
      "openrouter",
      "--sandbox",
      "oc-sub-test",
      "--command",
      `cat ${shellQuote(path.join(env.XDG_CONFIG_HOME as string, "test", "openrouter.key"))}`,
    ]);
    expect(calls[9]?.cmd).toEqual(["sbx", "exec", "oc-sub-test", "sh", "-c", placeholderKeyScript("test")]);
    expect(calls[11]?.cmd).toEqual(["sbx", "ports", "oc-sub-test", "--publish", "18768:4096"]);
    // The checks of the network rules, before the server starts.
    expect(calls[12]?.cmd).toEqual(["sbx", "policy", "check", "network", "--sandbox", "oc-sub-test", "host.docker.internal:8767"]);
    expect(calls[13]?.cmd).toEqual(["sbx", "policy", "check", "network", "--sandbox", "oc-sub-test", "localhost:8767"]);
    expect(execCommands).toEqual([[
      "sbx",
      "exec",
      "-e",
      `OPENCODE_CONFIG_DIR=${PLUGIN_CONFIG_DIR}`,
      "-e",
      `OPENCODE_CONFIG_CONTENT=${sandboxConfigContent()}`,
      "-e",
      "SSH_AUTH_SOCK=",
      "-e",
      "OPENCODE_ENABLE_EXA=1",
      "-e",
      `PATH=${toolBin}:${SANDBOX_PATH}`,
      "oc-sub-test",
      "opencode",
      "serve",
      "--hostname",
      "0.0.0.0",
      "--port",
      "4096",
    ]]);
    // The state file holds the name, the root, and the port.
    const state = readSandboxState(sandboxStatePath(env, "test"));
    expect(state).toEqual({ name: "oc-sub-test", root: "/repo", port: 18768 });
  });

  test("an existing sandbox without the installs mount stops up with a hint", async () => {
    const env = makeEnv();
    const { calls, runner } = fakeRunner((cmd) => {
      if (isSubcommand(cmd, "ls")) {
        return { stdout: `NAME     STATUS     WORKSPACE\noc-sub-test   running   /repo, ${PLUGIN_MOUNT}\n` };
      }
      return DENIED;
    });
    const spawnServe = () => {
      throw new Error("no server may start");
    };
    const errors: string[] = [];
    const err = console.error;
    console.error = (line: string) => errors.push(line);
    let result: number;
    try {
      result = await upSandbox({}, env, makeDeps({ runner, spawnServe }));
    } finally {
      console.error = err;
    }
    expect(result).toBe(1);
    expect(errors.join("\n")).toContain(`sbx rm oc-sub-test`);
    expect(errors.join("\n")).toContain("oc-sub up --sandbox");
    // No secret, no exec, no server.
    expect(subcommands(calls)).toEqual(["mise", "mise", "ls"]);
  });

  test("an allowed policy check stops up before the server starts", async () => {
    const env = makeEnv();
    const { calls, runner } = fakeRunner((cmd) => {
      if (isSubcommand(cmd, "ls")) return { stdout: lsWorkspace("oc-sub-test", env) };
      if (isSubcommand(cmd, "secret") && cmd[2] === "ls") return { stdout: "oc-sub-test   service   openrouter   (stored)\n" };
      if (isSubcommand(cmd, "ports")) return { stdout: "HOST IP     HOST PORT   SANDBOX PORT   PROTOCOL\n127.0.0.1   18768       4096           tcp4\n" };
      if (isSubcommand(cmd, "policy") && cmd[2] === "check") {
        return { stdout: "Allowed: host.docker.internal:8767\n" };
      }
      return DENIED;
    });
    const spawnServe = () => {
      throw new Error("no server may start");
    };
    const result = await upSandbox({}, env, makeDeps({ runner, spawnServe }));
    expect(result).toBe(1);
    expect(subcommands(calls)).toEqual(["mise", "mise", "ls", "secret", "exec", "ports", "policy"]);
  });

  test("a failed mise install stops up before any sbx call", async () => {
    const { calls, runner } = fakeRunner((cmd) => {
      if (cmd[0] === "mise" && cmd[1] === "install") return { stdout: "", exitCode: 1 };
      return DENIED;
    });
    const errors: string[] = [];
    const err = console.error;
    console.error = (line: string) => errors.push(line);
    let result: number;
    try {
      result = await upSandbox({}, makeEnv(), makeDeps({ runner }));
    } finally {
      console.error = err;
    }
    expect(result).toBe(1);
    expect(errors.join("\n")).toContain("mise install failed");
    expect(calls).toHaveLength(1);
  });

  test("a second up keeps the port and creates no sandbox, secret, or publish", async () => {
    const env = makeEnv();
    mkdirSync(env.XDG_STATE_HOME as string, { recursive: true });
    await writeSandboxState(sandboxStatePath(env, "test"), {
      name: "oc-sub-test",
      root: "/repo",
      port: 18799,
    });
    const { calls, runner } = fakeRunner((cmd) => {
      if (isSubcommand(cmd, "ls")) return { stdout: lsWorkspace("oc-sub-test", env) };
      if (isSubcommand(cmd, "secret") && cmd[2] === "ls") return { stdout: "SCOPE     TYPE      NAME         SECRET\noc-sub-test   service   openrouter   (stored)\n" };
      if (isSubcommand(cmd, "ports")) return { stdout: "HOST IP     HOST PORT   SANDBOX PORT   PROTOCOL\n127.0.0.1   18799       4096           tcp4\n" };
      return DENIED;
    });
    const output: string[] = [];
    const log = console.log;
    console.log = (line: string) => output.push(line);
    try {
      const result = await upSandbox({}, env, makeDeps({
        runner,
        probe: async () => ({ state: "up", version: "1.18.32" }),
      }));
      expect(result).toBe(0);
    } finally {
      console.log = log;
    }
    expect(subcommands(calls)).toEqual(["mise", "mise", "ls", "secret", "exec", "ports", "policy", "policy"]);
    expect(output).toContain("http://127.0.0.1:18799 version 1.18.32");
    expect(output.join("\n")).not.toContain("OC_SUB_URL");
    expect(output.join("\n")).toContain("sandbox: oc-sub-test");
    expect(output.join("\n")).toContain("log: ");
  });

  test("picks the port after the used ports of other projects", async () => {
    const env = makeEnv();
    mkdirSync(env.XDG_STATE_HOME as string, { recursive: true });
    await writeSandboxState(sandboxStatePath(env, "other"), {
      name: "oc-sub-other",
      root: "/other",
      port: 18768,
    });
    const { calls, runner } = fakeRunner((cmd) => {
      if (isSubcommand(cmd, "ls")) return { stdout: lsWorkspace("oc-sub-test", env) };
      if (isSubcommand(cmd, "ports")) return { stdout: "HOST IP     HOST PORT   SANDBOX PORT   PROTOCOL\n127.0.0.1   18769       4096           tcp4\n" };
      return DENIED;
    });
    const result = await upSandbox({}, env, makeDeps({
      runner,
      probe: async () => ({ state: "up", version: "1.18.32" }),
      spawnServe: () => ({ pid: 1, exitCode: () => null }),
    }));
    expect(result).toBe(0);
    // No publish: the fake already lists the picked port.
    expect(calls.find((call) => call.cmd[3] === "--publish")).toBeUndefined();
    const state = readSandboxState(sandboxStatePath(env, "test"));
    expect(state?.port).toBe(18769);
  });

  test("waits for health and reports the URL and log on success", async () => {
    const env = makeEnv();
    const { runner } = fakeRunner((cmd) =>
      isSubcommand(cmd, "ls") ? { stdout: lsWorkspace("oc-sub-test", env) } : DENIED,
    );
    const output: string[] = [];
    const log = console.log;
    console.log = (line: string) => output.push(line);
    try {
      let probes = 0;
      const result = await upSandbox({}, env, makeDeps({
        runner,
        probe: async () => {
          probes++;
          return probes < 3 ? { state: "down" } : { state: "up", version: "1.18.32" };
        },
      }));
      expect(result).toBe(0);
    } finally {
      console.log = log;
    }
    expect(output).toContain("http://127.0.0.1:18768 version 1.18.32");
  });
});

describe("downSandbox", () => {
  test("refuses without a state file", async () => {
    const { calls, runner } = fakeRunner(() => ({ stdout: "" }));
    const result = await downSandbox({ force: false }, makeEnv(), makeDeps({ runner }));
    expect(result).toBe(1);
    expect(calls).toHaveLength(0);
  });

  test("stops the sandbox and the holder, and keeps the state file", async () => {
    const env = makeEnv();
    mkdirSync(env.XDG_STATE_HOME as string, { recursive: true });
    await writeSandboxState(sandboxStatePath(env, "test"), {
      name: "oc-sub-test",
      root: "/repo",
      port: 18768,
    });
    const { calls, runner } = fakeRunner(() => ({ stdout: "" }));
    const result = await downSandbox({ force: false }, env, makeDeps({
      runner,
      probe: async () => ({ state: "down" }),
    }));
    expect(result).toBe(0);
    expect(calls).toEqual([{ cmd: ["sbx", "stop", "oc-sub-test"] }]);
    // The state file stays, so the port stays the same.
    expect(readSandboxState(sandboxStatePath(env, "test"))).not.toBeNull();
  });

  test("reports a failed sbx stop", async () => {
    const env = makeEnv();
    mkdirSync(env.XDG_STATE_HOME as string, { recursive: true });
    await writeSandboxState(sandboxStatePath(env, "test"), {
      name: "oc-sub-test",
      root: "/repo",
      port: 18768,
    });
    const { runner } = fakeRunner(() => ({ exitCode: 1 }));
    const result = await downSandbox({ force: false }, env, makeDeps({
      runner,
      probe: async () => ({ state: "down" }),
    }));
    expect(result).toBe(1);
  });
});
