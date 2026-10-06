/**
 * A fake user manager for the unit tests of `up`, `down`, sandbox mode, the
 * watchdog, and `doctor`. It answers `systemctl --user stop` and `systemctl
 * --user show --property=ActiveState` from a set of loaded units, and records
 * each stop in order. It answers the list query `systemctl --user show
 * 'ocsub-*'` of `listUnits` with the text of `show`, or, without `show`,
 * with one `Id=` block per loaded unit. A `show` of null makes the list query
 * fail. No test that uses it reaches the real `systemctl`.
 */
import type { UnitDeps, UnitRunner } from "../src/units";

export type FakeUnits = {
  deps: UnitDeps;
  /** Each `systemctl` call as `<verb> <unit>`, for example `stop ocsub-serve-8790`, in order. */
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
  } = {},
): FakeUnits {
  const calls: string[] = [];
  const loaded = new Set(opts.loaded ?? []);
  const run: UnitRunner = (cmd) => {
    const unit = (cmd[cmd.length - 1] ?? "").replace(/\.service$/, "");
    if (cmd[0] === "systemctl" && cmd[2] === "stop") {
      calls.push(`stop ${unit}`);
      if (unit === opts.failStop) return { stdout: "", exitCode: 1, stderr: "Failed to connect to bus" };
      if (!loaded.delete(unit)) return { stdout: "", exitCode: 5, stderr: `Unit ${unit}.service not loaded.` };
      return { stdout: "", exitCode: 0 };
    }
    if (cmd[0] === "systemctl" && cmd[2] === "show" && cmd[3] === "ocsub-*") {
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
  return { deps, calls, loaded };
}

/** A user manager that does not answer: the fallback path. */
export function noUnits(): UnitDeps {
  return fakeUnits({ available: false }).deps;
}
