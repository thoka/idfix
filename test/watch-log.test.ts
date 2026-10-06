import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { INFO, WARN, type Edge } from "../src/watch/conditions";
import {
  acquireLock,
  conditionEvent,
  EVENTS_FILE,
  formatSequence,
  heartbeatEvent,
  LOCK_FILE,
  openEventWriter,
  readLogState,
  sourceOf,
  watchStateDir,
  type CloudEvent,
  type LockProcess,
} from "../src/watch/log";
import { statLine } from "./claude-fixture";

const T0 = Date.parse("2026-10-06T10:00:00.000Z");
const SOURCE = sourceOf("mini-arch");

const tempDir = () => mkdtempSync(path.join(tmpdir(), "idfx-watch-log-"));

function edge(overrides: Partial<Edge> = {}): Edge {
  return {
    condition: "SessionWaitsForUser",
    status: "True",
    reason: "PermissionDialog",
    message: "waits 12 min: Bash permission",
    lastTransitionMs: T0,
    session: "14930230-7d4a-43c8-8d36-3498b1e09305",
    subject: "meta-f2",
    cwd: "/home/u/dv/meta",
    kind: "interactive",
    severity: WARN,
    ...overrides,
  };
}

const lines = (dir: string, file = EVENTS_FILE) =>
  readFileSync(path.join(dir, file), "utf8")
    .split("\n")
    .filter((line) => line.length > 0);

/** The JSON Schema check: the CloudEvents 1.0 schema plus the required protocol extensions. */
function schemaValidator() {
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  const fixtures = path.join(import.meta.dir, "fixtures");
  const ce = JSON.parse(readFileSync(path.join(fixtures, "cloudevents.schema.json"), "utf8"));
  ajv.addSchema(ce, "https://dv.invalid/idfx/cloudevents.schema.json");
  return ajv.compile(JSON.parse(readFileSync(path.join(fixtures, "idfx-event.schema.json"), "utf8")));
}

describe("the envelope", () => {
  test("a condition event carries the attributes of the protocol", () => {
    const event = conditionEvent(edge(), 413, SOURCE);
    expect(event).toEqual({
      specversion: "1.0",
      id: "413",
      source: "//mini-arch/idfx",
      type: "dv.idfx.session.waits-for-user",
      time: "2026-10-06T10:00:00.000Z",
      subject: "meta-f2",
      sequence: "00000000000000000413",
      severitytext: "WARN",
      severitynumber: 13,
      data: {
        condition: "SessionWaitsForUser",
        status: "True",
        reason: "PermissionDialog",
        message: "waits 12 min: Bash permission",
        lastTransitionTime: "2026-10-06T10:00:00.000Z",
        session: "14930230-7d4a-43c8-8d36-3498b1e09305",
        cwd: "/home/u/dv/meta",
        kind: "interactive",
      },
    });
  });

  test("each event type passes the CloudEvents schema with sequence and severity", () => {
    const validate = schemaValidator();
    const events: CloudEvent[] = [
      conditionEvent(edge(), 1, SOURCE),
      conditionEvent(edge({ condition: "ApiError", reason: "UsageLimit", severity: { text: "ERROR", number: 17 } }), 2, SOURCE),
      conditionEvent(edge({ condition: "SessionUnnamed", status: "False", severity: INFO }), 3, SOURCE),
      conditionEvent(edge({ condition: "SessionStalled" }), 4, SOURCE),
      conditionEvent(edge({ condition: "ContextHigh" }), 5, SOURCE),
      conditionEvent(edge({ condition: "HandoverFailed" }), 6, SOURCE),
      heartbeatEvent(7, SOURCE, T0, { sessions: 3, open: 1 }),
    ];
    for (const event of events) {
      const ok = validate(event);
      expect({ type: event.type, errors: validate.errors ?? null }).toEqual({ type: event.type, errors: null });
      expect(ok).toBe(true);
    }
    const { sequence: _sequence, ...withoutSequence } = conditionEvent(edge(), 8, SOURCE);
    expect(validate(withoutSequence)).toBe(false);
    expect(validate({ ...conditionEvent(edge(), 9, SOURCE), severitynumber: undefined })).toBe(false);
  });

  test("the sequence has 20 digits", () => {
    expect(formatSequence(1)).toBe("00000000000000000001");
    expect(formatSequence(1)).toHaveLength(20);
  });

  test("the folder is $XDG_STATE_HOME/idfx, else ~/.local/state/idfx", () => {
    expect(watchStateDir({ XDG_STATE_HOME: "/s" })).toBe("/s/idfx");
    expect(watchStateDir({ HOME: "/h" })).toBe("/h/.local/state/idfx");
    expect(watchStateDir({ XDG_STATE_HOME: "relative", HOME: "/h" })).toBe("/h/.local/state/idfx");
  });
});

describe("the writer", () => {
  test("one full line per event, in append mode", () => {
    const dir = tempDir();
    const writer = openEventWriter(dir, 0);
    writer.append((seq) => conditionEvent(edge(), seq, SOURCE));
    writer.append((seq) => heartbeatEvent(seq, SOURCE, T0, { sessions: 1, open: 1 }));
    writer.close();
    const written = lines(dir);
    expect(written).toHaveLength(2);
    expect(written.map((line) => JSON.parse(line).sequence)).toEqual(["00000000000000000001", "00000000000000000002"]);
    expect(readFileSync(path.join(dir, EVENTS_FILE), "utf8").endsWith("\n")).toBe(true);
  });

  test("the sequence continues after a restart", () => {
    const dir = tempDir();
    const first = openEventWriter(dir, readLogState(dir).lastSequence);
    for (let i = 0; i < 3; i++) first.append((seq) => conditionEvent(edge(), seq, SOURCE));
    first.close();
    const state = readLogState(dir);
    expect(state.lastSequence).toBe(3);
    const second = openEventWriter(dir, state.lastSequence);
    second.append((seq) => conditionEvent(edge(), seq, SOURCE));
    second.close();
    expect(lines(dir).map((line) => JSON.parse(line).id)).toEqual(["1", "2", "3", "4"]);
  });

  test("a cut last line after a crash is closed, and the next event starts on its own line", () => {
    const dir = tempDir();
    const event = JSON.stringify(conditionEvent(edge(), 1, SOURCE));
    writeFileSync(path.join(dir, EVENTS_FILE), `${event}\n{"specversion":"1.0","id":"2","seq`);
    const state = readLogState(dir);
    expect(state.lastSequence).toBe(1);
    const writer = openEventWriter(dir, state.lastSequence);
    writer.append((seq) => conditionEvent(edge(), seq, SOURCE));
    writer.close();
    expect(JSON.parse(lines(dir).at(-1) ?? "{}").id).toBe("2");
  });

  test("above the size limit the file is renamed to events.<first sequence>.jsonl, and the sequence continues", () => {
    const dir = tempDir();
    const writer = openEventWriter(dir, 0, 500);
    for (let i = 0; i < 4; i++) writer.append((seq) => conditionEvent(edge(), seq, SOURCE));
    writer.close();
    const files = readdirSync(dir).sort();
    expect(files).toContain(`events.${formatSequence(1)}.jsonl`);
    expect(files).toContain(EVENTS_FILE);
    const rotated = lines(dir, `events.${formatSequence(1)}.jsonl`).map((line) => JSON.parse(line).id);
    const current = lines(dir).map((line) => JSON.parse(line).id);
    expect([...rotated, ...current]).toEqual(["1", "2", "3", "4"]);
    expect(rotated[0]).toBe("1");
    // A restart after the rotation continues the sequence.
    expect(readLogState(dir).lastSequence).toBe(4);
  });

  test("after a rotation into an empty current file, a restart still finds the sequence and the records", () => {
    const dir = tempDir();
    const writer = openEventWriter(dir, 0, 10);
    writer.append((seq) => conditionEvent(edge(), seq, SOURCE));
    writer.append((seq) => conditionEvent(edge({ condition: "ContextHigh" }), seq, SOURCE));
    writer.close();
    const state = readLogState(dir);
    expect(state.lastSequence).toBe(2);
    expect(state.records.map((record) => record.condition).sort()).toEqual(["ContextHigh", "SessionWaitsForUser"]);
  });
});

describe("the state at start", () => {
  test("the last record of each condition and session, the last time, and the last heartbeat", () => {
    const dir = tempDir();
    const writer = openEventWriter(dir, 0);
    writer.append((seq) => conditionEvent(edge(), seq, SOURCE));
    writer.append((seq) => heartbeatEvent(seq, SOURCE, T0 + 1000, { sessions: 1, open: 1 }));
    writer.append((seq) =>
      conditionEvent(edge({ status: "False", reason: "Cleared", message: "", lastTransitionMs: T0 + 2000, severity: INFO }), seq, SOURCE),
    );
    writer.append((seq) => conditionEvent(edge({ condition: "ContextHigh", lastTransitionMs: T0 + 3000 }), seq, SOURCE));
    writer.close();
    const state = readLogState(dir);
    expect(state.lastSequence).toBe(4);
    expect(state.lastTimeMs).toBe(T0 + 3000);
    expect(state.lastHeartbeatMs).toBe(T0 + 1000);
    const byCondition = Object.fromEntries(state.records.map((record) => [record.condition, record]));
    expect(byCondition.SessionWaitsForUser).toMatchObject({ status: "False", lastTransitionMs: T0 + 2000, subject: "meta-f2" });
    expect(byCondition.ContextHigh).toMatchObject({ status: "True", lastTransitionMs: T0 + 3000 });
  });

  test("an empty folder gives sequence 0 and no records", () => {
    expect(readLogState(path.join(tempDir(), "missing"))).toEqual({
      lastSequence: 0,
      lastTimeMs: undefined,
      lastHeartbeatMs: undefined,
      records: [],
    });
  });
});

describe("the lock", () => {
  const procs = (live: Record<number, string>, pid: number): LockProcess => ({
    pid,
    procStat: (p) => (live[p] === undefined ? undefined : statLine(p, live[p] as string)),
  });

  test("a second watcher gets no lock while the first one lives", () => {
    const dir = tempDir();
    const live = { 100: "5000", 200: "6000" };
    const first = acquireLock(dir, procs(live, 100));
    expect(first.ok).toBe(true);
    const second = acquireLock(dir, procs(live, 200));
    expect(second).toEqual({ ok: false, holderPid: 100 });
    if (first.ok) first.lock.release();
    expect(existsSync(path.join(dir, LOCK_FILE))).toBe(false);
    expect(acquireLock(dir, procs(live, 200)).ok).toBe(true);
  });

  test("a lock of a dead process is stale and the next watcher takes it", () => {
    const dir = tempDir();
    expect(acquireLock(dir, procs({ 100: "5000" }, 100)).ok).toBe(true);
    // Process 100 died without a release.
    const next = acquireLock(dir, procs({ 200: "6000" }, 200));
    expect(next.ok).toBe(true);
    expect(JSON.parse(readFileSync(path.join(dir, LOCK_FILE), "utf8")).pid).toBe(200);
  });

  test("a lock whose PID now belongs to another process is stale", () => {
    const dir = tempDir();
    expect(acquireLock(dir, procs({ 100: "5000" }, 100)).ok).toBe(true);
    // PID 100 was reused: its start time differs.
    expect(acquireLock(dir, procs({ 100: "9999", 200: "6000" }, 200)).ok).toBe(true);
  });

  test("the release does not remove the lock of another watcher", () => {
    const dir = tempDir();
    const first = acquireLock(dir, procs({ 100: "5000" }, 100));
    // The first watcher hangs; a second one took the stale lock.
    acquireLock(dir, procs({ 200: "6000" }, 200));
    if (first.ok) first.lock.release();
    expect(JSON.parse(readFileSync(path.join(dir, LOCK_FILE), "utf8")).pid).toBe(200);
  });
});
