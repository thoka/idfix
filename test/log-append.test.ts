/**
 * The server and proxy logs keep the lines of older starts: the
 * logs open in append mode, every start writes one marker line first, and a
 * failed start prints only the output of this start (after the last marker).
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { up, defaultUpDeps, type UpDeps } from "../src/up";
import {
  appendLogMarker,
  isLogMarkerLine,
  logMarkerLine,
  logSinceLastMarker,
  proxyLogPath,
  readLogTail,
  serveLogPath,
} from "../src/state";
import { parseProxyLog } from "../src/proxycost";

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "oc-sub-logappend-"));
}

/** An env with a state home and a shared agents folder that exists. */
function makeEnv(): Record<string, string> {
  const shared = tempDir();
  writeFileSync(path.join(shared, "AGENTS.md"), "# rules\n");
  return { XDG_STATE_HOME: tempDir(), XDG_DATA_HOME: tempDir(), OC_SUB_SHARED_DIR: shared };
}

function makeDeps(overrides: Partial<UpDeps> = {}): UpDeps {
  return {
    probe: (() => {
      let probes = 0;
      return async () => (probes++ === 0 ? { state: "down" } : { state: "up", version: "1.18.32" });
    })(),
    bunBin: () => null,
    spawnServe: () => ({ pid: 1001, exitCode: () => null }),
    spawnProxy: () => ({ pid: 1002, exitCode: () => null }),
    // Never a real watchdog in a unit test.
    spawnIdleWatch: () => ({ pid: 1003, exitCode: () => null }),
    projectName: () => "test",
    readKeyFile: () => null,
    ...overrides,
  };
}

describe("log marker helpers", () => {
  test("logMarkerLine names oc-sub, the label, and the ISO time", () => {
    const line = logMarkerLine("up", new Date("2026-10-01T21:00:00.000Z"));
    expect(line).toBe("--- oc-sub up 2026-10-01T21:00:00.000Z ---");
  });

  test("isLogMarkerLine accepts markers and rejects log output", () => {
    expect(isLogMarkerLine("--- oc-sub up 2026-10-01T21:00:00.000Z ---")).toBe(true);
    expect(isLogMarkerLine("  --- oc-sub up 2026-10-01T21:00:00.000Z ---  ")).toBe(true);
    expect(isLogMarkerLine("opencode serve listening")).toBe(false);
    expect(isLogMarkerLine('{"source":"oc-sub-cost-proxy","event":"end"}')).toBe(false);
    expect(isLogMarkerLine("--- oc-sub up not-a-time ---")).toBe(false);
  });

  test("logSinceLastMarker returns the lines of the newest start only", () => {
    const text = [
      logMarkerLine("up", new Date("2026-10-01T20:00:00.000Z")),
      "first start output",
      "",
      logMarkerLine("up", new Date("2026-10-01T21:00:00.000Z")),
      "second start output a",
      "second start output b",
      "",
    ].join("\n");
    expect(logSinceLastMarker(text)).toEqual(["second start output a", "second start output b"]);
  });

  test("logSinceLastMarker gives an empty list without a marker", () => {
    expect(logSinceLastMarker("just output\nmore output\n")).toEqual([]);
    expect(logSinceLastMarker("")).toEqual([]);
  });

  test("appendLogMarker appends and creates the file", async () => {
    const file = path.join(tempDir(), "state", "serve-8790.log");
    await appendLogMarker(file, "up");
    await appendLogMarker(file, "up");
    const text = readFileSync(file, "utf8");
    expect(text.match(/^--- oc-sub up /gm)).toHaveLength(2);
  });

  test("readLogTail caps the lines of the newest start", async () => {
    const file = path.join(tempDir(), "log");
    const lines = [logMarkerLine("up"), ...Array.from({ length: 60 }, (_, i) => `line ${i}`)];
    writeFileSync(file, `${lines.join("\n")}\n`);
    const tail = await readLogTail(file, 50);
    expect(tail).toHaveLength(51);
    expect(tail[49]).toBe("line 59");
    expect(tail[50]).toBe("(10 earlier lines cut)");
    expect(await readLogTail(path.join(tempDir(), "missing"))).toEqual([]);
  });

  test("the proxy log readers still skip the marker lines", () => {
    const session = "ses_main";
    const text = [
      logMarkerLine("up", new Date("2026-10-01T21:00:00.000Z")),
      JSON.stringify({ source: "oc-sub-cost-proxy", event: "end", session, upstream: "openrouter", cost: 0.01 }),
      logMarkerLine("up", new Date("2026-10-01T22:00:00.000Z")),
    ].join("\n");
    const totals = parseProxyLog(text, new Set([session]));
    expect(totals.requests).toBe(1);
    expect(totals.byUpstream).toEqual([{ name: "openrouter", cost: 0.01, requests: 1 }]);
  });
});

describe("spawnServe opens the log in append mode", () => {
  test("a second start keeps the lines of the first start", async () => {
    const env = makeEnv();
    const logPath = serveLogPath(env, 8790);
    mkdirSync(path.dirname(logPath), { recursive: true });
    const pidPath = path.join(tempDir(), "serve.pid");
    // A real command that writes one line, so both starts leave output.
    defaultUpDeps.spawnServe(["sh", "-c", "echo start-output"], logPath, pidPath, env);
    defaultUpDeps.spawnServe(["sh", "-c", "echo start-output"], logPath, pidPath, env);
    // The starts are detached; give the echo processes a moment.
    await Bun.sleep(100);
    expect(readFileSync(logPath, "utf8").match(/start-output/g)).toHaveLength(2);
  });
});

describe("up marks each start and keeps older log lines", () => {
  test("a second up appends a marker and keeps the lines of the first start", async () => {
    const env = makeEnv();
    const serveLog = serveLogPath(env, 8790);
    const proxyLog = proxyLogPath(env, 8790);
    // The state of an older start: its marker and its proxy `end` line.
    mkdirSync(path.dirname(serveLog), { recursive: true });
    const oldServe = `--- oc-sub up 2026-10-01T20:00:00.000Z ---\nolder start\n`;
    const oldProxy = `--- oc-sub up 2026-10-01T20:00:00.000Z ---\n{"source":"oc-sub-cost-proxy","event":"end","session":"ses_old","upstream":"openrouter","cost":0.05}\n`;
    writeFileSync(serveLog, oldServe);
    writeFileSync(proxyLog, oldProxy);

    const result = await up({ port: 8790, noCostProxy: true }, env, makeDeps());
    expect(result).toBe(0);

    const serveText = readFileSync(serveLog, "utf8");
    expect(serveText).toContain("older start");
    const serveMarkers = serveText.match(/^--- oc-sub up \d{4}-.* ---$/gm) ?? [];
    expect(serveMarkers).toHaveLength(2);
    // The old end line of the proxy log survives the restart: `oc-sub log`
    // of the older run keeps its real cost.
    expect(readFileSync(proxyLog, "utf8")).toBe(oldProxy);
    expect(readFileSync(proxyLog, "utf8")).toContain('"session":"ses_old"');
  });

  test("up writes one marker into the serve log and the proxy log", async () => {
    const env = makeEnv();
    const serveLog = serveLogPath(env, 8790);
    const proxyLog = proxyLogPath(env, 8790);
    const result = await up({ port: 8790 }, env, makeDeps({ bunBin: () => "/opt/bun/bin/bun" }));
    expect(result).toBe(0);
    expect(readFileSync(serveLog, "utf8").match(/^--- oc-sub up \S+ ---$/gm)).toHaveLength(1);
    expect(readFileSync(proxyLog, "utf8").match(/^--- oc-sub up \S+ ---$/gm)).toHaveLength(1);
  });

  test("a failed start shows only the output after the last marker", async () => {
    const env = makeEnv();
    const serveLog = serveLogPath(env, 8790);
    mkdirSync(path.dirname(serveLog), { recursive: true });
    writeFileSync(serveLog, `--- oc-sub up 2026-10-01T20:00:00.000Z ---\nold start output\n`);
    const errors: string[] = [];
    const err = console.error;
    console.error = (line: string) => errors.push(line);
    let result: number;
    try {
      result = await up({ port: 8790, noCostProxy: true }, env, makeDeps({
        probe: async () => ({ state: "down" }),
        spawnServe: (_cmd, logPath) => {
          writeFileSync(logPath, `${readFileSync(logPath, "utf8")}opencode serve: fatal error\n`);
          return { pid: 1001, exitCode: () => 1 };
        },
      }));
    } finally {
      console.error = err;
    }
    expect(result).toBe(1);
    const output = errors.join("\n");
    expect(output).toContain("see " + serveLog);
    expect(output).toContain("output of this start:");
    expect(output).toContain("opencode serve: fatal error");
    expect(output).not.toContain("old start output");
  });

  test("a start that fails later shows the output of this start", async () => {
    const env = makeEnv();
    const serveLog = serveLogPath(env, 8790);
    const errors: string[] = [];
    const err = console.error;
    console.error = (line: string) => errors.push(line);
    let result: number;
    try {
      result = await up({ port: 8790, noCostProxy: true }, env, makeDeps({
        probe: async () => ({ state: "down" }),
        // The server starts, writes output, and exits after some health polls.
        spawnServe: (_cmd, logPath) => {
          writeFileSync(logPath, `${readFileSync(logPath, "utf8")}waiting for the database\n`);
          let polls = 0;
          return { pid: 1001, exitCode: () => (polls++ > 10 ? 1 : null) };
        },
      }));
    } finally {
      console.error = err;
    }
    expect(result).toBe(1);
    const output = errors.join("\n");
    expect(output).toContain("exited with code 1");
    expect(output).toContain("waiting for the database");
  });
});
