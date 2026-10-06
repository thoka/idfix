import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WARN, type ConditionType, type Edge } from "../src/watch/conditions";
import { createWaker, noticeText, nodeNotifier, notifies, NOTIFY_CONDITIONS, NOTICE_PAUSE_MS, type NotifyResult } from "../src/watch/wake";

const LOG = "/state/idfx/events.jsonl";

function edge(subject: string, condition: ConditionType = "SessionWaitsForUser", status: "True" | "False" = "True", reason = "InputNeeded"): Edge {
  return {
    condition,
    status,
    reason,
    message: "",
    lastTransitionMs: 0,
    session: `${subject}-id`,
    subject,
    cwd: `/home/u/dv/${subject}`,
    kind: "interactive",
    severity: WARN,
  };
}

describe("which edges notify", () => {
  test("only True edges of SessionWaitsForUser and ApiError", () => {
    expect([...NOTIFY_CONDITIONS].sort()).toEqual(["ApiError", "SessionWaitsForUser"]);
    expect(notifies(edge("a"))).toBe(true);
    expect(notifies(edge("a", "ApiError", "True", "UsageLimit"))).toBe(true);
    expect(notifies(edge("a", "SessionWaitsForUser", "False", "Cleared"))).toBe(false);
    for (const other of ["SessionStalled", "ContextHigh", "HandoverFailed", "SessionUnnamed"] as const) {
      expect(notifies(edge("a", other))).toBe(false);
    }
  });
});

describe("noticeText", () => {
  test("names the count, the first three edges, and the log", () => {
    const edges = [edge("meta", "SessionWaitsForUser", "True", "PermissionDialog"), edge("grata", "ApiError", "True", "UsageLimit"), edge("c"), edge("d")];
    expect(noticeText(edges, LOG)).toBe(
      `idfx watch: 4 events: meta waits for user (PermissionDialog), grata API error (UsageLimit), c waits for user (InputNeeded), and 1 more. Log: ${LOG}`,
    );
    expect(noticeText([edge("meta")], LOG)).toBe(`idfx watch: 1 event: meta waits for user (InputNeeded). Log: ${LOG}`);
  });
});

describe("createWaker", () => {
  function waker(result: NotifyResult = { ok: true }) {
    const texts: string[] = [];
    const err: string[] = [];
    const w = createWaker(
      (text) => {
        texts.push(text);
        return result;
      },
      LOG,
      (line) => err.push(line),
    );
    return { w, texts, err };
  }

  test("a baseline poll and a poll without notifying edges send nothing", () => {
    const { w, texts } = waker();
    w.afterPoll([edge("a")], 0, true);
    w.afterPoll([edge("b", "ContextHigh")], 1, false);
    expect(texts).toEqual([]);
    // The baseline edge is not kept for later.
    w.afterPoll([], NOTICE_PAUSE_MS * 2, false);
    expect(texts).toEqual([]);
  });

  test("the pause holds the edges until it ends", () => {
    const { w, texts } = waker();
    w.afterPoll([edge("a")], 0, false);
    w.afterPoll([edge("b")], NOTICE_PAUSE_MS - 1, false);
    expect(texts).toHaveLength(1);
    w.afterPoll([], NOTICE_PAUSE_MS, false);
    expect(texts).toEqual([`idfx watch: 1 event: a waits for user (InputNeeded). Log: ${LOG}`, `idfx watch: 1 event: b waits for user (InputNeeded). Log: ${LOG}`]);
  });

  test("a missing notify-session warns once", () => {
    const { w, texts, err } = waker({ ok: false, missing: true, message: "notify-session is not on the PATH" });
    w.afterPoll([edge("a")], 0, false);
    w.afterPoll([edge("b")], NOTICE_PAUSE_MS, false);
    expect(texts).toHaveLength(2);
    expect(err).toEqual(["idfx watch: notify-session is not on the PATH; the supervisor gets no wake-up"]);
  });

  test("a failed notice warns each time", () => {
    const { w, err } = waker({ ok: false, missing: false, message: "notify-session exited with code 1" });
    w.afterPoll([edge("a")], 0, false);
    w.afterPoll([edge("b")], NOTICE_PAUSE_MS, false);
    expect(err).toHaveLength(2);
  });
});

describe("nodeNotifier", () => {
  // A fake notify-session on a fake PATH. The real one would wake the supervisor.
  function fakeBin(exitCode: number): { dir: string; argsFile: string } {
    const dir = mkdtempSync(path.join(tmpdir(), "idfx-wake-bin-"));
    const argsFile = path.join(dir, "args");
    const script = path.join(dir, "notify-session");
    writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argsFile}"\necho "notify-session: no live session" >&2\nexit ${exitCode}\n`);
    chmodSync(script, 0o755);
    return { dir, argsFile };
  }

  test("runs notify-session from the PATH with the name supervisor", () => {
    const { dir, argsFile } = fakeBin(0);
    expect(nodeNotifier({ PATH: dir })("idfx watch: 1 event")).toEqual({ ok: true });
    expect(readFileSync(argsFile, "utf8").split("\n").slice(0, -1)).toEqual(["--name", "supervisor", "--", "none", "idfx watch: 1 event"]);
  });

  test("a non-zero exit is a failure with the last stderr line", () => {
    const { dir } = fakeBin(1);
    expect(nodeNotifier({ PATH: dir })("x")).toEqual({
      ok: false,
      missing: false,
      message: "notify-session exited with code 1: notify-session: no live session",
    });
  });

  test("a PATH without notify-session gives missing", () => {
    const empty = mkdtempSync(path.join(tmpdir(), "idfx-wake-empty-"));
    expect(nodeNotifier({ PATH: empty })("x")).toMatchObject({ ok: false, missing: true });
  });
});
