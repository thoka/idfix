import { describe, expect, test } from "bun:test";
import { resolveServerUrl } from "../src/config";
import { ENV_NAMES, idfxEnv, oldOnlyEnvNames } from "../src/env-names";
import { sharedAgentsDir } from "../src/shared";
import { unitOwner } from "../src/units";

describe("idfxEnv", () => {
  for (const [key, { name, old }] of Object.entries(ENV_NAMES) as Array<[keyof typeof ENV_NAMES, { name: string; old: string }]>) {
    describe(name, () => {
      test("the new name wins over the old name", () => {
        expect(idfxEnv({ [name]: "new", [old]: "old" }, key)).toBe("new");
      });

      test("the old name works alone", () => {
        expect(idfxEnv({ [old]: "old" }, key)).toBe("old");
      });

      test("a blank new name falls back to the old name", () => {
        expect(idfxEnv({ [name]: "  ", [old]: "old" }, key)).toBe("old");
        expect(idfxEnv({ [name]: "", [old]: "old" }, key)).toBe("old");
      });

      test("is undefined when no name is set or both are blank", () => {
        expect(idfxEnv({}, key)).toBeUndefined();
        expect(idfxEnv({ [name]: "", [old]: " " }, key)).toBeUndefined();
      });
    });
  }
});

describe("the readers of the variables", () => {
  test("resolveServerUrl reads IDFX_URL first, then OC_SUB_URL", () => {
    expect(resolveServerUrl(undefined, { IDFX_URL: "http://10.0.0.2:2", OC_SUB_URL: "http://10.0.0.1:1" })).toBe("http://10.0.0.2:2");
    expect(resolveServerUrl(undefined, { OC_SUB_URL: "http://10.0.0.1:1" })).toBe("http://10.0.0.1:1");
  });

  test("sharedAgentsDir reads IDFX_SHARED_DIR first, then OC_SUB_SHARED_DIR", () => {
    expect(sharedAgentsDir({ IDFX_SHARED_DIR: "/new", OC_SUB_SHARED_DIR: "/old" })).toBe("/new");
    expect(sharedAgentsDir({ OC_SUB_SHARED_DIR: "/old" })).toBe("/old");
  });

  test("unitOwner reads IDFX_OWNER first, then OC_SUB_OWNER", () => {
    expect(unitOwner({ IDFX_OWNER: "new", OC_SUB_OWNER: "old" }, "proj")).toBe("new");
    expect(unitOwner({ OC_SUB_OWNER: "old" }, "proj")).toBe("old");
    expect(unitOwner({}, "proj")).toBe("proj");
  });
});

describe("oldOnlyEnvNames", () => {
  test("lists each variable that has only the old name set", () => {
    expect(oldOnlyEnvNames({ OC_SUB_URL: "x", OC_SUB_SHARED_DIR: "/a", IDFX_SHARED_DIR: "/a" })).toEqual([ENV_NAMES.url]);
  });

  test("ignores a blank old name and gives an empty list without old names", () => {
    expect(oldOnlyEnvNames({ OC_SUB_OWNER: " " })).toEqual([]);
    expect(oldOnlyEnvNames({ IDFX_URL: "x" })).toEqual([]);
  });
});
