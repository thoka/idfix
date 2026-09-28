#!/usr/bin/env bun
/** oc-sub: drive an opencode server for cheap subagent runs. */
import { UsageError, parseArgs } from "./args";
import { up } from "./up";
import { down } from "./down";
import { run } from "./run";
import { status } from "./status";
import { watch } from "./watch";
import { log } from "./log";
import { abort } from "./abort";

const HELP = `oc-sub - drive an opencode server for subagent runs

Usage:
  oc-sub up [--port N]
  oc-sub down [--port N] [--force]
  oc-sub restart [--port N] [--force]
  oc-sub run --agent NAME --dir DIR (--brief FILE | TEXT) [--title T]
  oc-sub status [--dir DIR]
  oc-sub watch SESSION [--dir DIR] [--json]
  oc-sub log SESSION [--dir DIR]
  oc-sub abort SESSION [--dir DIR]

Every command accepts:
  --url URL   opencode server URL (default: $OC_SUB_URL or http://127.0.0.1:8767)

Environment:
  OC_SUB_URL                 default server URL
  OPENCODE_SERVER_PASSWORD   enables basic auth (never printed)
  OPENCODE_SERVER_USERNAME   basic-auth user (default: opencode)`;

const HELP_EXIT_HINT = "run `oc-sub --help` for usage";

export async function main(argv: readonly string[]): Promise<number> {
  const [head] = argv;
  if (argv.length === 0 || head === "--help" || head === "-h" || head === "help") {
    console.log(HELP);
    return 0;
  }
  const args = parseArgs(argv);
  switch (args.command) {
    case "up":
      return up(args);
    case "down":
      return down(args);
    case "restart": {
      const stopped = await down(args);
      return stopped === 0 ? up(args) : stopped;
    }
    case "run":
      return run(args);
    case "status":
      return status(args);
    case "watch":
      return watch(args);
    case "log":
      return log(args);
    case "abort":
      return abort(args);
  }
}

if (import.meta.main) {
  try {
    const code = await main(process.argv.slice(2));
    process.exit(code);
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`usage error: ${error.message}`);
      console.error(HELP_EXIT_HINT);
      process.exit(2);
    }
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
