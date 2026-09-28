import { describe, expect, test } from "bun:test";
import type { Message, SessionStatus } from "@opencode-ai/sdk";
import { missingSessionIsSettled, treeIsSettled, QUIET_GRACE_MS } from "../src/settled";
import type { MessageEntry } from "../src/summary";

type Assistant = Extract<Message, { role: "assistant" }>;

function assistant(time: Assistant["time"]): MessageEntry {
  return {
    info: {
      id: "msg_2",
      sessionID: "ses_1",
      role: "assistant",
      time,
      parentID: "msg_1",
      modelID: "m",
      providerID: "p",
      mode: "primary",
      path: { cwd: "/x", root: "/x" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [],
  };
}

function user(created: number): MessageEntry {
  return {
    info: {
      id: "msg_1",
      sessionID: "ses_1",
      role: "user",
      time: { created },
      agent: "coder",
      model: { providerID: "p", modelID: "m" },
    },
    parts: [],
  };
}

const NOW = 1_000_000;

describe("missingSessionIsSettled", () => {
  test("a finished assistant message at the end means the session ended", () => {
    const messages = [user(NOW - 5000), assistant({ created: NOW - 4000, completed: NOW - 100 })];
    expect(missingSessionIsSettled(messages, NOW - 100, NOW)).toBe(true);
  });

  test("the race right after run: a fresh user message and no answer yet is not idle", () => {
    const messages = [user(NOW - 200)];
    expect(missingSessionIsSettled(messages, NOW - 200, NOW)).toBe(false);
  });

  test("a fresh session without messages is not idle yet", () => {
    expect(missingSessionIsSettled([], NOW - 500, NOW)).toBe(false);
  });

  test("an unfinished assistant message at the end is not idle while recent", () => {
    const messages = [user(NOW - 3000), assistant({ created: NOW - 1000 })];
    expect(missingSessionIsSettled(messages, NOW - 1000, NOW)).toBe(false);
  });

  test("a quiet session without an answer counts as idle after the grace time", () => {
    expect(missingSessionIsSettled([], NOW - QUIET_GRACE_MS, NOW)).toBe(true);
    const messages = [user(NOW - QUIET_GRACE_MS - 1)];
    expect(missingSessionIsSettled(messages, NOW - QUIET_GRACE_MS - 1, NOW)).toBe(true);
  });

  test("a recent session update keeps an old unanswered prompt from counting as idle", () => {
    const messages = [user(NOW - 60_000)];
    expect(missingSessionIsSettled(messages, NOW - 100, NOW)).toBe(false);
  });

  test("the grace time can be set", () => {
    expect(missingSessionIsSettled([], NOW - 50, NOW, 50)).toBe(true);
    expect(missingSessionIsSettled([], NOW - 49, NOW, 50)).toBe(false);
  });
});

describe("treeIsSettled", () => {
  const idle: SessionStatus = { type: "idle" };
  const busy: SessionStatus = { type: "busy" };
  const retry: SessionStatus = { type: "retry", attempt: 1, message: "rate limited", next: 0 };

  test("a busy main session keeps the watch open", () => {
    expect(treeIsSettled(["main", "child"], { main: busy })).toBe(false);
  });

  test("a busy child keeps the watch open", () => {
    expect(treeIsSettled(["main", "child"], { main: idle, child: busy })).toBe(false);
  });

  test("a retrying child keeps the watch open", () => {
    expect(treeIsSettled(["main", "child"], { child: retry })).toBe(false);
  });

  test("an idle main session and a missing child end the watch", () => {
    expect(treeIsSettled(["main", "child"], { main: idle })).toBe(true);
  });

  test("sessions missing from the status map have ended", () => {
    expect(treeIsSettled(["main", "child"], {})).toBe(true);
  });

  test("an idle child beside an idle main session ends the watch", () => {
    expect(treeIsSettled(["main", "child"], { main: idle, child: idle })).toBe(true);
  });
});
