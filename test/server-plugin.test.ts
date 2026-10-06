import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { findRunningServers, restartServer, type RestartDeps, type RunningServer } from "../src/server-plugin";
import { serveDirsPath, servePidPath, servePluginPath } from "../src/state";

function makeEnv(): Record<string, string> {
  const env = { XDG_STATE_HOME: mkdtempSync(path.join(tmpdir(), "oc-sub-server-plugin-")) };
  mkdirSync(path.join(env.XDG_STATE_HOME, "oc-sub"), { recursive: true });
  return env;
}

const SANDBOX = { name: "oc-sub-repo", root: "/repo", port: 18768 };
const HOST_CMD = "opencode serve --port 8767 --hostname 127.0.0.1";
const HOLDER_CMD = "sbx exec -e OPENCODE_CONFIG_DIR=/d/opencode oc-sub-repo sh -c loop";

describe("findRunningServers", () => {
  test("finds the host server and the sandbox server with their digests", () => {
    const env = makeEnv();
    writeFileSync(servePidPath(env, 8767), "100\n");
    writeFileSync(servePluginPath(env, 8767), "sha256:host\n");
    writeFileSync(servePidPath(env, 18768), "200\n");
    writeFileSync(servePluginPath(env, 18768), "sha256:sandbox\n");
    const commandLine = (pid: number) => (pid === 100 ? HOST_CMD : pid === 200 ? HOLDER_CMD : null);
    expect(findRunningServers(env, SANDBOX, commandLine)).toEqual([
      { mode: "host", port: 8767, url: "http://127.0.0.1:8767", digest: "sha256:host" },
      { mode: "sandbox", port: 18768, url: "http://127.0.0.1:18768", root: "/repo", name: "oc-sub-repo", digest: "sha256:sandbox" },
    ]);
  });

  test("a server without a plugin record has the digest null", () => {
    const env = makeEnv();
    writeFileSync(servePidPath(env, 8767), "100\n");
    expect(findRunningServers(env, null, () => HOST_CMD)).toEqual([
      { mode: "host", port: 8767, url: "http://127.0.0.1:8767", digest: null },
    ]);
  });

  test("skips a stale PID file and a PID of another process", () => {
    const env = makeEnv();
    writeFileSync(servePidPath(env, 8767), "100\n");
    writeFileSync(servePidPath(env, 18768), "200\n");
    // PID 100 is gone, and PID 200 now belongs to another program.
    const commandLine = (pid: number) => (pid === 200 ? "vim notes.md" : null);
    expect(findRunningServers(env, SANDBOX, commandLine)).toEqual([]);
  });

  test("a bad OPENCODE_SERVER_URL skips the host server instead of throwing", () => {
    const env = { ...makeEnv(), OPENCODE_SERVER_URL: "not a url" };
    writeFileSync(servePidPath(env, 18768), "200\n");
    expect(findRunningServers(env, SANDBOX, () => HOLDER_CMD).map((server) => server.mode)).toEqual(["sandbox"]);
  });

  test("finds nothing without PID files", () => {
    expect(findRunningServers(makeEnv(), SANDBOX, () => HOST_CMD)).toEqual([]);
  });
});

describe("restartServer", () => {
  const host: RunningServer = { mode: "host", port: 8767, url: "http://127.0.0.1:8767", digest: "sha256:old" };
  const sandbox: RunningServer = { mode: "sandbox", port: 18768, url: "http://127.0.0.1:18768", root: "/repo", name: "oc-sub-repo", digest: "sha256:old" };

  function fakeDeps(overrides: Partial<RestartDeps> = {}): { deps: RestartDeps; calls: string[] } {
    const calls: string[] = [];
    const deps: RestartDeps = {
      probe: async () => ({ state: "up", version: "1.18.32" }),
      busySessions: async () => [],
      down: async (port) => {
        calls.push(`down ${port}`);
        return 0;
      },
      up: async (port) => {
        calls.push(`up ${port}`);
        return 0;
      },
      downSandbox: async (root) => {
        calls.push(`downSandbox ${root}`);
        return 0;
      },
      upSandbox: async (root) => {
        calls.push(`upSandbox ${root}`);
        return 0;
      },
      sandboxMissingMounts: () => [],
      ...overrides,
    };
    return { deps, calls };
  }

  test("restarts an idle host server with down and up on its port", async () => {
    const { deps, calls } = fakeDeps();
    expect(await restartServer(host, makeEnv(), deps)).toEqual({ ok: true, note: "restarted the host server :8767" });
    expect(calls).toEqual(["down 8767", "up 8767"]);
  });

  test("restarts an idle sandbox server with the sandbox forms on its root", async () => {
    const { deps, calls } = fakeDeps();
    const outcome = await restartServer(sandbox, makeEnv(), deps);
    expect(outcome.ok).toBe(true);
    expect(calls).toEqual(["downSandbox /repo", "upSandbox /repo"]);
  });

  test("never stops an old sandbox that lacks the synced plugin mount", async () => {
    const seen: string[] = [];
    const { deps, calls } = fakeDeps({
      sandboxMissingMounts: (name, root) => {
        seen.push(`${name} ${root}`);
        return ["/home/user/.local/share/oc-sub/opencode:ro"];
      },
      probe: async () => {
        calls.push("probe");
        return { state: "up", version: "1.18.32" };
      },
    });
    const outcome = await restartServer(sandbox, makeEnv(), deps);
    expect(outcome.ok).toBe(false);
    expect(outcome.note).toContain("lacks the mounts /home/user/.local/share/oc-sub/opencode:ro");
    expect(outcome.note).toContain("recreate first (step 15d)");
    expect(outcome.note).toContain("sbx rm --force oc-sub-repo");
    expect(seen).toEqual(["oc-sub-repo /repo"]);
    // Nothing else ran: no probe, no down, no up.
    expect(calls).toEqual([]);
  });

  test("a host server whose up fails after the down reports ok=false", async () => {
    const { deps, calls } = fakeDeps({
      up: async () => {
        calls.push("up");
        return 1;
      },
    });
    const outcome = await restartServer(host, makeEnv(), deps);
    expect(outcome).toEqual({ ok: false, note: "host server :8767: oc-sub up failed with code 1" });
    expect(calls).toEqual(["down 8767", "up"]);
  });

  test("does not restart a busy server and names oc-sub abort and oc-sub down", async () => {
    const env = makeEnv();
    writeFileSync(serveDirsPath(env, 8767), "/repo\n");
    let dirsSeen: readonly string[] = [];
    const { deps, calls } = fakeDeps({
      busySessions: async (_url, dirs) => {
        dirsSeen = dirs;
        return [{ directory: "/repo", id: "ses_1", state: "busy" }];
      },
    });
    const outcome = await restartServer(host, env, deps);
    expect(outcome.ok).toBe(false);
    expect(outcome.note).toContain("host server :8767 is busy, not restarted: busy ses_1 /repo");
    expect(outcome.note).toContain("oc-sub abort or oc-sub down");
    expect(dirsSeen).toEqual(["/repo"]);
    expect(calls).toEqual([]);
  });

  test("does not restart a server that refuses the credentials", async () => {
    const { deps, calls } = fakeDeps({ probe: async () => ({ state: "unauthorized" }) });
    const outcome = await restartServer(host, makeEnv(), deps);
    expect(outcome.ok).toBe(false);
    expect(outcome.note).toContain("refused the credentials");
    expect(calls).toEqual([]);
  });

  test("a failed down stops the restart before up", async () => {
    const { deps, calls } = fakeDeps({
      down: async () => {
        calls.push("down");
        return 1;
      },
    });
    const outcome = await restartServer(host, makeEnv(), deps);
    expect(outcome).toEqual({ ok: false, note: "host server :8767: oc-sub down failed with code 1" });
    expect(calls).toEqual(["down"]);
  });

  test("the output of down and up goes to stderr, so --json keeps stdout clean", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation((line) => out.push(String(line)));
    const errorSpy = spyOn(console, "error").mockImplementation((line) => err.push(String(line)));
    try {
      const { deps } = fakeDeps({
        up: async () => {
          console.log("http://127.0.0.1:8767 version 1.18.32");
          return 0;
        },
      });
      await restartServer(host, makeEnv(), deps);
      console.log("after");
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
    expect(err).toEqual(["http://127.0.0.1:8767 version 1.18.32"]);
    expect(out).toEqual(["after"]);
  });
});
