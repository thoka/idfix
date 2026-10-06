import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  DRIVERS,
  dispatchSession,
  lookupDriver,
  opencodeDriver,
  sessionDriver,
  unknownDriverLine,
  type Driver,
  type DriverRegistry,
  type SessionDriverDeps,
} from "../src/driver";
import { makeRunRecord, recordDriver, type RunRecord } from "../src/runs";

const ENV = { XDG_STATE_HOME: "/tmp/opencode/driver-test/state" };

function record(driver?: RunRecord["driver"]): RunRecord {
  return makeRunRecord({ sessionId: "ses_1", directory: "/w", agent: "coder", driver });
}

/** A driver whose members record their calls and return `code`. */
function fakeDriver(name: Driver["name"], calls: string[], code = 0): Driver {
  const member = (what: string) => async () => {
    calls.push(`${name}:${what}`);
    return code;
  };
  return {
    name,
    run: member("run"),
    say: member("say"),
    abort: member("abort"),
    watch: member("watch"),
    log: member("log"),
  };
}

describe("makeRunRecord driver", () => {
  test("leaves the field out without a driver", () => {
    const made = record();
    expect("driver" in made).toBe(false);
  });

  test("writes the driver when given", () => {
    expect(record("opencode").driver).toBe("opencode");
    expect(record("claude-glm").driver).toBe("claude-glm");
  });
});

describe("recordDriver", () => {
  test("a record without driver is an opencode record", () => {
    expect(recordDriver(record())).toBe("opencode");
  });

  test("returns the named driver", () => {
    expect(recordDriver(record("claude"))).toBe("claude");
  });

  test("an empty or non-string driver means opencode", () => {
    expect(recordDriver({ ...record(), driver: "" as never })).toBe("opencode");
    expect(recordDriver({ ...record(), driver: 3 as never })).toBe("opencode");
  });

  test("keeps a name that this version does not know", () => {
    expect(recordDriver({ ...record(), driver: "codex" as never })).toBe("codex");
  });
});

describe("driver registry", () => {
  test("holds only the opencode driver", () => {
    expect(lookupDriver(DRIVERS, "opencode")).toBe(opencodeDriver);
    expect(opencodeDriver.name).toBe("opencode");
    expect(lookupDriver(DRIVERS, "claude")).toBeUndefined();
    expect(lookupDriver(DRIVERS, "claude-glm")).toBeUndefined();
  });

  test("ignores inherited object keys", () => {
    expect(lookupDriver(DRIVERS, "toString")).toBeUndefined();
    expect(lookupDriver(DRIVERS, "__proto__")).toBeUndefined();
  });
});

describe("sessionDriver", () => {
  const calls: string[] = [];
  const registry: DriverRegistry = {
    opencode: fakeDriver("opencode", calls),
    claude: fakeDriver("claude", calls),
  };
  const deps = (load: SessionDriverDeps["load"]): SessionDriverDeps => ({ registry, load });

  test("no record means opencode", async () => {
    expect(await sessionDriver("ses_1", "/w", ENV, deps(async () => null))).toBe(registry.opencode!);
  });

  test("a record without driver means opencode", async () => {
    expect(await sessionDriver("ses_1", "/w", ENV, deps(async () => record()))).toBe(registry.opencode!);
  });

  test("a record picks its driver", async () => {
    expect(await sessionDriver("ses_1", "/w", ENV, deps(async () => record("claude")))).toBe(registry.claude!);
  });

  test("a failed lookup means opencode", async () => {
    const failing = async (): Promise<RunRecord | null> => {
      throw new Error("disk gone");
    };
    expect(await sessionDriver("ses_1", "/w", ENV, deps(failing))).toBe(registry.opencode!);
  });

  test("a driver without an entry gives the error line", async () => {
    expect(await sessionDriver("ses_1", "/w", ENV, deps(async () => record("claude-glm")))).toBe(
      "idfx cannot drive claude-glm sessions yet",
    );
  });

  test("passes the session, the folder, and the environment to the lookup", async () => {
    const seen: unknown[] = [];
    await sessionDriver("ses_9", "/project", ENV, deps(async (...args) => (seen.push(...args), null)));
    expect(seen).toEqual(["ses_9", "/project", ENV]);
  });
});

describe("dispatchSession", () => {
  let calls: string[];
  let errors: string[];
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    calls = [];
    errors = [];
    errorSpy = spyOn(console, "error").mockImplementation((line: unknown) => {
      errors.push(String(line));
    });
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  function depsFor(found: RunRecord | null): SessionDriverDeps {
    return {
      registry: { opencode: fakeDriver("opencode", calls), claude: fakeDriver("claude", calls, 7) },
      load: async () => found,
    };
  }

  test("calls the opencode driver without a record", async () => {
    const code = await dispatchSession({ session: "ses_1", dir: "/w" }, (d) => d.say({ session: "ses_1", text: "hi" }), ENV, depsFor(null));
    expect(code).toBe(0);
    expect(calls).toEqual(["opencode:say"]);
    expect(errors).toEqual([]);
  });

  test("calls the driver of the record and returns its exit code", async () => {
    const code = await dispatchSession({ session: "ses_1" }, (d) => d.log({ session: "ses_1" }), ENV, depsFor(record("claude")));
    expect(code).toBe(7);
    expect(calls).toEqual(["claude:log"]);
  });

  test("prints one error line and exits 1 for a driver without an entry", async () => {
    const code = await dispatchSession(
      { session: "ses_1" },
      (d) => d.abort({ session: "ses_1" }),
      ENV,
      depsFor(record("claude-glm")),
    );
    expect(code).toBe(1);
    expect(calls).toEqual([]);
    expect(errors).toEqual([unknownDriverLine("claude-glm")]);
  });

  test("uses the current folder without --dir", async () => {
    const seen: string[] = [];
    const deps: SessionDriverDeps = {
      registry: { opencode: fakeDriver("opencode", calls) },
      load: async (_id, cwd) => (seen.push(cwd), null),
    };
    await dispatchSession({ session: "ses_1" }, (d) => d.watch({ session: "ses_1", json: false }), ENV, deps);
    expect(seen).toEqual([process.cwd()]);
  });
});
