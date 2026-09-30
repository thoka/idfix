#!/usr/bin/env bun
/**
 * The probe CLI (PLAN.md step 10d): run the probe task once per provider
 * and run number, one run at a time, and print a table at the end.
 *
 *   bun probe/run.ts --providers z-ai,baseten --runs 3 [--dir ROOT] [--control] [--yes]
 *
 * Paid runs need `--yes`. Without it, the command prints the number of runs
 * and the cost estimate and stops.
 */
import path from "node:path";
import { UsageError } from "../src/args";
import type { Env } from "../src/config";
import { makeClient } from "../src/client";
import { defaultRunner, resolveCommandUrl, readSandboxState, sandboxStatePath } from "../src/sandbox";
import { projectNameOf } from "../src/keys";
import { CONTROL_PROVIDER, defaultPendingRequests, defaultResolveKey, median, resultsFilePath, runProbe, appendResultLine, type ProbeDeps, type ProbeRunResult } from "../src/probe/runner";
import type { ExpectedAnswer } from "../src/probe/evaluate";
import { formatCost, formatDuration } from "../src/summary";

const HELP = `usage: bun probe/run.ts --providers LIST --runs N [--dir ROOT] [--control] [--yes]

  --providers LIST   comma-separated OpenRouter provider slugs (lower case),
                     for example z-ai,baseten
  --runs N           runs per provider
  --dir ROOT         the project root of the sandbox clone (default: the
                     current folder)
  --control          one control run with the provider ${CONTROL_PROVIDER},
                     which must fail with a routing error
  --yes              start the paid runs; without it the command only prints
                     the cost estimate

Every run costs about 0.01 USD at OpenRouter.`;

type CliArgs = { providers: string[]; runs: number; dir?: string; control: boolean; yes: boolean };

function parseCli(argv: readonly string[]): CliArgs {
  const args: CliArgs = { providers: [], runs: 0, control: false, yes: false };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith("--")) throw new UsageError(`unexpected argument "${token}"`);
    const [name, inline] = token.slice(2).split("=", 2);
    const value = (keys: readonly string[]): string => {
      if (inline !== undefined) return inline;
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) throw new UsageError(`--${name} needs a value`);
      i++;
      return next;
    };
    switch (name) {
      case "providers":
        args.providers = value([]).split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
        break;
      case "runs": {
        const runs = Number(value([]));
        if (!Number.isInteger(runs) || runs < 1) throw new UsageError("--runs must be a number of 1 or more");
        args.runs = runs;
        break;
      }
      case "dir":
        args.dir = value([]);
        break;
      case "control":
        args.control = true;
        break;
      case "yes":
        args.yes = true;
        break;
      default:
        throw new UsageError(`unknown option --${name}`);
    }
  }
  if (args.control) {
    args.providers = [CONTROL_PROVIDER];
    args.runs = 1;
  } else if (args.providers.length === 0 || args.runs < 1) {
    throw new UsageError("--providers and --runs are required");
  }
  return args;
}

function ms(value: number | null): string {
  return value === null ? "-" : `${Math.round(value)}ms`;
}

function rate(value: number | null): string {
  return value === null ? "-" : `${value.toFixed(1)} tok/s`;
}

function usd(value: number | null): string {
  return value === null ? "-" : `$${value.toFixed(4)}`;
}

function runLine(result: ProbeRunResult): string {
  const outcome = result.control
    ? result.pass
      ? "control: refused as expected"
      : "control: ANSWERED (routing pin does not reach OpenRouter)"
    : result.pass
      ? "pass"
      : `FAIL (${result.failures.map((failure) => failure.rule).join(", ")})`;
  return (
    `${result.step}: ${outcome}, ` +
    `ttft ${ms(result.speed.timeToFirstTokenMs)}, ${rate(result.speed.generationTokensPerSecond)}, ` +
    `est ${formatCost(result.estimatedCost)}, real ${usd(result.realCostDelta)}, ${formatDuration(result.wallMs)}`
  );
}

/** One row of the end table, aggregated per provider. A run with a `setup`
 * failure (worktree create, config write, or remove) is not a provider
 * failure: the setup column counts it, and the pass rate leaves it out. */
export function providerRows(results: readonly ProbeRunResult[]): Array<{
  provider: string;
  passes: number;
  runs: number;
  setup: number;
  medianTtftMs: number | null;
  medianTokensPerSecond: number | null;
  medianRealCost: number | null;
}> {
  const byProvider = new Map<string, ProbeRunResult[]>();
  for (const result of results) {
    const list = byProvider.get(result.provider) ?? [];
    list.push(result);
    byProvider.set(result.provider, list);
  }
  return [...byProvider.entries()].map(([provider, list]) => {
    const setupRuns = list.filter((result) => result.failures.some((failure) => failure.rule === "setup"));
    const providerRuns = list.filter((result) => !result.failures.some((failure) => failure.rule === "setup"));
    return {
      provider,
      passes: providerRuns.filter((result) => result.pass).length,
      runs: providerRuns.length,
      setup: setupRuns.length,
      medianTtftMs: median(list.map((result) => result.speed.timeToFirstTokenMs ?? Number.NaN).filter((value) => !Number.isNaN(value))),
      medianTokensPerSecond: median(list.map((result) => result.speed.generationTokensPerSecond ?? Number.NaN).filter((value) => !Number.isNaN(value))),
      medianRealCost: median(list.map((result) => result.realCostDelta ?? Number.NaN).filter((value) => !Number.isNaN(value))),
    };
  });
}

export async function main(argv: readonly string[], env: Env = process.env): Promise<number> {
  let args: CliArgs;
  try {
    args = parseCli(argv);
  } catch (error) {
    console.error(error instanceof UsageError ? `usage error: ${error.message}` : String(error));
    console.error(HELP);
    return 2;
  }
  const dir = path.resolve(args.dir ?? process.cwd());
  const baseUrl = resolveCommandUrl(undefined, env, dir);
  const client = makeClient(baseUrl, env);

  const runsPerProvider = args.control ? 1 : args.runs;
  const total = runsPerProvider * args.providers.length;
  console.log(`${total} run(s) (${args.providers.length} provider(s) x ${runsPerProvider} run(s)), cost estimate $0.01 per run, about $${(total * 0.01).toFixed(2)} total`);
  if (!args.yes) {
    console.error("paid runs need --yes");
    return 1;
  }

  const taskText = await Bun.file(new URL("./task.md", import.meta.url)).text();
  const expected = (await Bun.file(new URL("./expected.json", import.meta.url)).json()) as ExpectedAnswer;
  const resultsFile = resultsFilePath(path.join(import.meta.dir, "results"), new Date());

  const deps: ProbeDeps = {
    runner: defaultRunner,
    sandboxState: (project) => readSandboxState(sandboxStatePath(env, project)),
    projectName: projectNameOf,
    client,
    baseUrl,
    fetch,
    resolveKey: defaultResolveKey(client, env),
    pendingRequests: defaultPendingRequests(baseUrl, env),
    appendResult: appendResultLine,
    now: Date.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    pollMs: 2000,
    runTimeoutMs: 15 * 60_000,
  };

  const results = await runProbe(
    { dir, providers: args.providers, runs: runsPerProvider, taskText, expected, control: args.control, resultsFile, env },
    deps,
  );

  console.log(`results: ${resultsFile}`);
  for (const result of results) console.log(runLine(result));

  const rows = providerRows(results);
  console.log("");
  console.log("provider      passes  setup  median ttft  median tok/s  median real cost");
  for (const row of rows) {
    console.log(
      row.provider.padEnd(14) +
        `${row.passes}/${row.runs}`.padEnd(8) +
        String(row.setup).padEnd(7) +
        ms(row.medianTtftMs).padEnd(13) +
        rate(row.medianTokensPerSecond).padEnd(14) +
        usd(row.medianRealCost),
    );
  }
  // A setup failure is not a provider failure: it leaves the pass rate out,
  // and the exit code counts only the provider runs.
  const providerRuns = results.filter((result) => !result.failures.some((failure) => failure.rule === "setup"));
  return providerRuns.every((result) => result.pass) ? 0 : 1;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
