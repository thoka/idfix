import { describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { run, type RunDeps } from "../src/run";
import { serveDirsPath } from "../src/state";

const BASE = "/tmp/opencode/run-cmd-test";
const CONFIG = path.join(BASE, "config");
const STATE = path.join(BASE, "state");
const CWD = path.join(BASE, "cwd");
const DIR_A = path.join(BASE, "alpha");
const DIR_B = path.join(BASE, "beta");
const ENV = { XDG_CONFIG_HOME: CONFIG, XDG_STATE_HOME: STATE };
const KEY_A = "sk-or-run-a-000000000000000000000000000000000000000000000001";
const KEY_B = "sk-or-run-b-000000000000000000000000000000000000000000000002";
const ENV_KEY = "sk-or-run-env-0000000000000000000000000000000000000000000003";

function fingerprint(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 8);
}

function capture(): { logs: string[]; errors: string[]; restore: () => void } {
  const logs: string[] = [];
  const errors: string[] = [];
  const log = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map((part) => String(part)).join(" "));
  });
  const err = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.map((part) => String(part)).join(" "));
  });
  return { logs, errors, restore: () => { log.mockRestore(); err.mockRestore(); } };
}

type FakeServer = { url: string; sessionsCreated: number; unmatched: string[]; all: string[]; stop: () => void };

function startFakeServer(keyByDirectory: (directory: string) => string | undefined): FakeServer {
  let sessionsCreated = 0;
  const unmatched: string[] = [];
  const all: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/global/health") return Response.json({ healthy: true, version: "1.0.0" });
      if (url.pathname === "/config/providers") {
        const directory = url.searchParams.get("directory") ?? "";
        const key = keyByDirectory(directory);
        return Response.json({
          providers: key === undefined ? [] : [{ id: "openrouter", options: { apiKey: key } }],
          default: {},
        });
      }
      if (url.pathname === "/project") return Response.json([]);
      if (url.pathname === "/session" && request.method === "POST") {
        sessionsCreated++;
        return Response.json({ id: "ses_new" });
      }
      if (request.method !== "GET") unmatched.push(`${request.method} ${url.pathname}`);
      if (url.pathname.endsWith("/prompt_async")) return new Response(null, { status: 200 });
      return new Response("not found", { status: 404 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    get sessionsCreated() {
      return sessionsCreated;
    },
    unmatched,
    all,
    stop: () => server.stop(true),
  };
}

/** The OpenRouter stub: answers the key endpoint, or throws. */
function openrouterFetch(answer?: { usage?: number; throws?: Error }): RunDeps["fetch"] {
  return async (_input, init) => {
    if (answer?.throws) throw answer.throws;
    if (new Headers(init?.headers).get("Authorization") === null) return new Response("", { status: 401 });
    return Response.json({ data: { usage: answer?.usage ?? 0 } });
  };
}

function makeDeps(fetch: RunDeps["fetch"]): RunDeps {
  return { fetch, projectName: (d) => path.basename(d), worktreesOf: (d) => [d], exists: () => true, cwd: CWD, existsInSandbox: () => true };
}

function writeDirsFile(url: string, dirs: string[]): void {
  const port = new URL(url).port;
  const file = serveDirsPath({ ...ENV, XDG_STATE_HOME: STATE }, Number(port));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${dirs.join("\n")}\n`);
}

function projectKey(project: string, key: string): void {
  const file = path.join(CONFIG, project, "openrouter.key");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${key}\n`);
}

function reset(): void {
  rmSync(BASE, { recursive: true, force: true });
  for (const dir of [CWD, DIR_A, DIR_B]) mkdirSync(dir, { recursive: true });
}

describe("idfx run and the shared OpenRouter key", () => {
  test("refuses when a directory of another project resolves to the same fingerprint", async () => {
    reset();
    projectKey("alpha", KEY_A);
    projectKey("beta", KEY_A);
    const server = startFakeServer((directory) => (directory === DIR_A ? KEY_A : KEY_A));
    writeDirsFile(server.url, [DIR_B]);
    const captured = capture();
    try {
      const code = await run(
        { agent: "coder", dir: DIR_A, text: "brief", url: server.url },
        ENV,
        makeDeps(openrouterFetch({ usage: 1 })),
      );
      expect(code).toBe(1);
      expect(server.sessionsCreated).toBe(0);
      const message = captured.errors.join("\n");
      expect(message).toContain("beta");
      expect(message).toContain(fingerprint(KEY_A));
      expect(message).toContain("idfx restart");
      expect(message).not.toContain(KEY_A);
    } finally {
      captured.restore();
      server.stop();
    }
  });

  test("refuses when the run directory uses the global environment key", async () => {
    reset();
    const server = startFakeServer(() => ENV_KEY);
    const captured = capture();
    try {
      const code = await run(
        { agent: "coder", dir: DIR_A, text: "brief", url: server.url },
        { ...ENV, OPENROUTER_API_KEY: ENV_KEY },
        makeDeps(openrouterFetch({ usage: 1 })),
      );
      expect(code).toBe(1);
      expect(server.sessionsCreated).toBe(0);
      expect(captured.errors.join("\n")).toContain("does not use its project key");
    } finally {
      captured.restore();
      server.stop();
    }
  });

  test("starts the run when the server reports the sandbox placeholder", async () => {
    reset();
    // The sandbox reports the placeholder `proxy-managed`; the real key of
    // the project lives in the project key file on the host.
    projectKey("alpha", KEY_A);
    projectKey("beta", KEY_B);
    const server = startFakeServer(() => "proxy-managed");
    writeDirsFile(server.url, [DIR_B]);
    const captured = capture();
    try {
      const code = await run(
        { agent: "coder", dir: DIR_A, text: "brief", url: server.url },
        ENV,
        makeDeps(openrouterFetch({ usage: 1 })),
      );
      expect(code).toBe(0);
      expect(server.sessionsCreated).toBe(1);
      expect(captured.errors.join("\n")).not.toContain("does not use its project key");
      const record = JSON.parse(readFileSync(path.join(CWD, ".opencode", "runs", "ses_new.json"), "utf8"));
      expect(record.keyFingerprint).toBe(fingerprint(KEY_A));
      expect(record.usageAtStart).toBe(1);
    } finally {
      captured.restore();
      server.stop();
    }
  });

  test("starts the run and records the fingerprint and the usage at the start", async () => {
    reset();
    projectKey("alpha", KEY_A);
    projectKey("beta", KEY_B);
    const server = startFakeServer((directory) => (directory === DIR_A ? KEY_A : KEY_B));
    writeDirsFile(server.url, [DIR_B]);
    const captured = capture();
    try {
      const code = await run(
        { agent: "coder", dir: DIR_A, text: "brief", title: "T", url: server.url },
        ENV,
        makeDeps(openrouterFetch({ usage: 1.25 })),
      );
      expect(code).toBe(0);
      expect(server.sessionsCreated).toBe(1);
      expect(captured.logs[0]).toBe("ses_new");
      expect(captured.logs.join("\n")).toContain("watch live: idfx attach es_new");
      const record = JSON.parse(readFileSync(path.join(CWD, ".opencode", "runs", "ses_new.json"), "utf8"));
      expect(record.keyFingerprint).toBe(fingerprint(KEY_A));
      expect(record.usageAtStart).toBe(1.25);
      const stateRecord = JSON.parse(
        readFileSync(path.join(STATE, "idfx", "runs", "ses_new.json"), "utf8"),
      );
      expect(stateRecord.keyFingerprint).toBe(fingerprint(KEY_A));
      expect(captured.logs.join("\n")).not.toContain(KEY_A);
    } finally {
      captured.restore();
      server.stop();
    }
  });

  test("names the opencode driver in both run records", async () => {
    reset();
    projectKey("alpha", KEY_A);
    projectKey("beta", KEY_B);
    const server = startFakeServer((directory) => (directory === DIR_A ? KEY_A : KEY_B));
    writeDirsFile(server.url, [DIR_B]);
    const captured = capture();
    try {
      const code = await run(
        { agent: "coder", dir: DIR_A, text: "brief", url: server.url },
        ENV,
        makeDeps(openrouterFetch({ usage: 1 })),
      );
      expect(code).toBe(0);
      const record = JSON.parse(readFileSync(path.join(CWD, ".opencode", "runs", "ses_new.json"), "utf8"));
      const stateRecord = JSON.parse(readFileSync(path.join(STATE, "idfx", "runs", "ses_new.json"), "utf8"));
      expect(record.driver).toBe("opencode");
      expect(stateRecord.driver).toBe("opencode");
    } finally {
      captured.restore();
      server.stop();
    }
  });

  test("starts the run with usageAtStart null when OpenRouter does not answer", async () => {
    reset();
    projectKey("alpha", KEY_A);
    const server = startFakeServer((directory) => (directory === DIR_A ? KEY_A : undefined));
    const captured = capture();
    try {
      const code = await run(
        { agent: "coder", dir: DIR_A, text: "brief", url: server.url },
        ENV,
        makeDeps(openrouterFetch({ throws: new Error("connection refused") })),
      );
      expect(code).toBe(0);
      expect(server.sessionsCreated).toBe(1);
      const record = JSON.parse(readFileSync(path.join(CWD, ".opencode", "runs", "ses_new.json"), "utf8"));
      expect(record.keyFingerprint).toBe(fingerprint(KEY_A));
      expect(record.usageAtStart).toBeNull();
    } finally {
      captured.restore();
      server.stop();
    }
  });
});
