import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { formatProxyLine, parseProxyLog, readProxyTotals } from "../src/proxycost";

const MAIN = "ses_main";
const SUB = "ses_sub";
const IDS = new Set([MAIN, SUB]);

/** One proxy `end` line. */
function endLine(input: {
  session: string;
  upstream: string;
  cost: number | null;
  time?: string;
}): string {
  return JSON.stringify({
    source: "oc-sub-cost-proxy",
    event: "end",
    time: input.time ?? "2026-10-01T04:58:34.594Z",
    request: 20,
    upstream: input.upstream,
    session: input.session,
    method: "POST",
    path: "/deepinfra/v1/openai/chat/completions",
    status: 200,
    model: "zai-org/GLM-5.3-Flash",
    cost: input.cost,
    tokens: { input: 15183, output: 233, reasoning: 0, cached: 12160 },
  });
}

describe("parseProxyLog", () => {
  test("sums the end lines of the tree sessions, per upstream", () => {
    const text = [
      endLine({ session: MAIN, upstream: "deepinfra", cost: 0.001 }),
      endLine({ session: SUB, upstream: "deepinfra", cost: 0.002 }),
      endLine({ session: MAIN, upstream: "openrouter", cost: 0.01 }),
    ].join("\n");
    expect(parseProxyLog(text, IDS)).toEqual({
      requests: 3,
      withoutCost: 0,
      byUpstream: [
        { name: "deepinfra", cost: 0.003, requests: 2 },
        { name: "openrouter", cost: 0.01, requests: 1 },
      ],
    });
  });

  test("skips server output, start lines, other sessions, and other sources", () => {
    const text = [
      "2026-10-01T04:58:30.000Z INFO listening on 4096",
      JSON.stringify({ source: "oc-sub-cost-proxy", event: "start", session: MAIN, upstream: "deepinfra" }),
      endLine({ session: "ses_other", upstream: "deepinfra", cost: 1 }),
      endLine({ session: SUB, upstream: "deepinfra", cost: 1 }),
      JSON.stringify({ source: "other-proxy", event: "end", session: SUB, upstream: "deepinfra", cost: 1 }),
      "not json at all",
    ].join("\n");
    const totals = parseProxyLog(text, IDS);
    expect(totals.requests).toBe(1);
    expect(totals.byUpstream).toEqual([{ name: "deepinfra", cost: 1, requests: 1 }]);
  });

  test("counts a cost null line as without cost and never throws", () => {
    const text = [
      endLine({ session: MAIN, upstream: "openrouter", cost: null }),
      endLine({ session: MAIN, upstream: "openrouter", cost: 0.002 }),
      "",
      "}{ broken",
      endLine({ session: MAIN, upstream: "openrouter", cost: null }),
    ].join("\n");
    const totals = parseProxyLog(text, IDS);
    expect(totals.requests).toBe(3);
    expect(totals.withoutCost).toBe(2);
    expect(totals.byUpstream).toEqual([{ name: "openrouter", cost: 0.002, requests: 3 }]);
  });
});

describe("formatProxyLine", () => {
  test("formats one upstream", () => {
    expect(
      formatProxyLine({
        requests: 20,
        withoutCost: 0,
        byUpstream: [{ name: "deepinfra", cost: 0.0115, requests: 20 }],
      }),
    ).toBe("real cost $0.0115 from the cost proxy (20 requests, deepinfra $0.0115)");
  });

  test("formats two upstreams in alphabetical order", () => {
    expect(
      formatProxyLine({
        requests: 31,
        withoutCost: 0,
        byUpstream: [
          { name: "deepinfra", cost: 0.0115, requests: 20 },
          { name: "openrouter", cost: 0.0115, requests: 11 },
        ],
      }),
    ).toBe("real cost $0.0230 from the cost proxy (31 requests, deepinfra $0.0115, openrouter $0.0115)");
  });

  test("names the requests without cost", () => {
    expect(
      formatProxyLine({
        requests: 22,
        withoutCost: 2,
        byUpstream: [{ name: "deepinfra", cost: 0.0115, requests: 22 }],
      }),
    ).toBe(
      "real cost $0.0115 from the cost proxy (22 requests, deepinfra $0.0115, 2 requests without cost)",
    );
  });

  test("returns null without requests", () => {
    expect(formatProxyLine({ requests: 0, withoutCost: 0, byUpstream: [] })).toBeNull();
  });
});

const TMP = "/tmp/opencode/proxycost-test";
const STATE = path.join(TMP, "state", "oc-sub");

describe("readProxyTotals", () => {
  test("sums the serve log and the proxy log of the state folder", async () => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(STATE, { recursive: true });
    writeFileSync(path.join(STATE, "serve-4096.log"), [
      "server output",
      endLine({ session: MAIN, upstream: "deepinfra", cost: 0.001 }),
      endLine({ session: "ses_other", upstream: "deepinfra", cost: 5 }),
    ].join("\n"));
    writeFileSync(path.join(STATE, "proxy-4097.log"), [
      endLine({ session: SUB, upstream: "openrouter", cost: 0.01 }),
    ].join("\n"));
    writeFileSync(path.join(STATE, "serve-4096.dirs"), "not a log\n");
    const totals = await readProxyTotals(STATE, IDS);
    expect(totals.requests).toBe(2);
    expect(totals.byUpstream).toEqual([
      { name: "deepinfra", cost: 0.001, requests: 1 },
      { name: "openrouter", cost: 0.01, requests: 1 },
    ]);
    rmSync(TMP, { recursive: true, force: true });
  });

  test("counts a missing folder as empty", async () => {
    rmSync(TMP, { recursive: true, force: true });
    expect(await readProxyTotals(STATE, IDS)).toEqual({ requests: 0, withoutCost: 0, byUpstream: [] });
  });
});
