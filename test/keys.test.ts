import { describe, expect, test } from "bun:test";
import { fetchKeyUsage, keyFingerprint, sharedKeyRefusal, type KeyOwner } from "../src/keys";

const ENV = { XDG_CONFIG_HOME: "/tmp/opencode/keys-test/config" };
const PROJECT_A = "proj-a";
const PROJECT_B = "proj-b";

function owner(project: string, fingerprint: string | null, isProjectKey: boolean): KeyOwner {
  return { project, fingerprint, isProjectKey };
}

describe("sharedKeyRefusal", () => {
  const run = { project: PROJECT_A, fingerprint: keyFingerprint("key-a"), isProjectKey: true };

  test("allows a run with its own project key and no conflicts", () => {
    const others = [owner(PROJECT_B, keyFingerprint("key-b"), true), owner(PROJECT_B, null, false)];
    expect(sharedKeyRefusal(run, others, ENV)).toBeNull();
  });

  test("allows directories of the same project that share the key", () => {
    const others = [owner(PROJECT_A, run.fingerprint, true), owner(PROJECT_A, run.fingerprint, true)];
    expect(sharedKeyRefusal(run, others, ENV)).toBeNull();
  });

  test("refuses another project with the same fingerprint and names it", () => {
    const others = [owner(PROJECT_A, run.fingerprint, true), owner(PROJECT_B, run.fingerprint, true)];
    const message = sharedKeyRefusal(run, others, ENV);
    expect(message).not.toBeNull();
    expect(message).toContain(PROJECT_B);
    expect(message).toContain(`sha256 ${run.fingerprint}`);
    expect(message).toContain(`~/.config/${PROJECT_B}/openrouter.key`.replace("~/.config", "/tmp/opencode/keys-test/config"));
    expect(message).toContain("oc-sub restart");
  });

  test("refuses when the run directory uses the global key", () => {
    const message = sharedKeyRefusal({ ...run, isProjectKey: false }, [], ENV);
    expect(message).not.toBeNull();
    expect(message).toContain(PROJECT_A);
    expect(message).toContain("Each project needs its own OpenRouter key");
    expect(message).toContain("oc-sub restart");
  });

  test("names two conflicting projects sorted", () => {
    const others = [owner("zeta", run.fingerprint, true), owner("alpha", run.fingerprint, true)];
    const message = sharedKeyRefusal(run, others, ENV);
    expect(message).toContain("and alpha, zeta");
  });
});

describe("fetchKeyUsage", () => {
  test("returns the cumulative usage in USD", async () => {
    const usage = await fetchKeyUsage("k", async () => Response.json({ data: { usage: 1.25 } }));
    expect(usage).toBe(1.25);
  });

  test("returns null when OpenRouter does not answer", async () => {
    const usage = await fetchKeyUsage("k", async () => new Response("", { status: 500 }));
    expect(usage).toBeNull();
  });
});
