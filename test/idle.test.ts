import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs, UsageError } from "../src/args";
import { signalGroup } from "../src/down";
import {
  CLI_PATH,
  DEFAULT_IDLE_MINUTES,
  IdleTracker,
  checkIntervalMs,
  idlePidPath,
  idleStopLine,
  idleWatch,
  idleWatchCommand,
  isIdleWatch,
  startIdleWatch,
  stopIdleWatch,
  type GlobalItem,
  type IdleWatchDeps,
  type StatusMap,
} from "../src/idle";
import type { ServerState } from "../src/client";
import { serveLogPath, stateDir } from "../src/state";

const MINUTE = 60_000;

function status(sessionID: string, type: string): GlobalItem {
  return { directory: "/w", payload: { type: "session.status", properties: { sessionID, status: { type } } } };
}

function idle(sessionID: string): GlobalItem {
  return { directory: "/w", payload: { type: "session.idle", properties: { sessionID } } };
}

describe("IdleTracker", () => {
  test("a fresh tracker is idle only after the limit", () => {
    const tracker = new IdleTracker(0);
    expect(tracker.isIdle(MINUTE - 1, MINUTE)).toBe(false);
    expect(tracker.isIdle(MINUTE, MINUTE)).toBe(true);
  });

  test("busy and retry add a session, idle and session.idle remove it", () => {
    const tracker = new IdleTracker(0);
    tracker.apply(status("a", "busy"), 0);
    tracker.apply(status("b", "retry"), 0);
    expect(tracker.busySessions().sort()).toEqual(["a", "b"]);
    tracker.apply(status("a", "idle"), 0);
    tracker.apply(idle("b"), 0);
    expect(tracker.busySessions()).toEqual([]);
  });

  test("a busy session keeps the server from idle, however old the last event", () => {
    const tracker = new IdleTracker(0);
    tracker.apply(status("a", "busy"), 0);
    expect(tracker.isIdle(10 * MINUTE, MINUTE)).toBe(false);
  });

  test("a real event resets the time, a heartbeat and server.connected do not", () => {
    const tracker = new IdleTracker(0);
    tracker.apply({ payload: { type: "server.heartbeat", properties: {} } }, 50_000);
    tracker.apply({ payload: { type: "server.connected", properties: {} } }, 55_000);
    expect(tracker.idleForMs(60_000)).toBe(60_000);
    tracker.apply({ directory: "/w", payload: { type: "message.updated", properties: {} } }, 50_000);
    expect(tracker.idleForMs(60_000)).toBe(10_000);
  });

  test("records the folders that the stream names", () => {
    const tracker = new IdleTracker(0);
    tracker.apply(status("a", "busy"), 0);
    tracker.apply({ payload: { type: "server.heartbeat" } }, 0);
    expect([...tracker.directories]).toEqual(["/w"]);
  });

  test("seed replaces the busy set and resets the time; null keeps the set", () => {
    const tracker = new IdleTracker(0);
    tracker.apply(status("old", "busy"), 0);
    tracker.seed([{ x: { type: "busy" } }, { y: { type: "retry" }, z: { type: "idle" } }], 5_000);
    expect(tracker.busySessions().sort()).toEqual(["x", "y"]);
    expect(tracker.idleForMs(6_000)).toBe(1_000);
    tracker.seed(null, 9_000);
    expect(tracker.busySessions().sort()).toEqual(["x", "y"]);
    expect(tracker.idleForMs(9_000)).toBe(0);
  });
});

describe("pure helpers", () => {
  test("checkIntervalMs is one minute for a long limit and shorter for a short one", () => {
    expect(checkIntervalMs(30 * MINUTE)).toBe(MINUTE);
    expect(checkIntervalMs(8_000)).toBe(2_000);
    expect(checkIntervalMs(100)).toBe(1_000);
  });

  test("idleStopLine names the port and the limit", () => {
    expect(idleStopLine(8767, 30)).toBe("idle-stop port=8767 idle=30m");
    expect(idleStopLine(18768, 0.05)).toBe("idle-stop port=18768 idle=0.05m");
  });

  test("isIdleWatch accepts the watchdog of the port only", () => {
    const line = `/usr/bin/bun ${CLI_PATH} idle-watch --port 8767 --minutes 30`;
    expect(isIdleWatch(line, 8767)).toBe(true);
    expect(isIdleWatch(line, 8768)).toBe(false);
    expect(isIdleWatch("opencode serve --port 8767", 8767)).toBe(false);
  });

  test("idleWatchCommand runs the cli with bun", () => {
    expect(idleWatchCommand(8767, 30, "/bin/bun")).toEqual([
      "/bin/bun",
      CLI_PATH,
      "idle-watch",
      "--port",
      "8767",
      "--minutes",
      "30",
    ]);
  });

  test("the default limit is 30 minutes", () => {
    expect(DEFAULT_IDLE_MINUTES).toBe(30);
  });
});

/** A fake world for `idleWatch`: a clock that each sleep moves forward. */
function makeWorld(opts: {
  pids?: Array<number | null>;
  health?: ServerState["state"][];
  statuses?: Record<string, StatusMap>;
  stopCodes?: number[];
  /** Runs before each sleep returns, with the number of the sleep (1, 2, ...). */
  onSleep?: (count: number, push: (item: GlobalItem) => void) => void;
}) {
  let now = 0;
  let sleeps = 0;
  let onItem: ((item: GlobalItem) => void) | undefined;
  const calls = { stop: 0, ended: false, status: [] as string[] };
  const lines: string[] = [];
  const pids = opts.pids ?? [];
  const health = opts.health ?? [];
  const stopCodes = opts.stopCodes ?? [];
  let statuses = opts.statuses ?? {};
  const deps: IdleWatchDeps = {
    now: () => now,
    sleep: async (ms) => {
      now += ms;
      sleeps += 1;
      opts.onSleep?.(sleeps, (item) => onItem?.(item));
      // Let a reseed of `server.connected` finish.
      await Bun.sleep(0);
    },
    probe: async () => {
      const state = health.length > 0 ? (health.shift() as ServerState["state"]) : "up";
      return state === "up" ? { state, version: "1" } : ({ state } as ServerState);
    },
    readServerPid: async () => {
      if (pids.length === 0) return 100;
      return pids.length > 1 ? (pids.shift() as number | null) : (pids[0] as number | null);
    },
    readDirs: async () => ["/w"],
    sessionStatus: async (directory) => {
      calls.status.push(directory);
      const map = statuses[directory];
      if (map === undefined) throw new Error("no answer");
      return map;
    },
    subscribe: (handler) => {
      onItem = handler;
      return () => {
        calls.ended = true;
      };
    },
    stopServer: async () => {
      calls.stop += 1;
      return stopCodes.length > 0 ? (stopCodes.shift() as number) : 0;
    },
    log: (line) => lines.push(line),
  };
  return {
    deps,
    calls,
    lines,
    now: () => now,
    setStatuses: (next: Record<string, StatusMap>) => {
      statuses = next;
    },
  };
}

describe("idleWatch", () => {
  test("stops an idle server after the limit through the stop path", async () => {
    const world = makeWorld({ statuses: { "/w": {} } });
    expect(await idleWatch(8767, 30, world.deps)).toBe("stopped");
    expect(world.calls.stop).toBe(1);
    expect(world.now()).toBe(30 * MINUTE);
    expect(world.lines).toEqual(["idle-stop port=8767 idle=30m"]);
    expect(world.calls.ended).toBe(true);
  });

  test("a busy session from the stream holds the stop until it is idle", async () => {
    const world = makeWorld({
      statuses: { "/w": {} },
      onSleep: (count, push) => {
        if (count === 1) push(status("ses_1", "busy"));
        if (count === 50) push(idle("ses_1"));
      },
    });
    expect(await idleWatch(8767, 30, world.deps)).toBe("stopped");
    // The idle event at minute 50 resets the time, so the stop comes 30 minutes later.
    expect(world.now()).toBe(80 * MINUTE);
  });

  test("a heartbeat does not hold the stop", async () => {
    const world = makeWorld({
      statuses: { "/w": {} },
      onSleep: (_count, push) => push({ payload: { type: "server.heartbeat", properties: {} } }),
    });
    expect(await idleWatch(8767, 30, world.deps)).toBe("stopped");
    expect(world.now()).toBe(30 * MINUTE);
  });

  test("the final check finds a busy session in a folder of the stream and resets the timer", async () => {
    const world = makeWorld({
      statuses: { "/w": {}, "/other": { ses_2: { type: "busy" } } },
      onSleep: (count, push) => {
        if (count === 1) push({ directory: "/other", payload: { type: "session.updated", properties: {} } });
      },
    });
    const result = idleWatch(8767, 30, world.deps);
    // Let the watchdog reach its final check, then end the busy session.
    await Bun.sleep(5);
    world.setStatuses({ "/w": {}, "/other": {} });
    expect(await result).toBe("stopped");
    expect(world.calls.status).toContain("/other");
    expect(world.calls.stop).toBe(1);
  });

  test("a folder that does not answer in the final check prevents the stop", async () => {
    const world = makeWorld({
      statuses: {},
      // The server PID changes after two hours, so the test ends.
      pids: [100, ...Array.from({ length: 120 }, () => 100), 200],
    });
    expect(await idleWatch(8767, 30, world.deps)).toBe("server-changed");
    expect(world.calls.stop).toBe(0);
  });

  test("ends without a stop when the server PID file changes or disappears", async () => {
    const changed = makeWorld({ pids: [100, 100, 101] });
    expect(await idleWatch(8767, 30, changed.deps)).toBe("server-changed");
    expect(changed.calls.stop).toBe(0);
    const gone = makeWorld({ pids: [100, null] });
    expect(await idleWatch(8767, 30, gone.deps)).toBe("server-changed");
    expect(gone.calls.ended).toBe(true);
  });

  test("ends without a stop after 3 failed health checks in a row", async () => {
    const world = makeWorld({ health: ["down", "down", "up", "down", "down", "down"] });
    expect(await idleWatch(8767, 30, world.deps)).toBe("server-gone");
    expect(world.calls.stop).toBe(0);
    expect(world.now()).toBe(6 * MINUTE);
  });

  test("ends at once without a server PID file", async () => {
    const world = makeWorld({ pids: [null] });
    expect(await idleWatch(8767, 30, world.deps)).toBe("no-server");
    expect(world.lines[0]).toContain("no server PID file");
  });

  test("seeds the busy set at the start and on each server.connected", async () => {
    const world = makeWorld({
      statuses: { "/w": { ses_1: { type: "busy" } } },
      onSleep: (count, push) => {
        if (count === 40) {
          world.setStatuses({ "/w": {} });
          push({ payload: { type: "server.connected", properties: {} } });
        }
      },
    });
    expect(await idleWatch(8767, 30, world.deps)).toBe("stopped");
    // The seed at the start found a busy session, the reseed at minute 40 found none.
    expect(world.now()).toBe(70 * MINUTE);
  });

  test("keeps watching when the stop fails, and stops later", async () => {
    const world = makeWorld({ statuses: { "/w": {} }, stopCodes: [1, 0] });
    expect(await idleWatch(8767, 30, world.deps)).toBe("stopped");
    expect(world.calls.stop).toBe(2);
    expect(world.lines[1]).toContain("the stop failed with exit code 1");
    expect(world.now()).toBe(60 * MINUTE);
  });
});

function tempEnv(): Record<string, string> {
  const dir = mkdtempSync(path.join(tmpdir(), "oc-sub-idle-"));
  mkdirSync(path.join(dir, "oc-sub"));
  return { XDG_STATE_HOME: dir };
}

describe("startIdleWatch", () => {
  test("spawns the watchdog with its PID file and the server log", () => {
    const env = tempEnv();
    const spawned: Array<{ cmd: readonly string[]; log: string; pid: string; cwd: string }> = [];
    startIdleWatch(env, 8767, 5, (cmd, log, pid, cwd) => {
      spawned.push({ cmd, log, pid, cwd });
      return { pid: 1, exitCode: () => null };
    });
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.cmd.slice(2)).toEqual(["idle-watch", "--port", "8767", "--minutes", "5"]);
    expect(spawned[0]?.log).toBe(serveLogPath(env, 8767));
    expect(spawned[0]?.pid).toBe(idlePidPath(env, 8767));
    expect(spawned[0]?.cwd).toBe(stateDir(env));
  });

  test("0 minutes starts nothing", () => {
    let called = false;
    startIdleWatch(tempEnv(), 8767, 0, () => {
      called = true;
      return { pid: 1, exitCode: () => null };
    });
    expect(called).toBe(false);
  });

  test("a failed spawn is a warning, not an error", () => {
    expect(() =>
      startIdleWatch(tempEnv(), 8767, 5, () => {
        throw new Error("no bun");
      }),
    ).not.toThrow();
  });
});

describe("stopIdleWatch", () => {
  test("stops a live watchdog group and removes its PID file", async () => {
    const env = tempEnv();
    const proc = Bun.spawn(["sleep", "30"], { stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true });
    writeFileSync(idlePidPath(env, 8767), `${proc.pid}\n`);
    await stopIdleWatch(env, 8767, {
      commandLineOf: () => `bun ${CLI_PATH} idle-watch --port 8767 --minutes 30`,
      killGroup: signalGroup,
    });
    await proc.exited;
    expect(proc.signalCode).toBe("SIGTERM");
    expect(existsSync(idlePidPath(env, 8767))).toBe(false);
  });

  test("a stale PID file of another process gets no signal", async () => {
    const env = tempEnv();
    writeFileSync(idlePidPath(env, 8767), `${process.pid}\n`);
    const signaled: number[] = [];
    await stopIdleWatch(
      env,
      8767,
      { commandLineOf: () => "vim notes", killGroup: (pid) => signaled.push(pid) },
      -1,
    );
    expect(signaled).toEqual([]);
    expect(existsSync(idlePidPath(env, 8767))).toBe(false);
  });

  test("the watchdog itself gets no signal when it runs the stop", async () => {
    const env = tempEnv();
    writeFileSync(idlePidPath(env, 8767), `${process.pid}\n`);
    const signaled: number[] = [];
    await stopIdleWatch(env, 8767, {
      commandLineOf: () => `bun ${CLI_PATH} idle-watch --port 8767`,
      killGroup: (pid) => signaled.push(pid),
    });
    expect(signaled).toEqual([]);
    expect(existsSync(idlePidPath(env, 8767))).toBe(false);
  });

  test("a missing PID file is fine", async () => {
    await stopIdleWatch(tempEnv(), 8767);
  });
});

describe("parseArgs for the watchdog", () => {
  test("idle-watch takes --port and --minutes", () => {
    expect(parseArgs(["idle-watch", "--port", "8767", "--minutes", "5"])).toEqual({
      command: "idle-watch",
      port: 8767,
      minutes: 5,
    });
    expect(parseArgs(["idle-watch", "--port", "8767"])).toEqual({ command: "idle-watch", port: 8767, minutes: 30 });
  });

  test("idle-watch needs a port and a limit above 0", () => {
    expect(() => parseArgs(["idle-watch"])).toThrow(UsageError);
    expect(() => parseArgs(["idle-watch", "--port", "8767", "--minutes", "0"])).toThrow(UsageError);
  });

  test("up and restart take --idle-minutes, down does not", () => {
    expect(parseArgs(["up", "--idle-minutes", "0"])).toMatchObject({ command: "up", idleMinutes: 0 });
    expect(parseArgs(["up", "--no-sandbox", "--idle-minutes=0.5"])).toMatchObject({ idleMinutes: 0.5 });
    expect(parseArgs(["restart", "--idle-minutes", "10"])).toMatchObject({ command: "restart", idleMinutes: 10 });
    expect(() => parseArgs(["down", "--idle-minutes", "10"])).toThrow(UsageError);
    expect(() => parseArgs(["up", "--idle-minutes", "-1"])).toThrow(UsageError);
    expect(() => parseArgs(["up", "--idle-minutes", "soon"])).toThrow(UsageError);
  });
});
