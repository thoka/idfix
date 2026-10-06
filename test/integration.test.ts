/**
 * Integration test: runs against a real `opencode serve` on a free port from
 * 8790 upward. It exercises `up`, creates sessions over the SDK (without
 * sending any prompt, so no model is called and nothing costs money), checks
 * `status`, runs `watch` on an already finished session, runs `abort`, and
 * stops the server with `restart` and `down`. Skipped when the `opencode` command is not on the
 * PATH.
 *
 * `up` starts the server and the restart loop of the cost proxy detached,
 * each in its own process group. The teardown of each test kills both
 * groups (`stopStartedGroups`), also when the test failed before `down`.
 * The last test checks that no group of these tests is left.
 */
import { expect, test } from "bun:test";
import { createOpencodeClient, type Event, type OpencodeClient } from "@opencode-ai/sdk";
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { stopStartedGroups } from "../src/down";
import { proxyPidPath, servePidPath } from "../src/state";
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

/** The process groups (server and proxy loop) that the tests started. */
const startedGroups = new Set<number>();

/** Records the groups of the server on `port` and of its proxy, as their PID files name them. */
function recordGroups(env: Record<string, string>, port: number): void {
  for (const file of [servePidPath(env, port), proxyPidPath(env, port)]) {
    if (!existsSync(file)) continue;
    const pid = Number(readFileSync(file, "utf8").trim());
    if (Number.isInteger(pid) && pid > 0) startedGroups.add(pid);
  }
}

/**
 * The teardown of a test: kills the whole process groups of the server and
 * of the proxy restart loop. Killing only the server PID leaves the loop,
 * and the loop then starts the proxy again forever.
 */
async function killStarted(env: Record<string, string>, port: number): Promise<void> {
  recordGroups(env, port);
  await stopStartedGroups(env, port, "SIGKILL");
}

function groupExists(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
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
    // The fast health checks of `up` and `restart` warn without AGENTS.md,
    // and the test asserts that stderr stays empty.
    writeFileSync(path.join(workDir, "AGENTS.md"), "# rules\n");
    const dataDir = path.join(workDir, "data"); // isolate opencode storage
    const stateHome = path.join(workDir, "state"); // isolate the oc-sub state
    // The outer shell may set OPENCODE_CONFIG_DIR (for example to another
    // checkout of this plugin). Drop it, so that `up` serves the agents of
    // this checkout and prints no warning.
    const { OPENCODE_CONFIG_DIR: _outer, ...baseEnv } = process.env as Record<string, string | undefined>;
    const env: Record<string, string> = { ...baseEnv, XDG_DATA_HOME: dataDir, XDG_STATE_HOME: stateHome } as Record<
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
      recordGroups(env, port);

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
        // Without a run record, watch prints the unknown real cost after the summary.
        expect(watched.stdout.trim()).toMatch(
          /^idle after \d+m\d\d?s, 0 tool calls, cost \$0\.0000, tokens in 0, out 0, reasoning 0, cache read 0, cache write 0\nreal cost: unknown \(no key usage at the start of the run\)$/,
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
      recordGroups(env, port);

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

      // status without a server: a normal state, so no error.
      const statusDown = runCli(workDir, ["status", "--url", url], env);
      expect(statusDown.code).toBe(0);
      expect(statusDown.stdout.trim()).toBe(`no server on ${url}`);
      expect(statusDown.stderr).toBe("");

      // log without a server: an error with a clear message.
      const logDown = runCli(workDir, ["log", "ses_missing", "--url", url], env);
      expect(logDown.code).toBe(1);
      expect(logDown.stderr).toContain(`no server on ${url}. Start it with: oc-sub up`);
    } finally {
      // Make sure no server and no proxy loop survives the test.
      await killStarted(env, port);
      rmSync(workDir, { recursive: true, force: true });
    }
  },
  { timeout: 180_000 },
);

test.skipIf(!hasOpencode)(
  "pending question and permission lists and answer against a server without pending requests",
  async () => {
    // A real pending question needs an agent that calls the question tool,
    // and that needs a model call. This test therefore checks the list
    // endpoints and the answer command against a server with no pending
    // requests. The pause-and-answer flow itself is covered by the fake
    // server tests in test/watch-pending.test.ts and test/answer.test.ts.
    const port = await findFreePort();
    const workDir = mkdtempSync(path.join(tmpdir(), "oc-sub-it-questions-"));
    const dataDir = path.join(workDir, "data");
    const stateHome = path.join(workDir, "state");
    const { OPENCODE_CONFIG_DIR: _outer, ...baseEnv } = process.env as Record<string, string | undefined>;
    const env: Record<string, string> = {
      ...baseEnv,
      XDG_DATA_HOME: dataDir,
      XDG_STATE_HOME: stateHome,
    } as Record<string, string>;
    const url = `http://127.0.0.1:${port}`;
    const pidFile = path.join(stateHome, "oc-sub", `serve-${port}.pid`);

    try {
      const started = runCli(workDir, ["up", "--url", url], env);
      expect(started.code).toBe(0);
      recordGroups(env, port);

      // The pending lists of a real 1.18.x server answer with an empty
      // array. This checks that the routes exist and that they accept the
      // directory query.
      const scopedQuestions = await fetch(`${url}/question?directory=${encodeURIComponent(workDir)}`);
      expect(scopedQuestions.status).toBe(200);
      expect(await scopedQuestions.json()).toEqual([]);
      const scopedPermissions = await fetch(`${url}/permission?directory=${encodeURIComponent(workDir)}`);
      expect(scopedPermissions.status).toBe(200);
      expect(await scopedPermissions.json()).toEqual([]);
      const unscopedQuestions = await fetch(`${url}/question`);
      expect(unscopedQuestions.status).toBe(200);
      expect(await unscopedQuestions.json()).toEqual([]);

      // answer: an unknown request ID stops with a clear error.
      const answered = runCli(workDir, ["answer", "que_missing", "--url", url, "--dir", workDir, "--reject"], env);
      expect(answered.code).toBe(1);
      expect(answered.stderr).toContain("no pending request que_missing");

      // Usage errors exit with code 2.
      const badReply = runCli(workDir, ["answer", "que_missing", "--url", url, "--reply", "sometimes"], env);
      expect(badReply.code).toBe(2);
      const noReply = runCli(workDir, ["answer", "que_missing", "--url", url], env);
      expect(noReply.code).toBe(2);

      const stopped = runCli(workDir, ["down", "--url", url], env);
      expect(stopped.code).toBe(0);
    } finally {
      // Make sure no server and no proxy loop survives the test.
      await killStarted(env, port);
      rmSync(workDir, { recursive: true, force: true });
    }
  },
  { timeout: 120_000 },
);

test.skipIf(!hasOpencode)(
  "a server with a password: a wrong password gives a clear error",
  async () => {
    const port = await findFreePort();
    const workDir = mkdtempSync(path.join(tmpdir(), "oc-sub-it-auth-"));
    const stateHome = path.join(workDir, "state");
    const base = { ...process.env, XDG_DATA_HOME: path.join(workDir, "data"), XDG_STATE_HOME: stateHome } as Record<
      string,
      string
    >;
    delete base.OPENCODE_SERVER_USERNAME;
    const right = { ...base, OPENCODE_SERVER_PASSWORD: "right-test-password" };
    const wrong = { ...base, OPENCODE_SERVER_PASSWORD: "wrong-test-password" };
    const none = { ...base };
    delete none.OPENCODE_SERVER_PASSWORD;
    const url = `http://127.0.0.1:${port}`;
    const pidFile = path.join(stateHome, "oc-sub", `serve-${port}.pid`);

    try {
      const started = runCli(workDir, ["up", "--url", url], right);
      expect(started.code).toBe(0);
      recordGroups(right, port);

      const wrongStatus = runCli(workDir, ["status", "--url", url], wrong);
      expect(wrongStatus.code).toBe(1);
      expect(wrongStatus.stderr).toContain(`the server on ${url} rejected the password in OPENCODE_SERVER_PASSWORD`);
      expect(wrongStatus.stderr).not.toContain("wrong-test-password");

      const noPassword = runCli(workDir, ["status", "--url", url], none);
      expect(noPassword.code).toBe(1);
      expect(noPassword.stderr).toContain(`the server on ${url} needs a password`);

      // up with a wrong password must not start a second server.
      const wrongUp = runCli(workDir, ["up", "--url", url], wrong);
      expect(wrongUp.code).toBe(1);
      expect(wrongUp.stderr).toContain("rejected the password");

      const stopped = runCli(workDir, ["down", "--url", url], right);
      expect(stopped.code).toBe(0);
      expect(existsSync(pidFile)).toBe(false);
    } finally {
      await killStarted(right, port);
      rmSync(workDir, { recursive: true, force: true });
    }
  },
  { timeout: 120_000 },
);

test.skipIf(!hasOpencode)(
  "a test that ends without down: the teardown still stops the server and the proxy loop",
  async () => {
    // This is the path of a failed test: no `down` runs, only the teardown.
    const port = await findFreePort();
    const workDir = mkdtempSync(path.join(tmpdir(), "oc-sub-it-nodown-"));
    const env = {
      ...process.env,
      XDG_DATA_HOME: path.join(workDir, "data"),
      XDG_STATE_HOME: path.join(workDir, "state"),
    } as Record<string, string>;
    try {
      const started = runCli(workDir, ["up", "--url", `http://127.0.0.1:${port}`], env);
      expect(started.code).toBe(0);
      recordGroups(env, port);
      // With bun on the PATH, up also starts the proxy loop.
      expect(existsSync(proxyPidPath(env, port))).toBe(Bun.which("bun") !== null);
    } finally {
      await killStarted(env, port);
      rmSync(workDir, { recursive: true, force: true });
    }
  },
  { timeout: 120_000 },
);

// Runs last: bun runs the tests of a file in order.
test.skipIf(!hasOpencode)("no process of the integration tests outlives its teardown", async () => {
  // Each test starts a server and, with bun on the PATH, a proxy loop.
  expect(startedGroups.size).toBeGreaterThan(0);
  const deadline = Date.now() + 5_000;
  let left = [...startedGroups].filter(groupExists);
  while (left.length > 0 && Date.now() < deadline) {
    await Bun.sleep(100);
    left = left.filter(groupExists);
  }
  const lines = left.map((pgid) => Bun.spawnSync(["ps", "-o", "pid=,args=", "-g", String(pgid)]).stdout.toString().trim());
  expect(lines).toEqual([]);
}, { timeout: 15_000 });
