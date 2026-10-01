#!/usr/bin/env bun
/**
 * The Jev probe (PLAN.md step 18): one or two non-streaming requests to
 * OpenRouter to learn whether the Jev slugs answer and what they cost.
 *
 *   bun probe/jev.ts [MODEL ...]        (default: typesafe/jev-router ~typesafe/jev-latest)
 *
 * The key comes from OPENROUTER_API_KEY, else from the project key file.
 * The key is never printed. Cost cap: two requests, 200 output tokens each.
 */
import { readFileSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { projectKeyPath } from "../src/keys";
import type { Env } from "../src/config";

export const DEFAULT_MODELS = ["typesafe/jev-router", "~typesafe/jev-latest"] as const;

const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_GENERATION_URL = "https://openrouter.ai/api/v1/generation?id=";
const MAX_TOKENS = 200;
const CONTENT_LIMIT = 1000;
const GENERATION_RETRIES = 3;
const GENERATION_RETRY_MS = 2000;

/** The fake agent step that the probe sends as the state: a tool call, its output, and the claim. */
export const STEP_STATE = [
  "tool call: bash ls src",
  "tool output: agent.ts\ncli.ts\nindex.ts",
  "claim: I listed the folder",
].join("\n");

/** The two typed questions in the user message: one Choice and one Noul. */
export const STEP_QUESTIONS = [
  "Choice: which tag fits the step: ok | wasted | wrong-tool | hallucinated-claim",
  "Noul: does the result support the claim? yes or no",
].join("\n");

/** The answer schema: one field per question. */
export function answerSchema(): object {
  return {
    type: "json_schema",
    json_schema: {
      name: "jev_probe",
      strict: true,
      schema: {
        type: "object",
        properties: {
          tag: { type: "string", enum: ["ok", "wasted", "wrong-tool", "hallucinated-claim"] },
          claim_supported: { type: "string", enum: ["yes", "no"] },
        },
        required: ["tag", "claim_supported"],
        additionalProperties: false,
      },
    },
  };
}

/** The request body for one model slug. Pure. */
export function buildRequestBody(model: string): object {
  return {
    model,
    max_tokens: MAX_TOKENS,
    response_format: answerSchema(),
    messages: [
      {
        role: "user",
        content: `State:\n${STEP_STATE}\n\nQuestions:\n${STEP_QUESTIONS}\n\nAnswer as JSON with the fields "tag" and "claim_supported".`,
      },
    ],
  };
}

/** The OpenRouter key: the environment variable first, then the project key file. Never printed. */
export function readKey(env: Env, readText: (file: string) => string | null): string | null {
  const fromEnv = env.OPENROUTER_API_KEY?.trim();
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  return readText(projectKeyPath("opencode-subagents", env))?.trim() ?? null;
}

/** One line of the result file: everything but the key. Pure. */
export function resultLine(
  slug: string,
  httpStatus: number,
  model: string | null,
  provider: string | null,
  content: string | null,
  usage: unknown,
  generationCost: number | null,
): string {
  return JSON.stringify({
    date: new Date().toISOString(),
    slug,
    httpStatus,
    model,
    provider,
    content: content === null ? null : content.slice(0, CONTENT_LIMIT),
    usage,
    generationCost,
  });
}

/** The console output for one slug, without the key. Pure. */
export function formatResult(
  slug: string,
  httpStatus: number,
  errorText: string | null,
  model: string | null,
  provider: string | null,
  content: string | null,
  usage: unknown,
  generationCost: number | null,
): string {
  const lines = [
    `== ${slug} ==`,
    `HTTP status: ${httpStatus}`,
  ];
  if (errorText !== null) lines.push(`Error: ${errorText}`);
  if (model !== null) lines.push(`Model: ${model}`);
  if (provider !== null) lines.push(`Provider: ${provider}`);
  if (content !== null) lines.push(`Content: ${content.slice(0, CONTENT_LIMIT)}`);
  lines.push(`Usage: ${JSON.stringify(usage)}`);
  lines.push(`Generation cost: ${generationCost === null ? "unknown" : `$${generationCost.toFixed(6)}`}`);
  return lines.join("\n");
}

/** The content of a chat completion response, or null. */
function contentOf(body: unknown): string | null {
  const choices = (body as { choices?: Array<{ message?: { content?: unknown } }> })?.choices;
  const content = choices?.[0]?.message?.content;
  return typeof content === "string" ? content : null;
}

/**
 * One probe request against one slug, plus the generation cost lookup with
 * up to three tries, because OpenRouter counts a request a minute or two late.
 */
export async function probeSlug(
  slug: string,
  key: string,
  doFetch: typeof fetch,
  sleep: (ms: number) => Promise<void>,
): Promise<{ status: number; errorText: string | null; model: string | null; provider: string | null; content: string | null; usage: unknown; generationId: string | null; generationCost: number | null }> {
  const response = await doFetch(OPENROUTER_CHAT_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(buildRequestBody(slug)),
  });
  const status = response.status;
  const body = (await response.json().catch(() => null)) as
    | { model?: unknown; provider?: unknown; usage?: unknown; error?: { message?: unknown }; id?: unknown }
    | null;

  let errorText: string | null = null;
  if (status !== 200) {
    const message = body?.error?.message;
    errorText = typeof message === "string" ? message : `HTTP ${status}`;
  }
  const model = typeof body?.model === "string" ? body.model : null;
  const provider = typeof body?.provider === "string" ? body.provider : null;
  const usage = body?.usage ?? null;
  const content = status === 200 ? contentOf(body) : null;
  const generationId = typeof body?.id === "string" ? body.id : null;

  let generationCost: number | null = null;
  if (status === 200 && generationId !== null) {
    for (let attempt = 0; attempt < GENERATION_RETRIES; attempt++) {
      if (attempt > 0) await sleep(GENERATION_RETRY_MS);
      const gen = await doFetch(`${OPENROUTER_GENERATION_URL}${encodeURIComponent(generationId)}`, {
        headers: { Authorization: `Bearer ${key}` },
      });
      if (gen.status !== 200) continue;
      const genBody = (await gen.json().catch(() => null)) as { data?: { total_cost?: unknown } } | null;
      const cost = genBody?.data?.total_cost;
      if (typeof cost === "number") {
        generationCost = cost;
        break;
      }
    }
  }
  return { status, errorText, model, provider, content, usage, generationId, generationCost };
}

function readFileSyncOrNull(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

export async function main(argv: readonly string[], env: Env = process.env): Promise<number> {
  const slugs = argv.length > 0 ? [...argv] : [...DEFAULT_MODELS];
  const key = readKey(env, (file) => readFileSyncOrNull(file));
  if (key === null || key.length === 0) {
    console.error(`no key: set OPENROUTER_API_KEY or create ${projectKeyPath("opencode-subagents", env)}`);
    return 2;
  }
  const resultsDir = path.join(import.meta.dir, "results");
  await mkdir(resultsDir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const resultsFile = path.join(resultsDir, `jev-${date}.jsonl`);

  let failures = 0;
  for (const slug of slugs) {
    const result = await probeSlug(slug, key, fetch, (ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    console.log(formatResult(slug, result.status, result.errorText, result.model, result.provider, result.content, result.usage, result.generationCost));
    const line = resultLine(slug, result.status, result.model, result.provider, result.content, result.usage, result.generationCost);
    await appendFile(resultsFile, `${line}\n`);
    if (result.status !== 200) failures++;
  }
  console.log(`results: ${resultsFile}`);
  return failures === slugs.length ? 1 : 0;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
