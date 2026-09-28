/**
 * Integration test: runs against a real `opencode serve` on a free port from
 * 8790 upward. It exercises `up`, creates sessions over the SDK (without
 * sending any prompt, so no model is called and nothing costs money), checks
 * `status`, runs `watch` on an already finished session, runs `abort`, and
 * stops the server with `restart` and `down`. Skipped when the `opencode` command is not on the
 * PATH.
 */
import { expect, test } from "bun:test";
import { createOpencodeClient, type Event, type OpencodeClient } from "@opencode-ai/sdk";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import net from "node:net";
import path from "node:path";

const hasOpencode = Bun.which("opencode") !== null;
if (!hasOpencode) {
  console.log("skipping integration test: the command `opencode` is not on the PATH");
}

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const CLI = path.join(REPO_ROOT, "src", "cli.ts");
const FIRST_PORT = 8790;
const LAST_PORT = 8900;

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, "127.0.0.1");
  });
}

async function findFreePort(): Promise<number> {
  for (let port = FIRST_PORT; port <= LAST_PORT; port++) {
    if (await isPortFree(port)) return port;
  }
  throw new Error(`no free port between ${FIRST_PORT} and ${LAST_PORT}`);
}

type CliResult = { code: number; stdout: string; stderr: string };

function runCli(cwd: string, args: string[], env: Record<string, string>): CliResult {
  const proc = Bun.spawnSync([process.execPath, "run", CLI, ...args], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: proc.exitCode ?? -1,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

/** Wait until the serve process is gone (SIGTERM done) or time out. */
async function waitUntilGone(pid: number, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let alive: boolean;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {
      alive = false;
    }
    if (!alive) return true;
    if (Date.now() > deadline) return false;
    await Bun.sleep(200);
  }
}

async function makeSession(client: OpencodeClient, directory: string, title: string): Promise<string> {
  const created = await client.session.create({ query: { directory }, body: { title } });
  expect(created.error).toBeUndefined();
  const sessionId = created.data?.id;
  expect(typeof sessionId).toBe("string");
  if (sessionId === undefined) throw new Error("session was not created");
  return sessionId;
}

/**
 * Consume the first event of the stream. The SDK opens the SSE connection
 * lazily on the first next(), so the stream must be primed before events of
 * interest can be observed.
 */
async function primeStream(iterator: AsyncGenerator<Event>, timeoutMs: number): Promise<boolean> {
  const next = await Promise.race([iterator.next(), Bun.sleep(timeoutMs).then(() => null)]);
  return next !== null && !next.done;
}

/** Whether the stream delivers a session.created event for the session in time. */
async function deliversSessionCreated(
  iterator: AsyncGenerator<Event>,
  sessionId: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) return false;
    const next = await Promise.race([iterator.next(), Bun.sleep(left).then(() => null)]);
    if (next === null || next.done) return false;
    const event = next.value as Event;
    if (event.type === "session.created" && event.properties.info.id === sessionId) return true;
  }
}

/** Prime a stream, run `probe`, look for its session.created, then close. */
async function probeStream(
  client: OpencodeClient,
  label: string,
  directory: string | undefined,
  timeoutMs: number,
): Promise<boolean> {
  const subscription = directory === undefined ? await client.event.subscribe() : await client.event.subscribe({ query: { directory } });
  const iterator = subscription.stream[Symbol.asyncIterator]() as AsyncGenerator<Event>;
  try {
    if (!(await primeStream(iterator, timeoutMs))) return false;
    const probeId = await makeSession(client, directory ?? "", `oc-sub ${label} probe`);
    return await deliversSessionCreated(iterator, probeId, timeoutMs);
  } finally {
    await iterator.return(undefined);
  }
}

test.skipIf(!hasOpencode)(
  "up, create session without prompt, status, abort, stop the server",
  async () => {
    const port = await findFreePort();
    const workDir = mkdtempSync(path.join(tmpdir(), "oc-sub-it-"));
    const dataDir = path.join(workDir, "data"); // isolate opencode storage
    const stateHome = path.join(workDir, "state"); // isolate the oc-sub state
    const env: Record<string, string> = { ...process.env, XDG_DATA_HOME: dataDir, XDG_STATE_HOME: stateHome } as Record<
      string,
      string
    >;
    const pidFile = path.join(stateHome, "oc-sub", `serve-${port}.pid`);

    try {
      const url = `http://127.0.0.1:${port}`;

      // up: nothing on this port yet, so it starts a server in the background.
      const started = runCli(workDir, ["up", "--url", url, "--port", String(port)], env);
      expect(started.code).toBe(0);
      expect(started.stdout).toContain(url);
      expect(started.stdout).toMatch(/version \S+/);
      expect(existsSync(pidFile)).toBe(true);
      const pid = Number(readFileSync(pidFile, "utf8").trim());

      // up again: the server is healthy, so nothing new is started.
      const again = runCli(workDir, ["up", "--url", url], env);
      expect(again.code).toBe(0);
      expect(again.stdout).toContain(url);

      // Create a session directly over the SDK. No prompt is sent, so no
      // model is called and the run costs nothing.
      const client = createOpencodeClient({ baseUrl: url });
      const sessionId = await makeSession(client, workDir, "oc-sub integration test");

      // status lists the session as idle with its title.
      const listed = runCli(workDir, ["status", "--url", url, "--dir", workDir], env);
      expect(listed.code).toBe(0);
      const lines = listed.stdout.trim().split("\n").filter((line) => line.length > 0);
      expect(lines.some((line) => line === `${sessionId} idle oc-sub integration test`)).toBe(true);

      // abort the (idle) session.
      const aborted = runCli(workDir, ["abort", sessionId, "--url", url, "--dir", workDir], env);
      expect(aborted.code).toBe(0);
      expect(aborted.stdout).toContain(`aborted ${sessionId}`);

      // A quiet session in a DIFFERENT directory than the server default:
      // watch must end with a summary. The status map lists only sessions
      // that are not idle, and this session has no messages, so watch ends
      // after the quiet grace time (see src/settled.ts).
      const otherDir = mkdtempSync(path.join(tmpdir(), "oc-sub-it-other-"));
      try {
        const watchSessionId = await makeSession(client, otherDir, "oc-sub watch test");

        // Does the event stream need the directory query to carry events of a
        // session in another directory? The scoped stream is what watch uses,
        // so its delivery is asserted; the plain stream is informational.
        const withDirectory = await probeStream(client, "scoped", otherDir, 10_000);
        expect(withDirectory).toBe(true);
        const withoutDirectory = await probeStream(client, "plain", undefined, 10_000);
        console.log(
          `/event delivered other-directory session.created events: with directory query=${withDirectory}, without=${withoutDirectory}`,
        );

        const watched = runCli(workDir, ["watch", watchSessionId, "--url", url, "--dir", otherDir], env);
        expect(watched.code).toBe(0);
        expect(watched.stdout.trim()).toMatch(
          /^idle after \d+m\d\d?s, 0 tool calls, cost \$0\.0000, tokens in 0, out 0, reasoning 0, cache read 0, cache write 0$/,
        );
        expect(watched.stderr).toBe("");

        const abortedWatch = runCli(workDir, ["abort", watchSessionId, "--url", url, "--dir", otherDir], env);
        expect(abortedWatch.code).toBe(0);
      } finally {
        rmSync(otherDir, { recursive: true, force: true });
      }

      // restart: stops the server and starts a new one on the same port.
      const restarted = runCli(workDir, ["restart", "--url", url], env);
      expect(restarted.stderr).toBe("");
      expect(restarted.code).toBe(0);
      expect(restarted.stdout).toContain(`stopped ${url} (PID ${pid})`);
      expect(await waitUntilGone(pid)).toBe(true);
      const newPid = Number(readFileSync(pidFile, "utf8").trim());
      expect(newPid).not.toBe(pid);

      // down: stops the server and removes the PID file.
      const stopped = runCli(workDir, ["down", "--url", url], env);
      expect(stopped.stderr).toBe("");
      expect(stopped.code).toBe(0);
      expect(stopped.stdout).toContain(`stopped ${url} (PID ${newPid})`);
      expect(await waitUntilGone(newPid)).toBe(true);
      expect(existsSync(pidFile)).toBe(false);

      // down again: nothing runs, so it only says so.
      const noServer = runCli(workDir, ["down", "--url", url], env);
      expect(noServer.code).toBe(0);
      expect(noServer.stdout).toContain(`no server on ${url}`);
    } finally {
      // Make sure no server survives the test.
      if (existsSync(pidFile)) {
        const pid = Number(readFileSync(pidFile, "utf8").trim());
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
      rmSync(workDir, { recursive: true, force: true });
    }
  },
  { timeout: 180_000 },
);
