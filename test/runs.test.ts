import { describe, expect, test } from "bun:test";
import path from "node:path";
import { rmSync, mkdirSync, writeFileSync } from "node:fs";
import {
  loadAllRunRecords,
  loadRunRecord,
  makeRunRecord,
  otherRunIds,
  realCostLine,
  runRecordPath,
  stateRunRecordPath,
  stateRunsDir,
  writeRunRecord,
  writeStateRunRecord,
  type RunRecord,
} from "../src/runs";

const ENV = { XDG_STATE_HOME: "/tmp/opencode/runs-test/state" };
const CWD = "/tmp/opencode/runs-test/cwd";

describe("state run record paths", () => {
  test("live under <stateHome>/oc-sub/runs", () => {
    expect(stateRunsDir(ENV)).toBe(path.join("/tmp/opencode/runs-test/state", "oc-sub", "runs"));
    expect(stateRunRecordPath(ENV, "ses_1")).toBe(
      path.join("/tmp/opencode/runs-test/state", "oc-sub", "runs", "ses_1.json"),
    );
  });

  test("writeStateRunRecord writes JSON that reads back", async () => {
    rmSync("/tmp/opencode/runs-test", { recursive: true, force: true });
    const record = makeRunRecord({
      sessionId: "ses_state",
      directory: "/w",
      agent: "coder",
      keyFingerprint: "ab12cd34",
      usageAtStart: 0.5,
    });
    const file = await writeStateRunRecord(ENV, record);
    expect(file).toBe(stateRunRecordPath(ENV, "ses_state"));
    const loaded = await loadRunRecord("ses_state", CWD, ENV);
    expect(loaded).toEqual(record);
    rmSync("/tmp/opencode/runs-test", { recursive: true, force: true });
  });
});

describe("otherRunIds", () => {
  const run: RunRecord = makeRunRecord({
    sessionId: "ses_main",
    directory: "/w",
    agent: "coder",
    keyFingerprint: "ab12cd34",
    startedAt: new Date("2026-09-29T10:00:00Z"),
  });

  test("collects other runs with the same fingerprint that started at or after the run", () => {
    const records = [
      makeRunRecord({ sessionId: "ses_early", directory: "/w", agent: "a", keyFingerprint: "ab12cd34", startedAt: new Date("2026-09-29T09:00:00Z") }),
      makeRunRecord({ sessionId: "ses_late", directory: "/w", agent: "a", keyFingerprint: "ab12cd34", startedAt: new Date("2026-09-29T10:30:00Z") }),
      makeRunRecord({ sessionId: "ses_same", directory: "/w", agent: "a", keyFingerprint: "ab12cd34", startedAt: new Date("2026-09-29T10:00:00Z") }),
    ];
    expect(otherRunIds(records, run)).toEqual(["ses_late", "ses_same"]);
  });

  test("ignores other fingerprints, old records, and the run itself", () => {
    const records = [
      makeRunRecord({ sessionId: "ses_other_key", directory: "/w", agent: "a", keyFingerprint: "ffff0000", startedAt: new Date("2026-09-29T11:00:00Z") }),
      makeRunRecord({ sessionId: "ses_no_fp", directory: "/w", agent: "a", startedAt: new Date("2026-09-29T11:00:00Z") }),
      run,
    ];
    expect(otherRunIds(records, run)).toEqual([]);
  });
});

describe("realCostLine", () => {
  const run: RunRecord = makeRunRecord({
    sessionId: "ses_1",
    directory: "/w",
    agent: "coder",
    keyFingerprint: "ab12cd34",
    usageAtStart: 1,
  });

  test("shows the growth of the key usage with 4 decimals", () => {
    expect(realCostLine(run, 1.0512, [])).toBe(
      "real cost $0.0512 at OpenRouter (key usage since the start of the run)",
    );
  });

  test("names overlapping runs of the same key", () => {
    expect(realCostLine(run, 1.0512, ["ses_a", "ses_b"])).toBe(
      "real cost $0.0512 at OpenRouter (key usage since the start of the run), includes other runs: ses_a, ses_b",
    );
  });

  test("is unknown without a record or without the usage at the start", () => {
    expect(realCostLine(null, 1, [])).toBe("real cost: unknown (no key usage at the start of the run)");
    const withoutUsage = makeRunRecord({ sessionId: "s", directory: "/w", agent: "a", keyFingerprint: "ab12cd34" });
    expect(realCostLine(withoutUsage, 1, [])).toBe("real cost: unknown (no key usage at the start of the run)");
    const failedStart = makeRunRecord({ sessionId: "s", directory: "/w", agent: "a", keyFingerprint: "ab12cd34", usageAtStart: null });
    expect(realCostLine(failedStart, 1, [])).toBe("real cost: unknown (no key usage at the start of the run)");
  });

  test("is unknown when OpenRouter does not answer at the end", () => {
    expect(realCostLine(run, null, [])).toBe("real cost: unknown (OpenRouter did not answer)");
  });
});

describe("loadAllRunRecords", () => {
  test("reads the records of the state folder and of cwd without duplicates", async () => {
    rmSync("/tmp/opencode/runs-test", { recursive: true, force: true });
    mkdirSync(path.join(CWD, ".opencode", "runs"), { recursive: true });
    const a = makeRunRecord({ sessionId: "ses_a", directory: "/w", agent: "a", keyFingerprint: "ab12cd34", usageAtStart: 1 });
    const b = makeRunRecord({ sessionId: "ses_b", directory: "/w", agent: "a", keyFingerprint: "ab12cd34", usageAtStart: 1 });
    await writeStateRunRecord(ENV, a);
    writeFileSync(runRecordPath(CWD, "ses_b"), `${JSON.stringify(b, null, 2)}\n`);
    writeFileSync(runRecordPath(CWD, "broken.json"), "not json\n");
    const records = await loadAllRunRecords(CWD, ENV);
    expect(records.map((record) => record.sessionId).sort()).toEqual(["ses_a", "ses_b"]);
    rmSync("/tmp/opencode/runs-test", { recursive: true, force: true });
  });

  test("is empty without any folder", async () => {
    rmSync("/tmp/opencode/runs-test", { recursive: true, force: true });
    expect(await loadAllRunRecords(CWD, ENV)).toEqual([]);
    expect(await loadRunRecord("ses_missing", CWD, ENV)).toBeNull();
  });
});

describe("makeRunRecord keeps the new fields optional", () => {
  test("an old-style record has neither fingerprint nor usage", () => {
    const record = makeRunRecord({ sessionId: "s", directory: "/w", agent: "a" });
    expect(record.keyFingerprint).toBeUndefined();
    expect(record.usageAtStart).toBeUndefined();
  });
});
