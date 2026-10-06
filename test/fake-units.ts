/**
 * A fake user manager for the unit tests of `up`, `down`, sandbox mode, the
 * watchdog, and `doctor`. It answers `systemctl --user stop` and `systemctl
 * --user show --property=ActiveState` from a set of loaded units, and records
 * each stop in order. It answers the list query `systemctl --user show
 * 'idfx-*' 'ocsub-*'` of `listUnits` with the text of `show`, or, without `show`,
 * with one `Id=` block per loaded unit. A `show` of null makes the list query
 * fail. No test that uses it reaches the real `systemctl`.
 *
 * For the installed units of `doctor` (`host-proxy`), it keeps a state per
 * unit in `states`: `UnitFileState` and `ActiveState`. It answers `systemctl
 * --user show <unit> --property=UnitFileState,ActiveState` from it, in the
 * order of systemd (ActiveState first), and records `daemon-reload`,
 * `enable`, `start`, and `restart` as calls such as `enable idfx-proxy`,
 * with their effect on the state. `fail` names a call that fails.
 */
import type { UnitDeps, UnitRunner } from "../src/units";

/** The state of an installed unit in the fake. */
export type FakeUnitState = { fileState: string; active: string };

export type FakeUnits = {
  deps: UnitDeps;
  /** The state of each installed unit, without `.service`. */
  states: Map<string, FakeUnitState>;
  /** Each `systemctl` call as `<verb> <unit>`, for example `stop idfx-serve-8790`, in order. */
  calls: string[];
  /** The units that are loaded now, without `.service`. */
  loaded: Set<string>;
};

export function fakeUnits(
  opts: {
    available?: boolean;
    loaded?: readonly string[];
    own?: string | null;
    failStop?: string;
    show?: string | null;
    states?: Record<string, FakeUnitState>;
    /** A call that fails, as recorded, for example `start idfx-proxy` or `daemon-reload`. */
    fail?: string;
  } = {},
): FakeUnits {
  const calls: string[] = [];
  const loaded = new Set(opts.loaded ?? []);
  const states = new Map(Object.entries(opts.states ?? {}).map(([name, state]) => [name, { ...state }]));
  const failed = (call: string) => ({ stdout: "", exitCode: 1, stderr: `fake failure of ${call}` });
  const run: UnitRunner = (cmd) => {
    if (cmd[0] === "systemctl" && cmd[2] === "show" && cmd.includes("--property=UnitFileState,ActiveState")) {
      const name = (cmd[3] ?? "").replace(/\.service$/, "");
      calls.push(`show-state ${name}`);
      if (opts.fail === `show-state ${name}`) return failed(`show-state ${name}`);
      const state = states.get(name) ?? { fileState: "", active: "inactive" };
      return { stdout: `ActiveState=${state.active}\nUnitFileState=${state.fileState}\n`, exitCode: 0 };
    }
    if (cmd[0] === "systemctl" && cmd[2] === "daemon-reload") {
      calls.push("daemon-reload");
      return opts.fail === "daemon-reload" ? failed("daemon-reload") : { stdout: "", exitCode: 0 };
    }
    if (cmd[0] === "systemctl" && ["enable", "start", "restart"].includes(cmd[2] ?? "")) {
      const verb = cmd[2] as string;
      const name = (cmd[3] ?? "").replace(/\.service$/, "");
      const call = `${verb} ${name}`;
      calls.push(call);
      if (opts.fail === call) return failed(call);
      const state = states.get(name) ?? { fileState: "", active: "inactive" };
      if (verb === "enable") state.fileState = "enabled";
      else state.active = "active";
      states.set(name, state);
      return { stdout: "", exitCode: 0 };
    }
    const unit = (cmd[cmd.length - 1] ?? "").replace(/\.service$/, "");
    if (cmd[0] === "systemctl" && cmd[2] === "stop") {
      calls.push(`stop ${unit}`);
      if (unit === opts.failStop) return { stdout: "", exitCode: 1, stderr: "Failed to connect to bus" };
      if (!loaded.delete(unit)) return { stdout: "", exitCode: 5, stderr: `Unit ${unit}.service not loaded.` };
      return { stdout: "", exitCode: 0 };
    }
    if (cmd[0] === "systemctl" && cmd[2] === "show" && cmd[3] === "idfx-*") {
      calls.push("list");
      if (opts.show === null) return { stdout: "", exitCode: 1, stderr: "Failed to connect to bus" };
      const text = opts.show ?? [...loaded].map((name) => `Id=${name}.service\n`).join("\n");
      return { stdout: text, exitCode: 0 };
    }
    if (cmd[0] === "systemctl" && cmd[2] === "show") {
      calls.push(`show ${unit}`);
      return { stdout: loaded.has(unit) ? "active\n" : "inactive\n", exitCode: 0 };
    }
    calls.push(cmd.join(" "));
    return { stdout: "", exitCode: 1, stderr: "the fake runs no other command" };
  };
  const deps: UnitDeps = {
    run,
    available: () => opts.available ?? true,
    busEnv: () => ({}),
    spawnFallback: () => {
      throw new Error("the fake starts no process");
    },
    writePid: () => {},
    ownUnit: () => opts.own ?? null,
  };
  return { deps, calls, loaded, states };
}

/** A user manager that does not answer: the fallback path. */
export function noUnits(): UnitDeps {
  return fakeUnits({ available: false }).deps;
}
