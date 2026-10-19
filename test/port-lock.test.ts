/** Tests for the cross-process port reservation of the integration tests. */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import net from "node:net";
import path from "node:path";
import { lockPath, reservePortPair, type PortRange } from "./port-lock";

const CHILD = path.join(import.meta.dir, "fixtures", "port-lock-child.ts");

function lockDir(): string {
  return mkdtempSync(path.join(tmpdir(), "oc-sub-port-lock-"));
}

/** A PID that belonged to a process that has exited. */
function deadPid(): number {
  const proc = Bun.spawnSync([process.execPath, "-e", "process.stdout.write(String(process.pid))"]);
  return Number(proc.stdout.toString());
}

/** Reads the first line of a stream. */
async function firstLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of stream) {
    text += decoder.decode(chunk);
    const end = text.indexOf("\n");
    if (end >= 0) return text.slice(0, end);
  }
  return text;
}

/** Binds a port on 127.0.0.1 and returns the server. */
function bind(port: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

// High ports far from the integration range, so the bind probe passes.
const RANGE: PortRange = { first: 47310, last: 47333 };

describe("reservePortPair", () => {
  test("processes that reserve at the same time never get the same port or overlapping pairs", async () => {
    const dir = lockDir();
    const children = Array.from({ length: 6 }, () =>
      Bun.spawn([process.execPath, CHILD, dir, String(RANGE.first), String(RANGE.last)], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "inherit",
      }),
    );
    try {
      const lines = await Promise.all(children.map((child) => firstLine(child.stdout)));
      const ports = lines.map((line) => Number(line));
      for (const port of ports) {
        expect(Number.isInteger(port)).toBe(true);
        expect(port).toBeGreaterThanOrEqual(RANGE.first);
        expect(port + 1).toBeLessThanOrEqual(RANGE.last);
      }
      const taken = ports.flatMap((port) => [port, port + 1]);
      expect(new Set(taken).size).toBe(taken.length);
    } finally {
      for (const child of children) {
        child.stdin.end();
      }
      await Promise.all(children.map((child) => child.exited));
    }
    // Each child released its locks when it exited.
    expect(readdirSync(dir)).toEqual([]);
  });

  test("a second reservation in the same process gets the next pair, and release frees the first", async () => {
    const dir = lockDir();
    const first = await reservePortPair({ dir, range: RANGE });
    const second = await reservePortPair({ dir, range: RANGE });
    expect(first.port).toBe(RANGE.first);
    expect(second.port).toBe(RANGE.first + 2);
    expect(readFileSync(lockPath(dir, first.port), "utf8").trim()).toBe(String(process.pid));
    first.release();
    expect(existsSync(lockPath(dir, first.port))).toBe(false);
    const third = await reservePortPair({ dir, range: RANGE });
    expect(third.port).toBe(RANGE.first);
    second.release();
    third.release();
    expect(readdirSync(dir)).toEqual([]);
  });

  test("a lock of a live process is skipped", async () => {
    const dir = lockDir();
    // The parent of the test process is alive while the test runs.
    writeFileSync(lockPath(dir, RANGE.first), `${process.ppid}\n`);
    const pair = await reservePortPair({ dir, range: RANGE });
    expect(pair.port).toBe(RANGE.first + 2);
    pair.release();
    expect(readFileSync(lockPath(dir, RANGE.first), "utf8").trim()).toBe(String(process.ppid));
  });

  test("a lock of a dead process is stale and is taken over", async () => {
    const dir = lockDir();
    writeFileSync(lockPath(dir, RANGE.first), `${deadPid()}\n`);
    const pair = await reservePortPair({ dir, range: RANGE });
    expect(pair.port).toBe(RANGE.first);
    expect(readFileSync(lockPath(dir, RANGE.first), "utf8").trim()).toBe(String(process.pid));
    pair.release();
    expect(readdirSync(dir)).toEqual([]);
  });

  test("a pair whose second port is bound is skipped and its lock is freed", async () => {
    const dir = lockDir();
    const server = await bind(RANGE.first + 1);
    try {
      const pair = await reservePortPair({ dir, range: RANGE });
      expect(pair.port).toBe(RANGE.first + 2);
      expect(existsSync(lockPath(dir, RANGE.first))).toBe(false);
      pair.release();
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test("release does not remove a lock that another process owns now", async () => {
    const dir = lockDir();
    const pair = await reservePortPair({ dir, range: RANGE });
    writeFileSync(lockPath(dir, pair.port), `${process.ppid}\n`);
    pair.release();
    expect(readFileSync(lockPath(dir, pair.port), "utf8").trim()).toBe(String(process.ppid));
  });

  test("a full range fails with a clear error", async () => {
    const dir = lockDir();
    const range: PortRange = { first: RANGE.first, last: RANGE.first + 1 };
    const pair = await reservePortPair({ dir, range });
    await expect(reservePortPair({ dir, range })).rejects.toThrow(`no free port pair between ${range.first} and ${range.last}`);
    pair.release();
  });
});
