import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { Smoke } from "../src/top/smoke";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 50));

describe("Smoke (Ink under bun)", () => {
  test("renders counter 0, then j/j/k gives 1", async () => {
    const { lastFrame, stdin, unmount } = render(<Smoke />);
    await tick();
    expect(lastFrame()).toContain("count: 0");

    stdin.write("j");
    await tick();
    stdin.write("j");
    await tick();
    stdin.write("k");
    await tick();
    expect(lastFrame()).toContain("count: 1");

    stdin.write("q");
    await tick();
    unmount();
  });
});
