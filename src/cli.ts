#!/usr/bin/env bun
/** oc-sub: drive an opencode server for cheap subagent runs. */
import { UsageError, parseArgs } from "./args";
import { up } from "./up";
import { down } from "./down";
import { upSandbox, downSandbox } from "./sandbox";
import { run } from "./run";
import { attach } from "./attach";
import { status } from "./status";
import { top } from "./top/load";
import { ping } from "./ping";
import { pingRules } from "./rules";
import { watch } from "./watch";
import { log } from "./log";
import { trace } from "./trace";
import { abort } from "./abort";
import { answer } from "./answer";
import { say } from "./say";
import { doctor, gateForCommand } from "./doctor";
import { fetch, worktree, worktreeRm } from "./clone";

const HELP = `oc-sub - drive an opencode server for subagent runs

Usage:
  oc-sub up [--dir DIR] [--no-cost-proxy]
  oc-sub up --no-sandbox [--port N] [--no-cost-proxy]
  oc-sub down [--dir DIR] [--force]
  oc-sub down --no-sandbox [--port N] [--force]
  oc-sub restart [--dir DIR] [--force] [--no-cost-proxy]
  oc-sub restart --no-sandbox [--port N] [--force] [--no-cost-proxy]
  oc-sub run --agent NAME --dir DIR (--brief FILE | TEXT) [--title T] [--model PROVIDER/MODEL]
  oc-sub attach CODE [--url URL]
  oc-sub status [--dir DIR | --all]
  oc-sub top [--dir DIR | --all]
  oc-sub top --once [--dir DIR | --all] [--json]
  oc-sub ping [--dir DIR]
  oc-sub ping --rules [--dir DIR]
  oc-sub watch SESSION [--dir DIR] [--json]
  oc-sub log SESSION [--dir DIR]
  oc-sub trace SESSION [--dir DIR] [--out FILE]
  oc-sub abort SESSION [--dir DIR]
  oc-sub answer REQUEST_ID [--dir DIR] (--reply once|always|reject | --reject | ANSWER...)
  oc-sub say SESSION [--dir DIR] [--agent NAME] [--model PROVIDER/MODEL] TEXT
  oc-sub worktree STEP [--dir ROOT] [--base BRANCH] [--no-setup]
  oc-sub worktree rm STEP [--dir ROOT]
  oc-sub fetch [--dir ROOT]
  oc-sub doctor [--dir DIR] [--json]
  oc-sub doctor --fix [--force] [--dir DIR] [--json]
  oc-sub doctor --fix-as-root [--force] [--dir DIR] [--json]

Every command accepts:
  --url URL   opencode server URL (default: $OC_SUB_URL or http://127.0.0.1:8767)

Sandbox mode:
  Sandbox mode is the default for up, down, and restart. It runs the opencode
  server in a Docker Sandbox (sbx) per project. The sandbox needs sbx on PATH
  (or $SBX_BIN) and one sbx login. A host server needs --no-sandbox.
  --sandbox       the explicit form of the default. It cannot be combined
                  with --no-sandbox, --url, or --port.
  --no-sandbox    run the opencode server on the host (the old default).
  --port N        a host port. Implies --no-sandbox.
  --url URL       a host server URL. Implies --no-sandbox.
  --dir DIR       the project directory (only in sandbox mode; default: the
                  current folder). Not allowed with --no-sandbox, --url, or
                  --port.
  --no-cost-proxy run without the cost proxy, in both modes. The server then
                  calls OpenRouter directly. Use it when the proxy breaks
                  runs.

  worktree and fetch run only in sandbox mode: in clone mode, the worktree
  of a run lives inside the sandbox clone, not on the host.

Environment:
  OC_SUB_URL                 default server URL
  OC_SUB_SHARED_DIR          the folder with the shared AGENTS.md and skills
                             (default: $HOME/dv/meta/agents)
  OPENCODE_SERVER_PASSWORD   enables basic auth (never printed)
  OPENCODE_SERVER_USERNAME   basic-auth user (default: opencode)
  SBX_BIN                    the sbx binary (default: sbx on PATH)
  CLAUDE_BIN                 the claude binary for doctor --fix
                             (default: claude on PATH)

Doctor fixes:
  --fix           runs the safe fixes, then all checks again. It never
                  calls sudo.
  --fix-as-root   implies --fix, and also runs the fixes that need root
                  through sudo (for example chmod 0666 /dev/kvm). sudo may
                  ask for the password; without a terminal it runs sudo -n.`;

const HELP_EXIT_HINT = "run `oc-sub --help` for usage";

export async function main(argv: readonly string[]): Promise<number> {
  const [head] = argv;
  if (argv.length === 0 || head === "--help" || head === "-h" || head === "help") {
    console.log(HELP);
    return 0;
  }
  const args = parseArgs(argv);
  // The fast health checks run once before the dispatch of the commands that
  // change state or start a paid run. A fail stops the command here.
  if ((args.command === "up" || args.command === "restart" || args.command === "run") && !gateForCommand(args)) {
    return 1;
  }
  switch (args.command) {
    case "up":
      return args.sandbox ? upSandbox(args, process.env) : up(args);
    case "down":
      return args.sandbox ? downSandbox(args, process.env) : down(args);
    case "restart": {
      if (args.sandbox) {
        const stoppedSandbox = await downSandbox(args, process.env);
        return stoppedSandbox === 0 ? upSandbox(args, process.env) : stoppedSandbox;
      }
      const stopped = await down(args);
      return stopped === 0 ? up(args) : stopped;
    }
    case "run":
      return run(args);
    case "attach":
      return attach(args);
    case "status":
      return status(args);
    case "top":
      return top(args);
    case "ping":
      return args.rules ? pingRules(args) : ping(args);
    case "watch":
      return watch(args);
    case "log":
      return log(args);
    case "trace":
      return trace(args);
    case "abort":
      return abort(args);
    case "answer":
      return answer(args);
    case "say":
      return say(args);
    case "worktree":
      return args.remove ? await worktreeRm(args, process.env) : worktree(args, process.env);
    case "fetch":
      return fetch(args, process.env);
    case "doctor":
      return doctor(args);
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
