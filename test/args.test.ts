import { describe, expect, test } from "bun:test";
import { parseArgs, UsageError } from "../src/args";

function usage(fn: () => unknown): UsageError {
  try {
    fn();
  } catch (error) {
    if (error instanceof UsageError) return error;
    throw error;
  }
  throw new Error("expected a UsageError");
}

describe("parseArgs", () => {
  test("up defaults to sandbox mode, and --port implies host mode", () => {
    expect(parseArgs(["up"])).toEqual({ command: "up", sandbox: true });
    expect(parseArgs(["up", "--port", "8767"])).toEqual({ command: "up", port: 8767, sandbox: false });
    expect(parseArgs(["up", "--port=1234"])).toEqual({ command: "up", port: 1234, sandbox: false });
    expect(parseArgs(["up", "--no-sandbox"])).toEqual({ command: "up", sandbox: false });
    expect(parseArgs(["up", "--url", "http://h:1"])).toEqual({ command: "up", url: "http://h:1", sandbox: false });
  });

  test("up rejects bad ports and positionals", () => {
    expect(() => parseArgs(["up", "--port", "0"])).toThrow(UsageError);
    expect(() => parseArgs(["up", "--port", "70000"])).toThrow(UsageError);
    expect(() => parseArgs(["up", "--port", "abc"])).toThrow(UsageError);
    expect(() => parseArgs(["up", "extra"])).toThrow(UsageError);
  });

  test("down and restart default to sandbox mode, host flags imply host mode", () => {
    expect(parseArgs(["down"])).toEqual({ command: "down", force: false, sandbox: true });
    expect(parseArgs(["down", "--no-sandbox", "--port", "8790", "--force"])).toEqual({
      command: "down",
      port: 8790,
      force: true,
      sandbox: false,
    });
    expect(parseArgs(["restart", "--no-sandbox", "--port=8790"])).toEqual({
      command: "restart",
      port: 8790,
      force: false,
      sandbox: false,
    });
  });

  test("--sandbox stays the explicit form of the default", () => {
    expect(parseArgs(["up", "--sandbox"])).toEqual({ command: "up", sandbox: true });
    expect(parseArgs(["down", "--sandbox", "--force"])).toEqual({ command: "down", force: true, sandbox: true });
  });

  test("--dir works with the explicit sandbox flag and in default sandbox mode", () => {
    expect(parseArgs(["up", "--dir", "/w"])).toEqual({ command: "up", sandbox: true, dir: "/w" });
    expect(parseArgs(["down", "--dir=/w", "--force"])).toEqual({
      command: "down",
      sandbox: true,
      dir: "/w",
      force: true,
    });
    expect(parseArgs(["restart", "--dir", "/w"])).toEqual({
      command: "restart",
      sandbox: true,
      dir: "/w",
      force: false,
    });
  });

  test("--dir, --sandbox reject host mode flags", () => {
    expect(() => parseArgs(["up", "--dir", "/w", "--no-sandbox"])).toThrow(/--dir is only allowed in sandbox mode/);
    expect(() => parseArgs(["down", "--dir=/w", "--port", "8767"])).toThrow(/--dir is only allowed in sandbox mode/);
    expect(() => parseArgs(["restart", "--dir", "/w", "--url=http://h:1"])).toThrow(/--dir is only allowed in sandbox mode/);
    expect(() => parseArgs(["up", "--sandbox", "--no-sandbox"])).toThrow(/--sandbox and --no-sandbox cannot be combined/);
    expect(() => parseArgs(["up", "--sandbox", "--url", "http://h:1"])).toThrow(/--sandbox cannot be combined/);
    expect(() => parseArgs(["up", "--sandbox", "--port", "8767"])).toThrow(/--sandbox cannot be combined/);
    expect(() => parseArgs(["down", "--sandbox", "--port=8767"])).toThrow(/--sandbox cannot be combined/);
    expect(() => parseArgs(["restart", "--sandbox", "--url=http://h:1"])).toThrow(/--sandbox cannot be combined/);
  });

  test("down and restart reject positionals and a value for --force", () => {
    expect(() => parseArgs(["down", "extra"])).toThrow(UsageError);
    expect(() => parseArgs(["restart", "--force=yes"])).toThrow(UsageError);
  });

  test("run with a brief file", () => {
    expect(parseArgs(["run", "--agent", "researcher", "--dir", "/w", "--brief", "brief.md", "--title", "T"])).toEqual({
      command: "run",
      agent: "researcher",
      dir: "/w",
      briefFile: "brief.md",
      text: undefined,
      title: "T",
    });
  });

  test("run with positional text", () => {
    expect(parseArgs(["run", "--agent", "a", "--dir", "/w", "do the thing"])).toEqual({
      command: "run",
      agent: "a",
      dir: "/w",
      briefFile: undefined,
      text: "do the thing",
      title: undefined,
    });
  });

  test("run rejects a missing brief, both briefs, and missing required flags", () => {
    expect(() => parseArgs(["run", "--agent", "a", "--dir", "/w"])).toThrow(/brief/);
    expect(() => parseArgs(["run", "--agent", "a", "--dir", "/w", "--brief", "b.md", "text"])).toThrow(/both/);
    expect(() => parseArgs(["run", "--dir", "/w", "text"])).toThrow(UsageError);
    expect(() => parseArgs(["run", "--agent", "a", "text"])).toThrow(UsageError);
  });

  test("status, watch, log, abort", () => {
    expect(parseArgs(["status"])).toEqual({ command: "status", all: false });
    expect(parseArgs(["status", "--dir", "/w"])).toEqual({ command: "status", dir: "/w", all: false });
    expect(parseArgs(["watch", "ses_1", "--json"])).toEqual({ command: "watch", session: "ses_1", json: true });
    expect(parseArgs(["watch", "ses_1", "--dir", "/w"])).toEqual({ command: "watch", session: "ses_1", json: false, dir: "/w" });
    expect(parseArgs(["log", "ses_1"])).toEqual({ command: "log", session: "ses_1" });
    expect(parseArgs(["abort", "ses_1", "--dir", "/w"])).toEqual({ command: "abort", session: "ses_1", dir: "/w" });
  });

  test("status --all, and --all with --dir is an error", () => {
    expect(parseArgs(["status", "--all"])).toEqual({ command: "status", all: true });
    expect(parseArgs(["status", "--all", "--url=http://h:1"])).toEqual({ command: "status", all: true, url: "http://h:1" });
    expect(() => parseArgs(["status", "--all", "--dir", "/w"])).toThrow(/--all and --dir/);
    expect(() => parseArgs(["status", "--dir=/w", "--all"])).toThrow(/--all and --dir/);
  });

  test("answer with answers, --reply, and --reject", () => {
    expect(parseArgs(["answer", "que_1", "Option A"])).toEqual({
      command: "answer",
      request: "que_1",
      reject: false,
      reply: undefined,
      answers: ["Option A"],
    });
    expect(parseArgs(["answer", "per_1", "--dir", "/w", "--reply", "always"])).toEqual({
      command: "answer",
      request: "per_1",
      dir: "/w",
      reject: false,
      reply: "always",
      answers: [],
    });
    expect(parseArgs(["answer", "que_1", "--reject"])).toEqual({
      command: "answer",
      request: "que_1",
      reject: true,
      reply: undefined,
      answers: [],
    });
    expect(parseArgs(["answer", "que_1", "a 1", "a 2", "--url=http://h:1"])).toEqual({
      command: "answer",
      request: "que_1",
      url: "http://h:1",
      reject: false,
      reply: undefined,
      answers: ["a 1", "a 2"],
    });
  });

  test("answer rejects bad flag combinations and a missing request ID", () => {
    expect(() => parseArgs(["answer"])).toThrow(/request ID/);
    expect(() => parseArgs(["answer", "que_1"])).toThrow(/answer per question/);
    expect(() => parseArgs(["answer", "que_1", "--reply", "sometimes"])).toThrow(/--reply must be once, always, or reject/);
    expect(() => parseArgs(["answer", "que_1", "--reply", "once", "--reject"])).toThrow(/--reject and --reply/);
    expect(() => parseArgs(["answer", "que_1", "--reject", "Option A"])).toThrow(/--reject takes no answers/);
    expect(() => parseArgs(["answer", "que_1", "--reply"])).toThrow(/needs a value/);
  });

  test("answer --message is only allowed with --reply reject", () => {
    expect(parseArgs(["answer", "per_1", "--reply", "reject", "--message", "no, use rg instead"])).toEqual({
      command: "answer",
      request: "per_1",
      reject: false,
      reply: "reject",
      message: "no, use rg instead",
      answers: [],
    });
    expect(() => parseArgs(["answer", "per_1", "--reply", "once", "--message", "x"])).toThrow(/--message is only allowed/);
    expect(() => parseArgs(["answer", "que_1", "--reject", "--message", "x"])).toThrow(/--message is only allowed/);
    expect(() => parseArgs(["answer", "que_1", "a", "--message", "x"])).toThrow(/--message is only allowed/);
  });

  test("say takes a session and a message text", () => {
    expect(parseArgs(["say", "ses_1", "please continue"])).toEqual({
      command: "say",
      session: "ses_1",
      agent: undefined,
      text: "please continue",
    });
    expect(parseArgs(["say", "ses_1", "--dir", "/w", "--agent", "coder", "try again with rg"])).toEqual({
      command: "say",
      session: "ses_1",
      dir: "/w",
      agent: "coder",
      text: "try again with rg",
    });
    expect(parseArgs(["say", "ses_1", "one", "two three"])).toEqual({
      command: "say",
      session: "ses_1",
      agent: undefined,
      text: "one two three",
    });
  });

  test("say rejects a missing session and a missing text", () => {
    expect(() => parseArgs(["say"])).toThrow(/session/);
    expect(() => parseArgs(["say", "ses_1"])).toThrow(/TEXT/);
    expect(() => parseArgs(["say", "ses_1", "--agent", "coder"])).toThrow(/TEXT/);
  });

  test("ping parses like status", () => {
    expect(parseArgs(["ping"])).toEqual({ command: "ping" });
    expect(parseArgs(["ping", "--dir", "/w"])).toEqual({ command: "ping", dir: "/w" });
    expect(parseArgs(["ping", "--dir=/w", "--url=http://h:1"])).toEqual({ command: "ping", dir: "/w", url: "http://h:1" });
    expect(() => parseArgs(["ping", "extra"])).toThrow(/takes no positional arguments/);
    expect(() => parseArgs(["ping", "--dir"])).toThrow(/needs a value/);
  });

  test("--url is accepted by every command", () => {
    expect(parseArgs(["up", "--url", "http://h:1"])).toEqual({ command: "up", url: "http://h:1", sandbox: false });
    expect(parseArgs(["status", "--url=http://h:1"])).toEqual({ command: "status", url: "http://h:1", all: false });
    expect(parseArgs(["watch", "s", "--url", "http://h:1"])).toEqual({ command: "watch", session: "s", json: false, url: "http://h:1" });
  });

  test("unknown --no-sandbox on other commands stays a usage error", () => {
    expect(() => parseArgs(["run", "--agent", "a", "--dir", "/w", "--no-sandbox", "text"])).toThrow(/unknown option/);
  });

  test("rejects a session-less watch/log/abort", () => {
    expect(() => parseArgs(["watch"])).toThrow(/session/);
    expect(() => parseArgs(["log"])).toThrow(/session/);
    expect(() => parseArgs(["abort"])).toThrow(/session/);
  });

  test("rejects unknown commands, unknown options, and missing flag values", () => {
    expect(() => parseArgs(["frobnicate"])).toThrow(/unknown command/);
    expect(() => parseArgs(["up", "--wat"])).toThrow(/unknown option/);
    expect(() => parseArgs(["status", "--dir"])).toThrow(/needs a value/);
    expect(() => parseArgs(["watch", "s", "--json=yes"])).toThrow(/takes no value/);
  });

  test("no command is a usage error", () => {
    expect(() => parseArgs([])).toThrow(UsageError);
    expect(usage(() => parseArgs(["nope"])).message).toContain("nope");
  });
});
