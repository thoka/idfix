import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  placeholderKeyScript,
  bunBinFromInstalls,
  bunBinFromToolPath,
  listsOpenRouterSecret,
  listsPublishedPort,
  deniesNetwork,
  downSandbox,
  EXA_HOST,
  listsCloneRemote,
  listsMounts,
  listsName,
  miseBin,
  miseInstallsDir,
  MISE_TOOL,
  NETWORK_DENY_HOSTS,
  parseBinPaths,
  parseMiseVersion,
  parseSandboxState,
  pickPort,
  projectRoot,
  projectToolPath,
  proxyBaseUrl,
  proxyLoopScript,
  readSandboxState,
  relativeMount,
  resolveCommandUrl,
  SANDBOX_PROXY_PORT,
  sandboxConfigContent,
  sandboxHolderScript,
  sandboxMiseEnv,
  sandboxMiseBinDir,
  sandboxName,
  sandboxRecreateFix,
  sandboxMountPlan,
  requiredSandboxMounts,
  isInsideRoot,
  cloneCheckCommand,
  hasClone,
  cloneStatus,
  printStderr,
  missingCloneMessage,
  sandboxUrlFor,
  SANDBOX_BASH_AGENTS,
  SANDBOX_HOME,
  SANDBOX_PATH,
  sandboxToolPathEntry,
  shellQuote,
  upSandbox,
  usedSandboxPorts,
  sandboxStatePath,
  writeSandboxState,
  type Runner,
  type SandboxDeps,
  DEEPINFRA_NETWORK_HOST,
  deepinfraProxyBaseUrl,
  deepinfraSecretCommand,
  listsDeepInfraSecret,
  providerEntries,
} from "../src/sandbox";
import { DEEPINFRA_PLACEHOLDER, projectNameOf, projectRootOfRun } from "../src/keys";
import { sharedAgentsDir } from "../src/shared";
import { PLUGIN_CONFIG_DIR } from "../src/up";
import { pluginDataDir, pluginDigest, proxyBundleIn } from "../src/plugin-sync";
import { readServePlugin, serveLogPath, servePidPath, servePluginPath } from "../src/state";
import { idlePidPath } from "../src/idle";
import type { UnitOptions } from "../src/units";
import { fakeUnits, noUnits } from "./fake-units";

/** The bundle of the cost proxy, inside the synced plugin folder of the env. */
function bundlePath(env: Record<string, string>): string {
  return proxyBundleIn(pluginDataDir(env));
}

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "oc-sub-sandbox-"));
}

function makeEnv(): Record<string, string> {
  // The cost proxy needs a bun in the mise installs folder. A fake file is
  // enough, because the tests never execute it.
  const home = tempDir();
  const bunBin = path.join(home, ".local/share/mise/installs/bun/1.4.2/bin/bun");
  mkdirSync(path.dirname(bunBin), { recursive: true });
  writeFileSync(bunBin, "");
  return { XDG_STATE_HOME: tempDir(), XDG_CONFIG_HOME: tempDir(), HOME: home, OC_SUB_SHARED_DIR: path.join(home, "agents") };
}

/** The absolute bun path that the tests hand to the holder command. */
function bunBinOf(env: Record<string, string>): string {
  return `${miseInstallsDir(env)}/bun/1.4.2/bin/bun`;
}

type Call = { cmd: string[]; cwd?: string };

/** The mounts of a sandbox of the tests, as the WORKSPACE column shows them. */
function pluginMount(env: Record<string, string>): string {
  return `${pluginDataDir(env)}:ro`;
}

/** The shared folder of a test env; the tests always set it. */
function sharedDirOf(env: Record<string, string | undefined>): string {
  const dir = sharedAgentsDir(env);
  if (dir === undefined) throw new Error("the test env sets no OC_SUB_SHARED_DIR");
  return dir;
}

function sharedMount(env: Record<string, string>): string {
  return `${sharedDirOf(env)}:ro`;
}

function installsMount(env: Record<string, string>): string {
  return `${miseInstallsDir(env)}:ro`;
}

/** The `sbx ls` output with all mounts, in the real column format. */
function lsWorkspace(name: string, env: Record<string, string>): string {
  return `NAME     STATUS     WORKSPACE\n${name}   running   /repo, ${pluginMount(env)}, ${installsMount(env)}, ${sharedMount(env)}\n`;
}

/** What `sbx policy check network` prints for a denied target. */
const DENIED = { stdout: "Denied: host.docker.internal:8767\n" };

/** What `git remote` prints in a project whose sandbox is in clone mode. */
const GIT_REMOTE = { stdout: "origin\nsandbox-oc-sub-test\n" };

/** The version that the tests report for an unhandled `mise --version`. */
const MISE_VERSION = "2026.10.1";

/**
 * A fake runner whose answers come from a per-subcommand script. By default
 * it answers `mise --version` with a version, so the mise steps
 * run in every sandbox test; `miseVersion: null` simulates a host mise
 * whose version cannot be read.
 */
function fakeRunner(
  answer: (cmd: readonly string[]) => { stdout?: string; exitCode?: number; stderr?: string },
  opts: { miseVersion?: string | null } = {},
): {
  calls: Call[];
  runner: Runner;
} {
  const calls: Call[] = [];
  const runner: Runner = (cmd, opts2) => {
    calls.push({ cmd: [...cmd], cwd: opts2?.cwd });
    if (cmd[0] === "mise" && cmd[1] === "--version") {
      if (opts.miseVersion === null) return { stdout: "mise: cannot read the version\n", exitCode: 1, stderr: "" };
      return { stdout: `${opts.miseVersion ?? MISE_VERSION} linux-x64\n`, exitCode: 0, stderr: "" };
    }
    const { stdout = "", exitCode = 0, stderr } = answer(cmd);
    return stderr === undefined ? { stdout, exitCode } : { stdout, exitCode, stderr };
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
    // The openrouter key file exists; the optional DeepInfra key file does
    // not, so DeepInfra stays off unless a test turns it on.
    keyExists: (file) => !file.endsWith("deepinfra.key"),
    isPortFree: () => true,
    probe: async () => ({ state: "down" }),
    spawnServe: () => ({ pid: 4242, exitCode: () => null }),
    // Never a real watchdog in a unit test.
    spawnIdleWatch: () => ({ pid: 4243, exitCode: () => null }),
    // Never the real user manager in a unit test.
    units: noUnits(),
    projectName: () => "test",
    rootOf: () => "/repo",
    binExists: () => true,
    fileExists: () => true,
    checkKvm: () => ({ name: "kvm-access", status: "pass", message: "ok" }),
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

  test("a host git worktree of the project resolves to the sandbox server", async () => {
    const env = makeEnv();
    await writeState(env, "repo", 18786);
    // The fake git common dir maps the host worktree <repo>/.claude/worktrees/x
    // to the project root, and the project name follows the root.
    const worktree = "/repo/.claude/worktrees/x";
    const commonDirOf = (dir: string) => (dir === worktree || dir === "/repo" ? "/repo/.git" : null);
    const projectName = (directory: string) => projectNameOf(projectRootOfRun(directory, () => true, commonDirOf));
    expect(resolveCommandUrl(undefined, env, worktree, projectName)).toBe("http://127.0.0.1:18786");
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
      (() => spawnResult(0, "/home/user/src/proj/.git\n")) as unknown as typeof Bun.spawnSync,
    );
    try {
      expect(projectRoot("/home/user/src/proj/.worktrees/step")).toBe("/home/user/src/proj");
    } finally {
      spy.mockRestore();
    }
  });

  test("is the directory itself without git", () => {
    const spy = spyOn(Bun, "spawnSync").mockImplementation(
      (() => spawnResult(128, "")) as unknown as typeof Bun.spawnSync,
    );
    try {
      expect(projectRoot("/home/user/src/other/repo-x")).toBe("/home/user/src/other/repo-x");
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
    expect(miseInstallsDir({ XDG_DATA_HOME: "/home/user/.local/data" })).toBe("/home/user/.local/data/mise/installs");
  });

  test("miseInstallsDir falls back to ~/.local/share/mise", () => {
    expect(miseInstallsDir({ HOME: "/home/user" })).toBe("/home/user/.local/share/mise/installs");
  });

  test("projectToolPath keeps only the entries inside the installs folder, in order", () => {
    const json = JSON.stringify({
      PATH: "/home/user/.local/bin:/home/user/.local/share/mise/installs/bun/1.4.2/bin:/usr/local/bin:/home/user/.local/share/mise/installs/node/22/bin:/home/user/.local/share/mise/installs2/x/bin:/usr/bin",
    });
    expect(projectToolPath(json, "/home/user/.local/share/mise/installs")).toBe(
      "/home/user/.local/share/mise/installs/bun/1.4.2/bin:/home/user/.local/share/mise/installs/node/22/bin",
    );
  });

  test("projectToolPath returns the empty string for no JSON and no PATH string", () => {
    expect(projectToolPath("not json", "/installs")).toBe("");
    expect(projectToolPath("{}", "/installs")).toBe("");
    expect(projectToolPath('{"PATH":"x"}', "/installs")).toBe("");
    expect(projectToolPath('{"PATH":["/installs/a"]}', "/installs")).toBe("");
  });

  test("parseMiseVersion takes the first version-looking token", () => {
    expect(parseMiseVersion("2026.10.1 linux-x64\n")).toBe("2026.10.1");
    expect(parseMiseVersion("2026.10.1 linux-x64 (2026-09-28)\n")).toBe("2026.10.1");
    expect(parseMiseVersion("v2026.10.1\n")).toBe("2026.10.1");
    expect(parseMiseVersion("")).toBe(null);
    expect(parseMiseVersion("warning: something failed\n")).toBe(null);
    expect(parseMiseVersion("\n")).toBe(null);
  });

  test("parseBinPaths takes the first non-empty line", () => {
    expect(parseBinPaths("/installs/aqua-jdx-mise/2026.10.1/mise/bin\n")).toBe(
      "/installs/aqua-jdx-mise/2026.10.1/mise/bin",
    );
    expect(parseBinPaths("\n/other/bin\n/third/bin\n")).toBe("/other/bin");
    expect(parseBinPaths("")).toBe(null);
    expect(parseBinPaths("\n  \n")).toBe(null);
  });

  test("sandboxMiseEnv lists the six mise settings of the server", () => {
    expect(sandboxMiseEnv("/installs", "/repo")).toEqual([
      "MISE_SHARED_INSTALL_DIRS=/installs",
      "MISE_TRUSTED_CONFIG_PATHS=/repo",
      `MISE_DATA_DIR=${SANDBOX_HOME}/.local/share/mise`,
      `MISE_CACHE_DIR=${SANDBOX_HOME}/.cache/mise`,
      `MISE_STATE_DIR=${SANDBOX_HOME}/.local/state/mise`,
      "MISE_DISABLE_UPDATE_WARNING=true",
    ]);
  });

  test("sandboxToolPathEntry puts the project tools first, the mise bin second, and the sandbox PATH last", () => {
    expect(sandboxToolPathEntry("/installs/bun/1.4.2/bin")).toBe(`PATH=/installs/bun/1.4.2/bin:${SANDBOX_PATH}`);
    expect(sandboxToolPathEntry("/installs/bun/1.4.2/bin", "/installs/mise/2026.10.1/bin")).toBe(
      `PATH=/installs/bun/1.4.2/bin:/installs/mise/2026.10.1/bin:${SANDBOX_PATH}`,
    );
    expect(sandboxToolPathEntry("", "/installs/mise/2026.10.1/bin")).toBe(
      `PATH=/installs/mise/2026.10.1/bin:${SANDBOX_PATH}`,
    );
    expect(sandboxToolPathEntry("")).toBe(`PATH=${SANDBOX_PATH}`);
  });

  test("sandboxMiseBinDir returns the bin folder of the host mise version inside the installs folder", () => {
    const calls: string[][] = [];
    const runner: Runner = (cmd) => {
      calls.push([...cmd]);
      if (cmd[1] === "--version") return { stdout: "2026.10.1 linux-x64\n", exitCode: 0 };
      if (cmd[1] === "bin-paths")
        return { stdout: "/home/user/.local/share/mise/installs/aqua-jdx-mise/2026.10.1/mise/bin\n", exitCode: 0 };
      return { stdout: "", exitCode: 0 };
    };
    const env = { HOME: "/home/user" } as never;
    expect(sandboxMiseBinDir(runner, env, "/repo")).toBe("/home/user/.local/share/mise/installs/aqua-jdx-mise/2026.10.1/mise/bin");
    // It installs the exact host version into the shared installs folder.
    expect(calls.map((c) => c.join(" "))).toContain(`mise install ${MISE_TOOL}@2026.10.1`);
  });

  test("sandboxMiseBinDir warns and returns undefined without a version", () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      const runner: Runner = () => ({ stdout: "", exitCode: 0 });
      expect(sandboxMiseBinDir(runner, { HOME: "/home/user" } as never, "/repo")).toBeUndefined();
      expect(err.mock.calls.join("\n")).toContain("the sandbox gets no mise");
    } finally {
      err.mockRestore();
    }
  });

  test("sandboxMiseBinDir warns and returns undefined when the bin folder lies outside the installs folder", () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      const runner: Runner = (cmd) => {
        if (cmd[1] === "--version") return { stdout: "2026.10.1 linux-x64\n", exitCode: 0 };
        if (cmd[1] === "bin-paths") return { stdout: "/opt/other-mise/bin\n", exitCode: 0 };
        return { stdout: "", exitCode: 0 };
      };
      expect(sandboxMiseBinDir(runner, { HOME: "/home/user" } as never, "/repo")).toBeUndefined();
      expect(err.mock.calls.join("\n")).toContain("lies outside the installs folder");
    } finally {
      err.mockRestore();
    }
  });

  test("deniesNetwork reads the first line of the policy check", () => {
    expect(deniesNetwork("Denied: host.docker.internal:8767\n")).toBe(true);
    expect(deniesNetwork("Allowed: host.docker.internal:8767\n")).toBe(false);
    expect(deniesNetwork("")).toBe(false);
  });

  test("listsMounts needs the sandbox name and every mount on one line", () => {
    const out = "NAME   STATUS   WORKSPACE\noc-sub-t   running   /repo, /home/user/p/opencode:ro, /home/user/.local/share/mise/installs:ro\n";
    expect(listsMounts(out, "oc-sub-t", ["/home/user/p/opencode:ro", "/home/user/.local/share/mise/installs:ro"])).toBe(true);
    expect(listsMounts(out, "oc-sub-t", ["/home/user/p/opencode:ro"])).toBe(true);
    expect(listsMounts(out, "oc-sub-t", ["/home/user/p/opencode:ro", "/other:ro"])).toBe(false);
    expect(listsMounts(out, "other", ["/home/user/p/opencode:ro"])).toBe(false);
  });

  test("listsCloneRemote matches the sandbox-<name> remote as a whole line", () => {
    expect(listsCloneRemote("origin\nsandbox-oc-sub-t\n", "oc-sub-t")).toBe(true);
    expect(listsCloneRemote("sandbox-oc-sub-t-2\n", "oc-sub-t")).toBe(false);
    expect(listsCloneRemote("", "oc-sub-t")).toBe(false);
  });

  test("sandboxRecreateFix names doctor --fix --force first and sbx rm as the fallback", () => {
    const fix = sandboxRecreateFix("oc-sub-t");
    expect(fix).toContain("idfx doctor --fix --force");
    expect(fix).toContain("clone mode");
    // The manual commands stay as the fallback in the same text.
    expect(fix).toContain("sbx rm --force oc-sub-t");
    expect(fix).toContain("idfx up");
  });
});

describe("sandboxMountPlan", () => {
  const PLUGIN = "/home/user/src/idfix/opencode";
  const INSTALLS = "/home/user/.local/share/mise/installs";
  const SHARED = "/home/user/src/meta/agents";

  test("isInsideRoot is true for the root itself and for folders inside it", () => {
    expect(isInsideRoot("/r", "/r")).toBe(true);
    expect(isInsideRoot("/r/", "/r")).toBe(true);
    expect(isInsideRoot("/r/sub", "/r")).toBe(true);
    expect(isInsideRoot("/r/a/b", "/r/")).toBe(true);
    // A folder whose name starts with two dots is still inside.
    expect(isInsideRoot("/r/..hidden", "/r")).toBe(true);
  });

  test("isInsideRoot is false for siblings, parents, and name prefixes", () => {
    expect(isInsideRoot("/r2", "/r")).toBe(false);
    expect(isInsideRoot("/r-other/sub", "/r")).toBe(false);
    expect(isInsideRoot("/", "/r")).toBe(false);
    expect(isInsideRoot("/other", "/r")).toBe(false);
  });

  test("mounts every folder outside the root, in order", () => {
    expect(sandboxMountPlan("/home/user/src/proj", PLUGIN, INSTALLS, SHARED)).toEqual({
      mounted: [PLUGIN, INSTALLS, SHARED],
      inClone: [],
    });
  });

  test("leaves out the plugin folder when the project is the plugin itself", () => {
    expect(sandboxMountPlan("/home/user/src/idfix", PLUGIN, INSTALLS, SHARED)).toEqual({
      mounted: [INSTALLS, SHARED],
      inClone: [PLUGIN],
    });
  });

  test("leaves out the shared agents folder for the project meta", () => {
    expect(sandboxMountPlan("/home/user/src/meta", PLUGIN, INSTALLS, SHARED)).toEqual({
      mounted: [PLUGIN, INSTALLS],
      inClone: [SHARED],
    });
  });

  test("leaves out a folder equal to the root", () => {
    expect(sandboxMountPlan(SHARED, PLUGIN, INSTALLS, SHARED).inClone).toEqual([SHARED]);
  });

  test("requiredSandboxMounts is the mounted part of the plan with :ro", () => {
    expect(requiredSandboxMounts("/home/user/src/proj", PLUGIN, INSTALLS, SHARED)).toEqual([
      `${PLUGIN}:ro`,
      `${INSTALLS}:ro`,
      `${SHARED}:ro`,
    ]);
    expect(requiredSandboxMounts("/home/user/src/meta", PLUGIN, INSTALLS, SHARED)).toEqual([
      `${PLUGIN}:ro`,
      `${INSTALLS}:ro`,
    ]);
  });
});

describe("clone check", () => {
  test("cloneCheckCommand runs git rev-parse --git-dir at the root inside the sandbox", () => {
    expect(cloneCheckCommand("sbx", "oc-sub-t", "/r")).toEqual([
      "sbx", "exec", "oc-sub-t", "git", "-C", "/r", "rev-parse", "--git-dir",
    ]);
  });

  test("hasClone follows the exit code of the check", () => {
    const calls: string[][] = [];
    const ok: Runner = (cmd) => {
      calls.push([...cmd]);
      return { stdout: ".git\n", exitCode: 0 };
    };
    expect(hasClone(ok, "sbx", "oc-sub-t", "/r")).toBe(true);
    expect(calls).toEqual([cloneCheckCommand("sbx", "oc-sub-t", "/r")]);
    expect(hasClone(() => ({ stdout: "", exitCode: 128 }), "sbx", "oc-sub-t", "/r")).toBe(false);
  });

  test("missingCloneMessage names the sandbox, the root, and the failed command", () => {
    const text = missingCloneMessage("oc-sub-t", "/r");
    expect(text).toContain("oc-sub-t");
    expect(text).toContain("no git clone at /r");
    expect(text).toContain("git -C /r rev-parse --git-dir");
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
  const SHARED = "/srv/agents";

  test("is JSON with exactly the sandbox agents, each with bash allow and external_directory allow", () => {
    const parsed = JSON.parse(sandboxConfigContent(SHARED)) as {
      agent: Record<string, { permission: { bash: string; external_directory: string } }>;
    };
    expect(Object.keys(parsed.agent).sort()).toEqual([...SANDBOX_BASH_AGENTS].sort());
    for (const agent of SANDBOX_BASH_AGENTS) {
      expect(parsed.agent[agent]).toEqual({ permission: { bash: "allow", external_directory: "allow" } });
    }
  });

  test("turns the MCP gateway of the sbx kit off", () => {
    const parsed = JSON.parse(sandboxConfigContent(SHARED)) as { mcp: Record<string, { enabled: boolean }> };
    expect(parsed.mcp["mcp-gateway"]).toEqual({ enabled: false });
  });

  test("loads the shared rules and skills through absolute paths", () => {
    const parsed = JSON.parse(sandboxConfigContent(SHARED)) as {
      instructions: string[];
      skills: { paths: string[] };
    };
    expect(parsed.instructions).toEqual(["/srv/agents/AGENTS.md"]);
    expect(parsed.skills).toEqual({ paths: ["/srv/agents/skills"] });
  });

  test("the holder command names both -e options before the sandbox name", async () => {
    const env = makeEnv();
    const { runner } = fakeRunner((cmd) => {
      if (isSubcommand(cmd, "ls")) return { stdout: lsWorkspace("oc-sub-test", env) };
      if (isSubcommand(cmd, "secret") && cmd[2] === "ls") return { stdout: "SCOPE     TYPE      NAME         SECRET\noc-sub-test   service   openrouter   (stored)\n" };
      if (isSubcommand(cmd, "ports")) return { stdout: "HOST IP     HOST PORT   SANDBOX PORT   PROTOCOL\n127.0.0.1   18768       4096           tcp4\n" };
      if (cmd[0] === "git") return GIT_REMOTE;
      return DENIED;
    });
    const holderCommands: string[][] = [];
    // The first probe finds no server, so up starts the holder.
    let probes = 0;
    const result = await upSandbox({}, env, makeDeps({
      runner,
      probe: async () => (probes++ === 0 ? { state: "down" } : { state: "up", version: "1.18.32" }),
      spawnServe: ({ cmd }) => {
        holderCommands.push([...cmd]);
        return { pid: 4242, exitCode: () => null };
      },
    }));
    expect(result).toBe(0);
    expect(holderCommands).toHaveLength(1);
    const cmd = holderCommands[0] ?? [];
    const nameIndex = cmd.indexOf("oc-sub-test");
    const contentFlag = cmd.indexOf(
      `OPENCODE_CONFIG_CONTENT=${sandboxConfigContent(sharedDirOf(env), proxyBaseUrl(SANDBOX_PROXY_PORT))}`,
    );
    const sshFlag = cmd.indexOf("SSH_AUTH_SOCK=");
    expect(sshFlag).toBe(contentFlag + 2);
    expect(contentFlag).toBeLessThan(nameIndex);
    expect(sshFlag).toBeLessThan(nameIndex);
  });

  test("starts the idle watchdog after the healthy start of the holder", async () => {
    const env = makeEnv();
    const { runner } = fakeRunner((cmd) => {
      if (isSubcommand(cmd, "ls")) return { stdout: lsWorkspace("oc-sub-test", env) };
      if (isSubcommand(cmd, "secret") && cmd[2] === "ls") return { stdout: "SCOPE     TYPE      NAME         SECRET\noc-sub-test   service   openrouter   (stored)\n" };
      if (isSubcommand(cmd, "ports")) return { stdout: "HOST IP     HOST PORT   SANDBOX PORT   PROTOCOL\n127.0.0.1   18768       4096           tcp4\n" };
      if (cmd[0] === "git") return GIT_REMOTE;
      return DENIED;
    });
    const spawned: string[][] = [];
    let probes = 0;
    const result = await upSandbox({ idleMinutes: 7 }, env, makeDeps({
      runner,
      probe: async () => (probes++ === 0 ? { state: "down" } : { state: "up", version: "1.18.32" }),
      spawnIdleWatch: ({ cmd, pidPath }) => {
        spawned.push([...cmd, pidPath]);
        return { pid: 4243, exitCode: () => null };
      },
    }));
    expect(result).toBe(0);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.slice(2)).toEqual(["idle-watch", "--port", "18768", "--minutes", "7", idlePidPath(env, 18768)]);
  });

  test("starts the holder as the unit ocsub-holder-<port> after a stop of a stale one", async () => {
    const env = makeEnv();
    const { runner } = fakeRunner((cmd) => {
      if (isSubcommand(cmd, "ls")) return { stdout: lsWorkspace("oc-sub-test", env) };
      if (isSubcommand(cmd, "secret") && cmd[2] === "ls") return { stdout: "SCOPE     TYPE      NAME         SECRET\noc-sub-test   service   openrouter   (stored)\n" };
      if (isSubcommand(cmd, "ports")) return { stdout: "HOST IP     HOST PORT   SANDBOX PORT   PROTOCOL\n127.0.0.1   18768       4096           tcp4\n" };
      if (cmd[0] === "git") return GIT_REMOTE;
      return DENIED;
    });
    const units = fakeUnits({ loaded: ["ocsub-holder-18768", "ocsub-idle-18768"] });
    const started: UnitOptions[] = [];
    const record = (opts: UnitOptions) => {
      started.push(opts);
      units.calls.push(`start ${opts.kind}`);
      return { pid: 4242, exitCode: () => null };
    };
    let probes = 0;
    const result = await upSandbox({}, env, makeDeps({
      runner,
      units: units.deps,
      probe: async () => (probes++ === 0 ? { state: "down" } : { state: "up", version: "1.18.32" }),
      spawnServe: record,
      spawnIdleWatch: record,
    }));
    expect(result).toBe(0);
    expect(units.calls).toEqual(["stop ocsub-holder-18768", "stop ocsub-idle-18768", "start holder", "start idle"]);
    expect(started.map((opts) => [opts.kind, opts.name, opts.owner, opts.reason])).toEqual([
      ["holder", "18768", "test", "sandbox oc-sub-test: opencode server of up on port 18768"],
      ["idle", "18768", "test", "idle watchdog for port 18768, stops the server after 30m without activity"],
    ]);
    expect(started[0]?.cmd.slice(0, 2)).toEqual(["sbx", "exec"]);
    expect(started[0]?.logPath).toBe(serveLogPath(env, 18768));
    expect(started[0]?.pidPath).toBe(servePidPath(env, 18768));
  });

  test("OC_SUB_OWNER overrides the owner of the holder and the watchdog units", async () => {
    const env = { ...makeEnv(), OC_SUB_OWNER: "session-7" };
    const { runner } = fakeRunner((cmd) => {
      if (isSubcommand(cmd, "ls")) return { stdout: lsWorkspace("oc-sub-test", env) };
      if (isSubcommand(cmd, "secret") && cmd[2] === "ls") return { stdout: "SCOPE     TYPE      NAME         SECRET\noc-sub-test   service   openrouter   (stored)\n" };
      if (isSubcommand(cmd, "ports")) return { stdout: "HOST IP     HOST PORT   SANDBOX PORT   PROTOCOL\n127.0.0.1   18768       4096           tcp4\n" };
      if (cmd[0] === "git") return GIT_REMOTE;
      return DENIED;
    });
    const units = fakeUnits({ loaded: ["ocsub-holder-18768", "ocsub-idle-18768"] });
    const started: UnitOptions[] = [];
    const record = (opts: UnitOptions) => {
      started.push(opts);
      units.calls.push(`start ${opts.kind}`);
      return { pid: 4242, exitCode: () => null };
    };
    let probes = 0;
    const result = await upSandbox({}, env, makeDeps({
      runner,
      units: units.deps,
      probe: async () => (probes++ === 0 ? { state: "down" } : { state: "up", version: "1.18.32" }),
      spawnServe: record,
      spawnIdleWatch: record,
    }));
    expect(result).toBe(0);
    expect(started.map((opts) => [opts.kind, opts.owner])).toEqual([
      ["holder", "session-7"],
      ["idle", "session-7"],
    ]);
  });

  test("a set host OPENCODE_CONFIG_CONTENT gives a warning on stderr", async () => {
    const env = { ...makeEnv(), OPENCODE_CONFIG_CONTENT: '{"agent":{}}' };
    const { runner } = fakeRunner((cmd) => {
      if (isSubcommand(cmd, "ls")) return { stdout: lsWorkspace("oc-sub-test", env) };
      if (isSubcommand(cmd, "secret") && cmd[2] === "ls") return { stdout: "SCOPE     TYPE      NAME         SECRET\noc-sub-test   service   openrouter   (stored)\n" };
      if (isSubcommand(cmd, "ports")) return { stdout: "HOST IP     HOST PORT   SANDBOX PORT   PROTOCOL\n127.0.0.1   18768       4096           tcp4\n" };
      if (cmd[0] === "git") return GIT_REMOTE;
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

describe("cost proxy wiring (sandbox mode)", () => {
  test("proxyBaseUrl points at loopback and /v1", () => {
    expect(proxyBaseUrl(4097)).toBe("http://127.0.0.1:4097/v1");
  });

  test("sandboxConfigContent adds the openrouter baseURL only with a proxy URL", () => {
    const without = JSON.parse(sandboxConfigContent("/srv/agents")) as Record<string, unknown>;
    expect(without.provider).toBeUndefined();
    const withProxy = JSON.parse(sandboxConfigContent("/srv/agents", proxyBaseUrl(SANDBOX_PROXY_PORT))) as {
      provider: { openrouter: { options: { baseURL: string } } };
    };
    expect(withProxy.provider.openrouter.options.baseURL).toBe("http://127.0.0.1:4097/v1");
  });

  test("proxyLoopScript runs the bundle in a restart loop with quoted arguments", () => {
    const script = proxyLoopScript("/installs/bun/1.4.2/bin/bun", "/srv/agents/cost-proxy/cost-proxy.js", 4097, "127.0.0.1");
    expect(script).toBe(
      `while :; do '/installs/bun/1.4.2/bin/bun' '/srv/agents/cost-proxy/cost-proxy.js' --port 4097 --hostname '127.0.0.1' ; sleep 1; done`,
    );
  });

  test("proxyLoopScript quotes shell metacharacters in every argument", () => {
    const script = proxyLoopScript("/a b'c/d", "/e'f", 4097, "127.0.0.1");
    expect(script).toContain(`'/a b'\\''c/d'`);
    expect(script).toContain(`'/e'\\''f'`);
    // A quote can never close early: every `'` inside an argument is escaped.
    expect(script.startsWith("while :; do '/a b")).toBe(true);
  });

  test("sandboxHolderScript runs the proxy loop in the background and execs the server in the front", () => {
    const script = sandboxHolderScript("/bun", "/proxy.js", 4097, 4096);
    expect(script).toBe(
      `while :; do '/bun' '/proxy.js' --port 4097 --hostname '127.0.0.1' ; sleep 1; done & exec opencode serve --hostname 0.0.0.0 --port 4096`,
    );
  });

  test("bunBinFromToolPath picks the bun entry of the project tool PATH", () => {
    const installs = "/home/user/.local/share/mise/installs";
    const toolPath = `${installs}/node/22/bin:${installs}/bun/1.4.2/bin:/usr/local/bin`;
    expect(bunBinFromToolPath(toolPath, installs)).toBe(`${installs}/bun/1.4.2/bin/bun`);
    expect(bunBinFromToolPath(`${installs}/bun/1.4.2/bin`, installs)).toBe(`${installs}/bun/1.4.2/bin/bun`);
  });

  test("bunBinFromToolPath returns null without a bun entry or outside the installs folder", () => {
    const installs = "/home/user/.local/share/mise/installs";
    expect(bunBinFromToolPath("/usr/local/bin", installs)).toBeNull();
    expect(bunBinFromToolPath("", installs)).toBeNull();
    expect(bunBinFromToolPath("/other/installs/bun/1.0.0/bin", installs)).toBeNull();
    expect(bunBinFromToolPath(`${installs}/bun/1.4.2/bin/bun`, installs)).toBeNull();
  });

  test("bunBinFromInstalls finds the newest installed bun as a fallback", () => {
    const installs = path.join(tempDir(), "installs");
    mkdirSync(path.join(installs, "bun", "1.4.2", "bin"), { recursive: true });
    writeFileSync(path.join(installs, "bun", "1.4.2", "bin", "bun"), "");
    mkdirSync(path.join(installs, "bun", "1.5.0", "bin"), { recursive: true });
    writeFileSync(path.join(installs, "bun", "1.5.0", "bin", "bun"), "");
    expect(bunBinFromInstalls(installs)).toBe(path.join(installs, "bun", "1.5.0", "bin", "bun"));
  });

  test("bunBinFromInstalls returns null without an installs folder or without bun", () => {
    expect(bunBinFromInstalls(path.join(tempDir(), "missing"))).toBeNull();
    const installs = tempDir();
    mkdirSync(path.join(installs, "bun", "1.4.2"), { recursive: true });
    expect(bunBinFromInstalls(installs)).toBeNull();
  });

  test("up runs the holder as sh -c with the loop, the bundle, and the bun of the installs folder", async () => {
    const env = makeEnv();
    const { runner } = fakeRunner((cmd) => {
      if (isSubcommand(cmd, "ls")) return { stdout: lsWorkspace("oc-sub-test", env) };
      if (isSubcommand(cmd, "secret") && cmd[2] === "ls") return { stdout: "SCOPE     TYPE      NAME         SECRET\noc-sub-test   service   openrouter   (stored)\n" };
      if (isSubcommand(cmd, "ports")) return { stdout: "HOST IP     HOST PORT   SANDBOX PORT   PROTOCOL\n127.0.0.1   18768       4096           tcp4\n" };
      if (cmd[0] === "git") return GIT_REMOTE;
      return DENIED;
    });
    // The project has no bun in its mise.toml (empty PATH from mise env), so
    // the bun comes from the shared installs folder.
    const holderCommands: string[][] = [];
    let probes = 0;
    const result = await upSandbox({}, env, makeDeps({
      runner,
      probe: async () => (probes++ === 0 ? { state: "down" } : { state: "up", version: "1.18.32" }),
      spawnServe: ({ cmd }) => {
        holderCommands.push([...cmd]);
        return { pid: 4242, exitCode: () => null };
      },
    }));
    expect(result).toBe(0);
    const cmd = holderCommands[0] ?? [];
    const shIndex = cmd.indexOf("sh");
    expect(cmd.slice(shIndex, shIndex + 2)).toEqual(["sh", "-c"]);
    expect(cmd[shIndex + 2]).toBe(sandboxHolderScript(bunBinOf(env), bundlePath(env), SANDBOX_PROXY_PORT, 4096));
  });

  test("--no-cost-proxy keeps the plain serve holder and no baseURL", async () => {
    const env = makeEnv();
    const { runner } = fakeRunner((cmd) => {
      if (isSubcommand(cmd, "ls")) return { stdout: lsWorkspace("oc-sub-test", env) };
      if (isSubcommand(cmd, "secret") && cmd[2] === "ls") return { stdout: "SCOPE     TYPE      NAME         SECRET\noc-sub-test   service   openrouter   (stored)\n" };
      if (isSubcommand(cmd, "ports")) return { stdout: "HOST IP     HOST PORT   SANDBOX PORT   PROTOCOL\n127.0.0.1   18768       4096           tcp4\n" };
      if (cmd[0] === "git") return GIT_REMOTE;
      return DENIED;
    });
    const holderCommands: string[][] = [];
    let probes = 0;
    const result = await upSandbox({ noCostProxy: true }, env, makeDeps({
      runner,
      probe: async () => (probes++ === 0 ? { state: "down" } : { state: "up", version: "1.18.32" }),
      spawnServe: ({ cmd }) => {
        holderCommands.push([...cmd]);
        return { pid: 4242, exitCode: () => null };
      },
    }));
    expect(result).toBe(0);
    const cmd = holderCommands[0] ?? [];
    expect(cmd.slice(-6)).toEqual(["opencode", "serve", "--hostname", "0.0.0.0", "--port", "4096"]);
    expect(cmd).not.toContain("sh");
    const contentFlag = cmd.find((arg) => arg.startsWith("OPENCODE_CONFIG_CONTENT=")) ?? "";
    expect(JSON.parse(contentFlag.slice("OPENCODE_CONFIG_CONTENT=".length))).not.toHaveProperty("provider");
  });

  test("without any bun in the installs folder, up stops and names --no-cost-proxy", async () => {
    // A plain env without the fake bun of makeEnv.
    const env = { XDG_STATE_HOME: tempDir(), XDG_CONFIG_HOME: tempDir(), HOME: tempDir(), OC_SUB_SHARED_DIR: tempDir() };
    const { calls, runner } = fakeRunner((cmd) => {
      if (isSubcommand(cmd, "ls")) return { stdout: lsWorkspace("oc-sub-test", env) };
      if (isSubcommand(cmd, "secret") && cmd[2] === "ls") return { stdout: "SCOPE     TYPE      NAME         SECRET\noc-sub-test   service   openrouter   (stored)\n" };
      if (cmd[0] === "git") return GIT_REMOTE;
      return DENIED;
    });
    const errors: string[] = [];
    const err = console.error;
    console.error = (line: string) => errors.push(line);
    let result: number;
    try {
      result = await upSandbox({}, env, makeDeps({ runner, spawnServe: () => { throw new Error("no server may start"); } }));
    } finally {
      console.error = err;
    }
    expect(result).toBe(1);
    expect(errors.join("\n")).toContain("no bun in the mise installs folder");
    expect(errors.join("\n")).toContain("--no-cost-proxy");
    // The bun check runs right after `mise env`, before any sandbox call.
    expect(subcommands(calls)).toEqual(["mise", "mise", "mise", "mise", "mise"]);
  });
});

describe("upSandbox", () => {
  const PORTS_HEADER = "HOST IP     HOST PORT   SANDBOX PORT   PROTOCOL\n";

  for (const [label, shared] of [["unset", undefined], ["blank", ""]] as const) {
    test(`stops before any call when OC_SUB_SHARED_DIR is ${label}`, async () => {
      const { calls, runner } = fakeRunner(() => ({ stdout: "" }));
      const env: Record<string, string> = { ...makeEnv() };
      delete env.OC_SUB_SHARED_DIR;
      if (shared !== undefined) env.OC_SUB_SHARED_DIR = shared;
      const errors: string[] = [];
      const err = console.error;
      console.error = (line: string) => errors.push(line);
      let result: number;
      try {
        result = await upSandbox({}, env, makeDeps({ runner, fileExists: () => true }));
      } finally {
        console.error = err;
      }
      expect(result).toBe(1);
      expect(calls).toHaveLength(0);
      expect(errors).toEqual([
        "error: OC_SUB_SHARED_DIR is not set.",
        "Set OC_SUB_SHARED_DIR to the folder that holds AGENTS.md (your global rules) and skills/<name>/SKILL.md (your skills).",
      ]);
    });
  }

  test("a missing shared AGENTS.md stops up before any call", async () => {
    const { calls, runner } = fakeRunner(() => ({ stdout: "" }));
    const errors: string[] = [];
    const err = console.error;
    console.error = (line: string) => errors.push(line);
    let result: number;
    try {
      result = await upSandbox({}, makeEnv(), makeDeps({ runner, fileExists: () => false }));
    } finally {
      console.error = err;
    }
    expect(result).toBe(1);
    expect(calls).toHaveLength(0);
    const text = errors.join("\n");
    expect(text).toContain("AGENTS.md");
    expect(text).toContain("OC_SUB_SHARED_DIR");
  });

  test("an existing sandbox without the shared mount stops up with a hint", async () => {
    const env = makeEnv();
    const { calls, runner } = fakeRunner((cmd) => {
      if (isSubcommand(cmd, "ls")) {
        return {
          stdout: `NAME     STATUS     WORKSPACE\noc-sub-test   running   /repo, ${pluginMount(env)}, ${installsMount(env)}\n`,
        };
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
    expect(errors.join("\n")).toContain(`sbx rm --force oc-sub-test`);
    expect(subcommands(calls)).toEqual(["mise", "mise", "mise", "mise", "mise", "ls"]);
  });

  test("a failed readability check of the shared rules stops up before the server starts", async () => {
    const env = makeEnv();
    const { calls, runner } = fakeRunner((cmd) => {
      if (isSubcommand(cmd, "ls")) return { stdout: lsWorkspace("oc-sub-test", env) };
      if (isSubcommand(cmd, "secret")) return { stdout: "oc-sub-test   service   openrouter   (stored)\n" };
      if (cmd[0] === "git") return GIT_REMOTE;
      // The clone check and the placeholder write succeed, the readability
      // check (`test -r`) fails.
      if (isSubcommand(cmd, "exec")) return { stdout: "", exitCode: cmd[3] === "test" ? 1 : 0 };
      if (isSubcommand(cmd, "ports")) return { stdout: `${PORTS_HEADER}127.0.0.1   18768       4096           tcp4\n` };
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
    expect(errors.join("\n")).toContain("cannot read the shared agents file");
    expect(subcommands(calls).at(-1)).toBe("exec");
  });

  test("a publish that fails is fine when a second list shows the port", async () => {
    const env = makeEnv();
    let lists = 0;
    const { calls, runner } = fakeRunner((cmd) => {
      if (isSubcommand(cmd, "ls")) return { stdout: lsWorkspace("oc-sub-test", env) };
      if (isSubcommand(cmd, "secret")) return { stdout: "oc-sub-test   service   openrouter   (stored)\n" };
      if (isSubcommand(cmd, "ports") && cmd.includes("--publish")) return { stdout: "", exitCode: 1 };
      if (cmd[0] === "git") return GIT_REMOTE;
      if (isSubcommand(cmd, "ports")) {
        lists += 1;
        return { stdout: lists === 1 ? PORTS_HEADER : `${PORTS_HEADER}127.0.0.1   18768       4096           tcp4\n` };
      }
      return DENIED;
    });
    const result = await upSandbox({}, env, makeDeps({ runner, probe: async () => ({ state: "up", version: "1.18.32" }) }));
    expect(result).toBe(0);
    expect(subcommands(calls)).toEqual(["mise", "mise", "mise", "mise", "mise", "ls", "exec", "git", "secret", "exec", "ports", "ports", "ports", "policy", "policy", "exec"]);
  });

  test("a publish that fails without the port in a second list is an error", async () => {
    const env = makeEnv();
    const { runner } = fakeRunner((cmd) => {
      if (isSubcommand(cmd, "ls")) return { stdout: lsWorkspace("oc-sub-test", env) };
      if (isSubcommand(cmd, "secret")) return { stdout: "oc-sub-test   service   openrouter   (stored)\n" };
      if (isSubcommand(cmd, "ports") && cmd.includes("--publish")) return { stdout: "", exitCode: 1 };
      if (cmd[0] === "git") return GIT_REMOTE;
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
      if (cmd[0] === "git") return GIT_REMOTE;
      // Only the placeholder write (`sh -c ...`) fails, the clone check passes.
      if (isSubcommand(cmd, "exec")) return { stdout: "", exitCode: cmd[3] === "sh" ? 1 : 0 };
      return DENIED;
    });
    const result = await upSandbox({}, env, makeDeps({ runner }));
    expect(result).toBe(1);
    expect(subcommands(calls)).toEqual(["mise", "mise", "mise", "mise", "mise", "ls", "exec", "git", "secret", "exec"]);
  });

  test("refuses without the project key file and calls no sbx", async () => {
    const { calls, runner } = fakeRunner(() => ({ stdout: "" }));
    const result = await upSandbox({}, makeEnv(), makeDeps({ runner, keyExists: () => false }));
    expect(result).toBe(1);
    expect(calls).toHaveLength(0);
  });

  test("a missing sbx binary stops up with the host alternative", async () => {
    const { calls, runner } = fakeRunner(() => ({ stdout: "" }));
    const env = makeEnv();
    const errors: string[] = [];
    const err = console.error;
    console.error = (line: string) => errors.push(line);
    let result: number;
    try {
      result = await upSandbox({}, { ...env, SBX_BIN: "/nowhere/sbx" }, makeDeps({ runner, binExists: () => false }));
    } finally {
      console.error = err;
    }
    expect(result).toBe(1);
    expect(calls).toHaveLength(0);
    expect(errors.join("\n")).toContain("/nowhere/sbx");
    expect(errors.join("\n")).toContain("idfx up --no-sandbox");
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
      // `mise bin-paths aqua:jdx/mise@<version>`: the bin folder of the
      // installed mise, inside the installs folder.
      if (cmd[0] === "mise" && cmd[1] === "bin-paths") {
        return { stdout: `${miseInstallsDir(env)}/aqua-jdx-mise/${MISE_VERSION}/mise/bin\n` };
      }
      if (isSubcommand(cmd, "policy") && cmd[2] === "check") return DENIED;
      if (cmd[0] === "git") return GIT_REMOTE;
      return { stdout: "", exitCode: 0 };
    });
    const execCommands: string[][] = [];
    const result = await upSandbox({}, env, makeDeps({
      runner,
      spawnServe: ({ cmd }) => {
        execCommands.push([...cmd]);
        return { pid: 4242, exitCode: () => 1 };
      },
    }));
    // The fake holder exits immediately, so up reports the failure.
    expect(result).toBe(1);

    expect(subcommands(calls)).toEqual([
      "mise", "mise", "mise", "mise", "mise", "ls", "create", "policy", "policy", "policy", "exec", "git",
      "secret", "secret", "exec", "ports", "ports", "policy", "policy", "exec",
    ]);
    // `mise install` and `mise env` run in the project root.
    expect(calls[0]?.cmd).toEqual([miseBin(env), "install"]);
    expect(calls[0]?.cwd).toBe("/repo");
    expect(calls[1]?.cmd).toEqual([miseBin(env), "env", "-C", "/repo", "--json"]);
    expect(calls[1]?.cwd).toBe("/repo");
    // Step 12: the mise of the sandbox follows the version of the host mise.
    expect(calls[2]?.cmd).toEqual([miseBin(env), "--version"]);
    expect(calls[3]?.cmd).toEqual([miseBin(env), "install", `${MISE_TOOL}@${MISE_VERSION}`]);
    expect(calls[4]?.cmd).toEqual([miseBin(env), "bin-paths", `${MISE_TOOL}@${MISE_VERSION}`]);
    // The create runs with the working directory `/` and mounts the plugin
    // folder, the mise installs folder, and the shared agents folder
    // read-only, all relative from `/`.
    expect(calls[6]?.cmd).toEqual([
      "sbx",
      "create",
      "--clone",
      "--name",
      "oc-sub-test",
      "opencode",
      "/repo",
      `${relativeMount("/", pluginDataDir(env))}:ro`,
      `${relativeMount("/", miseInstallsDir(env))}:ro`,
      `${relativeMount("/", sharedDirOf(env))}:ro`,
    ]);
    expect(calls[6]?.cwd).toBe("/");
    expect(calls[7]?.cmd).toEqual([
      "sbx", "policy", "allow", "network", "--sandbox", "oc-sub-test", "**", "--method", "GET,HEAD",
    ]);
    expect(calls[8]?.cmd).toEqual([
      "sbx", "policy", "allow", "network", "--sandbox", "oc-sub-test", EXA_HOST,
    ]);
    expect(calls[9]?.cmd).toEqual([
      "sbx", "policy", "deny", "network", "--sandbox", "oc-sub-test", NETWORK_DENY_HOSTS.join(","),
    ]);
    // The clone check runs right after the create and its network rules.
    expect(calls[10]?.cmd).toEqual(["sbx", "exec", "oc-sub-test", "git", "-C", "/repo", "rev-parse", "--git-dir"]);
    // The clone mode check follows the clone check.
    expect(calls[11]?.cmd).toEqual(["git", "-C", "/repo", "remote"]);
    expect(calls[13]?.cmd).toEqual([
      "sbx",
      "secret",
      "set",
      "openrouter",
      "--sandbox",
      "oc-sub-test",
      "--command",
      `cat ${shellQuote(path.join(env.XDG_CONFIG_HOME as string, "test", "openrouter.key"))}`,
    ]);
    expect(calls[14]?.cmd).toEqual(["sbx", "exec", "oc-sub-test", "sh", "-c", placeholderKeyScript("test")]);
    expect(calls[16]?.cmd).toEqual(["sbx", "ports", "oc-sub-test", "--publish", "18768:4096"]);
    // The checks of the network rules, before the server starts.
    expect(calls[17]?.cmd).toEqual(["sbx", "policy", "check", "network", "--sandbox", "oc-sub-test", "host.docker.internal:8767"]);
    expect(calls[18]?.cmd).toEqual(["sbx", "policy", "check", "network", "--sandbox", "oc-sub-test", "localhost:8767"]);
    // The readability check of the shared rules, before the server starts.
    expect(calls[19]?.cmd).toEqual(["sbx", "exec", "oc-sub-test", "test", "-r", `${sharedDirOf(env)}/AGENTS.md`]);
    expect(execCommands).toEqual([[
      "sbx",
      "exec",
      "-e",
      `OPENCODE_CONFIG_DIR=${pluginDataDir(env)}`,
      "-e",
      `OPENCODE_CONFIG_CONTENT=${sandboxConfigContent(sharedDirOf(env), proxyBaseUrl(SANDBOX_PROXY_PORT))}`,
      "-e",
      "SSH_AUTH_SOCK=",
      "-e",
      "OPENCODE_ENABLE_EXA=1",
      "-e",
      `PATH=${toolBin}:${miseInstallsDir(env)}/aqua-jdx-mise/${MISE_VERSION}/mise/bin:${SANDBOX_PATH}`,
      // The mise of the sandbox: the host installs read-only, trust for the
      // project root, and writable state folders in the sandbox home.
      ...sandboxMiseEnv(miseInstallsDir(env), "/repo").flatMap((entry) => ["-e", entry]),
      "oc-sub-test",
      "sh",
      "-c",
      sandboxHolderScript(`${toolBin}/bun`, bundlePath(env), SANDBOX_PROXY_PORT, 4096),
    ]]);
    // The state file holds the name, the root, and the port.
    const state = readSandboxState(sandboxStatePath(env, "test"));
    expect(state).toEqual({ name: "oc-sub-test", root: "/repo", port: 18768 });
  });

  test("a mise whose version cannot be read warns and installs no sandbox mise", async () => {
    const env = makeEnv();
    const { calls, runner } = fakeRunner((cmd) => {
      if (isSubcommand(cmd, "ls")) return { stdout: lsWorkspace("oc-sub-test", env) };
      if (isSubcommand(cmd, "secret") && cmd[2] === "ls") return { stdout: "github\n" };
      if (isSubcommand(cmd, "ports")) return { stdout: "" };
      if (cmd[0] === "mise" && cmd[1] === "env") {
        return { stdout: JSON.stringify({ PATH: `${miseInstallsDir(env)}/bun/1.4.2/bin:/usr/local/bin` }) };
      }
      if (isSubcommand(cmd, "policy") && cmd[2] === "check") return DENIED;
      if (cmd[0] === "git") return GIT_REMOTE;
      return { stdout: "", exitCode: 0 };
    }, { miseVersion: null });
    const holderArgs: string[][] = [];
    const errors: string[] = [];
    const err = console.error;
    console.error = (line: string) => errors.push(line);
    let result: number;
    try {
      result = await upSandbox({}, env, makeDeps({
        runner,
        spawnServe: ({ cmd }) => {
          holderArgs.push([...cmd]);
          return { pid: 4242, exitCode: () => 1 };
        },
      }));
    } finally {
      console.error = err;
    }
    expect(result).toBe(1);
    expect(errors.join("\n")).toContain("the sandbox gets no mise");
    // No `mise install mise@<version>`: the version is missing.
    expect(calls.filter((call) => call.cmd[0] === "mise").map((call) => call.cmd[1])).toEqual([
      "install", "env", "--version",
    ]);
    // The PATH entry of the holder has no mise folder, but the mise settings
    // of the server are still there (mise may exist in the sandbox image).
    const envArgs = holderArgs[0]?.filter((arg, i) => holderArgs[0]?.[i - 1] === "-e") ?? [];
    expect(envArgs.some((arg) => arg.startsWith("PATH=") && arg.includes("mise/2026"))).toBe(false);
    expect(envArgs).toContain("MISE_SHARED_INSTALL_DIRS=" + miseInstallsDir(env));
  });

  test("a failed mise install warns and goes on without sandbox mise", async () => {
    const env = makeEnv();
    const { calls, runner } = fakeRunner((cmd) => {
      if (cmd[0] === "mise" && cmd[1] === "install" && cmd[2] !== undefined) {
        return { stdout: "", exitCode: 1, stderr: "mise: download failed\n" };
      }
      if (isSubcommand(cmd, "ls")) return { stdout: lsWorkspace("oc-sub-test", env) };
      if (isSubcommand(cmd, "secret") && cmd[2] === "ls") return { stdout: "github\n" };
      if (isSubcommand(cmd, "ports")) return { stdout: "" };
      if (cmd[0] === "mise" && cmd[1] === "env") {
        return { stdout: JSON.stringify({ PATH: `${miseInstallsDir(env)}/bun/1.4.2/bin:/usr/local/bin` }) };
      }
      if (isSubcommand(cmd, "policy") && cmd[2] === "check") return DENIED;
      if (cmd[0] === "git") return GIT_REMOTE;
      return { stdout: "", exitCode: 0 };
    });
    const holderArgs: string[][] = [];
    const errors: string[] = [];
    const err = console.error;
    console.error = (line: string) => errors.push(line);
    let result: number;
    try {
      result = await upSandbox({}, env, makeDeps({
        runner,
        spawnServe: ({ cmd }) => {
          holderArgs.push([...cmd]);
          return { pid: 4242, exitCode: () => 1 };
        },
      }));
    } finally {
      console.error = err;
    }
    expect(result).toBe(1);
    expect(errors.join("\n")).toContain(`mise install ${MISE_TOOL}@${MISE_VERSION} failed`);
    expect(errors.join("\n")).toContain("mise: download failed");
    const envArgs = holderArgs[0]?.filter((arg, i) => holderArgs[0]?.[i - 1] === "-e") ?? [];
    expect(envArgs.some((arg) => arg.startsWith("PATH=") && arg.includes("mise/2026"))).toBe(false);
  });

  test("a bin folder of mise outside the installs folder warns and goes on", async () => {
    const env = makeEnv();
    const { runner } = fakeRunner((cmd) => {
      if (cmd[0] === "mise" && cmd[1] === "bin-paths") {
        return { stdout: "/opt/other-mise/aqua-jdx-mise/bin\n" };
      }
      if (isSubcommand(cmd, "ls")) return { stdout: lsWorkspace("oc-sub-test", env) };
      if (isSubcommand(cmd, "secret") && cmd[2] === "ls") return { stdout: "github\n" };
      if (isSubcommand(cmd, "ports")) return { stdout: "" };
      if (cmd[0] === "mise" && cmd[1] === "env") {
        return { stdout: JSON.stringify({ PATH: `${miseInstallsDir(env)}/bun/1.4.2/bin:/usr/local/bin` }) };
      }
      if (isSubcommand(cmd, "policy") && cmd[2] === "check") return DENIED;
      if (cmd[0] === "git") return GIT_REMOTE;
      return { stdout: "", exitCode: 0 };
    });
    const holderArgs: string[][] = [];
    const errors: string[] = [];
    const err = console.error;
    console.error = (line: string) => errors.push(line);
    let result: number;
    try {
      result = await upSandbox({}, env, makeDeps({
        runner,
        spawnServe: ({ cmd }) => {
          holderArgs.push([...cmd]);
          return { pid: 4242, exitCode: () => 1 };
        },
      }));
    } finally {
      console.error = err;
    }
    expect(result).toBe(1);
    expect(errors.join("\n")).toContain("lies outside the installs folder");
    const envArgs = holderArgs[0]?.filter((arg, i) => holderArgs[0]?.[i - 1] === "-e") ?? [];
    expect(envArgs.some((arg) => arg.startsWith("PATH=") && arg.includes("/opt/other-mise"))).toBe(false);
  });

  test("an existing sandbox without the installs mount stops up with a hint", async () => {
    const env = makeEnv();
    const { calls, runner } = fakeRunner((cmd) => {
      if (isSubcommand(cmd, "ls")) {
        return { stdout: `NAME     STATUS     WORKSPACE\noc-sub-test   running   /repo, ${pluginMount(env)}\n` };
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
    expect(errors.join("\n")).toContain(`sbx rm --force oc-sub-test`);
    expect(errors.join("\n")).toContain("idfx up");
    expect(errors.join("\n")).not.toContain("--sandbox");
    // No secret, no exec, no server.
    expect(subcommands(calls)).toEqual(["mise", "mise", "mise", "mise", "mise", "ls"]);
  });

  test("a stopped clone-mode sandbox passes, because its start adds the remote again", async () => {
    // `sbx stop` removes the `sandbox-<name>` remote, and the next start of
    // the sandbox adds it again. The first `sbx exec` starts the sandbox.
    const env = makeEnv();
    let started = false;
    const { calls, runner } = fakeRunner((cmd) => {
      if (isSubcommand(cmd, "ls")) return { stdout: lsWorkspace("oc-sub-test", env) };
      if (isSubcommand(cmd, "exec")) started = true;
      if (isSubcommand(cmd, "secret") && cmd[2] === "ls") return { stdout: "oc-sub-test   service   openrouter   (stored)\n" };
      if (cmd[0] === "git") return started ? GIT_REMOTE : { stdout: "origin\n" };
      return DENIED;
    });
    const errors: string[] = [];
    const err = console.error;
    console.error = (line: string) => errors.push(line);
    try {
      await upSandbox({}, env, makeDeps({ runner, spawnServe: () => ({ pid: 4242, exitCode: () => 1 }) }));
    } finally {
      console.error = err;
    }
    expect(errors.join("\n")).not.toContain("not in clone mode");
    expect(subcommands(calls).slice(0, 8)).toEqual(["mise", "mise", "mise", "mise", "mise", "ls", "exec", "git"]);
  });

  test("an existing direct-mount sandbox without the clone remote stops up with a hint", async () => {
    const env = makeEnv();
    const { calls, runner } = fakeRunner((cmd) => {
      if (isSubcommand(cmd, "ls")) return { stdout: lsWorkspace("oc-sub-test", env) };
      // `git remote` does not list `sandbox-<name>`: an old direct-mount sandbox.
      if (cmd[0] === "git") return { stdout: "origin\n" };
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
    const text = errors.join("\n");
    expect(text).toContain("not in clone mode");
    expect(text).toContain("sbx rm --force oc-sub-test");
    expect(text).toContain("idfx up");
    // No secret, no exec, no server.
    expect(subcommands(calls)).toEqual(["mise", "mise", "mise", "mise", "mise", "ls", "exec", "git"]);
  });

  test("an allowed policy check stops up before the server starts", async () => {
    const env = makeEnv();
    const { calls, runner } = fakeRunner((cmd) => {
      if (isSubcommand(cmd, "ls")) return { stdout: lsWorkspace("oc-sub-test", env) };
      if (isSubcommand(cmd, "secret") && cmd[2] === "ls") return { stdout: "oc-sub-test   service   openrouter   (stored)\n" };
      if (isSubcommand(cmd, "ports")) return { stdout: "HOST IP     HOST PORT   SANDBOX PORT   PROTOCOL\n127.0.0.1   18768       4096           tcp4\n" };
      if (cmd[0] === "git") return GIT_REMOTE;
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
    expect(subcommands(calls)).toEqual(["mise", "mise", "mise", "mise", "mise", "ls", "exec", "git", "secret", "exec", "ports", "policy"]);
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
      if (cmd[0] === "git") return GIT_REMOTE;
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
    expect(subcommands(calls)).toEqual(["mise", "mise", "mise", "mise", "mise", "ls", "exec", "git", "secret", "exec", "ports", "policy", "policy", "exec"]);
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
      if (cmd[0] === "git") return GIT_REMOTE;
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
      isSubcommand(cmd, "ls") ? { stdout: lsWorkspace("oc-sub-test", env) } : cmd[0] === "git" ? GIT_REMOTE : DENIED,
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
    // The started server records the digest of the synced plugin folder.
    expect(pluginDigest(pluginDataDir(env))).toBe(pluginDigest(PLUGIN_CONFIG_DIR));
    expect(readServePlugin(servePluginPath(env, 18768))).toBe(pluginDigest(pluginDataDir(env)));
  });

  test("a healthy server keeps its plugin digest: up neither syncs nor rewrites it", async () => {
    const env = makeEnv();
    mkdirSync(path.join(env.XDG_STATE_HOME as string, "oc-sub"), { recursive: true });
    writeFileSync(servePluginPath(env, 18768), "sha256:old\n");
    const { runner } = fakeRunner((cmd) =>
      isSubcommand(cmd, "ls") ? { stdout: lsWorkspace("oc-sub-test", env) } : cmd[0] === "git" ? GIT_REMOTE : DENIED,
    );
    const log = console.log;
    console.log = () => {};
    try {
      const result = await upSandbox({}, env, makeDeps({ runner, probe: async () => ({ state: "up", version: "1.18.32" }) }));
      expect(result).toBe(0);
    } finally {
      console.log = log;
    }
    expect(readServePlugin(servePluginPath(env, 18768))).toBe("sha256:old");
    expect(existsSync(pluginDataDir(env))).toBe(false);
  });

  test("a first up of the plugin repository mounts the synced plugin folder outside the root", async () => {
    const env = makeEnv();
    // The project is the plugin repository itself. Its own plugin folder lies
    // inside the root, but the server loads the synced copy, which does not.
    const root = path.dirname(PLUGIN_CONFIG_DIR);
    const { calls, runner } = fakeRunner((cmd) => {
      if (isSubcommand(cmd, "ls")) return { stdout: "other-sb\n" };
      if (isSubcommand(cmd, "policy") && cmd[2] === "check") return DENIED;
      return { stdout: "", exitCode: 0 };
    });
    const output: string[] = [];
    const log = console.log;
    console.log = (line: string) => output.push(line);
    try {
      await upSandbox({}, env, makeDeps({
        runner,
        rootOf: () => root,
        probe: async () => ({ state: "up", version: "1.18.32" }),
      }));
    } finally {
      console.log = log;
    }
    const create = calls.find((call) => isSubcommand(call.cmd, "create"));
    expect(create?.cmd).toEqual([
      "sbx",
      "create",
      "--clone",
      "--name",
      "oc-sub-test",
      "opencode",
      root,
      `${relativeMount("/", pluginDataDir(env))}:ro`,
      `${relativeMount("/", miseInstallsDir(env))}:ro`,
      `${relativeMount("/", sharedDirOf(env))}:ro`,
    ]);
    expect(output.join("\n")).not.toContain("lies inside the project root");
    // The mount source exists before the create.
    expect(pluginDigest(pluginDataDir(env))).toBe(pluginDigest(PLUGIN_CONFIG_DIR));
    expect(calls.map((call) => call.cmd)).toContainEqual(cloneCheckCommand("sbx", "oc-sub-test", root));
  });

  test("an existing sandbox without the synced plugin mount stops up and names the newer plugin mount", async () => {
    const env = makeEnv();
    const root = path.dirname(PLUGIN_CONFIG_DIR);
    const { runner } = fakeRunner((cmd) => {
      if (isSubcommand(cmd, "ls")) {
        return { stdout: `NAME     STATUS     WORKSPACE\noc-sub-test   running   ${root}, ${installsMount(env)}, ${sharedMount(env)}\n` };
      }
      return DENIED;
    });
    const errors: string[] = [];
    const err = console.error;
    console.error = (line: string) => errors.push(line);
    let result: number;
    try {
      result = await upSandbox({}, env, makeDeps({
        runner,
        rootOf: () => root,
        spawnServe: () => {
          throw new Error("no server may start");
        },
      }));
    } finally {
      console.error = err;
    }
    expect(result).toBe(1);
    const text = errors.join("\n");
    expect(text).toContain(`lacks the mounts ${pluginMount(env)}`);
    expect(text).toContain("of newer idfx versions");
    expect(text).toContain("sbx rm --force oc-sub-test");
  });

  test("a create without a clone stops up with the sbx rm --force fix", async () => {
    const env = makeEnv();
    const { calls, runner } = fakeRunner((cmd) => {
      if (isSubcommand(cmd, "ls")) return { stdout: "other-sb\n" };
      // `sbx create` exits 0, but the clone check fails inside.
      if (isSubcommand(cmd, "exec") && cmd[3] === "git") return { stdout: "", exitCode: 128 };
      // The mise of the sandbox installs without a warning.
      if (cmd[0] === "mise" && cmd[1] === "bin-paths") {
        return { stdout: `${miseInstallsDir(env)}/aqua-jdx-mise/${MISE_VERSION}/mise/bin\n` };
      }
      return { stdout: "", exitCode: 0 };
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
    expect(errors).toEqual([
      `error: ${missingCloneMessage("oc-sub-test", "/repo")}`,
      sandboxRecreateFix("oc-sub-test"),
    ]);
    expect(errors.join("\n")).toContain("sbx rm --force oc-sub-test");
    // No secret, no port, no server after the failed check.
    expect(subcommands(calls)).toEqual(["mise", "mise", "mise", "mise", "mise", "ls", "create", "policy", "policy", "policy", "exec"]);
  });

  test("an existing sandbox without a clone stops up with the sbx rm --force fix", async () => {
    const env = makeEnv();
    const { calls, runner } = fakeRunner((cmd) => {
      if (isSubcommand(cmd, "ls")) return { stdout: lsWorkspace("oc-sub-test", env) };
      if (cmd[0] === "git") return GIT_REMOTE;
      if (isSubcommand(cmd, "exec") && cmd[3] === "git") return { stdout: "", exitCode: 128 };
      return DENIED;
    });
    const errors: string[] = [];
    const err = console.error;
    console.error = (line: string) => errors.push(line);
    let result: number;
    try {
      result = await upSandbox({}, env, makeDeps({ runner }));
    } finally {
      console.error = err;
    }
    expect(result).toBe(1);
    expect(errors.join("\n")).toContain("has no git clone at /repo");
    expect(errors.join("\n")).toContain("sbx rm --force oc-sub-test");
    expect(subcommands(calls)).toEqual(["mise", "mise", "mise", "mise", "mise", "ls", "exec"]);
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
    writeFileSync(servePluginPath(env, 18768), "sha256:abc\n");
    // A stale PID file of the idle watchdog: no such process.
    writeFileSync(idlePidPath(env, 18768), "2147483000\n");
    const { calls, runner } = fakeRunner(() => ({ stdout: "" }));
    const result = await downSandbox({ force: false }, env, makeDeps({
      runner,
      probe: async () => ({ state: "down" }),
    }));
    expect(result).toBe(0);
    expect(calls).toEqual([{ cmd: ["sbx", "stop", "oc-sub-test"] }]);
    // The state file stays, so the port stays the same.
    expect(readSandboxState(sandboxStatePath(env, "test"))).not.toBeNull();
    // The plugin digest belongs to the stopped server.
    expect(existsSync(servePluginPath(env, 18768))).toBe(false);
    // The idle watchdog ends with the server.
    expect(existsSync(idlePidPath(env, 18768))).toBe(false);
  });

  test("stops the holder unit after sbx stop, then the idle unit", async () => {
    const env = makeEnv();
    mkdirSync(env.XDG_STATE_HOME as string, { recursive: true });
    await writeSandboxState(sandboxStatePath(env, "test"), { name: "oc-sub-test", root: "/repo", port: 18768 });
    const { calls, runner } = fakeRunner(() => ({ stdout: "" }));
    const units = fakeUnits({ loaded: ["ocsub-holder-18768", "ocsub-idle-18768"] });
    const result = await downSandbox({ force: false }, env, makeDeps({
      runner: (cmd, opts) => {
        units.calls.push(cmd.join(" "));
        return runner(cmd, opts);
      },
      units: units.deps,
      probe: async () => ({ state: "down" }),
    }));
    expect(result).toBe(0);
    expect(calls).toEqual([{ cmd: ["sbx", "stop", "oc-sub-test"] }]);
    expect(units.calls).toEqual(["sbx stop oc-sub-test", "stop ocsub-holder-18768", "stop ocsub-idle-18768"]);
  });

  test("the watchdog stops the holder unit but never its own unit", async () => {
    const env = makeEnv();
    mkdirSync(env.XDG_STATE_HOME as string, { recursive: true });
    await writeSandboxState(sandboxStatePath(env, "test"), { name: "oc-sub-test", root: "/repo", port: 18768 });
    const { runner } = fakeRunner(() => ({ stdout: "" }));
    const units = fakeUnits({ loaded: ["ocsub-holder-18768", "ocsub-idle-18768"], own: "ocsub-idle-18768" });
    const result = await downSandbox({ force: false }, env, makeDeps({
      runner,
      units: units.deps,
      probe: async () => ({ state: "down" }),
    }));
    expect(result).toBe(0);
    expect(units.calls).toEqual(["stop ocsub-holder-18768"]);
    expect([...units.loaded]).toEqual(["ocsub-idle-18768"]);
  });

  test("reports a failed sbx stop", async () => {
    const env = makeEnv();
    mkdirSync(env.XDG_STATE_HOME as string, { recursive: true });
    await writeSandboxState(sandboxStatePath(env, "test"), {
      name: "oc-sub-test",
      root: "/repo",
      port: 18768,
    });
    writeFileSync(idlePidPath(env, 18768), "2147483000\n");
    const { runner } = fakeRunner(() => ({ exitCode: 1 }));
    const result = await downSandbox({ force: false }, env, makeDeps({
      runner,
      probe: async () => ({ state: "down" }),
    }));
    expect(result).toBe(1);
    // The server still runs, so its watchdog stays.
    expect(existsSync(idlePidPath(env, 18768))).toBe(true);
  });
});

/** Capture console.error while the body runs. */
async function captureErrors(body: () => Promise<number>): Promise<{ result: number; text: string }> {
  const errors: string[] = [];
  const err = console.error;
  console.error = (line: string) => errors.push(line);
  try {
    const result = await body();
    return { result, text: errors.join("\n") };
  } finally {
    console.error = err;
  }
}

describe("the KVM gate and the stderr of sbx in upSandbox", () => {
  const SBX_START_ERROR = "ERROR: start runtime: 500 Internal Server Error";

  test("a failed kvm-access check stops up before any sbx call", async () => {
    const { calls, runner } = fakeRunner(() => ({ stdout: "" }));
    const { result, text } = await captureErrors(() =>
      upSandbox({}, makeEnv(), makeDeps({
        runner,
        checkKvm: () => ({
          name: "kvm-access",
          status: "fail",
          message: "the current user cannot read and write /dev/kvm (mode 0660, owner uid 0, group gid 109)",
          fix: "run idfx doctor --fix-as-root, or: sudo chmod 0666 /dev/kvm",
        }),
      })),
    );
    expect(result).toBe(1);
    expect(calls).toHaveLength(0);
    expect(text).toContain("error: kvm-access: the current user cannot read and write /dev/kvm (mode 0660");
    expect(text).toContain("fix: run idfx doctor --fix-as-root");
  });

  test("a skipped or passed kvm-access check lets up continue", async () => {
    const { calls, runner } = fakeRunner(() => ({ stdout: "", exitCode: 1 }));
    await captureErrors(() =>
      upSandbox({}, makeEnv(), makeDeps({
        runner,
        checkKvm: () => ({ name: "kvm-access", status: "skip", message: "not on Linux (darwin)" }),
      })),
    );
    // The first call after the gate is `mise install`.
    expect(calls.length).toBeGreaterThan(0);
  });

  test("a failed sbx create prints its stderr and names sbx diagnose", async () => {
    const { calls, runner } = fakeRunner((cmd) => {
      if (isSubcommand(cmd, "create")) return { exitCode: 1, stderr: `${SBX_START_ERROR}\n` };
      return { stdout: "" };
    });
    const { result, text } = await captureErrors(() => upSandbox({}, makeEnv(), makeDeps({ runner })));
    expect(result).toBe(1);
    expect(text).toContain("error: sbx create failed for oc-sub-test");
    expect(text).toContain(`  ${SBX_START_ERROR}`);
    expect(text).toContain("sbx diagnose");
    expect(subcommands(calls)).toEqual(["mise", "mise", "mise", "mise", "mise", "ls", "create"]);
  });

  test("a failed sbx exec of the clone check prints its stderr, not \"has no git clone\"", async () => {
    const env = makeEnv();
    const { calls, runner } = fakeRunner((cmd) => {
      if (isSubcommand(cmd, "ls")) return { stdout: lsWorkspace("oc-sub-test", env) };
      if (isSubcommand(cmd, "exec")) return { exitCode: 1, stderr: SBX_START_ERROR };
      return DENIED;
    });
    const { result, text } = await captureErrors(() => upSandbox({}, env, makeDeps({ runner })));
    expect(result).toBe(1);
    expect(text).not.toContain("has no git clone");
    expect(text).not.toContain("sbx rm --force");
    expect(text).toContain(SBX_START_ERROR);
    expect(text).toContain("sbx diagnose");
    expect(subcommands(calls)).toEqual(["mise", "mise", "mise", "mise", "mise", "ls", "exec"]);
  });
});

describe("cloneStatus and printStderr", () => {
  test("cloneStatus tells a missing clone from a failed sbx exec", () => {
    expect(cloneStatus(() => ({ stdout: ".git\n", exitCode: 0 }), "sbx", "n", "/r")).toEqual({ state: "present" });
    expect(cloneStatus(() => ({ stdout: "", exitCode: 128, stderr: "fatal: not a git repository" }), "sbx", "n", "/r")).toEqual({
      state: "missing",
    });
    expect(cloneStatus(() => ({ stdout: "", exitCode: 1, stderr: " boom \n" }), "sbx", "n", "/r")).toEqual({
      state: "exec-failed",
      exitCode: 1,
      stderr: "boom",
    });
    expect(cloneStatus(() => ({ stdout: "", exitCode: 1 }), "sbx", "n", "/r")).toEqual({
      state: "exec-failed",
      exitCode: 1,
      stderr: "",
    });
  });

  test("printStderr indents each line and prints nothing for an empty stderr", () => {
    const lines: string[] = [];
    printStderr({ stdout: "", exitCode: 1, stderr: "a\nb\n" }, (line) => lines.push(line));
    printStderr({ stdout: "", exitCode: 1 }, (line) => lines.push(line));
    printStderr({ stdout: "", exitCode: 1, stderr: "  \n" }, (line) => lines.push(line));
    expect(lines).toEqual(["  a", "  b"]);
  });
});

describe("DeepInfra in sandbox mode", () => {
  const SECRETS_OPENROUTER = "SCOPE     TYPE      NAME         SECRET\noc-sub-test   service   openrouter   (stored)\n";
  // The real output of sbx 0.45.1: custom secrets come in a separate table.
  const CUSTOM_TABLE = (scope: string) =>
    `\nCUSTOM SECRETS\nSCOPE                      TARGETS            ENV\n${scope}  api.deepinfra.com  DEEPINFRA_API_KEY\n`;
  const SECRETS_BOTH = `${SECRETS_OPENROUTER}${CUSTOM_TABLE("oc-sub-test")}`;
  const PORTS = "HOST IP     HOST PORT   SANDBOX PORT   PROTOCOL\n127.0.0.1   18768       4096           tcp4\n";

  /** An up of an existing sandbox, with the given secret list and key files. */
  async function upExisting(opts: { secrets: string; deepinfraKey: boolean; noCostProxy?: boolean }) {
    const env = makeEnv();
    const { calls, runner } = fakeRunner((cmd) => {
      if (isSubcommand(cmd, "ls")) return { stdout: lsWorkspace("oc-sub-test", env) };
      if (isSubcommand(cmd, "secret") && cmd[2] === "ls") return { stdout: opts.secrets };
      if (isSubcommand(cmd, "ports")) return { stdout: PORTS };
      if (isSubcommand(cmd, "policy") && cmd[2] === "check") return DENIED;
      if (cmd[0] === "git") return GIT_REMOTE;
      return { stdout: "", exitCode: 0 };
    });
    const holderCommands: string[][] = [];
    let probes = 0;
    const result = await upSandbox({ noCostProxy: opts.noCostProxy }, env, makeDeps({
      runner,
      keyExists: (file) => opts.deepinfraKey || !file.endsWith("deepinfra.key"),
      probe: async () => (probes++ === 0 ? { state: "down" } : { state: "up", version: "1.18.32" }),
      spawnServe: ({ cmd }) => {
        holderCommands.push([...cmd]);
        return { pid: 4242, exitCode: () => null };
      },
    }));
    return { env, calls, result, holder: holderCommands[0] ?? [] };
  }

  function configOf(holder: string[]): { provider?: Record<string, { options: { baseURL: string } }> } {
    const flag = holder.find((arg) => arg.startsWith("OPENCODE_CONFIG_CONTENT=")) ?? "";
    return JSON.parse(flag.slice("OPENCODE_CONFIG_CONTENT=".length));
  }

  test("deepinfraProxyBaseUrl ends in /deepinfra/v1, because the SDK appends /openai", () => {
    expect(deepinfraProxyBaseUrl(4097)).toBe("http://127.0.0.1:4097/deepinfra/v1");
  });

  test("listsDeepInfraSecret finds the custom secret of the sandbox only", () => {
    expect(listsDeepInfraSecret(SECRETS_BOTH, "oc-sub-test")).toBe(true);
    expect(listsDeepInfraSecret(SECRETS_OPENROUTER, "oc-sub-test")).toBe(false);
    expect(listsDeepInfraSecret(SECRETS_BOTH, "oc-sub-other")).toBe(false);
    // The live output of the project sandbox, verbatim.
    const live = "CUSTOM SECRETS\nSCOPE                      TARGETS            ENV\noc-sub-idfix  api.deepinfra.com  DEEPINFRA_API_KEY\n";
    expect(listsDeepInfraSecret(live, "oc-sub-idfix")).toBe(true);
    expect(listsDeepInfraSecret(live, "oc-sub-test")).toBe(false);
    // The openrouter rule does not take the custom row for an openrouter secret.
    expect(listsOpenRouterSecret(live, "oc-sub-idfix")).toBe(false);
    expect(listsOpenRouterSecret(CUSTOM_TABLE("oc-sub-test"), "oc-sub-test")).toBe(false);
    expect(listsOpenRouterSecret(SECRETS_BOTH, "oc-sub-test")).toBe(true);
    expect(listsDeepInfraSecret("No secrets found.\n", "oc-sub-test")).toBe(false);
  });

  test("deepinfraSecretCommand scopes the custom secret to the sandbox and the host", () => {
    expect(deepinfraSecretCommand("sbx", "oc-sub-test", "/home/user/.config/test/deepinfra.key")).toEqual([
      "sbx", "secret", "set-custom", "--sandbox", "oc-sub-test", "--host", "api.deepinfra.com",
      "--env", "DEEPINFRA_API_KEY", "--placeholder", DEEPINFRA_PLACEHOLDER,
      "--command", "cat '/home/user/.config/test/deepinfra.key'",
    ]);
  });

  test("providerEntries sets each provider only with its proxy URL", () => {
    expect(providerEntries()).toEqual({});
    expect(providerEntries("http://p/v1")).toEqual({ provider: { openrouter: { options: { baseURL: "http://p/v1" } } } });
    expect(providerEntries("http://p/v1", "http://p/deepinfra/v1")).toEqual({
      provider: {
        openrouter: { options: { baseURL: "http://p/v1" } },
        deepinfra: { options: { baseURL: "http://p/deepinfra/v1" } },
      },
    });
  });

  test("with the key file and no secret, up allows the API host, sets the secret, and passes the placeholder", async () => {
    const { env, calls, result, holder } = await upExisting({ secrets: SECRETS_OPENROUTER, deepinfraKey: true });
    expect(result).toBe(0);
    const keyPath = path.join(env.XDG_CONFIG_HOME as string, "test", "deepinfra.key");
    const allowIndex = calls.findIndex((call) => call.cmd.includes(DEEPINFRA_NETWORK_HOST));
    expect(calls[allowIndex]?.cmd).toEqual([
      "sbx", "policy", "allow", "network", "--sandbox", "oc-sub-test", "api.deepinfra.com:443",
    ]);
    expect(calls[allowIndex + 1]?.cmd).toEqual(deepinfraSecretCommand("sbx", "oc-sub-test", keyPath));
    // The secret list runs once and serves both providers.
    expect(calls.filter((call) => call.cmd[1] === "secret" && call.cmd[2] === "ls")).toHaveLength(1);
    // The placeholder goes in with -e, before the sandbox name.
    const envIndex = holder.indexOf(`DEEPINFRA_API_KEY=${DEEPINFRA_PLACEHOLDER}`);
    expect(holder[envIndex - 1]).toBe("-e");
    expect(envIndex).toBeLessThan(holder.indexOf("oc-sub-test"));
    expect(configOf(holder).provider?.deepinfra).toEqual({
      options: { baseURL: deepinfraProxyBaseUrl(SANDBOX_PROXY_PORT) },
    });
    expect(configOf(holder).provider?.openrouter).toEqual({ options: { baseURL: proxyBaseUrl(SANDBOX_PROXY_PORT) } });
  });

  test("with the secret listed, up skips the allow rule and the secret", async () => {
    const { calls, result, holder } = await upExisting({ secrets: SECRETS_BOTH, deepinfraKey: true });
    expect(result).toBe(0);
    expect(calls.some((call) => call.cmd.includes("set-custom"))).toBe(false);
    expect(calls.some((call) => call.cmd.includes(DEEPINFRA_NETWORK_HOST))).toBe(false);
    expect(holder).toContain(`DEEPINFRA_API_KEY=${DEEPINFRA_PLACEHOLDER}`);
  });

  test("without the key file, up sets nothing up for DeepInfra", async () => {
    const { calls, result, holder } = await upExisting({ secrets: SECRETS_OPENROUTER, deepinfraKey: false });
    expect(result).toBe(0);
    expect(calls.some((call) => call.cmd.includes("set-custom"))).toBe(false);
    expect(calls.some((call) => call.cmd.includes(DEEPINFRA_NETWORK_HOST))).toBe(false);
    expect(holder.some((arg) => arg.startsWith("DEEPINFRA_API_KEY="))).toBe(false);
    expect(configOf(holder).provider?.deepinfra).toBeUndefined();
  });

  test("with --no-cost-proxy, opencode calls DeepInfra directly with the placeholder", async () => {
    const { result, holder } = await upExisting({ secrets: SECRETS_BOTH, deepinfraKey: true, noCostProxy: true });
    expect(result).toBe(0);
    expect(holder).toContain(`DEEPINFRA_API_KEY=${DEEPINFRA_PLACEHOLDER}`);
    expect(configOf(holder).provider).toBeUndefined();
  });

  test("a failed set-custom stops up before a server starts", async () => {
    const env = makeEnv();
    const { runner } = fakeRunner((cmd) => {
      if (isSubcommand(cmd, "ls")) return { stdout: lsWorkspace("oc-sub-test", env) };
      if (isSubcommand(cmd, "secret") && cmd[2] === "ls") return { stdout: SECRETS_OPENROUTER };
      if (isSubcommand(cmd, "secret") && cmd[2] === "set-custom") return { exitCode: 1, stderr: "unknown flag" };
      if (cmd[0] === "git") return GIT_REMOTE;
      return { stdout: "", exitCode: 0 };
    });
    const errors: string[] = [];
    const err = console.error;
    console.error = (line: string) => errors.push(line);
    let result: number;
    try {
      result = await upSandbox({}, env, makeDeps({
        runner,
        keyExists: () => true,
        spawnServe: () => {
          throw new Error("no server may start");
        },
      }));
    } finally {
      console.error = err;
    }
    expect(result).toBe(1);
    expect(errors.join("\n")).toContain("set-custom");
  });

  test("the deny list never matches the DeepInfra API host", () => {
    for (const host of NETWORK_DENY_HOSTS) expect(DEEPINFRA_NETWORK_HOST.startsWith(host)).toBe(false);
  });
});

describe("server log keeps older starts (sandbox mode)", () => {
  /** The runner answers of an up of an existing sandbox, without DeepInfra. */
  function sandboxRunner(env: Record<string, string>): Runner {
    return fakeRunner((cmd) => {
      if (isSubcommand(cmd, "ls")) return { stdout: lsWorkspace("oc-sub-test", env) };
      if (isSubcommand(cmd, "secret") && cmd[2] === "ls") return { stdout: "No secrets found.\n" };
      if (isSubcommand(cmd, "ports")) return { stdout: "HOST IP     HOST PORT   SANDBOX PORT   PROTOCOL\n127.0.0.1   18768       4096           tcp4\n" };
      if (cmd[0] === "git") return GIT_REMOTE;
      return DENIED;
    }).runner;
  }

  test("a second up appends a marker and keeps the lines of the first start", async () => {
    const env = makeEnv();
    const logPath = serveLogPath(env, 18768);
    mkdirSync(path.dirname(logPath), { recursive: true });
    writeFileSync(logPath, "--- oc-sub up 2026-10-01T20:00:00.000Z ---\nold start output\n");
    let probes = 0;
    const result = await upSandbox({}, env, makeDeps({
      runner: sandboxRunner(env),
      probe: async () => (probes++ === 0 ? { state: "down" } : { state: "up", version: "1.18.32" }),
      spawnServe: () => ({ pid: 4242, exitCode: () => null }),
    }));
    expect(result).toBe(0);
    const text = readFileSync(logPath, "utf8");
    expect(text).toContain("old start output");
    expect(text.match(/^--- oc-sub up \S+ ---$/gm)).toHaveLength(2);
  });

  test("a failed start shows only the output after the last marker", async () => {
    const env = makeEnv();
    const logPath = serveLogPath(env, 18768);
    mkdirSync(path.dirname(logPath), { recursive: true });
    writeFileSync(logPath, "--- oc-sub up 2026-10-01T20:00:00.000Z ---\nold start output\n");
    const errors: string[] = [];
    const err = console.error;
    console.error = (line: string) => errors.push(line);
    let result: number;
    try {
      result = await upSandbox({}, env, makeDeps({
        runner: sandboxRunner(env),
        probe: async () => ({ state: "down" }),
        spawnServe: ({ logPath: logPath2 }) => {
          writeFileSync(logPath2, `${readFileSync(logPath2, "utf8")}holder: fatal error\n`);
          return { pid: 4242, exitCode: () => 1 };
        },
      }));
    } finally {
      console.error = err;
    }
    expect(result).toBe(1);
    const output = errors.join("\n");
    expect(output).toContain("see " + logPath);
    expect(output).toContain("output of this start:");
    expect(output).toContain("holder: fatal error");
    expect(output).not.toContain("old start output");
  });
});
