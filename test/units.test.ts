import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RunnerResult, ServeProcess } from "../src/sandbox";
import {
  MAX_UNIT_NAME,
  PORT_UNIT_KINDS,
  portUnitName,
  stopPortUnits,
  unitActive,
  unitOfCgroup,
  unitsAvailable,
  busEnv,
  defaultUnitDeps,
  defaultUnitRunner,
  labelledEnv,
  probeUserManager,
  sanitizeUnitPart,
  startUnit,
  stopUnit,
  systemdRunArgv,
  unitDescription,
  unitExitCode,
  unitName,
  unitOwner,
  listUnits,
  orphanedUnits,
  parseUnitLabel,
  parseUnitShow,
  type LoadedUnit,
  type UnitDeps,
  type UnitOptions,
  type UnitRunner,
} from "../src/units";

const SECRET = "sk-or-v1-very-secret-value";

function options(over: Partial<UnitOptions> = {}): UnitOptions {
  return {
    kind: "serve",
    name: "18768",
    owner: "proj",
    reason: "host server",
    cmd: ["opencode", "serve", "--port", "18768"],
    cwd: "/work",
    env: { PATH: "/usr/bin", OPENROUTER_API_KEY: SECRET },
    logPath: "/state/serve-18768.log",
    pidPath: "/state/serve-18768.pid",
    ...over,
  };
}

type Call = { cmd: readonly string[]; env?: Record<string, string | undefined> };

/** A fake runner that answers by the first two words of a command. */
function fakeDeps(answers: Record<string, RunnerResult | RunnerResult[]>, available = true) {
  const calls: Call[] = [];
  const pids: Array<[string, number]> = [];
  const fallbacks: Array<{ cmd: readonly string[]; env: Record<string, string | undefined> }> = [];
  const run: UnitRunner = (cmd, opts = {}) => {
    calls.push({ cmd, env: opts.env });
    const key = cmd[0] === "systemctl" ? `systemctl ${cmd[2]}` : String(cmd[0]);
    const answer = answers[key];
    if (Array.isArray(answer)) return answer.shift() ?? { stdout: "", exitCode: 1 };
    return answer ?? { stdout: "", exitCode: 1, stderr: `no answer for ${key}` };
  };
  const deps: UnitDeps = {
    run,
    available: () => available,
    busEnv: () => ({ XDG_RUNTIME_DIR: "/run/user/1000", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus" }),
    spawnFallback: (cmd, _log, _pid, _cwd, env): ServeProcess => {
      fallbacks.push({ cmd, env });
      return { pid: 4242, exitCode: () => null };
    },
    writePid: (file, pid) => pids.push([file, pid]),
    ownUnit: () => null,
  };
  return { deps, calls, pids, fallbacks };
}

describe("unit names", () => {
  test("keeps letters, digits, _, ., and -", () => {
    expect(sanitizeUnitPart("my-proj_1.2")).toBe("my-proj_1.2");
  });

  test("replaces each run of other characters with one _", () => {
    expect(sanitizeUnitPart("my project/äö:x\\y")).toBe("my_project_x_y");
  });

  test("an empty part becomes _", () => {
    expect(sanitizeUnitPart("")).toBe("_");
  });

  test("builds ocsub-<kind>-<name> and caps the length", () => {
    expect(unitName("serve", "18768")).toBe("ocsub-serve-18768");
    expect(unitName("idle", "x".repeat(400)).length).toBe(MAX_UNIT_NAME);
  });

  test("the description is one line with owner and reason", () => {
    expect(unitDescription("proj", "cost\nproxy")).toBe("owner=proj reason=cost proxy");
  });
});

describe("unitOwner", () => {
  test("is the project without OC_SUB_OWNER, or with a blank one", () => {
    expect(unitOwner({}, "proj")).toBe("proj");
    expect(unitOwner({ OC_SUB_OWNER: "" }, "proj")).toBe("proj");
    expect(unitOwner({ OC_SUB_OWNER: "  \n " }, "proj")).toBe("proj");
  });

  test("is OC_SUB_OWNER when set, as one word", () => {
    expect(unitOwner({ OC_SUB_OWNER: "test" }, "proj")).toBe("test");
    expect(unitOwner({ OC_SUB_OWNER: " my session\nx\ty " }, "proj")).toBe("my_session_x_y");
    expect(unitDescription(unitOwner({ OC_SUB_OWNER: "a b" }, "proj"), "r")).toBe("owner=a_b reason=r");
  });
});

describe("systemdRunArgv", () => {
  test("gives the unit, the label, the slice, the folder, and the log", () => {
    const opts = options();
    const argv = systemdRunArgv(opts, labelledEnv(opts.env, opts.owner, opts.reason));
    expect(argv.slice(0, 10)).toEqual([
      "systemd-run",
      "--user",
      "--quiet",
      "--unit=ocsub-serve-18768",
      "--description=owner=proj reason=host server",
      "--slice=ocsub.slice",
      "--collect",
      "--working-directory=/work",
      "--property=StandardOutput=append:/state/serve-18768.log",
      "--property=StandardError=append:/state/serve-18768.log",
    ]);
    expect(argv.slice(argv.indexOf("--"))).toEqual(["--", "opencode", "serve", "--port", "18768"]);
    expect(argv).not.toContain("--property=Restart=on-failure");
  });

  test("adds Restart and RuntimeMaxSec on request", () => {
    const opts = options({ restart: "on-failure", runtimeMaxSec: 3600 });
    const argv = systemdRunArgv(opts, labelledEnv(opts.env, opts.owner, opts.reason));
    expect(argv).toContain("--property=Restart=on-failure");
    expect(argv).toContain("--property=RuntimeMaxSec=3600");
  });

  test("rejects a RuntimeMaxSec that is not a positive whole number", () => {
    const opts = options({ runtimeMaxSec: 0 });
    expect(() => systemdRunArgv(opts, {})).toThrow(/runtimeMaxSec/);
  });

  test("adds RestartSec and TimeoutStopSec on request", () => {
    const opts = options({ restart: "on-failure", restartSec: 1, timeoutStopSec: 15 });
    const argv = systemdRunArgv(opts, {});
    expect(argv).toContain("--property=RestartSec=1");
    expect(argv).toContain("--property=TimeoutStopSec=15");
    // All properties come before the command.
    expect(argv.indexOf("--property=RestartSec=1")).toBeLessThan(argv.indexOf("--"));
  });

  test("adds Restart=always and StartLimitIntervalSec=0 on request", () => {
    const argv = systemdRunArgv(options({ restart: "always", restartSec: 1, startLimitIntervalSec: 0 }), {});
    expect(argv).toContain("--property=Restart=always");
    expect(argv).toContain("--property=StartLimitIntervalSec=0");
    expect(argv).toContain("--property=RestartSec=1");
    expect(argv).not.toContain("--property=Restart=on-failure");
  });

  test("rejects a negative StartLimitIntervalSec", () => {
    expect(() => systemdRunArgv(options({ startLimitIntervalSec: -1 }), {})).toThrow(/startLimitIntervalSec/);
  });

  test("rejects a RestartSec or a TimeoutStopSec that is not a positive whole number", () => {
    expect(() => systemdRunArgv(options({ restartSec: -1 }), {})).toThrow(/restartSec/);
    expect(() => systemdRunArgv(options({ timeoutStopSec: 1.5 }), {})).toThrow(/timeoutStopSec/);
  });

  test("passes each variable by name and never a value", () => {
    const opts = options({ env: { PATH: "/usr/bin", OPENROUTER_API_KEY: SECRET, OTHER: "pass=word" } });
    const childEnv = labelledEnv(opts.env, opts.owner, opts.reason);
    const argv = systemdRunArgv(opts, childEnv);
    for (const key of Object.keys(childEnv)) expect(argv).toContain(`--setenv=${key}`);
    for (const value of Object.values(childEnv)) {
      for (const arg of argv) expect(arg.includes(`=${value}`) && arg.startsWith("--setenv")).toBe(false);
    }
    expect(argv.some((arg) => arg.includes(SECRET) || arg.includes("pass=word"))).toBe(false);
  });
});

describe("environment", () => {
  test("labelledEnv adds the label and leaves out undefined values", () => {
    expect(labelledEnv({ A: "1", B: undefined }, "o", "r")).toEqual({ A: "1", OCSUB_OWNER: "o", OCSUB_REASON: "r" });
  });

  test("busEnv fills the missing bus variables from the uid", () => {
    expect(busEnv({ HOME: "/h" }, 1000)).toEqual({
      HOME: "/h",
      XDG_RUNTIME_DIR: "/run/user/1000",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    });
  });

  test("busEnv keeps variables that exist", () => {
    const env = { XDG_RUNTIME_DIR: "/r", DBUS_SESSION_BUS_ADDRESS: "unix:path=/x" };
    expect(busEnv(env, 1000)).toEqual(env);
  });
});

describe("probeUserManager", () => {
  for (const [stdout, exitCode, expected] of [
    ["running\n", 0, true],
    ["degraded\n", 1, true],
    ["offline\n", 1, false],
    ["", 127, false],
  ] as const) {
    test(`'${stdout.trim()}' with exit ${exitCode} gives ${expected}`, () => {
      const run: UnitRunner = () => ({ stdout, exitCode });
      expect(probeUserManager(run, {})).toBe(expected);
    });
  }

  test("asks with the bus environment", () => {
    let seen: Record<string, string | undefined> | undefined;
    const run: UnitRunner = (_cmd, opts) => {
      seen = opts?.env;
      return { stdout: "running", exitCode: 0 };
    };
    probeUserManager(run, { XDG_RUNTIME_DIR: "/r" });
    expect(seen).toEqual({ XDG_RUNTIME_DIR: "/r" });
  });

  test("the real runner gives 127 for a missing binary", () => {
    expect(defaultUnitRunner(["ocsub-no-such-binary-xyz"]).exitCode).toBe(127);
  });
});

describe("startUnit", () => {
  test("starts a unit, reads its MainPID, and writes the PID file", () => {
    const { deps, calls, pids } = fakeDeps({
      "systemd-run": { stdout: "", exitCode: 0 },
      "systemctl show": { stdout: "777\n", exitCode: 0 },
    });
    const handle = startUnit(options(), deps);
    expect(handle.pid).toBe(777);
    expect(handle.unit).toBe("ocsub-serve-18768");
    expect(pids).toEqual([["/state/serve-18768.pid", 777]]);
    expect(calls[1]?.cmd).toEqual([
      "systemctl",
      "--user",
      "show",
      "--property=MainPID",
      "--value",
      "ocsub-serve-18768.service",
    ]);
  });

  test("gives systemd-run the child env plus the bus env, and no value on argv", () => {
    const { deps, calls } = fakeDeps({
      "systemd-run": { stdout: "", exitCode: 0 },
      "systemctl show": { stdout: "777\n", exitCode: 0 },
    });
    startUnit(options(), deps);
    const run = calls[0];
    expect(run?.env?.OPENROUTER_API_KEY).toBe(SECRET);
    expect(run?.env?.OCSUB_OWNER).toBe("proj");
    expect(run?.env?.OCSUB_REASON).toBe("host server");
    expect(run?.env?.DBUS_SESSION_BUS_ADDRESS).toBe("unix:path=/run/user/1000/bus");
    for (const arg of run?.cmd ?? []) expect(arg.includes(SECRET)).toBe(false);
    expect(run?.cmd).toContain("--setenv=OPENROUTER_API_KEY");
    expect(run?.cmd).toContain("--setenv=OCSUB_OWNER");
    // The bus variables are only for systemd-run, not for the child.
    expect(run?.cmd).not.toContain("--setenv=DBUS_SESSION_BUS_ADDRESS");
  });

  test("throws with the stderr of systemd-run and does not fall back", () => {
    const { deps, fallbacks, pids } = fakeDeps({
      "systemd-run": { stdout: "", exitCode: 1, stderr: "Failed to start transient service unit: Unit ocsub-serve-18768.service was already loaded or has a fragment file." },
    });
    expect(() => startUnit(options(), deps)).toThrow(/already loaded/);
    expect(fallbacks).toEqual([]);
    expect(pids).toEqual([]);
  });

  test("throws and writes no PID file when the unit has no main process", () => {
    const { deps, pids } = fakeDeps({
      "systemd-run": { stdout: "", exitCode: 0 },
      "systemctl show": { stdout: "0\n", exitCode: 0 },
    });
    expect(() => startUnit(options(), deps)).toThrow(/no main process/);
    expect(pids).toEqual([]);
  });

  test("falls back to the detached spawn with the label without a user manager", () => {
    const { deps, calls, fallbacks } = fakeDeps({}, false);
    const handle = startUnit(options(), deps);
    expect(handle).toMatchObject({ pid: 4242, unit: null });
    expect(handle.exitCode()).toBeNull();
    expect(calls).toEqual([]);
    expect(fallbacks[0]?.cmd).toEqual(["opencode", "serve", "--port", "18768"]);
    expect(fallbacks[0]?.env).toEqual({
      PATH: "/usr/bin",
      OPENROUTER_API_KEY: SECRET,
      OCSUB_OWNER: "proj",
      OCSUB_REASON: "host server",
    });
  });
});

describe("unitExitCode", () => {
  const show = (stdout: string, exitCode = 0) => fakeDeps({ "systemctl show": { stdout, exitCode } }).deps;

  test("is null while the unit runs or waits for a restart", () => {
    expect(unitExitCode(show("loaded\nactive\n0\n"), "u")).toBeNull();
    expect(unitExitCode(show("loaded\nactivating\n1\n"), "u")).toBeNull();
  });

  test("gives the exit status of a loaded unit that ended", () => {
    expect(unitExitCode(show("loaded\nfailed\n3\n"), "u")).toBe(3);
  });

  test("gives -1 for a unit that the manager unloaded", () => {
    expect(unitExitCode(show("not-found\ninactive\n0\n"), "u")).toBe(-1);
    expect(unitExitCode(show("", 1), "u")).toBe(-1);
  });
});

describe("stopUnit", () => {
  test("stops the unit and adds .service", () => {
    const { deps, calls } = fakeDeps({ "systemctl stop": { stdout: "", exitCode: 0 } });
    expect(stopUnit("ocsub-serve-1", deps)).toBe(true);
    expect(calls[0]?.cmd).toEqual(["systemctl", "--user", "stop", "ocsub-serve-1.service"]);
    expect(stopUnit("ocsub-serve-1.service", deps)).toBe(true);
    expect(calls[1]?.cmd).toEqual(["systemctl", "--user", "stop", "ocsub-serve-1.service"]);
  });

  test("a unit that is not loaded is no error", () => {
    const { deps } = fakeDeps({
      "systemctl stop": { stdout: "", exitCode: 5, stderr: "Failed to stop x.service: Unit x.service not loaded." },
    });
    expect(stopUnit("x", deps)).toBe(false);
  });

  test("throws on another failure", () => {
    const { deps } = fakeDeps({
      "systemctl stop": { stdout: "", exitCode: 1, stderr: "Failed to connect to bus" },
    });
    expect(() => stopUnit("x", deps)).toThrow(/Failed to connect to bus/);
  });
});

describe("units of a port", () => {
  test("the kinds are serve, proxy, holder, and idle, named by the port", () => {
    expect(PORT_UNIT_KINDS).toEqual(["serve", "proxy", "holder", "idle"]);
    expect(portUnitName("proxy", 4096)).toBe("ocsub-proxy-4096");
  });

  test("unitsAvailable asks the user manager", () => {
    expect(unitsAvailable(fakeDeps({}, true).deps)).toBe(true);
    expect(unitsAvailable(fakeDeps({}, false).deps)).toBe(false);
  });

  test("unitActive is true for a running unit only", () => {
    const show = (state: string) => fakeDeps({ "systemctl show": { stdout: `${state}\n`, exitCode: 0 } }).deps;
    expect(unitActive("ocsub-serve-1", show("active"))).toBe(true);
    expect(unitActive("ocsub-serve-1", show("activating"))).toBe(true);
    expect(unitActive("ocsub-serve-1", show("inactive"))).toBe(false);
    expect(unitActive("ocsub-serve-1", show("failed"))).toBe(false);
  });

  test("unitActive asks nothing without a user manager", () => {
    const { deps, calls } = fakeDeps({}, false);
    expect(unitActive("ocsub-serve-1", deps)).toBe(false);
    expect(calls).toEqual([]);
  });

  test("stopPortUnits stops the kinds in their order and names the stopped ones", () => {
    const { deps, calls } = fakeDeps({
      "systemctl stop": [
        { stdout: "", exitCode: 0 },
        { stdout: "", exitCode: 5, stderr: "Unit ocsub-proxy-4096.service not loaded." },
      ],
    });
    expect(stopPortUnits(4096, ["serve", "proxy"], deps)).toEqual(["ocsub-serve-4096"]);
    expect(calls.map((call) => call.cmd.join(" "))).toEqual([
      "systemctl --user stop ocsub-serve-4096.service",
      "systemctl --user stop ocsub-proxy-4096.service",
    ]);
  });

  test("stopPortUnits never stops the unit of the caller", () => {
    const { deps, calls } = fakeDeps({ "systemctl stop": { stdout: "", exitCode: 0 } });
    deps.ownUnit = () => "ocsub-idle-4096";
    expect(stopPortUnits(4096, ["serve", "idle"], deps)).toEqual(["ocsub-serve-4096"]);
    expect(calls).toHaveLength(1);
  });

  test("stopPortUnits does nothing without a user manager", () => {
    const { deps, calls } = fakeDeps({}, false);
    expect(stopPortUnits(4096, ["serve"], deps)).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("stopPortUnits throws when systemctl fails", () => {
    const { deps } = fakeDeps({ "systemctl stop": { stdout: "", exitCode: 1, stderr: "Failed to connect to bus" } });
    expect(() => stopPortUnits(4096, ["serve"], deps)).toThrow(/Failed to connect to bus/);
  });
});

describe("parseUnitShow", () => {
  test("reads the active state when the query asks for it", () => {
    const text = [
      "Id=ocsub-serve-4096.service",
      "Description=owner=proj reason=opencode server",
      "WorkingDirectory=/work",
      "ActiveState=active",
      "",
      "Id=ocsub-proxy-4096.service",
      "Description=owner=proj reason=cost proxy",
      "WorkingDirectory=",
      "ActiveState=failed",
    ].join("\n");
    expect(parseUnitShow(text)).toEqual([
      { unit: "ocsub-serve-4096", description: "owner=proj reason=opencode server", workingDirectory: "/work", activeState: "active" },
      { unit: "ocsub-proxy-4096", description: "owner=proj reason=cost proxy", workingDirectory: "", activeState: "failed" },
    ]);
  });

  test("gives an empty value for a property that the query left out, and keeps = in a value", () => {
    expect(parseUnitShow("Id=ocsub-x-1.service\nDescription=owner=a reason=b=c\n")).toEqual([
      { unit: "ocsub-x-1", description: "owner=a reason=b=c", workingDirectory: "", activeState: "" },
    ]);
  });
});

describe("parseUnitLabel", () => {
  test("reads the owner and the reason that unitDescription writes", () => {
    expect(parseUnitLabel(unitDescription("proj", "opencode server of up on port 4096"))).toEqual({
      owner: "proj",
      reason: "opencode server of up on port 4096",
    });
  });

  test("keeps an empty reason", () => {
    expect(parseUnitLabel("owner=proj reason=")).toEqual({ owner: "proj", reason: "" });
  });

  test("gives no owner and the whole text for another form", () => {
    expect(parseUnitLabel("/usr/bin/sleep 100")).toEqual({ owner: "", reason: "/usr/bin/sleep 100" });
    expect(parseUnitLabel("reason=x owner=y")).toEqual({ owner: "", reason: "reason=x owner=y" });
    expect(parseUnitLabel("")).toEqual({ owner: "", reason: "" });
  });
});

describe("listUnits", () => {
  const show = "Id=ocsub-serve-4096.service\nDescription=owner=proj reason=r\nWorkingDirectory=/work\nActiveState=active\n";

  test("asks systemctl once for all ocsub units with the bus environment", () => {
    const { deps, calls } = fakeDeps({ "systemctl show": { stdout: show, exitCode: 0 } });
    expect(listUnits(deps)).toEqual([
      { unit: "ocsub-serve-4096", description: "owner=proj reason=r", workingDirectory: "/work", activeState: "active" },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cmd).toEqual([
      "systemctl",
      "--user",
      "show",
      "ocsub-*",
      "--property=Id,Description,WorkingDirectory,ActiveState",
    ]);
    expect(calls[0]?.env?.XDG_RUNTIME_DIR).toBe("/run/user/1000");
  });

  test("gives an empty list when no unit is loaded", () => {
    const { deps } = fakeDeps({ "systemctl show": { stdout: "", exitCode: 0 } });
    expect(listUnits(deps)).toEqual([]);
  });

  test("gives null without a user manager, and makes no call", () => {
    const { deps, calls } = fakeDeps({}, false);
    expect(listUnits(deps)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  test("gives null when the call fails", () => {
    const { deps } = fakeDeps({ "systemctl show": { stdout: "", exitCode: 1, stderr: "Failed to connect to bus" } });
    expect(listUnits(deps)).toBeNull();
  });
});

describe("orphanedUnits", () => {
  const loaded = (unit: string, workingDirectory = "/work"): LoadedUnit => ({
    unit,
    description: "owner=proj reason=r",
    workingDirectory,
    activeState: "active",
  });
  const all = () => true;

  test("finds no orphan in a full set of units of one port", () => {
    const units = ["serve", "proxy", "idle"].map((kind) => loaded(`ocsub-${kind}-4096`));
    expect(orphanedUnits(units, all)).toEqual([]);
  });

  test("a holder unit also keeps the helpers of its port", () => {
    expect(orphanedUnits([loaded("ocsub-holder-4096"), loaded("ocsub-idle-4096")], all)).toEqual([]);
  });

  test("a unit whose folder is gone is orphaned", () => {
    const units = [loaded("ocsub-serve-4096", "/gone"), loaded("ocsub-serve-4097", "/work")];
    const orphans = orphanedUnits(units, (dir) => dir !== "/gone");
    expect(orphans.map((u) => u.unit)).toEqual(["ocsub-serve-4096"]);
    expect(orphans[0]?.cause).toBe("its folder /gone is gone");
  });

  test("an empty folder counts as unknown, not as missing", () => {
    expect(orphanedUnits([loaded("ocsub-serve-4096", "")], () => false)).toEqual([]);
  });

  test("a proxy or idle unit without a server unit on its port is orphaned", () => {
    const units = [loaded("ocsub-serve-4096"), loaded("ocsub-proxy-4097"), loaded("ocsub-idle-4098"), loaded("ocsub-idle-4096")];
    const orphans = orphanedUnits(units, all);
    expect(orphans.map((u) => [u.unit, u.cause])).toEqual([
      ["ocsub-proxy-4097", "no serve or holder unit runs on port 4097"],
      ["ocsub-idle-4098", "no serve or holder unit runs on port 4098"],
    ]);
  });

  test("a unit of another form is orphaned only when its folder is gone", () => {
    const units = [loaded("ocsub-test-1-2"), loaded("ocsub-idle-proj")];
    expect(orphanedUnits(units, all)).toEqual([]);
    expect(orphanedUnits(units, () => false).map((u) => u.unit)).toEqual(["ocsub-test-1-2", "ocsub-idle-proj"]);
  });

  test("the folder cause comes first and a unit is listed once", () => {
    const orphans = orphanedUnits([loaded("ocsub-proxy-4096", "/gone")], () => false);
    expect(orphans).toHaveLength(1);
    expect(orphans[0]?.cause).toContain("is gone");
  });
});

describe("unitOfCgroup", () => {
  test("finds the ocsub unit in a cgroup v2 path", () => {
    const text = "0::/user.slice/user-1000.slice/user@1000.service/ocsub.slice/ocsub-idle-4096.service\n";
    expect(unitOfCgroup(text)).toBe("ocsub-idle-4096");
  });

  test("gives null for another unit or an empty text", () => {
    expect(unitOfCgroup("0::/user.slice/user-1000.slice/session-3.scope\n")).toBeNull();
    expect(unitOfCgroup("")).toBeNull();
  });
});

// The live test starts a real unit. It runs only when a user manager answers.
const live = defaultUnitDeps.available();

describe.skipIf(!live)("live: a real transient user service", () => {
  const unit = `ocsub-test-${process.pid}-${Date.now()}`;
  let dir = "";

  afterEach(() => {
    // Stop the unit also after a failed assertion, so no test leaves a process behind.
    stopUnit(unit);
    if (dir !== "") rmSync(dir, { recursive: true, force: true });
  });

  test("starts with the label, reaches the group, and stops", () => {
    dir = mkdtempSync(path.join(tmpdir(), "ocsub-units-"));
    const pidPath = path.join(dir, "sleep.pid");
    const started = performance.now();
    const handle = startUnit({
      kind: "test",
      name: unit.slice("ocsub-test-".length),
      owner: "test",
      reason: "live test of units.ts",
      cmd: ["sleep", "30"],
      cwd: dir,
      env: { PATH: process.env.PATH, OCSUB_TEST_SECRET: SECRET },
      logPath: path.join(dir, "sleep.log"),
      pidPath,
    });
    const startMs = performance.now() - started;
    console.log(`live startUnit took ${startMs.toFixed(1)} ms`);
    expect(handle.unit).toBe(unit);

    const show = defaultUnitRunner(
      ["systemctl", "--user", "show", "--property=Description", "--property=ActiveState", "--value", `${unit}.service`],
      { env: defaultUnitDeps.busEnv() },
    );
    expect(show.stdout.split("\n").slice(0, 2)).toEqual(["owner=test reason=live test of units.ts", "active"]);
    expect(handle.exitCode()).toBeNull();

    const pid = Number.parseInt(readFileSync(pidPath, "utf8"), 10);
    expect(pid).toBe(handle.pid);
    // systemd starts the service with setsid, so the PID is also the group ID.
    expect(() => process.kill(-pid, 0)).not.toThrow();
    // The manager reports the MainPID before `systemd-executor` execs the
    // command, and until then /proc/<pid>/environ is not readable. Wait for
    // the exec of `sleep`.
    const deadline = Date.now() + 5000;
    while (readFileSync(`/proc/${pid}/comm`, "utf8").trim() !== "sleep" && Date.now() < deadline) Bun.sleepSync(10);
    const environ = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
    expect(environ).toContain("OCSUB_OWNER=test");
    expect(environ).toContain(`OCSUB_TEST_SECRET=${SECRET}`);

    expect(stopUnit(unit)).toBe(true);
    const after = defaultUnitRunner(
      ["systemctl", "--user", "show", "--property=LoadState", "--value", `${unit}.service`],
      { env: defaultUnitDeps.busEnv() },
    );
    expect(after.stdout.trim()).toBe("not-found");
    expect(() => process.kill(pid, 0)).toThrow();
    expect(stopUnit(unit)).toBe(false);
  });
});
