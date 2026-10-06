import { describe, expect, test } from "bun:test";
import { parseUnitShow, type LoadedUnit } from "../src/units";
import { runFolderOf, unitsToReap } from "./setup";

// The pure parts of the unit reaper of the test preload (test/setup.ts).
const TMP = "/tmp";
const THIS_RUN = "/tmp/oc-sub-test-run-aaaa";
const OTHER_RUN = "/tmp/oc-sub-test-run-bbbb";

function unit(name: string, description: string, workingDirectory = `${THIS_RUN}/oc-sub-it-x`, activeState = ""): LoadedUnit {
  return { unit: name, description, workingDirectory, activeState };
}

describe("parseUnitShow", () => {
  test("reads one unit per block, without the .service suffix", () => {
    const text = [
      "Id=ocsub-serve-8790.service",
      "Description=owner=test reason=opencode server of up on port 8790",
      "WorkingDirectory=/tmp/oc-sub-test-run-aaaa/oc-sub-it-x",
      "",
      "Id=ocsub-idle-4096.service",
      "Description=owner=proj reason=idle watchdog",
      "WorkingDirectory=/home/user/state",
      "",
    ].join("\n");
    expect(parseUnitShow(text)).toEqual([
      unit("ocsub-serve-8790", "owner=test reason=opencode server of up on port 8790"),
      unit("ocsub-idle-4096", "owner=proj reason=idle watchdog", "/home/user/state"),
    ]);
  });

  test("gives no unit for empty output", () => {
    expect(parseUnitShow("")).toEqual([]);
    expect(parseUnitShow("\n")).toEqual([]);
  });
});

describe("runFolderOf", () => {
  test("finds the run folder of a path inside it", () => {
    expect(runFolderOf(`${THIS_RUN}/oc-sub-it-x/state/oc-sub`, TMP)).toBe(THIS_RUN);
    expect(runFolderOf(THIS_RUN, TMP)).toBe(THIS_RUN);
  });

  test("gives null outside a run folder", () => {
    expect(runFolderOf("/tmp/other/x", TMP)).toBeNull();
    expect(runFolderOf("/home/user/project", TMP)).toBeNull();
    expect(runFolderOf("/tmp", TMP)).toBeNull();
    expect(runFolderOf("", TMP)).toBeNull();
  });
});

describe("unitsToReap", () => {
  const onlyThisRun = (run: string) => run === THIS_RUN;
  const names = (units: LoadedUnit[]) => units.map((u) => u.unit);

  test("stops a test unit of an integration port and an ocsub-test unit of this run", () => {
    const units = [
      unit("ocsub-serve-8790", "owner=test reason=opencode server of up on port 8790"),
      unit("ocsub-proxy-8900", "owner=test reason=cost proxy for port 8900"),
      unit("ocsub-test-123-456", "owner=test reason=live test of units.ts"),
    ];
    expect(names(unitsToReap(units, TMP, onlyThisRun))).toEqual(["ocsub-serve-8790", "ocsub-proxy-8900", "ocsub-test-123-456"]);
  });

  test("stops the test units with the new prefix idfx- too", () => {
    const units = [
      unit("idfx-serve-8790", "owner=test reason=opencode server of up on port 8790"),
      unit("idfx-test-123-456", "owner=test reason=live test of units.ts"),
      unit("idfx-serve-4096", "owner=test reason=x"),
      unit("idfx-watch", "owner=test reason=x"),
    ];
    expect(names(unitsToReap(units, TMP, onlyThisRun))).toEqual(["idfx-serve-8790", "idfx-test-123-456"]);
  });

  test("never touches a unit with another owner, also on a test port in a run folder", () => {
    const units = [
      unit("ocsub-serve-8790", "owner=idfix reason=opencode server of up on port 8790"),
      unit("ocsub-serve-8791", "owner=testing reason=x"),
      unit("ocsub-serve-8792", "owner=test"),
      unit("ocsub-serve-8793", "reason=x owner=test "),
    ];
    expect(unitsToReap(units, TMP, onlyThisRun)).toEqual([]);
  });

  test("keeps a test unit outside the integration ports", () => {
    const units = [
      unit("ocsub-serve-4096", "owner=test reason=x"),
      unit("ocsub-serve-8789", "owner=test reason=x"),
      unit("ocsub-serve-8901", "owner=test reason=x"),
    ];
    expect(unitsToReap(units, TMP, onlyThisRun)).toEqual([]);
  });

  test("keeps a test unit of a run that still works, and of no run folder", () => {
    const units = [
      unit("ocsub-serve-8790", "owner=test reason=x", `${OTHER_RUN}/oc-sub-it-y`),
      unit("ocsub-serve-8791", "owner=test reason=x", "/home/user/project"),
    ];
    expect(unitsToReap(units, TMP, onlyThisRun)).toEqual([]);
    // A run whose bun process is gone counts as reapable.
    expect(names(unitsToReap(units, TMP, () => true))).toEqual(["ocsub-serve-8790"]);
  });
});
