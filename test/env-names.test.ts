import { describe, expect, test } from "bun:test";
import { resolveServerUrl } from "../src/config";
import { ENV_NAMES, idfxEnv } from "../src/env-names";
import { sharedAgentsDir } from "../src/shared";
import { unitOwner } from "../src/units";

/** The old name of step 24.3 for a new name, for example IDFX_URL to its old OC_SUB name. */
const oldName = (name: string): string => name.replace(/^IDFX/, "OC_SUB");

describe("idfxEnv", () => {
  for (const [key, name] of Object.entries(ENV_NAMES) as Array<[keyof typeof ENV_NAMES, string]>) {
    describe(name, () => {
      test("reads the new name", () => {
        expect(idfxEnv({ [name]: "new" }, key)).toBe("new");
      });

      test("ignores the old name", () => {
        expect(idfxEnv({ [oldName(name)]: "old" }, key)).toBeUndefined();
        expect(idfxEnv({ [name]: "new", [oldName(name)]: "old" }, key)).toBe("new");
      });

      test("a blank value counts as unset", () => {
        expect(idfxEnv({}, key)).toBeUndefined();
        expect(idfxEnv({ [name]: "" }, key)).toBeUndefined();
        expect(idfxEnv({ [name]: "  " }, key)).toBeUndefined();
      });
    });
  }
});

describe("the readers use only the new names", () => {
  test("resolveServerUrl reads IDFX_URL and ignores the old name", () => {
    expect(resolveServerUrl(undefined, { IDFX_URL: "http://10.0.0.2:2" })).toBe("http://10.0.0.2:2");
    expect(resolveServerUrl(undefined, { [oldName("IDFX_URL")]: "http://10.0.0.1:1" })).toBe(resolveServerUrl(undefined, {}));
  });

  test("sharedAgentsDir reads IDFX_SHARED_DIR and ignores the old name", () => {
    expect(sharedAgentsDir({ IDFX_SHARED_DIR: "/new" })).toBe("/new");
    expect(sharedAgentsDir({ [oldName("IDFX_SHARED_DIR")]: "/old" })).toBeUndefined();
  });

  test("unitOwner reads IDFX_OWNER and ignores the old name", () => {
    expect(unitOwner({ IDFX_OWNER: "new" }, "proj")).toBe("new");
    expect(unitOwner({ [oldName("IDFX_OWNER")]: "old" }, "proj")).toBe("proj");
  });
});
