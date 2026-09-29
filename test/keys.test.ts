import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { OpencodeClient } from "@opencode-ai/sdk";
import { fetchKeyUsage, PLACEHOLDER_KEY, keyFingerprint, resolveDirectoryKey, sharedKeyRefusal, type KeyOwner } from "../src/keys";

const ENV = { XDG_CONFIG_HOME: "/tmp/opencode/keys-test/config" };
const PROJECT_A = "proj-a";
const PROJECT_B = "proj-b";
const FILE_KEY = "sk-or-file-00000000000000000000000000000000000000000000000001";

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

/** A client stub whose /config/providers answers one openrouter provider. */
function fakeClient(key: string | undefined): OpencodeClient {
  return {
    config: {
      providers: async () => ({
        data: { providers: key === undefined ? [] : [{ id: "openrouter", options: { apiKey: key } }] },
      }),
    },
  } as unknown as OpencodeClient;
}

describe("resolveDirectoryKey with the sandbox placeholder", () => {
  // A fresh temp folder is not a git repository, so the project is its
  // basename and projectNameOf needs no git spy.
  const directory = mkdtempSync(path.join(tmpdir(), "oc-sub-keys-dir-"));
  const project = path.basename(directory);
  const keyPath = path.join(ENV.XDG_CONFIG_HOME as string, project, "openrouter.key");
  const readText = (files: Record<string, string>) => async (file: string) => files[file] ?? null;

  test("replaces the placeholder with the project key file", async () => {
    const key = await resolveDirectoryKey(fakeClient(PLACEHOLDER_KEY), directory, ENV, {
      readText: readText({ [keyPath]: `  ${FILE_KEY}\n` }),
    });
    expect(key).not.toBeNull();
    expect(key?.key).toBe(FILE_KEY);
    expect(key?.fingerprint).toBe(keyFingerprint(FILE_KEY));
    expect(key?.isProjectKey).toBe(true);
    expect(key?.source).toBe(`sbx proxy with the project key file ${keyPath}`);
  });

  test("keeps the placeholder when the project key file is missing", async () => {
    const key = await resolveDirectoryKey(fakeClient(PLACEHOLDER_KEY), directory, ENV, { readText: readText({}) });
    expect(key).not.toBeNull();
    expect(key?.key).toBe(PLACEHOLDER_KEY);
    expect(key?.isProjectKey).toBe(false);
    expect(key?.source).toBe(`sbx proxy without a project key file (${keyPath} is missing)`);
  });

  test("keeps the placeholder when the project key file is empty", async () => {
    const key = await resolveDirectoryKey(fakeClient(PLACEHOLDER_KEY), directory, ENV, {
      readText: readText({ [keyPath]: "   \n" }),
    });
    expect(key?.key).toBe(PLACEHOLDER_KEY);
    expect(key?.isProjectKey).toBe(false);
  });

  test("a normal key still comes from the candidates", async () => {
    const key = await resolveDirectoryKey(fakeClient(FILE_KEY), directory, ENV, {
      readText: readText({ [keyPath]: FILE_KEY }),
    });
    expect(key?.key).toBe(FILE_KEY);
    expect(key?.isProjectKey).toBe(true);
    expect(key?.source).toBe(`project key file ${keyPath}`);
  });
});
