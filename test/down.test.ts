import { describe, expect, test } from "bun:test";
import { formatBusyLine, isAlive, isOpencodeServe } from "../src/down";

describe("isOpencodeServe", () => {
  test("accepts opencode serve on the port", () => {
    expect(isOpencodeServe("opencode serve --port 8767 --hostname 127.0.0.1", 8767)).toBe(true);
    expect(isOpencodeServe("/home/u/.local/share/mise/installs/opencode/1.18.32/bin/opencode serve --port 8767", 8767)).toBe(true);
    expect(isOpencodeServe("opencode serve --port=8767", 8767)).toBe(true);
  });

  test("rejects another port, another command, or another program", () => {
    expect(isOpencodeServe("opencode serve --port 8768", 8767)).toBe(false);
    expect(isOpencodeServe("opencode web --port 8767", 8767)).toBe(false);
    expect(isOpencodeServe("vim notes-opencode serve --port 8767", 8767)).toBe(false);
    expect(isOpencodeServe("", 8767)).toBe(false);
  });
});

describe("formatBusyLine", () => {
  test("shows state, session, and directory", () => {
    expect(formatBusyLine({ state: "busy", id: "ses_1", directory: "/w" })).toBe("busy ses_1 /w");
  });
});

describe("isAlive", () => {
  test("is true for this process", () => {
    expect(isAlive(process.pid)).toBe(true);
  });
});
