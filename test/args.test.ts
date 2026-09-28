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
  test("up with and without a port", () => {
    expect(parseArgs(["up"])).toEqual({ command: "up" });
    expect(parseArgs(["up", "--port", "8767"])).toEqual({ command: "up", port: 8767 });
    expect(parseArgs(["up", "--port=1234"])).toEqual({ command: "up", port: 1234 });
  });

  test("up rejects bad ports and positionals", () => {
    expect(() => parseArgs(["up", "--port", "0"])).toThrow(UsageError);
    expect(() => parseArgs(["up", "--port", "70000"])).toThrow(UsageError);
    expect(() => parseArgs(["up", "--port", "abc"])).toThrow(UsageError);
    expect(() => parseArgs(["up", "extra"])).toThrow(UsageError);
  });

  test("down and restart with port and force", () => {
    expect(parseArgs(["down"])).toEqual({ command: "down", force: false });
    expect(parseArgs(["down", "--port", "8790", "--force"])).toEqual({ command: "down", port: 8790, force: true });
    expect(parseArgs(["restart", "--port=8790"])).toEqual({ command: "restart", port: 8790, force: false });
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

  test("ping parses like status", () => {
    expect(parseArgs(["ping"])).toEqual({ command: "ping" });
    expect(parseArgs(["ping", "--dir", "/w"])).toEqual({ command: "ping", dir: "/w" });
    expect(parseArgs(["ping", "--dir=/w", "--url=http://h:1"])).toEqual({ command: "ping", dir: "/w", url: "http://h:1" });
    expect(() => parseArgs(["ping", "extra"])).toThrow(/takes no positional arguments/);
    expect(() => parseArgs(["ping", "--dir"])).toThrow(/needs a value/);
  });

  test("--url is accepted by every command", () => {
    expect(parseArgs(["up", "--url", "http://h:1"])).toEqual({ command: "up", url: "http://h:1" });
    expect(parseArgs(["status", "--url=http://h:1"])).toEqual({ command: "status", url: "http://h:1", all: false });
    expect(parseArgs(["watch", "s", "--url", "http://h:1"])).toEqual({ command: "watch", session: "s", json: false, url: "http://h:1" });
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
