import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parsePriceFile } from "../src/claude/prices";
import { createClaudeSource, loadClaudeRows, type ClaudeRow } from "../src/claude/rows";
import type { SessionNamesReader } from "../src/folder-config";
import type { HandoverCheck, PlanCommitReader } from "../src/watch/conditions";
import { acquireLock, EVENTS_FILE, type LockProcess } from "../src/watch/log";
import type { Notifier } from "../src/watch/wake";
import { HEARTBEAT_MS, humanLine, nodePlanCommit, parsePlanCommit, POLL_MS, runWatchAll, toWatchRow, type WatchAllDeps } from "../src/watch/run";
import { FIXTURE_DIR, FIXTURE_ROOT, fixtureFs, MINUTE, NOW, S1, S2, S5, statLine } from "./claude-fixture";
import { claudeRowOf } from "./top-rows";

/** Ten minutes after the fixture time: S1 waits 15 minutes, and S2 is busy without growth for 20 minutes. */
const AT = NOW + 10 * 60 * 1000;
const ROOT = path.join(import.meta.dir, "..");
const prices = parsePriceFile(readFileSync(path.join(FIXTURE_DIR, "litellm-prices.json"), "utf8"));

const proc = (pid: number, live: Record<number, string> = { [pid]: "1" }): LockProcess => ({
  pid,
  procStat: (p) => (live[p] === undefined ? undefined : statLine(p, live[p] as string)),
});

type Harness = {
  deps: WatchAllDeps;
  out: string[];
  err: string[];
  sleeps: number[];
  checks: string[];
  planReads: string[];
  notices: string[];
  /** The folders that the session name reader got, one list per poll. */
  nameReads: string[][];
};

function harness(options: {
  stateDir?: string;
  clock?: () => number;
  loadRows?: WatchAllDeps["loadRows"];
  check?: HandoverCheck;
  planCommit?: PlanCommitReader;
  sessionNames?: SessionNamesReader;
  signal?: AbortSignal;
  onSleep?: () => void;
  lockProcess?: LockProcess;
  notify?: Notifier;
}): Harness {
  const notices: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const sleeps: number[] = [];
  const checks: string[] = [];
  const planReads: string[] = [];
  const nameReads: string[][] = [];
  const source = createClaudeSource(FIXTURE_ROOT, fixtureFs());
  const deps: WatchAllDeps = {
    stateDir: options.stateDir ?? mkdtempSync(path.join(tmpdir(), "idfx-watch-run-")),
    now: options.clock ?? (() => AT),
    hostname: () => "testhost",
    loadRows: options.loadRows ?? ((nowMs) => loadClaudeRows({ source, nowMs, loadPrices: async () => prices })),
    handoverCheck: (cwd) => {
      checks.push(cwd);
      return options.check?.(cwd) ?? { code: 0, firstLine: undefined };
    },
    planCommit: (cwd) => {
      planReads.push(cwd);
      return options.planCommit?.(cwd);
    },
    sessionNames: () => {
      const reads: string[] = [];
      nameReads.push(reads);
      return (folder) => {
        reads.push(folder);
        return options.sessionNames?.(folder) ?? [];
      };
    },
    sleep: async (ms) => {
      sleeps.push(ms);
      options.onSleep?.();
    },
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    lockProcess: options.lockProcess ?? proc(4242),
    // Never the real notify-session: it would wake the supervisor.
    notify: (text) => {
      notices.push(text);
      return options.notify?.(text) ?? { ok: true };
    },
    signal: options.signal,
  };
  return { deps, out, err, sleeps, checks, planReads, notices, nameReads };
}

const fileEvents = (dir: string) =>
  readFileSync(path.join(dir, EVENTS_FILE), "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));

describe("runWatchAll --once over the Claude fixture", () => {
  test("writes the events of one poll and a heartbeat, and --json echoes the same lines", async () => {
    const h = harness({});
    expect(await runWatchAll({ json: true, once: true }, h.deps)).toBe(0);
    const events = fileEvents(h.deps.stateDir);
    expect(h.out.map((line) => JSON.parse(line))).toEqual(events);
    const summary = events.map((event) => [event.subject, event.data.condition, event.data.status, event.data.reason]);
    // S1 waits 15 minutes for a Bash permission; S5 is a job that is blocked for 3 days.
    expect(summary).toContainEqual(["proj", "SessionWaitsForUser", "True", "input_required"]);
    expect(summary).toContainEqual(["blocked-job", "SessionWaitsForUser", "True", "input_required"]);
    expect(summary).toContainEqual(["bg-worker", "SessionStalled", "True", "NoTranscriptGrowth"]);
    expect(events.at(-1)).toMatchObject({
      type: "dv.idfx.watch.heartbeat",
      source: "//testhost/idfx",
      data: { sessions: 4, open: events.length - 1 },
    });
    expect(events.map((event) => event.id)).toEqual(events.map((_, i) => String(i + 1)));
    expect(events.find((event) => event.data.session === S1)?.data.cwd).toBe("/home/user/src/proj");
    expect(events.some((event) => event.data.session === S5)).toBe(true);
    expect(h.sleeps).toEqual([]);
    expect(h.err).toEqual([]);
  });

  test("events hold no prompt or intent text of the fixture", async () => {
    const h = harness({});
    await runWatchAll({ json: true, once: true }, h.deps);
    const text = readFileSync(path.join(h.deps.stateDir, EVENTS_FILE), "utf8");
    expect(text).not.toContain("FAKE");
  });

  test("a restart does not repeat a True event that is still true, and continues the sequence", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "idfx-watch-run-"));
    await runWatchAll({ json: false, once: true }, harness({ stateDir: dir }).deps);
    const first = fileEvents(dir);
    const again = harness({ stateDir: dir, clock: () => AT + 1 * MINUTE });
    expect(await runWatchAll({ json: true, once: true }, again.deps)).toBe(0);
    // No new condition edge, and no heartbeat inside 5 minutes.
    expect(again.out).toEqual([]);
    expect(fileEvents(dir)).toHaveLength(first.length);
    const later = harness({ stateDir: dir, clock: () => AT + 6 * MINUTE });
    await runWatchAll({ json: true, once: true }, later.deps);
    const added = later.out.map((line) => JSON.parse(line));
    expect(added.map((event) => event.type)).toContain("dv.idfx.watch.heartbeat");
    expect(Number(added[0]?.id)).toBe(first.length + 1);
  });

  test("a condition that cleared while the watcher was down gives a False event at start", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "idfx-watch-run-"));
    await runWatchAll({ json: false, once: true }, harness({ stateDir: dir }).deps);
    const empty = harness({ stateDir: dir, clock: () => AT + MINUTE, loadRows: async () => [] });
    await runWatchAll({ json: true, once: true }, empty.deps);
    const added = empty.out.map((line) => JSON.parse(line));
    expect(added.length).toBeGreaterThan(0);
    expect(added.every((event) => event.data.status === "False" && event.data.reason === "SessionGone")).toBe(true);
  });

  test("without --json, one short line per event", async () => {
    const h = harness({});
    await runWatchAll({ json: false, once: true }, h.deps);
    expect(h.out.some((line) => /WARN proj SessionWaitsForUser=True \(input_required\) - permission dialog: Bash permission, waits for the user since 15 min/.test(line))).toBe(
      true,
    );
    expect(h.out.at(-1)).toMatch(/INFO heartbeat: 4 sessions/);
  });
});

describe("the lock and the loop", () => {
  test("a second watcher exits with code 1 and a message", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "idfx-watch-run-"));
    const live = { 100: "1", 200: "2" };
    const first = acquireLock(dir, proc(100, live));
    expect(first.ok).toBe(true);
    const h = harness({ stateDir: dir, lockProcess: proc(200, live) });
    expect(await runWatchAll({ json: true, once: true }, h.deps)).toBe(1);
    expect(h.err.join("\n")).toMatch(/another watcher runs \(pid 100\)/);
    expect(h.out).toEqual([]);
    if (first.ok) first.lock.release();
  });

  test("the loop polls every 15 seconds, sends the heartbeat every 5 minutes, and stops on the signal", async () => {
    const controller = new AbortController();
    let now = NOW;
    let polls = 0;
    const h = harness({
      clock: () => now,
      loadRows: async () => {
        polls += 1;
        return [];
      },
      signal: controller.signal,
      onSleep: () => {
        now += POLL_MS;
        if (polls >= 41) controller.abort();
      },
    });
    expect(await runWatchAll({ json: true, once: false }, h.deps)).toBe(0);
    expect(polls).toBe(41);
    expect(h.sleeps.every((ms) => ms === POLL_MS)).toBe(true);
    const beats = h.out.map((line) => JSON.parse(line)).filter((event) => event.type === "dv.idfx.watch.heartbeat");
    // 41 polls over 10 minutes: at 0, 5, and 10 minutes.
    expect(beats.map((event) => Date.parse(event.time) - NOW)).toEqual([0, HEARTBEAT_MS, 2 * HEARTBEAT_MS]);
    // The lock is free again.
    expect(acquireLock(h.deps.stateDir, proc(1)).ok).toBe(true);
  });

  test("a failing poll warns and the loop goes on; --once then exits with code 1", async () => {
    const failing = harness({
      loadRows: async () => {
        throw new Error("disk gone");
      },
    });
    expect(await runWatchAll({ json: true, once: true }, failing.deps)).toBe(1);
    expect(failing.err).toEqual(["idfx watch: the poll failed: disk gone"]);
  });

  test("handover check runs once at the edge from busy to ended, and exit code 1 gives HandoverFailed only", async () => {
    let state: ClaudeRow["state"] = "busy";
    const controller = new AbortController();
    let now = NOW;
    let polls = 0;
    const h = harness({
      clock: () => now,
      loadRows: async () => {
        polls += 1;
        return [claudeRowOf(S1, { name: "proj", directory: "/home/user/src/proj", state, pid: 1, transcriptGrowthMs: now, lastActivityMs: now })];
      },
      check: () => ({ code: 1, firstLine: "handover: not pushed" }),
      signal: controller.signal,
      onSleep: () => {
        now += POLL_MS;
        if (polls === 2) state = "ended";
        if (polls >= 4) controller.abort();
      },
    });
    await runWatchAll({ json: true, once: false }, h.deps);
    expect(h.checks).toEqual(["/home/user/src/proj"]);
    const failed = h.out.map((line) => JSON.parse(line)).filter((event) => event.data.condition === "HandoverFailed");
    expect(failed.map((event) => [event.data.status, event.data.message, event.severitytext])).toEqual([
      ["True", "handover: not pushed", "WARN"],
    ]);
    expect(h.planReads).toEqual([]);
    expect(h.out.some((line) => line.includes("SessionHandedOff"))).toBe(false);
  });
});

describe("SessionHandedOff in the loop", () => {
  const HASH_A = "a".repeat(40);
  const HASH_B = "b".repeat(40);

  /** Runs one loop over the given row states, one state per poll, and returns the harness. */
  async function loop(
    dir: string,
    startMs: number,
    states: Array<ClaudeRow["state"]>,
    planCommit: () => string | undefined,
  ): Promise<Harness> {
    const controller = new AbortController();
    let now = startMs;
    let polls = 0;
    const h = harness({
      stateDir: dir,
      clock: () => now,
      loadRows: async () => {
        const state = states[polls] ?? "idle";
        polls += 1;
        return [claudeRowOf(S1, { name: "proj", directory: "/home/user/src/proj", state, pid: 1, transcriptGrowthMs: now, lastActivityMs: now })];
      },
      planCommit,
      signal: controller.signal,
      onSleep: () => {
        now += POLL_MS;
        if (polls >= states.length) controller.abort();
      },
    });
    await runWatchAll({ json: true, once: false }, h.deps);
    return h;
  }

  const handedOff = (h: Harness) =>
    h.out.map((line) => JSON.parse(line)).filter((event) => event.data.condition === "SessionHandedOff");

  test("an idle edge with a clean check writes one INFO event with the plan commit, and sends no notice", async () => {
    const dir = await (async () => {
      const d = mkdtempSync(path.join(tmpdir(), "idfx-watch-run-"));
      await runWatchAll({ json: false, once: true }, harness({ stateDir: d, clock: () => NOW, loadRows: async () => [] }).deps);
      return d;
    })();
    const h = await loop(dir, NOW + MINUTE, ["busy", "idle", "idle", "busy", "idle"], () => HASH_A);
    expect(h.checks).toEqual(["/home/user/src/proj", "/home/user/src/proj"]);
    const events = handedOff(h);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "dv.idfx.session.handed-off",
      subject: "proj",
      severitytext: "INFO",
      severitynumber: 9,
      data: { condition: "SessionHandedOff", status: "True", reason: "HandoverCheckPassed", planCommit: HASH_A, session: S1 },
    });
    expect(h.notices).toEqual([]);
  });

  test("a restart remembers the plan commit from the log", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "idfx-watch-run-"));
    const first = await loop(dir, NOW, ["busy", "idle"], () => HASH_A);
    expect(handedOff(first)).toHaveLength(1);
    // A new watcher: the same commit gives no second event, a new commit gives one.
    const same = await loop(dir, NOW + 10 * MINUTE, ["busy", "idle"], () => HASH_A);
    expect(same.checks).toHaveLength(1);
    expect(handedOff(same)).toEqual([]);
    const next = await loop(dir, NOW + 20 * MINUTE, ["busy", "idle"], () => HASH_B);
    expect(handedOff(next).map((event) => event.data.planCommit)).toEqual([HASH_B]);
  });
});

describe("the wake-up of the supervisor", () => {
  /** A state folder whose log already holds one heartbeat, so the next run is no baseline. */
  async function seededDir(): Promise<string> {
    const dir = mkdtempSync(path.join(tmpdir(), "idfx-watch-run-"));
    const seed = harness({ stateDir: dir, clock: () => NOW, loadRows: async () => [] });
    await runWatchAll({ json: false, once: true }, seed.deps);
    expect(seed.notices).toEqual([]);
    return dir;
  }

  test("the first poll of a new log is the baseline: it writes the events but sends no notice", async () => {
    const h = harness({});
    await runWatchAll({ json: true, once: true }, h.deps);
    expect(fileEvents(h.deps.stateDir).some((event) => event.data.condition === "SessionWaitsForUser")).toBe(true);
    expect(h.notices).toEqual([]);
  });

  test("one notice for all notifying True edges of a poll, without the other conditions", async () => {
    const dir = await seededDir();
    const h = harness({ stateDir: dir });
    await runWatchAll({ json: true, once: true }, h.deps);
    // The fixture also gives SessionStalled (bg-worker); it goes only to the log.
    expect(fileEvents(dir).some((event) => event.data.condition === "SessionStalled")).toBe(true);
    expect(h.notices).toEqual([
      `idfx watch: 2 events: proj waits for user (permission dialog: Bash permission), blocked-job waits for user (blocked job: approve the push). Log: ${path.join(dir, EVENTS_FILE)}`,
    ]);
  });

  test("a restart with open conditions sends no notice", async () => {
    const dir = await seededDir();
    await runWatchAll({ json: true, once: true }, harness({ stateDir: dir }).deps);
    const again = harness({ stateDir: dir, clock: () => AT + MINUTE });
    await runWatchAll({ json: true, once: true }, again.deps);
    expect(again.notices).toEqual([]);
  });

  test("False edges and a condition that stays True send no notice", async () => {
    const dir = await seededDir();
    await runWatchAll({ json: true, once: true }, harness({ stateDir: dir }).deps);
    const gone = harness({ stateDir: dir, clock: () => AT + MINUTE, loadRows: async () => [] });
    await runWatchAll({ json: true, once: true }, gone.deps);
    expect(gone.out.length).toBeGreaterThan(0);
    expect(gone.notices).toEqual([]);
  });

  test("at most one notice per 60 seconds; edges in the pause go out with the next notice", async () => {
    const dir = await seededDir();
    const controller = new AbortController();
    let now = AT;
    let polls = 0;
    const waiting = (id: string, name: string) =>
      claudeRowOf(id, { name, directory: `/home/user/src/${name}`, state: "waiting", pid: 1, stateSinceMs: AT - 20 * MINUTE, waitingFor: "input needed" });
    const h = harness({
      stateDir: dir,
      clock: () => now,
      loadRows: async () => {
        polls += 1;
        const rows = [waiting(S1, "alpha")];
        if (polls >= 2) rows.push(waiting(S5, "beta"));
        if (polls >= 3) rows.push(waiting(S2, "gamma"));
        return rows;
      },
      signal: controller.signal,
      onSleep: () => {
        now += POLL_MS;
        if (polls >= 6) controller.abort();
      },
    });
    await runWatchAll({ json: true, once: false }, h.deps);
    expect(h.err).toEqual([]);
    // Poll 1 at 0 s sends; polls 2 and 3 wait; poll 5 at 60 s sends both.
    expect(h.notices).toEqual([
      `idfx watch: 1 event: alpha waits for user (input needed). Log: ${path.join(dir, EVENTS_FILE)}`,
      `idfx watch: 2 events: beta waits for user (input needed), gamma waits for user (input needed). Log: ${path.join(dir, EVENTS_FILE)}`,
    ]);
  });

  test("a failing notify-session warns, and the watcher goes on", async () => {
    const dir = await seededDir();
    const h = harness({ stateDir: dir, notify: () => ({ ok: false, missing: false, message: "notify-session exited with code 1" }) });
    expect(await runWatchAll({ json: true, once: true }, h.deps)).toBe(0);
    expect(h.notices).toHaveLength(1);
    expect(h.err).toEqual(["idfx watch: the wake-up failed: notify-session exited with code 1"]);
  });
});

describe("toWatchRow", () => {
  test("it fills project from the folder of the row", () => {
    const seen: string[] = [];
    const row = claudeRowOf(S1, { name: "idfix-36", directory: "/home/user/src/idfix/.worktrees/36-worker-names", pid: 1 });
    const watchRow = toWatchRow(row, (directory) => {
      seen.push(directory);
      return { root: "/home/user/src/idfix", name: "idfix" };
    });
    expect(seen).toEqual(["/home/user/src/idfix/.worktrees/36-worker-names"]);
    expect(watchRow).toMatchObject({ project: "idfix", projectRoot: "/home/user/src/idfix", name: "idfix-36", live: true });
  });

  test("it passes the turn and the count of background tasks", () => {
    const row = claudeRowOf(S1, { pid: 1, turn: "ended", backgroundTasks: 2 });
    expect(toWatchRow(row, () => ({ root: "/r", name: "r" }))).toMatchObject({ turn: "ended", backgroundTasks: 2 });
  });

  test("the default project is the folder name when the folder does not exist", () => {
    const row = claudeRowOf(S1, { directory: "/nonexistent-idfix-test/dv/proj" });
    expect(toWatchRow(row)).toMatchObject({ project: "proj", projectRoot: "/nonexistent-idfix-test/dv/proj" });
  });
});

describe("humanLine", () => {
  test("names the subject, the condition, the status, and the reason", () => {
    expect(
      humanLine({
        specversion: "1.0",
        id: "1",
        source: "//h/idfx",
        type: "dv.idfx.session.context-high",
        time: "2026-10-06T10:00:00.000Z",
        subject: "proj-a",
        sequence: "00000000000000000001",
        severitytext: "WARN",
        severitynumber: 13,
        data: { condition: "ContextHigh", status: "True", reason: "OverHalfWindow", message: "context 54% of 200000 tokens" },
      }),
    ).toBe("2026-10-06T10:00:00.000Z WARN proj-a ContextHigh=True (OverHalfWindow) - context 54% of 200000 tokens");
  });
});

describe("the command line", () => {
  test("watch SESSION --all is a usage error with exit code 2", () => {
    const result = Bun.spawnSync([path.join(ROOT, "bin", "idfx"), "watch", "ses_1", "--all"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toMatch(/usage error: watch --all takes no SESSION/);
  });

  test("watch --all --once --json against an empty Claude folder prints only the heartbeat", () => {
    const state = mkdtempSync(path.join(tmpdir(), "idfx-watch-cli-"));
    const claude = mkdtempSync(path.join(tmpdir(), "idfx-watch-claude-"));
    const result = Bun.spawnSync([path.join(ROOT, "bin", "idfx"), "watch", "--all", "--once", "--json"], {
      env: { ...process.env, XDG_STATE_HOME: state, CLAUDE_CONFIG_DIR: claude },
    });
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.toString().trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ type: "dv.idfx.watch.heartbeat", data: { sessions: 0, open: 0 } });
    expect(fileEvents(path.join(state, "idfx"))).toHaveLength(1);
  });
});

describe("parsePlanCommit", () => {
  const hash = "24e69b18e1666a40683c6139cfd1c8e507d064e5";

  test("takes planCommit from the output of handover show --json", () => {
    const out = JSON.stringify({ nextStep: null, waitsFor: null, newContext: false, planCommit: hash, planDir: ".plan" });
    expect(parsePlanCommit(`${out}\n`)).toBe(hash);
  });

  test("a null or missing planCommit gives undefined", () => {
    expect(parsePlanCommit(JSON.stringify({ planCommit: null, planDir: "docs" }))).toBeUndefined();
    expect(parsePlanCommit(JSON.stringify({ planDir: "docs" }))).toBeUndefined();
  });

  test("bad JSON, an empty output, or a value that is not an object gives undefined", () => {
    expect(parsePlanCommit("")).toBeUndefined();
    expect(parsePlanCommit("handover: plan missing")).toBeUndefined();
    expect(parsePlanCommit("{")).toBeUndefined();
    expect(parsePlanCommit(JSON.stringify(hash))).toBeUndefined();
    expect(parsePlanCommit("null")).toBeUndefined();
    expect(parsePlanCommit(JSON.stringify([hash]))).toBeUndefined();
  });

  test("a planCommit that is not a hex hash gives undefined", () => {
    for (const bad of ["", "HEAD", "abc", "24E69B18E1666A40", "zz69b18e16", 42, true]) {
      expect(parsePlanCommit(JSON.stringify({ planCommit: bad }))).toBeUndefined();
    }
  });
});

describe("nodePlanCommit", () => {
  /**
   * The environment without the variables of `git rev-parse --local-env-vars`
   * from a hook. The preload moves XDG_STATE_HOME, so mise no longer knows
   * the trusted config files above this checkout, and the mise shim of
   * python3 that runs `handover` fails. MISE_TRUSTED_CONFIG_PATHS trusts them
   * again, for this child only.
   */
  function cleanEnv(): Record<string, string> {
    const ancestors: string[] = [];
    for (let dir = ROOT; ; dir = path.dirname(dir)) {
      ancestors.push(dir);
      if (path.dirname(dir) === dir) break;
    }
    const env: Record<string, string | undefined> = { ...process.env, MISE_TRUSTED_CONFIG_PATHS: ancestors.join(":") };
    const local = Bun.spawnSync(["git", "rev-parse", "--local-env-vars"], { env: env as Record<string, string> });
    for (const name of local.stdout.toString().split("\n")) if (name.trim().length > 0) delete env[name.trim()];
    return env as Record<string, string>;
  }

  /** git with a clean environment: no variable of `git rev-parse --local-env-vars` from a hook leaks in. */
  function git(cwd: string, ...args: string[]): string {
    const result = Bun.spawnSync(["git", "-C", cwd, ...args], {
      env: {
        ...cleanEnv(),
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.invalid",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.invalid",
      },
    });
    if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
    return result.stdout.toString().trim();
  }

  function commitAll(repo: string, message: string): string {
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", message);
    return git(repo, "rev-parse", "HEAD");
  }

  const PLAN = "# Plan\n\n## Hand-off\n\nNext step: 1. Do it.\nWaits for: nothing\nNew context: no. Small.\n";
  const hasHandover = Bun.which("handover") !== null;

  test.skipIf(!hasHandover)("reads the last commit of docs/PLAN.md by default, not of another file", () => {
    const repo = mkdtempSync(path.join(tmpdir(), "idfx-plan-commit-"));
    git(repo, "init", "-q");
    const read = nodePlanCommit(cleanEnv());
    expect(read(repo)).toBeUndefined();
    mkdirSync(path.join(repo, "docs"));
    writeFileSync(path.join(repo, "docs", "PLAN.md"), PLAN);
    const planHash = commitAll(repo, "plan");
    writeFileSync(path.join(repo, "other.txt"), "x\n");
    commitAll(repo, "other");
    expect(read(repo)).toBe(planHash);
    expect(read(mkdtempSync(path.join(tmpdir(), "idfx-no-repo-")))).toBeUndefined();
  });

  test.skipIf(!hasHandover)("with plan_dir = \".plan\", reads the last plan commit of the companion repository", () => {
    const repo = mkdtempSync(path.join(tmpdir(), "idfx-plan-companion-"));
    git(repo, "init", "-q");
    writeFileSync(path.join(repo, ".handover.toml"), 'plan_dir = ".plan"\n');
    writeFileSync(path.join(repo, ".gitignore"), ".plan/\n");
    // A docs/PLAN.md in the main checkout must not count.
    mkdirSync(path.join(repo, "docs"));
    writeFileSync(path.join(repo, "docs", "PLAN.md"), PLAN);
    const mainHash = commitAll(repo, "main");
    const read = nodePlanCommit(cleanEnv());
    expect(read(repo)).toBeUndefined();
    const plan = path.join(repo, ".plan");
    mkdirSync(plan);
    git(plan, "init", "-q");
    writeFileSync(path.join(plan, "PLAN.md"), PLAN);
    const planHash = commitAll(plan, "plan");
    writeFileSync(path.join(plan, "notes.md"), "x\n");
    commitAll(plan, "notes");
    expect(planHash).not.toBe(mainHash);
    expect(read(repo)).toBe(planHash);
  });
});

describe("runWatchAll with session names", () => {
  const lead = (name: string) =>
    claudeRowOf(S1, { name, directory: "/nonexistent-idfix-test/home/user/src", pid: 1, state: "idle" });

  test("a listed role name gives no SessionUnnamed event, and the reader starts once per poll", async () => {
    const h = harness({
      loadRows: async () => [lead("lead")],
      sessionNames: (folder) => (folder === "/nonexistent-idfix-test/home/user/src" ? ["lead", "reviewer"] : []),
    });
    expect(await runWatchAll({ json: true, once: true }, h.deps)).toBe(0);
    expect(h.out.filter((line) => line.includes("SessionUnnamed"))).toEqual([]);
    expect(h.nameReads).toEqual([["/nonexistent-idfix-test/home/user/src"]]);
  });

  test("a role name that is not listed gives NameOffRule with the listed names", async () => {
    const h = harness({ loadRows: async () => [lead("planner")], sessionNames: () => ["lead", "reviewer"] });
    expect(await runWatchAll({ json: true, once: true }, h.deps)).toBe(0);
    const events = h.out.map((line) => JSON.parse(line)).filter((event) => event.data?.condition === "SessionUnnamed");
    expect(events.map((event) => [event.data.reason, event.data.message])).toEqual([
      ["NameOffRule", 'expected "src" or "src-<step>" or one of: lead, reviewer'],
    ]);
  });
});
