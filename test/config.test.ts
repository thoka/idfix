import { describe, expect, test } from "bun:test";
import { authHeaderFromEnv, DEFAULT_PORT, DEFAULT_SERVER_URL, portFromUrl, resolvePort, resolveServerUrl } from "../src/config";

describe("resolveServerUrl", () => {
  test("prefers the flag over the environment and the default", () => {
    expect(resolveServerUrl("http://127.0.0.1:9000", { OC_SUB_URL: "http://10.0.0.1:1" })).toBe("http://127.0.0.1:9000");
  });

  test("uses OC_SUB_URL when no flag is given", () => {
    expect(resolveServerUrl(undefined, { OC_SUB_URL: "http://10.0.0.1:1" })).toBe("http://10.0.0.1:1");
  });

  test("falls back to the default", () => {
    expect(resolveServerUrl(undefined, {})).toBe(DEFAULT_SERVER_URL);
  });

  test("adds a scheme and strips trailing slashes", () => {
    expect(resolveServerUrl("localhost:8767", {})).toBe("http://localhost:8767");
    expect(resolveServerUrl("127.0.0.1:8767/", {})).toBe("http://127.0.0.1:8767");
    expect(resolveServerUrl("http://host:1///", {})).toBe("http://host:1");
  });

  test("rejects an empty value", () => {
    expect(() => resolveServerUrl("   ", {})).toThrow(/empty/);
  });
});

describe("authHeaderFromEnv", () => {
  test("is undefined without a password", () => {
    expect(authHeaderFromEnv({})).toBeUndefined();
    expect(authHeaderFromEnv({ OPENCODE_SERVER_PASSWORD: "" })).toBeUndefined();
  });

  test("encodes user and password as basic auth", () => {
    const header = authHeaderFromEnv({ OPENCODE_SERVER_PASSWORD: "secret", OPENCODE_SERVER_USERNAME: "me" });
    expect(header).toBe(`Basic ${Buffer.from("me:secret").toString("base64")}`);
  });

  test("defaults the username to opencode", () => {
    const header = authHeaderFromEnv({ OPENCODE_SERVER_PASSWORD: "secret" });
    expect(header).toBe(`Basic ${Buffer.from("opencode:secret").toString("base64")}`);
  });

  test("never exposes the secret in plain form", () => {
    const header = authHeaderFromEnv({ OPENCODE_SERVER_PASSWORD: "secret" });
    expect(header).not.toContain("secret:");
  });
});

describe("portFromUrl", () => {
  test("reads the port", () => {
    expect(portFromUrl("http://127.0.0.1:8767")).toBe(8767);
  });

  test("is undefined without a port or on a bad URL", () => {
    expect(portFromUrl("http://127.0.0.1")).toBeUndefined();
    expect(portFromUrl("not a url")).toBeUndefined();
  });
});

describe("resolvePort", () => {
  test("prefers the flag, then the port of the URL, then the default", () => {
    expect(resolvePort(9000, "http://127.0.0.1:8767")).toBe(9000);
    expect(resolvePort(undefined, "http://127.0.0.1:8790")).toBe(8790);
    expect(resolvePort(undefined, "http://127.0.0.1")).toBe(DEFAULT_PORT);
  });
});
