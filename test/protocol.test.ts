import { describe, expect, test } from "bun:test";
import { checkoutVersionSources, idfxVersion, packageVersion, toolVersion, UNKNOWN_VERSION } from "../src/protocol";

describe("toolVersion", () => {
  test("takes the version of package.json first", () => {
    expect(toolVersion({ packageJson: () => '{"version": "0.25.0"}', gitSha: () => "abc1234" })).toBe("0.25.0");
  });

  test("takes the short git SHA when package.json has no version", () => {
    expect(toolVersion({ packageJson: () => '{"name": "idfix"}', gitSha: () => "abc1234" })).toBe("abc1234");
    expect(toolVersion({ packageJson: () => null, gitSha: () => "abc1234" })).toBe("abc1234");
  });

  test("gives 0.0.0 without both", () => {
    expect(toolVersion({ packageJson: () => "{ no json", gitSha: () => null })).toBe(UNKNOWN_VERSION);
  });

  test("ignores an empty or non-string version", () => {
    expect(packageVersion('{"version": ""}')).toBeNull();
    expect(packageVersion('{"version": 3}')).toBeNull();
  });

  test("the checkout of this repository has a version", () => {
    const version = idfxVersion();
    expect(version.length).toBeGreaterThan(0);
    // idfix has no version in package.json, so this is the git SHA of the checkout.
    expect(version).toBe(checkoutVersionSources().gitSha() ?? UNKNOWN_VERSION);
  });
});
