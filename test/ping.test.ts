import { describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import {
  authJsonKey,
  authJsonPath,
  checkOpenRouterKey,
  formatOpenRouterLine,
  identifyKeySource,
  keyFingerprint,
  ping,
  projectKeyPath,
  projectNameOf,
  resolvedProviderKey,
  type PingDeps,
} from "../src/ping";

const ENV = {
  XDG_CONFIG_HOME: "/tmp/opencode/ping-test/config",
  XDG_DATA_HOME: "/tmp/opencode/ping-test/data",
};
const DIR = "/tmp/opencode/ping-test/repo";
const PROJECT_KEY = projectKeyPath("proj", ENV);
const AUTH_JSON = authJsonPath(ENV);
const FILE_KEY = "sk-or-file-00000000000000000000000000000000000000000000000001";
const ENV_KEY = "sk-or-env-0000000000000000000000000000000000000000000000000002";
const AUTH_KEY = "sk-or-auth-0000000000000000000000000000000000000000000000000003";
const CONFIG_KEY = "sk-or-config-000000000000000000000000000000000000000000000000004";

function fingerprint(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 8);
}

function captureLog(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map((part) => String(part)).join(" "));
  });
  return { lines, restore: () => spy.mockRestore() };
}

type FakeServer = { url: string; requestedDirectories: string[]; stop: () => void };

/** A fake opencode server for /global/health and /config/providers. */
function startFakeServer(providers: unknown): FakeServer {
  const requestedDirectories: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/global/health") return Response.json({ healthy: true, version: "1.0.0" });
      if (url.pathname === "/config/providers") {
        requestedDirectories.push(url.searchParams.get("directory") ?? "");
        return Response.json({ providers, default: {} });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, requestedDirectories, stop: () => server.stop(true) };
}

/** What the fake OpenRouter fetch answers. */
type OpenRouterAnswer = { status: number; body?: unknown; throws?: Error };

function makeDeps(
  answer: OpenRouterAnswer | undefined,
  files: Record<string, string | null>,
  project = "proj",
): { deps: PingDeps; sentHeaders: string[] } {
  const sentHeaders: string[] = [];
  const deps: PingDeps = {
    fetch: async (_input, init) => {
      sentHeaders.push(new Headers(init?.headers).get("Authorization") ?? "");
      if (answer?.throws) throw answer.throws;
      if (answer?.body !== undefined) return Response.json(answer.body, { status: answer.status });
      return new Response("", { status: answer?.status ?? 500 });
    },
    readText: async (file) => files[file] ?? null,
    projectName: () => project,
  };
  return { deps, sentHeaders };
}

async function runPing(options: {
  providers: unknown;
  answer?: OpenRouterAnswer;
  files?: Record<string, string | null>;
  env?: Record<string, string | undefined>;
  dir?: string;
}): Promise<{ code: number; lines: string[]; headers: string[]; requestedDirectories: string[] }> {
  const server = startFakeServer(options.providers);
  const { deps, sentHeaders } = makeDeps(options.answer, options.files ?? {});
  const captured = captureLog();
  try {
    const code = await ping({ url: server.url, dir: options.dir ?? DIR }, { ...ENV, ...options.env }, deps);
    return { code, lines: captured.lines, headers: sentHeaders, requestedDirectories: server.requestedDirectories };
  } finally {
    captured.restore();
    server.stop();
  }
}

function openrouterProvider(overrides: Record<string, unknown> = {}): unknown[] {
  return [
    {
      id: "openrouter",
      name: "OpenRouter",
      source: "config",
      env: [],
      models: {},
      ...overrides,
    },
  ];
}

describe("keyFingerprint", () => {
  test("is the first 8 hex digits of the SHA-256 of the key", () => {
    expect(keyFingerprint("some-secret")).toBe(fingerprint("some-secret"));
    expect(keyFingerprint("some-secret")).toMatch(/^[0-9a-f]{8}$/);
    expect(keyFingerprint("other-secret")).not.toBe(keyFingerprint("some-secret"));
  });
});

describe("projectKeyPath and authJsonPath", () => {
  test("uses $XDG_CONFIG_HOME and $XDG_DATA_HOME when set", () => {
    expect(projectKeyPath("proj", { XDG_CONFIG_HOME: "/xdg/config" })).toBe("/xdg/config/proj/openrouter.key");
    expect(authJsonPath({ XDG_DATA_HOME: "/xdg/data" })).toBe("/xdg/data/opencode/auth.json");
  });

  test("falls back to the home folder", () => {
    expect(projectKeyPath("proj", {})).toBe(path.join(homedir(), ".config", "proj", "openrouter.key"));
    expect(authJsonPath({})).toBe(path.join(homedir(), ".local", "share", "opencode", "auth.json"));
  });

  test("ignores a relative XDG value, as state.ts does", () => {
    expect(projectKeyPath("proj", { XDG_CONFIG_HOME: "relative" })).toBe(
      path.join(homedir(), ".config", "proj", "openrouter.key"),
    );
  });
});

describe("identifyKeySource", () => {
  const candidates = [
    { label: "project key file /p", key: undefined },
    { label: "environment OPENROUTER_API_KEY", key: "k2" },
    { label: "global auth.json /a", key: "k2" },
  ];

  test("takes the first equal candidate", () => {
    expect(identifyKeySource("k2", false, candidates)).toBe("environment OPENROUTER_API_KEY");
    expect(identifyKeySource("k2", true, [{ label: "project key file /p", key: "k2" }, ...candidates])).toBe(
      "project key file /p",
    );
  });

  test("skips missing candidate keys", () => {
    expect(identifyKeySource("k2", false, [{ label: "project key file /p", key: undefined }, { label: "e", key: "k2" }])).toBe("e");
  });

  test("reports a configuration file when the key came from options.apiKey", () => {
    expect(identifyKeySource("nope", true, candidates)).toBe("a configuration file (not the project key file)");
  });

  test("reports unknown when the key came from the provider key", () => {
    expect(identifyKeySource("nope", false, candidates)).toBe("unknown");
  });
});

describe("authJsonKey", () => {
  test("reads openrouter.key", () => {
    expect(authJsonKey(JSON.stringify({ openrouter: { key: "k" }, other: { key: "x" } }))).toBe("k");
  });

  test("is undefined for missing, broken, or foreign content", () => {
    expect(authJsonKey(null)).toBeUndefined();
    expect(authJsonKey("not json")).toBeUndefined();
    expect(authJsonKey("[]")).toBeUndefined();
    expect(authJsonKey(JSON.stringify({ anthropic: { key: "k" } }))).toBeUndefined();
    expect(authJsonKey(JSON.stringify({ openrouter: {} }))).toBeUndefined();
  });
});

describe("resolvedProviderKey", () => {
  test("prefers a non-empty options.apiKey", () => {
    expect(resolvedProviderKey({ key: "k2", options: { apiKey: "k1" } })).toEqual({ key: "k1", fromConfigFile: true });
  });

  test("uses key when options.apiKey is missing or empty", () => {
    expect(resolvedProviderKey({ key: "k2", options: {} })).toEqual({ key: "k2", fromConfigFile: false });
    expect(resolvedProviderKey({ key: "k2", options: { apiKey: "" } })).toEqual({ key: "k2", fromConfigFile: false });
    expect(resolvedProviderKey({ key: "k2" })).toEqual({ key: "k2", fromConfigFile: false });
  });

  test("is undefined without any key", () => {
    expect(resolvedProviderKey({ options: {} })).toBeUndefined();
    expect(resolvedProviderKey({ key: "", options: {} })).toBeUndefined();
  });
});

describe("formatOpenRouterLine", () => {
  test("formats a healthy key with a limit", () => {
    expect(formatOpenRouterLine({ status: "ok", limit: 1, limitRemaining: 1, usage: 0 })).toBe(
      "openrouter: ok, limit $1.00, used $0.00, remaining $1.00",
    );
  });

  test("shows the usage but no remaining amount when there is no limit", () => {
    expect(formatOpenRouterLine({ status: "ok", limit: null, limitRemaining: null, usage: 0.25 })).toBe(
      "openrouter: ok, limit none, used $0.25",
    );
  });

  test("leaves out remaining when it is missing", () => {
    expect(formatOpenRouterLine({ status: "ok", limit: 1, limitRemaining: null, usage: 0 })).toBe(
      "openrouter: ok, limit $1.00, used $0.00",
    );
  });

  test("formats a rejected key with and without a message", () => {
    expect(formatOpenRouterLine({ status: "rejected", httpStatus: 401, message: "User not found." })).toBe(
      "openrouter: rejected (HTTP 401: User not found.)",
    );
    expect(formatOpenRouterLine({ status: "rejected", httpStatus: 403 })).toBe("openrouter: rejected (HTTP 403)");
  });

  test("formats an unreachable endpoint", () => {
    expect(formatOpenRouterLine({ status: "unreachable", message: "connection refused" })).toBe(
      "openrouter: unreachable (connection refused)",
    );
  });
});

describe("checkOpenRouterKey", () => {
  test("sends the key as a bearer token and reads the limit data", async () => {
    let seen: { url: string; auth: string | null } | undefined;
    const result = await checkOpenRouterKey("k", async (input, init) => {
      seen = { url: String(input), auth: new Headers(init?.headers).get("Authorization") };
      return Response.json({ data: { limit: 10, limit_remaining: 8.5, usage: 1.5 } });
    });
    expect(seen?.url).toBe("https://openrouter.ai/api/v1/key");
    expect(seen?.auth).toBe("Bearer k");
    expect(result).toEqual({ status: "ok", limit: 10, limitRemaining: 8.5, usage: 1.5 });
  });

  test("treats limit null as no limit", async () => {
    const result = await checkOpenRouterKey("k", async () =>
      Response.json({ data: { limit: null, limit_remaining: null, usage: 0.25 } }),
    );
    expect(result).toEqual({ status: "ok", limit: null, limitRemaining: null, usage: 0.25 });
  });

  test("reads the error message on a rejection", async () => {
    const result = await checkOpenRouterKey("k", async () =>
      Response.json({ error: { message: "User not found." } }, { status: 401 }),
    );
    expect(result).toEqual({ status: "rejected", httpStatus: 401, message: "User not found." });
  });

  test("keeps a missing error message and a non-JSON body", async () => {
    const result = await checkOpenRouterKey("k", async () => new Response("<html>no</html>", { status: 403 }));
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.httpStatus).toBe(403);
      expect(result.message).toBeUndefined();
    }
  });

  test("reports a throw as unreachable", async () => {
    const result = await checkOpenRouterKey("k", async () => {
      throw new Error("connection refused");
    });
    expect(result).toEqual({ status: "unreachable", message: "connection refused" });
  });
});

describe("projectNameOf", () => {
  function spawnResult(exitCode: number, stdout: string): ReturnType<typeof Bun.spawnSync> {
    return { exitCode, stdout: Buffer.from(stdout) } as unknown as ReturnType<typeof Bun.spawnSync>;
  }

  test("uses the folder that holds the main repository", () => {
    const spy = spyOn(Bun, "spawnSync").mockImplementation(
      (() => spawnResult(0, "/home/user/src/proj/.git\n")) as unknown as typeof Bun.spawnSync,
    );
    try {
      expect(projectNameOf("/home/user/src/proj/.worktrees/step")).toBe("proj");
    } finally {
      spy.mockRestore();
    }
  });

  test("falls back to the folder name without git", () => {
    const spy = spyOn(Bun, "spawnSync").mockImplementation(
      (() => spawnResult(128, "")) as unknown as typeof Bun.spawnSync,
    );
    try {
      expect(projectNameOf("/home/user/src/other/repo-x")).toBe("repo-x");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("ping", () => {
  test("reports the project key file and a healthy key", async () => {
    const { code, lines, headers, requestedDirectories } = await runPing({
      providers: openrouterProvider({ options: { apiKey: FILE_KEY } }),
      answer: { status: 200, body: { data: { limit: 1, limit_remaining: 1, usage: 0 } } },
      files: { [PROJECT_KEY]: `  ${FILE_KEY}\n`, [AUTH_JSON]: JSON.stringify({ openrouter: { key: AUTH_KEY } }) },
    });
    expect(code).toBe(0);
    expect(requestedDirectories).toEqual([DIR]);
    expect(lines).toEqual([
      `directory: ${DIR}`,
      "project: proj",
      `key: sha256 ${fingerprint(FILE_KEY)}`,
      `source: project key file ${PROJECT_KEY}`,
      "openrouter: ok, limit $1.00, used $0.00, remaining $1.00",
    ]);
    expect(headers).toEqual([`Bearer ${FILE_KEY}`]);
    expect(lines.join("\n")).not.toContain(FILE_KEY);
  });

  test("takes the environment key before auth.json and warns", async () => {
    const { code, lines } = await runPing({
      providers: openrouterProvider({ key: ENV_KEY }),
      answer: { status: 200, body: { data: { limit: null, limit_remaining: null, usage: 0.25 } } },
      files: { [AUTH_JSON]: JSON.stringify({ openrouter: { key: AUTH_KEY } }) },
      env: { OPENROUTER_API_KEY: ENV_KEY },
    });
    expect(code).toBe(0);
    expect(lines).toEqual([
      `directory: ${DIR}`,
      "project: proj",
      `key: sha256 ${fingerprint(ENV_KEY)}`,
      "source: environment OPENROUTER_API_KEY",
      "openrouter: ok, limit none, used $0.25",
      `warning: not the project key. The cost goes to another key. Create ${PROJECT_KEY} and refer to it in opencode.json. If you changed a configuration file, run idfx restart.`,
    ]);
  });

  test("identifies the key of the global auth.json and warns", async () => {
    const { code, lines } = await runPing({
      providers: openrouterProvider({ key: AUTH_KEY }),
      answer: { status: 200, body: { data: { limit: 10, limit_remaining: 9, usage: 1 } } },
      files: { [AUTH_JSON]: JSON.stringify({ openrouter: { key: AUTH_KEY } }) },
    });
    expect(code).toBe(0);
    expect(lines[3]).toBe(`source: global auth.json ${AUTH_JSON}`);
    expect(lines[4]).toBe("openrouter: ok, limit $10.00, used $1.00, remaining $9.00");
    expect(lines[5]?.startsWith("warning: not the project key.")).toBe(true);
  });

  test("names a configuration file that it cannot identify", async () => {
    const { code, lines } = await runPing({
      providers: openrouterProvider({ options: { apiKey: CONFIG_KEY } }),
      answer: { status: 200, body: { data: { limit: 5, limit_remaining: 4, usage: 1 } } },
    });
    expect(code).toBe(0);
    expect(lines[3]).toBe("source: a configuration file (not the project key file)");
    expect(lines[5]?.startsWith("warning: not the project key.")).toBe(true);
  });

  test("reports unknown for an unexplained provider key", async () => {
    const { code, lines } = await runPing({
      providers: openrouterProvider({ key: AUTH_KEY }),
      answer: { status: 200, body: { data: { limit: 5, limit_remaining: 4, usage: 1 } } },
    });
    expect(code).toBe(0);
    expect(lines[3]).toBe("source: unknown");
  });

  test("reports a rejected key without a warning", async () => {
    const { code, lines } = await runPing({
      providers: openrouterProvider({ options: { apiKey: FILE_KEY } }),
      answer: { status: 401, body: { error: { message: "User not found." } } },
      files: { [PROJECT_KEY]: FILE_KEY },
    });
    expect(code).toBe(1);
    expect(lines[4]).toBe("openrouter: rejected (HTTP 401: User not found.)");
    expect(lines.length).toBe(5);
  });

  test("reports an unreachable key endpoint", async () => {
    const { code, lines } = await runPing({
      providers: openrouterProvider({ options: { apiKey: FILE_KEY } }),
      answer: { status: 200, throws: new Error("connection refused") },
      files: { [PROJECT_KEY]: FILE_KEY },
    });
    expect(code).toBe(1);
    expect(lines[4]).toBe("openrouter: unreachable (connection refused)");
  });

  test("reports a missing provider", async () => {
    const { code, lines } = await runPing({ providers: [] });
    expect(code).toBe(1);
    expect(lines).toEqual([`openrouter: not configured for ${DIR}`]);
  });

  test("reports a provider without a key", async () => {
    const { code, lines } = await runPing({ providers: openrouterProvider({ options: {} }) });
    expect(code).toBe(1);
    expect(lines).toEqual([`directory: ${DIR}`, "project: proj", "key: none"]);
  });

  test("resolves a relative --dir against the working directory", async () => {
    const { code, lines } = await runPing({ providers: [], dir: "somewhere/else" });
    expect(code).toBe(1);
    expect(lines).toEqual([`openrouter: not configured for ${path.resolve("somewhere/else")}`]);
  });

  test("checks the project key file when the server reports the sandbox placeholder", async () => {
    const { code, lines, headers } = await runPing({
      providers: openrouterProvider({ options: { apiKey: "proxy-managed" } }),
      answer: { status: 200, body: { data: { limit: 2, limit_remaining: 1.5, usage: 0.5 } } },
      files: { [PROJECT_KEY]: `  ${FILE_KEY}\n` },
    });
    expect(code).toBe(0);
    expect(lines).toEqual([
      `directory: ${DIR}`,
      "project: proj",
      `key: sha256 ${fingerprint(FILE_KEY)}`,
      `source: sbx proxy with the project key file ${PROJECT_KEY}`,
      "openrouter: ok, limit $2.00, used $0.50, remaining $1.50",
    ]);
    expect(headers).toEqual([`Bearer ${FILE_KEY}`]);
    expect(lines.join("\n")).not.toContain("proxy-managed");
    expect(lines.join("\n")).not.toContain(FILE_KEY);
  });

  test("reports a missing project key file behind the sandbox placeholder", async () => {
    const { code, lines, headers } = await runPing({
      providers: openrouterProvider({ key: "proxy-managed" }),
      answer: { status: 200, body: { data: { limit: null, limit_remaining: null, usage: 0 } } },
      files: {},
    });
    expect(code).toBe(0);
    expect(lines[3]).toBe(`source: sbx proxy without a project key file (${PROJECT_KEY} is missing)`);
    expect(headers).toEqual(["Bearer proxy-managed"]);
    expect(lines[5]?.startsWith("warning: not the project key.")).toBe(true);
  });

  test("never prints a key, in any line", async () => {
    const { lines, headers } = await runPing({
      providers: openrouterProvider({ options: { apiKey: CONFIG_KEY } }),
      answer: { status: 200, body: { data: { limit: 1, limit_remaining: 1, usage: 0 } } },
      files: {
        [PROJECT_KEY]: FILE_KEY,
        [AUTH_JSON]: JSON.stringify({ openrouter: { key: AUTH_KEY } }),
      },
      env: { OPENROUTER_API_KEY: ENV_KEY },
    });
    const output = lines.join("\n");
    for (const key of [FILE_KEY, ENV_KEY, AUTH_KEY, CONFIG_KEY]) {
      expect(output).not.toContain(key);
    }
    expect(headers).toEqual([`Bearer ${CONFIG_KEY}`]);
  });
});
