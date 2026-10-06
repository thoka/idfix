#!/usr/bin/env bun
/** idfx: drive an opencode server for cheap subagent runs. */
import { UsageError, parseArgs } from "./args";
import { up } from "./up";
import { down } from "./down";
import { downAll } from "./down-all";
import { upSandbox, downSandbox } from "./sandbox";
import { run } from "./run";
import { attach } from "./attach";
import { status } from "./status";
import { top } from "./top/load";
import { ping } from "./ping";
import { pingRules } from "./rules";
import { watch } from "./watch";
import { watchAll } from "./watch/run";
import { log } from "./log";
import { trace } from "./trace";
import { abort } from "./abort";
import { answer } from "./answer";
import { say } from "./say";
import { doctor, gateForCommand } from "./doctor";
import { fetch, worktree, worktreeRm } from "./clone";
import { runIdleWatch } from "./idle";

/** The command name when the launcher does not pass one. */
export const DEFAULT_PROG = "idfx";

/**
 * The name the user called: idfx, idfix, or the old name oc-sub. The launchers in bin/
 * pass the base name of their $0 in IDFX_PROG, so a symlink name survives.
 * Without it, the name is DEFAULT_PROG.
 */
export function progName(env: Record<string, string | undefined>): string {
  const name = env.IDFX_PROG?.trim().split("/").pop();
  return name ? name : DEFAULT_PROG;
}

/** The help text, with the command name `prog` in each usage line. */
export function helpText(prog: string = DEFAULT_PROG): string {
  return `${prog} - drive an opencode server for subagent runs
oc-sub is the old name of idfx and still works.

Usage:
  ${prog} up [--dir DIR] [--no-cost-proxy] [--idle-minutes N]
  ${prog} up --no-sandbox [--port N] [--no-cost-proxy] [--idle-minutes N]
  ${prog} down [--dir DIR] [--force]
  ${prog} down --no-sandbox [--port N] [--force]
  ${prog} down --all [--force]
  ${prog} restart [--dir DIR] [--force] [--no-cost-proxy] [--idle-minutes N]
  ${prog} restart --no-sandbox [--port N] [--force] [--no-cost-proxy] [--idle-minutes N]
  ${prog} run --agent NAME --dir DIR (--brief FILE | TEXT) [--title T] [--model PROVIDER/MODEL]
  ${prog} attach CODE [--url URL]
  ${prog} status [--dir DIR | --all] [--json]
  ${prog} top [--dir DIR | --all]
  ${prog} top --once [--dir DIR | --all] [--json]
  ${prog} ping [--dir DIR]
  ${prog} ping --rules [--dir DIR]
  ${prog} watch SESSION [--dir DIR] [--json]
  ${prog} watch --all [--json] [--once]
  ${prog} log SESSION [--dir DIR]
  ${prog} trace SESSION [--dir DIR] [--out FILE] [--tag] [--max-steps N]
  ${prog} abort SESSION [--dir DIR]
  ${prog} answer REQUEST_ID [--dir DIR] (--reply once|always|reject | --reject | ANSWER...)
  ${prog} say SESSION [--dir DIR] [--agent NAME] [--model PROVIDER/MODEL] TEXT
  ${prog} worktree STEP [--dir ROOT] [--base BRANCH] [--no-setup]
  ${prog} worktree rm STEP [--dir ROOT]
  ${prog} fetch [--dir ROOT]
  ${prog} doctor [--dir DIR] [--json]
  ${prog} doctor --fix [--force] [--dir DIR] [--json]
  ${prog} doctor --renovate [--dir DIR] [--json]
  ${prog} doctor --fix-as-root [--force] [--dir DIR] [--json]

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
  --idle-minutes N
                  stop the new server after N minutes without a busy
                  session and without events (default 30). 0 turns the
                  idle watchdog off. In sandbox mode, the stop also stops
                  the VM.

  worktree and fetch run only in sandbox mode: in clone mode, the worktree
  of a run lives inside the sandbox clone, not on the host.

Environment:
  OC_SUB_URL                 default server URL
  OC_SUB_SHARED_DIR          the folder with the shared AGENTS.md and skills
                             (no default; up and ping --rules need it)
  OPENCODE_SERVER_PASSWORD   enables basic auth (never printed)
  OPENCODE_SERVER_USERNAME   basic-auth user (default: opencode)
  SBX_BIN                    the sbx binary (default: sbx on PATH)
  CLAUDE_BIN                 the claude binary for doctor --fix
                             (default: claude on PATH)

Watch all Claude Code sessions:
  watch --all     polls the Claude Code sessions of this machine every 15
                  seconds. Each change of a condition (a session waits for
                  the user, stalls, has a high context, ends without a clean
                  hand-off, hits an API error, or has no name) becomes one
                  CloudEvent in $XDG_STATE_HOME/idfx/events.jsonl. A
                  heartbeat follows every 5 minutes. Only one watcher runs at
                  a time; a second one exits with code 1. A session that
                  waits for the user or hits an API error wakes the
                  supervisor through notify-session, at most once per
                  minute, never on the first run of a new log.
  --json          also prints each new event on stdout, one JSON line each.
  --once          polls one time and exits.
  watch SESSION follows one opencode run and cannot be combined with --all.

JSON output (tool protocol version 0):
  status --json   prints one object: tool, version, time, source, sequence
                  (the last event of the watch log), conditions (the True
                  conditions of the Claude Code sessions, without
                  HandoverFailed), and items (the sessions).
  doctor --json   prints one object: tool, version, status (pass, warn, or
                  fail), checks (each with type urn:dv:idfx:doctor:<name>),
                  and fixes with --fix. Exit code 0 pass or warn, 1 fail or
                  a failed fix, 2 usage error or a doctor that cannot run.
  In JSON mode, stdout holds only the object; all other text goes to stderr.

Doctor fixes:
  --fix           runs the safe fixes, then all checks again. It never
                  calls sudo.
  --renovate      implies --fix and --force, and lifts the project to the
                  current standard: it also runs the fixes that need
                  --force (for example the agent-copies rewrite and the
                  recreate of the sandbox). The guards inside a fix still
                  block: a busy session and work in the clone that the host
                  would lose. A fix that writes a file in the project runs
                  only on a clean git tree; on a dirty tree it prints the
                  precondition instead.
  --fix-as-root   implies --fix, and also runs the fixes that need root
                  through sudo (for example chmod 0666 /dev/kvm). sudo may
                  ask for the password; without a terminal it runs sudo -n.`;
}

/** The hint after a usage error. */
export function helpExitHint(prog: string = DEFAULT_PROG): string {
  return `run \`${prog} --help\` for usage`;
}

// Read the name once and drop it from the environment, so that a child
// process (for example a nested launcher call) does not inherit it.
const PROG = progName(process.env);
delete process.env.IDFX_PROG;

export async function main(argv: readonly string[]): Promise<number> {
  const [head] = argv;
  if (argv.length === 0 || head === "--help" || head === "-h" || head === "help") {
    console.log(helpText(PROG));
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
      if (args.all) return downAll(args, process.env);
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
    case "watch-all":
      return watchAll(args, process.env);
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
      return args.remove ? await worktreeRm(args, process.env) : await worktree(args, process.env);
    case "fetch":
      return fetch(args, process.env);
    case "idle-watch":
      return runIdleWatch(args, process.env);
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
      console.error(helpExitHint(PROG));
      process.exit(2);
    }
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
