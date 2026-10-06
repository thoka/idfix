import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "../src/args";
import { HOST_PROXY_PORT, HOST_PROXY_UNIT, probeHello, startHostProxy, systemdUserDir, type HostProxy } from "../src/host-proxy";
import { hostProxyLogPath, isLogMarkerLine } from "../src/state";
import { defaultUnitDeps, isIdfixUnit, orphanedUnits, type LoadedUnit } from "../src/units";
import { testMayTouchUnit, unitOfCall } from "./setup";

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "idfx-host-proxy-"));
}

/** A free port: the kernel picks one for a short server, which then stops. */
function freePort(): number {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = probe.port as number;
  probe.stop(true);
  return port;
}

/** The lines of a log file, without the empty last line. */
function logLines(file: string): string[] {
  return readFileSync(file, "utf8").split("\n").filter((line) => line.length > 0);
}

describe("paths of the host proxy", () => {
  test("the log is proxy-host.log in the state folder", () => {
    const state = tempDir();
    expect(hostProxyLogPath({ XDG_STATE_HOME: state })).toBe(path.join(state, "idfx", "proxy-host.log"));
  });

  test("the unit folder is $XDG_CONFIG_HOME/systemd/user when absolute, else ~/.config/systemd/user", () => {
    expect(systemdUserDir({ XDG_CONFIG_HOME: "/cfg" }, "/h")).toBe("/cfg/systemd/user");
    expect(systemdUserDir({ XDG_CONFIG_HOME: "relative" }, "/h")).toBe("/h/.config/systemd/user");
    expect(systemdUserDir({}, "/h")).toBe("/h/.config/systemd/user");
  });

  test("the defaults: port 4090, unit idfx-proxy", () => {
    expect(HOST_PROXY_PORT).toBe(4090);
    expect(HOST_PROXY_UNIT).toBe("idfx-proxy");
  });
});

describe("parseArgs proxy", () => {
  test("defaults to 127.0.0.1:4090 and the default log", () => {
    expect(parseArgs(["proxy"])).toEqual({ command: "proxy", port: 4090, hostname: "127.0.0.1" });
  });

  test("takes the port, the hostname, the log, and both upstreams", () => {
    expect(
      parseArgs([
        "proxy",
        "--port",
        "5000",
        "--hostname",
        "0.0.0.0",
        "--log",
        "/tmp/p.log",
        "--upstream",
        "http://up",
        "--deepinfra-upstream",
        "http://di",
      ]),
    ).toEqual({
      command: "proxy",
      port: 5000,
      hostname: "0.0.0.0",
      log: "/tmp/p.log",
      upstream: "http://up",
      deepinfraUpstream: "http://di",
    });
  });

  test("rejects a bad port, a positional, and an unknown option", () => {
    expect(() => parseArgs(["proxy", "--port", "0"])).toThrow(/--port must be/);
    expect(() => parseArgs(["proxy", "extra"])).toThrow(/no positional/);
    expect(() => parseArgs(["proxy", "--url", "http://h:1"])).toThrow(/unknown option/);
  });
});

describe("startHostProxy", () => {
  let proxy: HostProxy | undefined;
  let upstream: ReturnType<typeof Bun.serve> | undefined;
  afterEach(async () => {
    await proxy?.stop();
    upstream?.stop(true);
    proxy = undefined;
    upstream = undefined;
  });

  test("appends the start marker, the listening line, and one line per request to the log", async () => {
    upstream = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => Response.json({ id: "gen-1", model: "m", usage: { prompt_tokens: 1, completion_tokens: 2, cost: 0.5 } }),
    });
    const logFile = path.join(tempDir(), "nested", "proxy-host.log");
    const printed: string[] = [];
    proxy = startHostProxy({
      port: 0,
      hostname: "127.0.0.1",
      logFile,
      upstream: `http://127.0.0.1:${upstream.port}`,
      print: (line) => printed.push(line),
    });
    expect(printed).toHaveLength(1);
    const listening = JSON.parse(printed[0] as string);
    expect(listening).toMatchObject({ source: "idfx-cost-proxy", event: "listening", port: proxy.server.port, log: logFile });

    const hello = await fetch(`http://127.0.0.1:${proxy.server.port}/api/hello`, { method: "HEAD" });
    expect(hello.status).toBe(200);
    const res = await fetch(`http://127.0.0.1:${proxy.server.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Session-Id": "ses_1", authorization: "Bearer secret" },
      body: JSON.stringify({ model: "m" }),
    });
    expect(res.status).toBe(200);
    await res.text();
    // The end line is written after the response body is done.
    for (let i = 0; i < 50 && !logLines(logFile).some((line) => line.includes('"event":"end"')); i++) await Bun.sleep(10);

    const lines = logLines(logFile);
    expect(isLogMarkerLine(lines[0] as string)).toBe(true);
    expect(lines[0]).toContain("idfx proxy");
    const events = lines.slice(1).map((line) => JSON.parse(line));
    // The hello probe writes no line.
    expect(events.map((e) => e.event)).toEqual(["listening", "start", "end"]);
    expect(events[1]).toMatchObject({ session: "ses_1", path: "/v1/chat/completions" });
    expect(readFileSync(logFile, "utf8")).not.toContain("secret");
  });

  test("probeHello answers true while the proxy runs and false on a closed port", async () => {
    proxy = startHostProxy({ port: 0, hostname: "127.0.0.1", logFile: path.join(tempDir(), "p.log"), print: () => {} });
    expect(await probeHello(proxy.server.port as number)).toBe(true);
    const port = proxy.server.port as number;
    await proxy.stop();
    proxy = undefined;
    expect(await probeHello(port, 300)).toBe(false);
  });
});

describe("idfx proxy", () => {
  test("runs in the foreground, prints the listening line, and ends with 0 on SIGTERM", async () => {
    const port = freePort();
    const logFile = path.join(tempDir(), "proxy-host.log");
    const child = Bun.spawn(["bun", path.join(import.meta.dir, "..", "src", "cli.ts"), "proxy", "--port", String(port), "--log", logFile], {
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const reader = child.stdout.getReader();
      let text = "";
      const deadline = Date.now() + 10_000;
      while (!text.includes("\n") && Date.now() < deadline) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += new TextDecoder().decode(chunk.value);
      }
      reader.releaseLock();
      const listening = JSON.parse(text.split("\n")[0] as string);
      expect(listening).toMatchObject({ event: "listening", port, hostname: "127.0.0.1", log: logFile });
      expect(await probeHello(port)).toBe(true);
      child.kill("SIGTERM");
      expect(await child.exited).toBe(0);
      const lines = logLines(logFile);
      expect(isLogMarkerLine(lines[0] as string)).toBe(true);
      expect(JSON.parse(lines[1] as string).event).toBe("listening");
    } finally {
      child.kill("SIGKILL");
    }
  }, 20_000);
});

describe("the host proxy unit and the guards", () => {
  test("idfx-proxy is not a unit of idfx.slice, so the units check ignores it", () => {
    const unit: LoadedUnit = { unit: "idfx-proxy", description: "idfx proxy: the host cost proxy", workingDirectory: "", activeState: "active", slice: "app.slice" };
    expect(isIdfixUnit(unit)).toBe(false);
    // Even when listed, it is no orphaned helper unit: its name has no port.
    expect(orphanedUnits([{ ...unit, slice: undefined }], () => false)).toEqual([]);
  });

  test("the test preload refuses a change of the real idfx-proxy unit", () => {
    for (const verb of ["start", "restart", "enable", "stop"]) {
      const cmd = ["systemctl", "--user", verb, "idfx-proxy.service"];
      expect(unitOfCall(cmd)).toBe("idfx-proxy.service");
      expect(() => defaultUnitDeps.run(cmd)).toThrow(/a test reached the real user manager for idfx-proxy.service/);
    }
    expect(testMayTouchUnit("idfx-proxy.service")).toBe(false);
    // A read stays allowed, and daemon-reload names no unit.
    expect(unitOfCall(["systemctl", "--user", "show", "idfx-proxy.service", "--property=ActiveState"])).toBeNull();
    expect(unitOfCall(["systemctl", "--user", "daemon-reload"])).toBeNull();
  });
});
