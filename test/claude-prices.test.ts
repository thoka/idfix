import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  apiEquivalentUsd,
  contextWindowOf,
  LITELLM_PRICES_URL,
  loadPrices,
  parsePriceFile,
  PRICE_CACHE_MS,
  priceCachePath,
  priceOf,
  type PriceDeps,
} from "../src/claude/prices";
import { emptyTokens } from "../src/claude/transcript";
import { FIXTURE_DIR, NOW } from "./claude-fixture";

const priceText = readFileSync(path.join(FIXTURE_DIR, "litellm-prices.json"), "utf8");
const table = parsePriceFile(priceText);

describe("parsePriceFile and priceOf", () => {
  test("reads a known model", () => {
    expect(priceOf(table, "claude-opus-5-5")).toEqual({
      input: 0.000004,
      output: 0.00002,
      cacheRead: 2e-7,
      cacheWrite: 0.000005,
      cacheWrite1h: 0.000008,
      maxInputTokens: 1000000,
    });
  });

  test("an entry without prices is left out", () => {
    expect(priceOf(table, "sample_spec")).toBeUndefined();
  });

  test("a missing cache price falls back to the input price", () => {
    expect(priceOf(table, "claude-haiku-4-5")?.cacheRead).toBe(0.000001);
  });

  test("an unknown model has no price, and only an exact id matches", () => {
    expect(priceOf(table, "z-ai/glm-5.3-flash")).toBeUndefined();
  });

  test("a broken file gives no table", () => {
    expect(parsePriceFile("not json")).toBeUndefined();
  });
});

describe("contextWindowOf", () => {
  test("is max_input_tokens of the model", () => {
    expect(contextWindowOf(table, "claude-haiku-4-5")).toBe(200000);
  });

  test("a [1m] id has a window of 1,000,000, also without a table", () => {
    expect(contextWindowOf(undefined, "claude-haiku-4-5[1m]")).toBe(1_000_000);
    expect(priceOf(table, "claude-haiku-4-5[1m]")?.input).toBe(0.000001);
  });

  test("an unknown model or no model has no window", () => {
    expect(contextWindowOf(table, "z-ai/glm-5.3-flash")).toBeUndefined();
    expect(contextWindowOf(table, undefined)).toBeUndefined();
  });
});

describe("apiEquivalentUsd", () => {
  test("prices input, output, cache read, and both cache write lifetimes", () => {
    const usage = new Map([
      ["claude-opus-5-5", { ...emptyTokens(), input: 15, output: 80, cacheRead: 1000, cacheWrite5m: 200, cacheWrite1h: 1000 }],
    ]);
    expect(apiEquivalentUsd(table, usage)).toBeCloseTo(15 * 4e-6 + 80 * 2e-5 + 1000 * 2e-7 + 200 * 5e-6 + 1000 * 8e-6, 12);
  });

  test("an unknown model makes the whole price unknown, not a partial sum", () => {
    const usage = new Map([
      ["claude-opus-5-5", { ...emptyTokens(), input: 1 }],
      ["z-ai/glm-5.3-flash", { ...emptyTokens(), input: 1 }],
    ]);
    expect(apiEquivalentUsd(table, usage)).toBeUndefined();
  });

  test("without a table there is no price", () => {
    expect(apiEquivalentUsd(undefined, new Map())).toBeUndefined();
  });
});

/** A fake cache folder and network. */
function fakeDeps(options: { cached?: { text: string; mtimeMs: number }; fetch?: () => Promise<string> }) {
  const files = new Map<string, { text: string; mtimeMs: number }>();
  const fetched: string[] = [];
  const deps: PriceDeps = {
    readFile: (file) => files.get(file),
    writeFile: (file, text) => {
      files.set(file, { text, mtimeMs: NOW });
    },
    fetchText: async (url) => {
      fetched.push(url);
      if (options.fetch === undefined) throw new Error("offline");
      return options.fetch();
    },
    nowMs: () => NOW,
  };
  const env = { XDG_CACHE_HOME: "/cache" };
  if (options.cached !== undefined) files.set(priceCachePath(env), options.cached);
  return { deps, files, fetched, env };
}

describe("loadPrices", () => {
  test("the cache path is $XDG_CACHE_HOME/idfix/litellm-prices.json, else ~/.cache", () => {
    expect(priceCachePath({ XDG_CACHE_HOME: "/cache" })).toBe("/cache/idfix/litellm-prices.json");
    expect(priceCachePath({ HOME: "/home/user" })).toBe("/home/user/.cache/idfix/litellm-prices.json");
    expect(priceCachePath({ HOME: "/home/user", XDG_CACHE_HOME: "relative" })).toBe("/home/user/.cache/idfix/litellm-prices.json");
  });

  test("a fresh cache serves without a download", async () => {
    const { deps, fetched, env } = fakeDeps({ cached: { text: priceText, mtimeMs: NOW - 1000 } });
    expect(priceOf(await loadPrices(env, deps), "claude-opus-5-5")).toBeDefined();
    expect(fetched).toEqual([]);
  });

  test("a stale cache downloads the file again and replaces the copy", async () => {
    const fresh = JSON.stringify({ "new-model": { input_cost_per_token: 1, output_cost_per_token: 2 } });
    const { deps, fetched, files, env } = fakeDeps({
      cached: { text: priceText, mtimeMs: NOW - PRICE_CACHE_MS - 1 },
      fetch: async () => fresh,
    });
    const prices = await loadPrices(env, deps);
    expect(fetched).toEqual([LITELLM_PRICES_URL]);
    expect(priceOf(prices, "new-model")?.output).toBe(2);
    expect(files.get(priceCachePath(env))?.text).toBe(fresh);
  });

  test("a failed download keeps the stale copy", async () => {
    const { deps, env } = fakeDeps({ cached: { text: priceText, mtimeMs: NOW - PRICE_CACHE_MS - 1 } });
    expect(priceOf(await loadPrices(env, deps), "claude-opus-5-5")).toBeDefined();
  });

  test("no cache file and a failed download give no prices", async () => {
    const { deps, env, fetched } = fakeDeps({});
    expect(await loadPrices(env, deps)).toBeUndefined();
    expect(fetched).toEqual([LITELLM_PRICES_URL]);
  });
});
