import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { down, formatBusyLine, isAlive, isOpencodeServe, signalGroup, stopGroup } from "../src/down";
import { servePidPath } from "../src/state";
import { noUnits } from "./fake-units";

describe("isOpencodeServe", () => {
  test("accepts opencode serve on the port", () => {
    expect(isOpencodeServe("opencode serve --port 8767 --hostname 127.0.0.1", 8767)).toBe(true);
    expect(isOpencodeServe("/home/user/.local/share/mise/installs/opencode/1.18.32/bin/opencode serve --port 8767", 8767)).toBe(true);
    expect(isOpencodeServe("opencode serve --port=8767", 8767)).toBe(true);
  });

  test("rejects another port, another command, or another program", () => {
    expect(isOpencodeServe("opencode serve --port 8768", 8767)).toBe(false);
    expect(isOpencodeServe("opencode web --port 8767", 8767)).toBe(false);
    expect(isOpencodeServe("vim notes-opencode serve --port 8767", 8767)).toBe(false);
    expect(isOpencodeServe("", 8767)).toBe(false);
  });
});

describe("formatBusyLine", () => {
  test("shows state, session, and directory", () => {
    expect(formatBusyLine({ state: "busy", id: "ses_1", directory: "/w" })).toBe("busy ses_1 /w");
  });
});

describe("isAlive", () => {
  test("is true for this process", () => {
    expect(isAlive(process.pid)).toBe(true);
  });
});

/**
 * A detached process group whose leader catches the first SIGTERM with a
 * one-shot handler and keeps running, like opencode serve while npm's
 * arborist installs the plugin dependencies (its `signal-exit` handler
 * aborts the install and removes itself). With `ignoreTerm`, the leader
 * ignores every SIGTERM.
 */
function spawnStubbornGroup(ignoreTerm = false): Bun.Subprocess {
  const trap = ignoreTerm ? "trap '' TERM" : "trap 'trap - TERM' TERM";
  return Bun.spawn(["sh", "-c", `${trap}; echo ready; while :; do sleep 0.05; done`], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    detached: true,
  });
}

async function waitForReady(proc: Bun.Subprocess): Promise<void> {
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  await reader.read();
  reader.releaseLock();
}

function killGroupSilently(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

describe("down stops a server whose first SIGTERM is caught", () => {
  test("down returns 0 and the group is gone", async () => {
    const proc = spawnStubbornGroup();
    const stateHome = mkdtempSync(path.join(tmpdir(), "oc-sub-down-stop-"));
    const env = { XDG_STATE_HOME: stateHome };
    const port = 8765;
    try {
      await waitForReady(proc);
      mkdirSync(path.dirname(servePidPath(env, port)), { recursive: true });
      writeFileSync(servePidPath(env, port), `${proc.pid}\n`);
      const started = Date.now();
      const code = await down({ port, force: true }, env, {
        units: noUnits(),
        commandLineOf: (pid) => (pid === proc.pid ? `opencode serve --port ${port}` : null),
      });
      expect(code).toBe(0);
      await proc.exited;
      // One repeated SIGTERM is enough: no wait for the SIGKILL deadline.
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(proc.signalCode).toBe("SIGTERM");
      expect(existsSync(servePidPath(env, port))).toBe(false);
    } finally {
      killGroupSilently(proc.pid);
      rmSync(stateHome, { recursive: true, force: true });
    }
  }, 20_000);
});

describe("stopGroup", () => {
  const short = { timeoutMs: 600, repeatMs: 200, killTimeoutMs: 2_000 };

  test("repeats SIGTERM when the first one is caught", async () => {
    const proc = spawnStubbornGroup();
    try {
      await waitForReady(proc);
      const sent: string[] = [];
      const result = await stopGroup(proc.pid, (pid, signal) => {
        sent.push(signal);
        signalGroup(pid, signal);
      }, { ...short, timeoutMs: 5_000 });
      expect(result).toBe("terminated");
      expect(sent.length).toBeGreaterThanOrEqual(2);
      expect(sent.every((signal) => signal === "SIGTERM")).toBe(true);
    } finally {
      killGroupSilently(proc.pid);
    }
  });

  test("sends SIGKILL to the group when SIGTERM never works", async () => {
    const proc = spawnStubbornGroup(true);
    try {
      await waitForReady(proc);
      const sent: string[] = [];
      const result = await stopGroup(proc.pid, (pid, signal) => {
        sent.push(signal);
        signalGroup(pid, signal);
      }, short);
      expect(result).toBe("killed");
      expect(sent.at(-1)).toBe("SIGKILL");
      await proc.exited;
      expect(proc.signalCode).toBe("SIGKILL");
    } finally {
      killGroupSilently(proc.pid);
    }
  });

  test("reports stuck when the process outlives SIGKILL", async () => {
    const proc = spawnStubbornGroup(true);
    try {
      await waitForReady(proc);
      // A signal function that reaches nothing stands in for a process
      // that SIGKILL cannot end (for example one in uninterruptible sleep).
      const result = await stopGroup(proc.pid, () => {}, { timeoutMs: 300, repeatMs: 100, killTimeoutMs: 300 });
      expect(result).toBe("stuck");
    } finally {
      killGroupSilently(proc.pid);
    }
  });
});
