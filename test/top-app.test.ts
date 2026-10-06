/** Tests for the helpers of the entry of the live view, `src/top/app.tsx`. */
import { describe, expect, test } from "bun:test";
import { isStreamAbort, tildeFolder } from "../src/top/app";

describe("tildeFolder", () => {
  test("shows the home directory as ~", () => {
    expect(tildeFolder("/home/user/src/p", "/home/user")).toBe("~/src/p");
    expect(tildeFolder("/home/user", "/home/user")).toBe("~");
    expect(tildeFolder("/home/user2/p", "/home/user")).toBe("/home/user2/p");
    expect(tildeFolder("/srv/p", "")).toBe("/srv/p");
  });
});

describe("isStreamAbort", () => {
  test("is true only for an AbortError", () => {
    expect(isStreamAbort(new DOMException("The operation was aborted.", "AbortError"))).toBe(true);
    const error = new Error("aborted");
    error.name = "AbortError";
    expect(isStreamAbort(error)).toBe(true);
    expect(isStreamAbort(new Error("boom"))).toBe(false);
    expect(isStreamAbort("AbortError")).toBe(false);
    expect(isStreamAbort(null)).toBe(false);
  });
});
