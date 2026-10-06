/**
 * Prices and context windows of models, from the LiteLLM file
 * `model_prices_and_context_window.json` (the source that ccusage also
 * uses). idfix keeps no price table of its own. It downloads the file at
 * most once per 24 hours into `$XDG_CACHE_HOME/idfix/litellm-prices.json`
 * and uses the cached copy offline. Without a copy, prices stay undefined.
 */
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { TokenCounts } from "./transcript";

export const LITELLM_PRICES_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

/** The cached copy is fresh for this long. */
export const PRICE_CACHE_MS = 24 * 60 * 60 * 1000;

/** The window of a Claude Code model id with the `[1m]` suffix. */
export const ONE_MILLION_WINDOW = 1_000_000;

/** The prices of one model in USD per token, and its input window. */
export type ModelPrice = {
  input: number;
  output: number;
  cacheRead: number;
  /** The cache write price (5-minute lifetime). */
  cacheWrite: number;
  /** The cache write price for the 1-hour lifetime, when LiteLLM names one. */
  cacheWrite1h: number | undefined;
  maxInputTokens: number | undefined;
};

/** The prices of all models that LiteLLM knows, by model id. */
export type PriceTable = ReadonlyMap<string, ModelPrice>;

type RawEntry = {
  input_cost_per_token?: unknown;
  output_cost_per_token?: unknown;
  cache_read_input_token_cost?: unknown;
  cache_creation_input_token_cost?: unknown;
  cache_creation_input_token_cost_above_1hr?: unknown;
  max_input_tokens?: unknown;
};

const numberOr = (value: unknown, fallback: number | undefined): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/**
 * The price table of a LiteLLM file. An entry without an input or an output
 * price is left out, so its model counts as unknown. A missing cache price
 * falls back to the input price, as an API without a cache charges.
 */
export function parsePriceFile(text: string): PriceTable | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (raw === null || typeof raw !== "object") return undefined;
  const table = new Map<string, ModelPrice>();
  for (const [model, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === null || typeof value !== "object") continue;
    const entry = value as RawEntry;
    const input = numberOr(entry.input_cost_per_token, undefined);
    const output = numberOr(entry.output_cost_per_token, undefined);
    if (input === undefined || output === undefined) continue;
    const cacheWrite = numberOr(entry.cache_creation_input_token_cost, input) ?? input;
    table.set(model, {
      input,
      output,
      cacheRead: numberOr(entry.cache_read_input_token_cost, input) ?? input,
      cacheWrite,
      cacheWrite1h: numberOr(entry.cache_creation_input_token_cost_above_1hr, undefined),
      maxInputTokens: numberOr(entry.max_input_tokens, undefined),
    });
  }
  return table;
}

/** The model id without the `[1m]` suffix of Claude Code. */
export function baseModelId(model: string): string {
  return model.replace(/\[1m\]$/i, "");
}

/** The prices of a model id, or undefined when LiteLLM does not know it. Only an exact id matches. */
export function priceOf(table: PriceTable | undefined, model: string): ModelPrice | undefined {
  return table?.get(baseModelId(model));
}

/**
 * The context window of a model: 1,000,000 for a `[1m]` id, else
 * `max_input_tokens` of LiteLLM, else undefined.
 */
export function contextWindowOf(table: PriceTable | undefined, model: string | undefined): number | undefined {
  if (model === undefined) return undefined;
  if (/\[1m\]$/i.test(model)) return ONE_MILLION_WINDOW;
  return priceOf(table, model)?.maxInputTokens;
}

/** The API price of the tokens of one model. */
export function costOfTokens(price: ModelPrice, tokens: TokenCounts): number {
  return (
    tokens.input * price.input +
    tokens.output * price.output +
    tokens.cacheRead * price.cacheRead +
    tokens.cacheWrite5m * price.cacheWrite +
    tokens.cacheWrite1h * (price.cacheWrite1h ?? price.cacheWrite)
  );
}

/**
 * The API price of the tokens of several models. Undefined when no table
 * exists or when one model with tokens is unknown: a partial sum would look
 * like a real price.
 */
export function apiEquivalentUsd(
  table: PriceTable | undefined,
  usageByModel: ReadonlyMap<string, TokenCounts>,
): number | undefined {
  if (table === undefined) return undefined;
  let sum = 0;
  for (const [model, tokens] of usageByModel) {
    const price = priceOf(table, model);
    if (price === undefined) return undefined;
    sum += costOfTokens(price, tokens);
  }
  return sum;
}

/** The parts of the price cache that the tests replace. */
export type PriceDeps = {
  /** The text and the modification time of a file, or undefined when it is missing. */
  readFile(file: string): { text: string; mtimeMs: number } | undefined;
  /** Write a file, creating its folder. */
  writeFile(file: string, text: string): void;
  /** Download a URL as text. It throws on a failure. */
  fetchText(url: string): Promise<string>;
  nowMs(): number;
};

export const defaultPriceDeps: PriceDeps = {
  readFile(file) {
    try {
      return { text: readFileSync(file, "utf8"), mtimeMs: statSync(file).mtimeMs };
    } catch {
      return undefined;
    }
  },
  writeFile(file, text) {
    mkdirSync(path.dirname(file), { recursive: true });
    // Write a temporary file first, so a reader never sees half a file.
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, text);
    renameSync(temporary, file);
  },
  async fetchText(url) {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.text();
  },
  nowMs: () => Date.now(),
};

/** The path of the cached LiteLLM file: `$XDG_CACHE_HOME/idfix/litellm-prices.json`, default `~/.cache`. A relative value is ignored, as the XDG spec says. */
export function priceCachePath(env: Record<string, string | undefined>): string {
  const base = env.XDG_CACHE_HOME !== undefined && path.isAbsolute(env.XDG_CACHE_HOME)
    ? env.XDG_CACHE_HOME
    : path.join(env.HOME ?? homedir(), ".cache");
  return path.join(base, "idfix", "litellm-prices.json");
}

/**
 * The price table: the cached copy while it is fresh, else a new download
 * that replaces the copy. When the download fails, a stale copy still
 * serves. Without any copy, the result is undefined.
 */
export async function loadPrices(
  env: Record<string, string | undefined>,
  deps: PriceDeps = defaultPriceDeps,
): Promise<PriceTable | undefined> {
  const file = priceCachePath(env);
  const cached = deps.readFile(file);
  const cachedTable = cached === undefined ? undefined : parsePriceFile(cached.text);
  if (cached !== undefined && cachedTable !== undefined && deps.nowMs() - cached.mtimeMs < PRICE_CACHE_MS) {
    return cachedTable;
  }
  try {
    const text = await deps.fetchText(LITELLM_PRICES_URL);
    const table = parsePriceFile(text);
    if (table === undefined) return cachedTable;
    try {
      deps.writeFile(file, text);
    } catch {
      // A cache folder that cannot be written only costs the next download.
    }
    return table;
  } catch {
    return cachedTable;
  }
}
