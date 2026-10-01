import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { createOpenRequestReader, formatProxyLine, parseOpenRequests, parseProxyLog, readProxyTotals } from "../src/proxycost";

const MAIN = "ses_main";
const SUB = "ses_sub";
const IDS = new Set([MAIN, SUB]);

/** One proxy `end` line. */
function endLine(input: {
  session: string;
  upstream: string;
  cost: number | null;
  time?: string;
  request?: number;
}): string {
  return JSON.stringify({
    source: "oc-sub-cost-proxy",
    event: "end",
    time: input.time ?? "2026-10-01T04:58:34.594Z",
    request: input.request ?? 20,
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

/** One proxy `start` line. */
function startLine(input: { session: string; request: number; upstream?: string; time?: string }): string {
  return JSON.stringify({
    source: "oc-sub-cost-proxy",
    event: "start",
    time: input.time ?? "2026-10-01T21:07:55.094Z",
    request: input.request,
    upstream: input.upstream ?? "openrouter",
    session: input.session,
    parentSession: null,
    method: "POST",
    path: "/v1/chat/completions",
  });
}

/** One proxy `listening` line. */
function listeningLine(): string {
  return JSON.stringify({
    source: "oc-sub-cost-proxy",
    event: "listening",
    time: "2026-10-01T15:55:28.336Z",
    hostname: "127.0.0.1",
    port: 4097,
  });
}

describe("parseOpenRequests", () => {
  test("finds an open start of a tree session", () => {
    const text = [
      listeningLine(),
      startLine({ session: MAIN, request: 44 }),
      startLine({ session: "ses_other", request: 45 }),
    ].join("\n");
    expect(parseOpenRequests(text, IDS)).toEqual([
      { session: MAIN, upstream: "openrouter", startedMs: Date.parse("2026-10-01T21:07:55.094Z") },
    ]);
  });

  test("a later end line with the same request number closes the start", () => {
    const text = [
      startLine({ session: MAIN, request: 44 }),
      endLine({ session: MAIN, upstream: "openrouter", cost: 0.001, request: 44 }),
      startLine({ session: SUB, request: 45 }),
    ].join("\n");
    expect(parseOpenRequests(text, IDS)).toEqual([
      { session: SUB, upstream: "openrouter", startedMs: Date.parse("2026-10-01T21:07:55.094Z") },
    ]);
  });

  test("a start before a later listening line is no longer open", () => {
    const text = [
      startLine({ session: MAIN, request: 44 }),
      listeningLine(),
      startLine({ session: "ses_other", request: 1 }),
    ].join("\n");
    expect(parseOpenRequests(text, IDS)).toEqual([]);
  });

  test("skips sessions outside the set and non-JSON lines", () => {
    const text = [
      "not json at all",
      "}{ broken",
      startLine({ session: "ses_other", request: 1 }),
      "",
      startLine({ session: SUB, request: 2 }),
    ].join("\n");
    expect(parseOpenRequests(text, IDS)).toEqual([
      { session: SUB, upstream: "openrouter", startedMs: Date.parse("2026-10-01T21:07:55.094Z") },
    ]);
  });

  test("an end line without a start and an unparsable time never throw", () => {
    const text = [
      JSON.stringify({ source: "oc-sub-cost-proxy", event: "end", request: 9 }),
      JSON.stringify({ source: "oc-sub-cost-proxy", event: "start", session: MAIN, request: 10 }),
    ].join("\n");
    expect(parseOpenRequests(text, IDS)).toEqual([{ session: MAIN, upstream: "unknown", startedMs: undefined }]);
  });
});

const OPEN_TMP = "/tmp/opencode/proxycost-open-test";
const OPEN_STATE = path.join(OPEN_TMP, "state", "oc-sub");
const OPEN_LOG = path.join(OPEN_STATE, "proxy-4097.log");

describe("createOpenRequestReader", () => {
  test("finds new lines, does not read old bytes twice, and restarts on a shorter file", async () => {
    rmSync(OPEN_TMP, { recursive: true, force: true });
    mkdirSync(OPEN_STATE, { recursive: true });
    const reader = createOpenRequestReader();

    // An unreadable folder counts as empty and never throws.
    expect(await reader.read(OPEN_STATE, IDS)).toEqual([]);

    writeFileSync(OPEN_LOG, [startLine({ session: MAIN, request: 1 })].join("\n") + "\n");
    const first = await reader.read(OPEN_STATE, IDS);
    expect(first).toEqual([
      { session: MAIN, upstream: "openrouter", startedMs: Date.parse("2026-10-01T21:07:55.094Z") },
    ]);

    // The same bytes are not read again: the request stays open, and a new
    // end line closes it on the next call.
    const { appendFileSync } = await import("node:fs");
    appendFileSync(OPEN_LOG, endLine({ session: MAIN, upstream: "openrouter", cost: 0.001, request: 1 }) + "\n");
    expect(await reader.read(OPEN_STATE, IDS)).toEqual([]);

    // A request number counts again after a restart, so a listening line
    // must clear the open requests of the file.
    appendFileSync(OPEN_LOG, [
      listeningLine(),
      startLine({ session: SUB, request: 1, time: "2026-10-01T22:00:00.000Z" }),
    ].join("\n") + "\n");
    expect(await reader.read(OPEN_STATE, IDS)).toEqual([
      { session: SUB, upstream: "openrouter", startedMs: Date.parse("2026-10-01T22:00:00.000Z") },
    ]);

    // A shorter file starts again from offset 0.
    writeFileSync(OPEN_LOG, startLine({ session: MAIN, request: 1, time: "2026-10-01T23:00:00.000Z" }) + "\n");
    expect(await reader.read(OPEN_STATE, IDS)).toEqual([
      { session: MAIN, upstream: "openrouter", startedMs: Date.parse("2026-10-01T23:00:00.000Z") },
    ]);

    rmSync(OPEN_TMP, { recursive: true, force: true });
  });

  test("holds an incomplete last line until it is complete", async () => {
    rmSync(OPEN_TMP, { recursive: true, force: true });
    mkdirSync(OPEN_STATE, { recursive: true });
    const reader = createOpenRequestReader();
    const line = startLine({ session: MAIN, request: 1 });
    writeFileSync(OPEN_LOG, line.slice(0, 20));
    expect(await reader.read(OPEN_STATE, IDS)).toEqual([]);
    writeFileSync(OPEN_LOG, line + "\n");
    expect(await reader.read(OPEN_STATE, IDS)).toHaveLength(1);
    rmSync(OPEN_TMP, { recursive: true, force: true });
  });

  test("keeps the open request of a subagent that joins the tree on a later poll", async () => {
    rmSync(OPEN_TMP, { recursive: true, force: true });
    mkdirSync(OPEN_STATE, { recursive: true });
    const reader = createOpenRequestReader();
    writeFileSync(OPEN_LOG, startLine({ session: SUB, request: 1 }) + "\n");
    // The first poll knows only the main session.
    expect(await reader.read(OPEN_STATE, new Set([MAIN]))).toEqual([]);
    // The next poll knows the subagent, and its request is still open.
    expect(await reader.read(OPEN_STATE, new Set([MAIN, SUB]))).toEqual([
      { session: SUB, upstream: "openrouter", startedMs: Date.parse("2026-10-01T21:07:55.094Z") },
    ]);
    rmSync(OPEN_TMP, { recursive: true, force: true });
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
