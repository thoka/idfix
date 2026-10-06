/**
 * `idfx down --all`: stop every server that idfx started. These are the
 * running sandboxes with a state file and the host servers with a PID file.
 * Each server keeps its own busy check, so a busy server stays up without
 * `--force`, and the other servers still stop.
 */
import { readdirSync } from "node:fs";
import { down, type DownDeps } from "./down";
import type { Env } from "./config";
import { defaultSandboxDeps, listsRunning, readSandboxStates, sbxBin, stopSandbox, type SandboxDeps } from "./sandbox";
import { stateDir } from "./state";

/**
 * The ports of the PID files `serve-<port>.pid` in the state folder, sorted.
 * A missing state folder gives no ports.
 */
export function pidFilePorts(env: Env): number[] {
  let entries: string[];
  try {
    entries = readdirSync(stateDir(env));
  } catch {
    return [];
  }
  const ports: number[] = [];
  for (const entry of entries) {
    const match = /^serve-(\d+)\.pid$/.exec(entry);
    if (match !== null) ports.push(Number(match[1]));
  }
  return ports.sort((a, b) => a - b);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function downAll(
  args: { force: boolean },
  env: Env = process.env,
  sandboxDeps: Partial<SandboxDeps> = {},
  downDeps: Partial<DownDeps> = {},
): Promise<number> {
  let failed = 0;
  const sandboxPorts = new Set<number>();
  const states = readSandboxStates(env);
  // One `sbx ls` for all sandboxes. Without sbx, no sandbox can run.
  let listing = "";
  if (states.length > 0) {
    try {
      const runner = sandboxDeps.runner ?? defaultSandboxDeps.runner;
      const ls = runner([sbxBin(env), "ls"]);
      if (ls.exitCode === 0) {
        listing = ls.stdout;
      } else {
        console.error("error: sbx ls failed, so no sandbox was stopped");
        failed += 1;
      }
    } catch (error) {
      console.error(`error: sbx ls failed: ${errorText(error)}`);
      failed += 1;
    }
  }

  for (const { state } of states) {
    // The holder of a sandbox writes its PID file on the port of the sandbox.
    sandboxPorts.add(state.port);
    if (!listsRunning(listing, state.name)) continue;
    try {
      if ((await stopSandbox(state, args.force, env, sandboxDeps)) !== 0) failed += 1;
    } catch (error) {
      console.error(`error: sandbox ${state.name}: ${errorText(error)}`);
      failed += 1;
    }
  }

  for (const port of pidFilePorts(env)) {
    if (sandboxPorts.has(port)) continue;
    try {
      if ((await down({ port, force: args.force }, env, downDeps)) !== 0) failed += 1;
    } catch (error) {
      console.error(`error: port ${port}: ${errorText(error)}`);
      failed += 1;
    }
  }

  if (failed > 0) {
    console.error(`error: ${failed} server(s) did not stop`);
    return 1;
  }
  return 0;
}
