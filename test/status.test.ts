import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  cloneDirectories,
  defaultClaudeRows,
  displayFolder,
  formatStatusLine,
  parseWorktreeList,
  projectDirectories,
  serverDirectories,
  sessionState,
  status,
  uniqueDirectories,
  worktreesOf,
  type StatusDeps,
} from "../src/status";
import type { Runner } from "../src/sandbox";
import { parsePriceFile } from "../src/claude/prices";
import { createClaudeSource, loadClaudeRows } from "../src/claude/rows";
import { FIXTURE_DIR, FIXTURE_ROOT, fixtureFs, MINUTE, NOW, S1, S2, S5, S7 } from "./claude-fixture";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { conditionEvent, EVENTS_FILE } from "../src/watch/log";
import { TRUE_SEVERITY } from "../src/watch/conditions";

const DIR = "/repo";

function captureLog(): { lines: string[]; errors: string[]; restore: () => void } {
  const lines: string[] = [];
  const errors: string[] = [];
  const logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map((part) => String(part)).join(" "));
  });
  const errorSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.map((part) => String(part)).join(" "));
  });
  return {
    lines,
    errors,
    restore: () => {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    },
  };
}

type FakeSession = { id: string; directory: string; title: string; parentID?: string };

type FakeServer = { url: string; port: number; stop: () => void };

/** A fake opencode server for /global/health, /session, /session/status, /project, and the pending lists. */
function startFakeServer(options: {
  sessions?: FakeSession[];
  states?: Record<string, { type: string }>;
  projects?: Array<{ id: string; worktree: string }>;
  questions?: Array<Record<string, unknown>>;
  permissions?: Array<Record<string, unknown>>;
  /** Directories whose session listing fails, as a broken project does. */
  brokenDirectories?: string[];
  /** The project listing fails, as a broken server does. */
  brokenProjects?: boolean;
}): FakeServer {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/global/health") return Response.json({ healthy: true, version: "1.0.0" });
      if (url.pathname === "/project") {
        if (options.brokenProjects === true) return Response.json({ message: "boom" }, { status: 500 });
        return Response.json(options.projects ?? []);
      }
      if (url.pathname === "/question") return Response.json(options.questions ?? []);
      if (url.pathname === "/permission") return Response.json(options.permissions ?? []);
      const directory = url.searchParams.get("directory") ?? "";
      if (url.pathname === "/session" || url.pathname === "/session/status") {
        if (options.brokenDirectories?.includes(directory)) {
          return Response.json(
            { name: "Error", data: { message: 'bad file reference: "{file:~/.config/p/openrouter.key}"' } },
            { status: 500 },
          );
        }
      }
      if (url.pathname === "/session") {
        return Response.json(options.sessions?.filter((session) => session.directory === directory) ?? []);
      }
      if (url.pathname === "/session/status") {
        const map: Record<string, unknown> = {};
        for (const session of options.sessions ?? []) {
          const state = options.states?.[session.id];
          if (session.directory === directory && state !== undefined) map[session.id] = state;
        }
        return Response.json(map);
      }
      return new Response("not found", { status: 404 });
    },
  });
  const url = `http://127.0.0.1:${server.port}`;
  return { url, port: Number(new URL(url).port), stop: () => server.stop(true) };
}

const testDeps: StatusDeps = {
  worktreesOf: (directory) => [directory],
  exists: () => true,
  // The sandbox servers of the tests serve their root as the only folder.
  cloneDirectoriesOf: (project) => (project === "sbx" ? ["/sbxproj"] : project === "dup" ? ["/proj"] : []),
};

async function runStatus(options: {
  server: FakeServer;
  dir?: string;
  all?: boolean;
  json?: boolean;
  deps?: Partial<StatusDeps>;
  env?: Record<string, string | undefined>;
}): Promise<{ code: number; lines: string[]; errors: string[] }> {
  const captured = captureLog();
  try {
    const code = await status(
      { url: options.server.url, dir: options.dir, all: options.all ?? false, json: options.json },
      options.env ?? {},
      { ...testDeps, ...options.deps },
    );
    return { code, lines: captured.lines, errors: captured.errors };
  } finally {
    captured.restore();
  }
}

/** The single JSON document of a JSON-mode run, parsed from the whole stdout. */
function parseJsonStdout(lines: string[]): unknown {
  return JSON.parse(lines.join("\n"));
}

/** The `items` of the snapshot object of a JSON-mode run. The whole stdout must be the one object. */
function parseItems(lines: string[]): unknown[] {
  const snapshot = parseJsonStdout(lines) as { tool?: unknown; items?: unknown };
  expect(snapshot.tool).toBe("idfx");
  expect(Array.isArray(snapshot.items)).toBe(true);
  return snapshot.items as unknown[];
}

describe("parseWorktreeList", () => {
  test("reads the worktree lines of the porcelain output", () => {
    const porcelain = [
      "worktree /repo",
      "HEAD 0123456789abcdef0123456789abcdef01234567",
      "branch refs/heads/main",
      "",
      "worktree /repo/.worktrees/x",
      "HEAD abcdef0123456789abcdef0123456789abcdef01",
      "branch refs/heads/feature",
      "",
    ].join("\n");
    expect(parseWorktreeList(porcelain)).toEqual(["/repo", "/repo/.worktrees/x"]);
  });

  test("reads a bare repository and a detached worktree", () => {
    const porcelain = [
      "worktree /repo.git",
      "bare",
      "",
      "worktree /repo/.worktrees/detached",
      "HEAD 0123456789abcdef0123456789abcdef01234567",
      "detached",
      "",
    ].join("\n");
    expect(parseWorktreeList(porcelain)).toEqual(["/repo.git", "/repo/.worktrees/detached"]);
  });

  test("keeps a path with a space whole", () => {
    expect(parseWorktreeList("worktree /home/user/my repo/.worktrees/wt one\n")).toEqual([
      "/home/user/my repo/.worktrees/wt one",
    ]);
  });

  test("returns no paths without a worktree line", () => {
    expect(parseWorktreeList("")).toEqual([]);
    expect(parseWorktreeList("HEAD abc\nbranch refs/heads/main\n")).toEqual([]);
  });
});

describe("uniqueDirectories", () => {
  test("keeps the first occurrence and the order", () => {
    expect(uniqueDirectories(["/b", "/a", "/b", "/c", "/a"])).toEqual(["/b", "/a", "/c"]);
  });

  test("returns an empty list for no input", () => {
    expect(uniqueDirectories([])).toEqual([]);
  });
});

describe("displayFolder", () => {
  test("shows a folder inside the directory relative to it", () => {
    expect(displayFolder("/repo/.worktrees/x", "/repo")).toBe(".worktrees/x");
  });

  test("shows a folder outside the directory absolute", () => {
    expect(displayFolder("/other", "/repo")).toBe("/other");
  });

  test("shows the directory itself absolute", () => {
    expect(displayFolder("/repo", "/repo")).toBe("/repo");
  });
});

describe("formatStatusLine", () => {
  test("keeps the plain format for a session of the directory itself", () => {
    expect(formatStatusLine("ses_1", "busy", "Title")).toBe("ses_1 busy Title");
  });

  test("appends the folder of another worktree", () => {
    expect(formatStatusLine("ses_1", "idle", "Title", ".worktrees/x")).toBe("ses_1 idle Title (.worktrees/x)");
  });
});

describe("worktreesOf", () => {
  function spawnResult(exitCode: number, stdout: string): ReturnType<typeof Bun.spawnSync> {
    return { exitCode, stdout: Buffer.from(stdout) } as unknown as ReturnType<typeof Bun.spawnSync>;
  }

  function spyGit(output: string, exitCode = 0) {
    return spyOn(Bun, "spawnSync").mockImplementation(
      (() => spawnResult(exitCode, output)) as unknown as typeof Bun.spawnSync,
    );
  }

  test("returns only the directory when git fails", () => {
    const spy = spyGit("", 128);
    try {
      expect(worktreesOf("/repo")).toEqual(["/repo"]);
    } finally {
      spy.mockRestore();
    }
  });

  test("returns the directory first, then its worktrees without duplicates", () => {
    const spy = spyGit("worktree /repo\n\nworktree /repo/.worktrees/x\n\nworktree /repo/.worktrees/x\n");
    try {
      expect(worktreesOf("/repo")).toEqual(["/repo", "/repo/.worktrees/x"]);
    } finally {
      spy.mockRestore();
    }
  });

  test("puts the directory first when git lists the main worktree before it", () => {
    const spy = spyGit("worktree /main\n\nworktree /main/.worktrees/x\n\nworktree /main/.worktrees/status\n");
    try {
      expect(worktreesOf("/main/.worktrees/status")).toEqual([
        "/main/.worktrees/status",
        "/main",
        "/main/.worktrees/x",
      ]);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("cloneDirectories", () => {
  const porcelain = "worktree /repo\n\nworktree /repo/.worktrees/x\n\n";

  function runnerFor(result: { stdout: string; exitCode: number }): Runner {
    return (cmd) => {
      (runnerFor as unknown as { lastCmd: readonly string[] }).lastCmd = cmd;
      return result;
    };
  }

  test("lists the root first, then the worktrees of the clone, through sbx exec", () => {
    const stateHome = mkdtempSync(path.join(tmpdir(), "oc-sub-status-clone-"));
    try {
      const stateFile = path.join(stateHome, "idfx", "sandbox-proj.json");
      mkdirSync(path.dirname(stateFile), { recursive: true });
      writeFileSync(stateFile, JSON.stringify({ name: "oc-sub-proj", root: "/repo", port: 18768 }));
      let cmd: readonly string[] = [];
      const runner: Runner = (call) => {
        cmd = call;
        return { stdout: porcelain, exitCode: 0 };
      };
      const dirs = cloneDirectories("proj", { XDG_STATE_HOME: stateHome }, runner);
      expect(cmd).toEqual(["sbx", "exec", "oc-sub-proj", "git", "-C", "/repo", "worktree", "list", "--porcelain"]);
      expect(dirs).toEqual(["/repo", "/repo/.worktrees/x"]);
    } finally {
      rmSync(stateHome, { recursive: true, force: true });
    }
  });

  test("returns an empty list when the command fails, for example a stopped sandbox", () => {
    const stateHome = mkdtempSync(path.join(tmpdir(), "oc-sub-status-clone-"));
    try {
      const stateFile = path.join(stateHome, "idfx", "sandbox-proj.json");
      mkdirSync(path.dirname(stateFile), { recursive: true });
      writeFileSync(stateFile, JSON.stringify({ name: "oc-sub-proj", root: "/repo", port: 18768 }));
      expect(cloneDirectories("proj", { XDG_STATE_HOME: stateHome }, runnerFor({ stdout: "", exitCode: 1 }))).toEqual(
        [],
      );
      // Without a state file the list is empty as well.
      expect(cloneDirectories("other", { XDG_STATE_HOME: stateHome }, runnerFor({ stdout: "", exitCode: 0 }))).toEqual(
        [],
      );
    } finally {
      rmSync(stateHome, { recursive: true, force: true });
    }
  });
});

describe("serverDirectories", () => {
  test("a sandbox server lists the clone directories without the host filters", async () => {
    const stateHome = mkdtempSync(path.join(tmpdir(), "oc-sub-status-dirs-"));
    const server = startFakeServer({
      sessions: [{ id: "ses_sbx", directory: "/repo/.worktrees/x", title: "Clone run" }],
      states: { ses_sbx: { type: "busy" } },
      projects: [{ id: "p1", worktree: "/repo" }],
    });
    try {
      const stateFile = path.join(stateHome, "idfx", "sandbox-sbx.json");
      mkdirSync(path.dirname(stateFile), { recursive: true });
      writeFileSync(stateFile, JSON.stringify({ name: "oc-sub-sbx", root: "/repo", port: server.port }));
      const calls: string[] = [];
      const deps: StatusDeps = {
        worktreesOf: (directory) => {
          calls.push(`worktreesOf ${directory}`);
          return [directory];
        },
        exists: (file) => {
          calls.push(`exists ${file}`);
          return false;
        },
        cloneDirectoriesOf: (project) => {
          calls.push(`cloneDirectoriesOf ${project}`);
          return ["/repo", "/repo/.worktrees/x"];
        },
      };
      const dirs = await serverDirectories(server.url, { XDG_STATE_HOME: stateHome }, deps);
      expect(dirs).toEqual(["/repo", "/repo/.worktrees/x"]);
      // No host git and no host exists filter for a sandbox server.
      expect(calls).toEqual(["cloneDirectoriesOf sbx"]);
    } finally {
      server.stop();
      rmSync(stateHome, { recursive: true, force: true });
    }
  });
});

describe("sessionState", () => {
  test("shows a busy session with a pending request as waiting", () => {
    expect(sessionState("busy", new Set(["ses_1"]), "ses_1")).toBe("waiting");
  });

  test("keeps busy, retry, and idle as they are", () => {
    expect(sessionState("busy", new Set(), "ses_1")).toBe("busy");
    expect(sessionState("retry", new Set(["ses_1"]), "ses_1")).toBe("retry");
    expect(sessionState(undefined, new Set(["ses_1"]), "ses_1")).toBe("idle");
  });
});

describe("status", () => {
  test("lists the sessions of the directory without a folder suffix", async () => {
    const server = startFakeServer({ sessions: [{ id: "ses_root", directory: DIR, title: "Root run" }] });
    try {
      const { code, lines } = await runStatus({ server, dir: DIR, deps: { worktreesOf: () => [DIR] } });
      expect(code).toBe(0);
      expect(lines).toEqual(["ses_root idle Root run"]);
    } finally {
      server.stop();
    }
  });

  test("shows a busy session with a pending question as waiting", async () => {
    const server = startFakeServer({
      sessions: [
        { id: "ses_wait", directory: DIR, title: "Waiting run" },
        { id: "ses_busy", directory: DIR, title: "Busy run" },
      ],
      states: { ses_wait: { type: "busy" }, ses_busy: { type: "busy" } },
      questions: [{ id: "que_1", sessionID: "ses_wait", questions: [] }],
    });
    try {
      const { code, lines } = await runStatus({ server, dir: DIR, deps: { worktreesOf: () => [DIR] } });
      expect(code).toBe(0);
      expect(lines).toEqual(["ses_wait waiting Waiting run", "ses_busy busy Busy run"]);
    } finally {
      server.stop();
    }
  });

  test("lists the sessions of its worktrees with their folder, and skips child sessions", async () => {
    const server = startFakeServer({
      sessions: [
        { id: "ses_root", directory: DIR, title: "Root run" },
        { id: "ses_wt", directory: `${DIR}/.worktrees/x`, title: "Worktree run" },
        { id: "ses_out", directory: "/other-place", title: "Outside run" },
        { id: "ses_child", directory: `${DIR}/.worktrees/x`, title: "Child run", parentID: "ses_wt" },
      ],
      states: { ses_wt: { type: "busy" }, ses_out: { type: "retry" }, ses_child: { type: "busy" } },
    });
    try {
      const { code, lines } = await runStatus({
        server,
        dir: DIR,
        deps: { worktreesOf: () => [DIR, `${DIR}/.worktrees/x`, "/other-place"] },
      });
      expect(code).toBe(0);
      expect(lines).toEqual([
        "ses_root idle Root run",
        "ses_wt busy Worktree run (.worktrees/x)",
        "ses_out retry Outside run (/other-place)",
      ]);
    } finally {
      server.stop();
    }
  });

  test("lists the clone directories when --dir is a run folder of a sandboxed project", async () => {
    const stateHome = mkdtempSync(path.join(tmpdir(), "oc-sub-status-run-"));
    const server = startFakeServer({
      sessions: [
        { id: "ses_root", directory: "/repo", title: "Root run" },
        { id: "ses_wt", directory: "/repo/.worktrees/x", title: "Clone run" },
      ],
      states: { ses_wt: { type: "busy" } },
    });
    try {
      const stateFile = path.join(stateHome, "idfx", "sandbox-repo.json");
      mkdirSync(path.dirname(stateFile), { recursive: true });
      writeFileSync(stateFile, JSON.stringify({ name: "oc-sub-repo", root: "/repo", port: server.port }));
      const calls: string[] = [];
      const { code, lines } = await runStatus({
        server,
        dir: "/repo/.worktrees/x",
        env: { XDG_STATE_HOME: stateHome },
        deps: {
          // The run folder exists only inside the sandbox, the root on the host.
          exists: (file) => file === "/repo",
          worktreesOf: (directory) => {
            calls.push(`worktreesOf ${directory}`);
            return [directory];
          },
          cloneDirectoriesOf: (project) => {
            calls.push(`cloneDirectoriesOf ${project}`);
            return ["/repo", "/repo/.worktrees/x"];
          },
        },
      });
      expect(code).toBe(0);
      expect(lines).toEqual(["ses_root idle Root run (/repo)", "ses_wt busy Clone run"]);
      // No host git for a project with a sandbox state file.
      expect(calls).toEqual(["cloneDirectoriesOf repo"]);
    } finally {
      server.stop();
      rmSync(stateHome, { recursive: true, force: true });
    }
  });

  test("prints no server and exits with 0 when nothing answers", async () => {
    const captured = captureLog();
    try {
      const code = await status({ url: "http://127.0.0.1:9", all: false }, {});
      expect(code).toBe(0);
      expect(captured.lines).toEqual(["no server on http://127.0.0.1:9"]);
    } finally {
      captured.restore();
    }
  });

  test("--all lists the running sessions of all sources with absolute folders", async () => {
    const stateHome = mkdtempSync(path.join(tmpdir(), "oc-sub-status-state-"));
    const server = startFakeServer({
      sessions: [
        { id: "ses_dirs", directory: "/from-dirs", title: "Dirs run" },
        { id: "ses_proj", directory: "/proj", title: "Proj run" },
        { id: "ses_wt", directory: "/proj/.worktrees/y", title: "WT run" },
        { id: "ses_idle", directory: "/proj", title: "Idle run" },
        { id: "ses_gone", directory: "/gone", title: "Gone run" },
      ],
      states: {
        ses_dirs: { type: "busy" },
        ses_proj: { type: "busy" },
        ses_wt: { type: "retry" },
        ses_gone: { type: "busy" },
      },
      projects: [
        { id: "p1", worktree: "/proj" },
        { id: "p2", worktree: "/gone" },
        { id: "p3", worktree: "/" },
      ],
    });
    try {
      const dirsFile = path.join(stateHome, "idfx", `serve-${server.port}.dirs`);
      mkdirSync(path.dirname(dirsFile), { recursive: true });
      writeFileSync(dirsFile, "/from-dirs\n/gone\n");
      const { code, lines } = await runStatus({
        server,
        all: true,
        env: { XDG_STATE_HOME: stateHome },
        deps: {
          worktreesOf: (directory) => (directory === "/proj" ? ["/proj", "/proj/.worktrees/y"] : [directory]),
          exists: (file) => file !== "/gone",
        },
      });
      expect(code).toBe(0);
      expect(lines).toEqual([
        "ses_dirs busy Dirs run (/from-dirs)",
        "ses_proj busy Proj run (/proj)",
        "ses_wt retry WT run (/proj/.worktrees/y)",
      ]);
    } finally {
      server.stop();
      rmSync(stateHome, { recursive: true, force: true });
    }
  });

  test("--all lists the running sessions of the host server and a sandbox server", async () => {
    const stateHome = mkdtempSync(path.join(tmpdir(), "oc-sub-status-state-"));
    const host = startFakeServer({
      sessions: [{ id: "ses_host", directory: "/hostproj", title: "Host run" }],
      states: { ses_host: { type: "busy" } },
      projects: [{ id: "p1", worktree: "/hostproj" }],
    });
    const sandbox = startFakeServer({
      sessions: [{ id: "ses_sbx", directory: "/sbxproj", title: "Sandbox run" }],
      states: { ses_sbx: { type: "busy" } },
      projects: [{ id: "p2", worktree: "/sbxproj" }],
    });
    try {
      const stateFile = path.join(stateHome, "idfx", "sandbox-sbx.json");
      mkdirSync(path.dirname(stateFile), { recursive: true });
      writeFileSync(stateFile, JSON.stringify({ name: "oc-sub-sbx", root: "/sbxproj", port: sandbox.port }));
      const captured = captureLog();
      try {
        // No --url: the host server comes from IDFX_URL, the sandbox from
        // its state file.
        const code = await status({ all: true }, { XDG_STATE_HOME: stateHome, IDFX_URL: host.url }, testDeps);
        expect(code).toBe(0);
        expect(captured.lines).toEqual(["ses_host busy Host run (/hostproj)", "ses_sbx busy Sandbox run (/sbxproj)"]);
      } finally {
        captured.restore();
      }
    } finally {
      host.stop();
      sandbox.stop();
      rmSync(stateHome, { recursive: true, force: true });
    }
  });

  test("--all warns about a server whose listing fails and lists the others", async () => {
    const stateHome = mkdtempSync(path.join(tmpdir(), "oc-sub-status-state-"));
    // The host server has the broken project listing. A sandbox server never
    // reads the projects of the server: its folders are the clone directories.
    const broken = startFakeServer({ brokenProjects: true });
    const sandbox = startFakeServer({
      sessions: [{ id: "ses_sbx", directory: "/sbxproj", title: "Sandbox run" }],
      states: { ses_sbx: { type: "busy" } },
      projects: [{ id: "p2", worktree: "/sbxproj" }],
    });
    try {
      const stateFile = path.join(stateHome, "idfx", "sandbox-sbx.json");
      mkdirSync(path.dirname(stateFile), { recursive: true });
      writeFileSync(stateFile, JSON.stringify({ name: "oc-sub-sbx", root: "/sbxproj", port: sandbox.port }));
      const captured = captureLog();
      try {
        const code = await status(
          { all: true },
          { XDG_STATE_HOME: stateHome, IDFX_URL: broken.url },
          { ...testDeps, cloneDirectoriesOf: (project) => (project === "sbx" ? ["/sbxproj"] : []) },
        );
        expect(code).toBe(0);
        expect(captured.lines).toEqual(["ses_sbx busy Sandbox run (/sbxproj)"]);
        expect(captured.errors.join("\n")).toContain(`warning: ${broken.url}:`);
      } finally {
        captured.restore();
      }
    } finally {
      broken.stop();
      sandbox.stop();
      rmSync(stateHome, { recursive: true, force: true });
    }
  });

  test("--all skips a sandbox state file whose port has no server", async () => {
    const stateHome = mkdtempSync(path.join(tmpdir(), "oc-sub-status-state-"));
    const host = startFakeServer({
      sessions: [{ id: "ses_host", directory: "/hostproj", title: "Host run" }],
      states: { ses_host: { type: "busy" } },
      projects: [{ id: "p1", worktree: "/hostproj" }],
    });
    try {
      const stateFile = path.join(stateHome, "idfx", "sandbox-gone.json");
      mkdirSync(path.dirname(stateFile), { recursive: true });
      writeFileSync(stateFile, JSON.stringify({ name: "oc-sub-gone", root: "/gone", port: 18799 }));
      const captured = captureLog();
      try {
        const code = await status({ all: true }, { XDG_STATE_HOME: stateHome, IDFX_URL: host.url }, testDeps);
        expect(code).toBe(0);
        expect(captured.lines).toEqual(["ses_host busy Host run (/hostproj)"]);
        expect(captured.errors).toEqual([]);
      } finally {
        captured.restore();
      }
    } finally {
      host.stop();
      rmSync(stateHome, { recursive: true, force: true });
    }
  });

  test("--all lists a session that two servers share once", async () => {
    const stateHome = mkdtempSync(path.join(tmpdir(), "oc-sub-status-state-"));
    const host = startFakeServer({
      sessions: [{ id: "ses_shared", directory: "/proj", title: "Shared run" }],
      states: { ses_shared: { type: "busy" } },
      projects: [{ id: "p1", worktree: "/proj" }],
    });
    const sandbox = startFakeServer({
      sessions: [{ id: "ses_shared", directory: "/proj", title: "Shared run" }],
      states: { ses_shared: { type: "busy" } },
      projects: [{ id: "p2", worktree: "/proj" }],
    });
    try {
      const stateFile = path.join(stateHome, "idfx", "sandbox-dup.json");
      mkdirSync(path.dirname(stateFile), { recursive: true });
      writeFileSync(stateFile, JSON.stringify({ name: "oc-sub-dup", root: "/proj", port: sandbox.port }));
      const captured = captureLog();
      try {
        const code = await status({ all: true }, { XDG_STATE_HOME: stateHome, IDFX_URL: host.url }, testDeps);
        expect(code).toBe(0);
        expect(captured.lines).toEqual(["ses_shared busy Shared run (/proj)"]);
      } finally {
        captured.restore();
      }
    } finally {
      host.stop();
      sandbox.stop();
      rmSync(stateHome, { recursive: true, force: true });
    }
  });

  test("--all prints no running sessions when nothing runs", async () => {
    const stateHome = mkdtempSync(path.join(tmpdir(), "oc-sub-status-state-"));
    const server = startFakeServer({
      sessions: [{ id: "ses_idle", directory: "/proj", title: "Idle run" }],
      projects: [{ id: "p1", worktree: "/proj" }],
    });
    try {
      const { code, lines } = await runStatus({ server, all: true, env: { XDG_STATE_HOME: stateHome } });
      expect(code).toBe(0);
      expect(lines).toEqual(["no running sessions"]);
    } finally {
      server.stop();
      rmSync(stateHome, { recursive: true, force: true });
    }
  });

  test("--all skips a busy child session, because its parent is listed", async () => {
    const stateHome = mkdtempSync(path.join(tmpdir(), "oc-sub-status-state-"));
    const server = startFakeServer({
      sessions: [
        { id: "ses_parent", directory: "/proj", title: "Parent run" },
        { id: "ses_child", directory: "/proj", title: "Child run", parentID: "ses_parent" },
      ],
      states: { ses_parent: { type: "busy" }, ses_child: { type: "busy" } },
      projects: [{ id: "p1", worktree: "/proj" }],
    });
    try {
      const { code, lines } = await runStatus({ server, all: true, env: { XDG_STATE_HOME: stateHome } });
      expect(code).toBe(0);
      expect(lines).toEqual(["ses_parent busy Parent run (/proj)"]);
    } finally {
      server.stop();
      rmSync(stateHome, { recursive: true, force: true });
    }
  });

  test("--all warns about a broken directory and lists the others", async () => {
    const stateHome = mkdtempSync(path.join(tmpdir(), "oc-sub-status-state-"));
    const server = startFakeServer({
      sessions: [
        { id: "ses_ok", directory: "/proj", title: "Good run" },
        { id: "ses_broken", directory: "/broken", title: "Broken run" },
      ],
      states: { ses_ok: { type: "busy" }, ses_broken: { type: "busy" } },
      projects: [
        { id: "p1", worktree: "/proj" },
        { id: "p2", worktree: "/broken" },
      ],
      brokenDirectories: ["/broken"],
    });
    try {
      const { code, lines, errors } = await runStatus({ server, all: true, env: { XDG_STATE_HOME: stateHome } });
      expect(code).toBe(0);
      expect(lines).toEqual(["ses_ok busy Good run (/proj)"]);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatch(/^warning: \/broken: list sessions: bad file reference/);
    } finally {
      server.stop();
      rmSync(stateHome, { recursive: true, force: true });
    }
  });

  test("warns about a broken worktree and lists the directory itself", async () => {
    const server = startFakeServer({
      sessions: [
        { id: "ses_ok", directory: DIR, title: "Good run" },
        { id: "ses_wt", directory: `${DIR}/.worktrees/x`, title: "WT run" },
      ],
      states: { ses_ok: { type: "busy" }, ses_wt: { type: "busy" } },
      brokenDirectories: [`${DIR}/.worktrees/x`],
    });
    try {
      const { code, lines, errors } = await runStatus({
        server,
        dir: DIR,
        deps: { worktreesOf: () => [DIR, `${DIR}/.worktrees/x`] },
      });
      expect(code).toBe(0);
      expect(lines).toEqual(["ses_ok busy Good run"]);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatch(/^warning: \/repo\/\.worktrees\/x: list sessions: bad file reference/);
    } finally {
      server.stop();
    }
  });
});

describe("status --json", () => {
  test("prints one JSON object whose items have id, state, title, folder, and driver as the whole stdout", async () => {
    const server = startFakeServer({
      sessions: [
        { id: "ses_root", directory: DIR, title: "Root run" },
        { id: "ses_wt", directory: `${DIR}/.worktrees/x`, title: "WT run" },
        { id: "ses_child", directory: `${DIR}/.worktrees/x`, title: "Child run", parentID: "ses_wt" },
      ],
      states: { ses_wt: { type: "busy" } },
    });
    try {
      const { code, lines, errors } = await runStatus({
        server,
        dir: DIR,
        json: true,
        deps: { worktreesOf: () => [DIR, `${DIR}/.worktrees/x`] },
      });
      expect(code).toBe(0);
      expect(errors).toEqual([]);
      // The whole stdout is one JSON document, so the test parses all of it.
      const rows = parseItems(lines) as Array<Record<string, string>>;
      expect(rows).toEqual([
        { id: "ses_root", state: "idle", title: "Root run", folder: DIR, driver: "opencode" },
        { id: "ses_wt", state: "busy", title: "WT run", folder: `${DIR}/.worktrees/x`, driver: "opencode" },
      ]);
    } finally {
      server.stop();
    }
  });

  test("--json --all adds project and server to every row", async () => {
    const stateHome = mkdtempSync(path.join(tmpdir(), "oc-sub-status-json-"));
    const server = startFakeServer({
      sessions: [{ id: "ses_proj", directory: "/proj", title: "Proj run" }],
      states: { ses_proj: { type: "busy" } },
      projects: [{ id: "p1", worktree: "/proj" }],
    });
    try {
      const { code, lines } = await runStatus({
        server,
        all: true,
        json: true,
        env: { XDG_STATE_HOME: stateHome },
        deps: { worktreesOf: (directory) => [directory] },
      });
      expect(code).toBe(0);
      const rows = parseItems(lines) as Array<Record<string, string>>;
      expect(rows).toEqual([
        { id: "ses_proj", state: "busy", title: "Proj run", folder: "/proj", project: "proj", server: server.url, driver: "opencode" },
      ]);
    } finally {
      server.stop();
      rmSync(stateHome, { recursive: true, force: true });
    }
  });

  test("--json names the project of a sandbox server and keeps stdout pure", async () => {
    const stateHome = mkdtempSync(path.join(tmpdir(), "oc-sub-status-json-"));
    const server = startFakeServer({
      sessions: [{ id: "ses_sbx", directory: "/sbxproj", title: "Sandbox run" }],
      states: { ses_sbx: { type: "busy" } },
      brokenDirectories: ["/sbxproj/.worktrees/x"],
    });
    try {
      const stateFile = path.join(stateHome, "idfx", "sandbox-sbx.json");
      mkdirSync(path.dirname(stateFile), { recursive: true });
      writeFileSync(stateFile, JSON.stringify({ name: "oc-sub-sbx", root: "/sbxproj", port: server.port }));
      const { code, lines, errors } = await runStatus({
        server,
        all: true,
        json: true,
        env: { XDG_STATE_HOME: stateHome },
        deps: {
          ...testDeps,
          cloneDirectoriesOf: (project) => (project === "sbx" ? ["/sbxproj", "/sbxproj/.worktrees/x"] : []),
        },
      });
      expect(code).toBe(0);
      // The warning goes to stderr; stdout stays the one JSON document.
      expect(errors.join("\n")).toContain("warning: /sbxproj/.worktrees/x:");
      const rows = parseItems(lines) as Array<Record<string, string>>;
      expect(rows).toEqual([
        {
          id: "ses_sbx",
          state: "busy",
          title: "Sandbox run",
          folder: "/sbxproj",
          project: "sbx",
          server: server.url,
          driver: "opencode",
        },
      ]);
    } finally {
      server.stop();
      rmSync(stateHome, { recursive: true, force: true });
    }
  });

  test("--json prints empty items to stdout and the message to stderr without a server", async () => {
    const captured = captureLog();
    try {
      const code = await status({ url: "http://127.0.0.1:9", all: false, json: true }, {});
      expect(code).toBe(0);
      expect(parseItems(captured.lines)).toEqual([]);
      expect(captured.errors).toEqual(["no server on http://127.0.0.1:9"]);
    } finally {
      captured.restore();
    }
  });

  test("--json prints an empty array when no session runs", async () => {
    const stateHome = mkdtempSync(path.join(tmpdir(), "oc-sub-status-json-"));
    const server = startFakeServer({
      sessions: [{ id: "ses_idle", directory: "/proj", title: "Idle run" }],
      projects: [{ id: "p1", worktree: "/proj" }],
    });
    try {
      const { code, lines, errors } = await runStatus({
        server,
        all: true,
        json: true,
        env: { XDG_STATE_HOME: stateHome },
      });
      expect(code).toBe(0);
      expect(errors).toEqual(["no running sessions"]);
      expect(parseItems(lines)).toEqual([]);
    } finally {
      server.stop();
      rmSync(stateHome, { recursive: true, force: true });
    }
  });

  test("--json --all keeps the plain text messages off stdout without --json", async () => {
    const captured = captureLog();
    try {
      const code = await status({ url: "http://127.0.0.1:9", all: true }, {});
      expect(code).toBe(0);
      expect(captured.lines).toEqual(["no server on http://127.0.0.1:9"]);
      expect(captured.errors).toEqual([]);
    } finally {
      captured.restore();
    }
  });
});

describe("host worktree of a project", () => {
  test("projectDirectories maps a host git worktree to the project root through the git common dir", async () => {
    const stateHome = mkdtempSync(path.join(tmpdir(), "oc-sub-status-wt-"));
    const server = startFakeServer({
      sessions: [{ id: "ses_root", directory: "/repo", title: "Root run" }],
      states: { ses_root: { type: "busy" } },
    });
    try {
      const stateFile = path.join(stateHome, "idfx", "sandbox-repo.json");
      mkdirSync(path.dirname(stateFile), { recursive: true });
      writeFileSync(stateFile, JSON.stringify({ name: "oc-sub-repo", root: "/repo", port: server.port }));
      const worktree = "/repo/.claude/worktrees/x";
      const calls: string[] = [];
      const { code, lines } = await runStatus({
        server,
        dir: worktree,
        env: { XDG_STATE_HOME: stateHome },
        deps: {
          exists: () => true,
          // The fake git common dir: the worktree belongs to the repository
          // at /repo, so it resolves to the project root of the sandbox.
          commonDirOf: (directory) => (directory === worktree || directory === "/repo" ? "/repo/.git" : null),
          worktreesOf: (directory) => {
            calls.push(`worktreesOf ${directory}`);
            return [directory];
          },
          cloneDirectoriesOf: (project) => {
            calls.push(`cloneDirectoriesOf ${project}`);
            return ["/repo"];
          },
        },
      });
      expect(code).toBe(0);
      expect(lines).toEqual(["ses_root busy Root run (/repo)"]);
      expect(calls).toEqual(["cloneDirectoriesOf repo"]);
    } finally {
      server.stop();
      rmSync(stateHome, { recursive: true, force: true });
    }
  });

  test("projectDirectories keeps the folder without a git common dir", () => {
    const calls: string[] = [];
    const dirs = projectDirectories("/repo/.claude/worktrees/x", {}, {
      ...testDeps,
      exists: () => true,
      commonDirOf: () => null,
      worktreesOf: (directory) => {
        calls.push(directory);
        return [directory];
      },
    });
    expect(dirs).toEqual(["/repo/.claude/worktrees/x"]);
    expect(calls).toEqual(["/repo/.claude/worktrees/x"]);
  });
});

describe("Claude sessions in status", () => {
  const claudeLoader = (nowMs = NOW) => async () =>
    loadClaudeRows({
      source: createClaudeSource(FIXTURE_ROOT, fixtureFs()),
      nowMs,
      loadPrices: async () => parsePriceFile(readFileSync(path.join(FIXTURE_DIR, "litellm-prices.json"), "utf8")),
    });
  const claudeDeps: StatusDeps = { ...testDeps, commonDirOf: () => null, worktreesOf: (directory) => [directory] };

  /** Run status with the Claude fixture. Without `down`, an opencode server without sessions answers. */
  async function run(args: { dir?: string; all: boolean; json?: boolean; down?: boolean }, loader = claudeLoader()) {
    const server = args.down === true ? undefined : startFakeServer({});
    const captured = captureLog();
    const stateHome = mkdtempSync(path.join(tmpdir(), "oc-sub-status-claude-"));
    try {
      const url = server?.url ?? "http://127.0.0.1:9";
      const code = await status({ url, dir: args.dir, all: args.all, json: args.json }, { XDG_STATE_HOME: stateHome, IDFX_URL: url }, claudeDeps, loader);
      return { code, lines: captured.lines, errors: captured.errors };
    } finally {
      captured.restore();
      server?.stop();
      rmSync(stateHome, { recursive: true, force: true });
    }
  }

  test("without --all, only the sessions inside the project folder show, also without an opencode server", async () => {
    const { code, lines } = await run({ dir: "/home/user/src/proj", all: false, down: true });
    expect(code).toBe(0);
    expect(lines).toEqual([
      "no server on http://127.0.0.1:9",
      `${S1} waiting fixture-title`,
      `${S2} busy bg-worker (.worktrees/w2)`,
      `${S7} ended proj`,
    ]);
  });

  test("--all shows every session with its absolute folder", async () => {
    const { lines } = await run({ all: true });
    expect(lines).toEqual([
      `${S1} waiting fixture-title (/home/user/src/proj)`,
      `${S5} waiting blocked-job (/home/user/src/other)`,
      `${S2} busy bg-worker (/home/user/src/proj/.worktrees/w2)`,
      `${S7} ended proj (/home/user/src/proj)`,
    ]);
  });

  test("--all --json gives the Claude fields of each entry", async () => {
    const { lines, errors } = await run({ all: true, json: true });
    expect(errors).toEqual([]);
    const rows = parseItems(lines) as Array<Record<string, unknown>>;
    expect(rows.map((row) => row.id)).toEqual([S1, S5, S2, S7]);
    expect(rows[0]).toEqual({
      id: S1,
      state: "waiting",
      title: "fixture-title",
      folder: "/home/user/src/proj",
      project: "proj",
      driver: "claude",
      name: "proj",
      kind: "interactive",
      waitingFor: "Bash permission",
      model: "claude-opus-5-5",
      contextTokens: 1205,
      contextWindow: 1000000,
      contextShare: 0.0012,
      lastActivity: new Date(1791284100000).toISOString(),
      apiEquivalentUsd: 0.0112,
    });
    expect(rows[3]).toMatchObject({ id: S7, state: "ended", model: "z-ai/glm-5.3-flash", contextWindow: null, contextShare: null, apiEquivalentUsd: null });
  });

  test("a failing Claude reader costs only the Claude rows", async () => {
    const { code, lines, errors } = await run({ all: true }, async () => {
      throw new Error("boom");
    });
    expect(code).toBe(0);
    expect(lines).toEqual(["no running sessions"]);
    expect(errors).toEqual(["warning: claude sessions: boom"]);
  });

  describe("--json snapshot of the tool protocol", () => {
    /** Six minutes after the fixture time: S1 waits over 10 minutes, S2 has no transcript growth for 16 minutes. */
    const LATER = NOW + 6 * MINUTE;
    const loaderAt = () => async (nowMs: number) =>
      loadClaudeRows({
        source: createClaudeSource(FIXTURE_ROOT, fixtureFs()),
        nowMs,
        loadPrices: async () => parsePriceFile(readFileSync(path.join(FIXTURE_DIR, "litellm-prices.json"), "utf8")),
      });
    const snapshotDeps: StatusDeps = { ...claudeDeps, now: () => LATER, hostname: () => "mini", version: () => "abc1234" };

    /** Run `status --json` without an opencode server; `seed` writes the event log first. */
    async function snapshot(args: { dir?: string; all: boolean }, seed?: (stateDir: string) => void) {
      const captured = captureLog();
      const stateHome = mkdtempSync(path.join(tmpdir(), "oc-sub-status-snapshot-"));
      try {
        mkdirSync(path.join(stateHome, "idfx"), { recursive: true });
        seed?.(path.join(stateHome, "idfx"));
        const url = "http://127.0.0.1:9";
        const code = await status(
          { url, dir: args.dir, all: args.all, json: true },
          { XDG_STATE_HOME: stateHome, IDFX_URL: url },
          snapshotDeps,
          loaderAt(),
        );
        return { code, lines: captured.lines, errors: captured.errors };
      } finally {
        captured.restore();
        rmSync(stateHome, { recursive: true, force: true });
      }
    }

    function validator() {
      const ajv = new Ajv({ strict: false, allErrors: true });
      addFormats(ajv);
      return ajv.compile(JSON.parse(readFileSync(path.join(import.meta.dir, "fixtures", "idfx-status.schema.json"), "utf8")));
    }

    test("stdout is one object with the protocol fields, and the True conditions of the rows", async () => {
      const { code, lines, errors } = await snapshot({ all: true });
      expect(code).toBe(0);
      expect(errors).toEqual(["no server on http://127.0.0.1:9"]);
      const out = parseJsonStdout(lines) as Record<string, unknown>;
      expect(Object.keys(out)).toEqual(["tool", "version", "time", "source", "conditions", "items"]);
      expect(out).toMatchObject({ tool: "idfx", version: "abc1234", time: new Date(LATER).toISOString(), source: "//mini/idfx" });
      // Without an event log there is no sequence, and each condition starts now.
      expect(out.conditions).toEqual([
        {
          type: "SessionWaitsForUser",
          status: "True",
          reason: "input_required",
          message: "permission dialog: Bash permission, waits for the user since 11 min",
          lastTransitionTime: new Date(LATER).toISOString(),
          subject: "proj",
          session: S1,
        },
        expect.objectContaining({ type: "SessionWaitsForUser", reason: "input_required", subject: "blocked-job", session: S5 }),
        expect.objectContaining({ type: "SessionStalled", reason: "NoTranscriptGrowth", subject: "bg-worker", session: S2 }),
        // The fixture name "bg-worker" in the folder w2 breaks the naming rule.
        expect.objectContaining({ type: "SessionUnnamed", reason: "NameOffRule", message: 'expected "w2" or "w2-<step>"', session: S2 }),
      ]);
      expect((out.items as Array<{ id: string }>).map((item) => item.id)).toEqual([S1, S5, S2, S7]);
    });

    test("the output passes the JSON Schema of the protocol", async () => {
      const { lines } = await snapshot({ all: true });
      const validate = validator();
      const ok = validate(parseJsonStdout(lines));
      expect(validate.errors ?? []).toEqual([]);
      expect(ok).toBe(true);
    });

    test("the event log gives the sequence and the lastTransitionTime of a known condition; HandoverFailed stays out", async () => {
      const since = NOW - 30 * MINUTE;
      const { lines } = await snapshot({ all: true }, (dir) => {
        const known = conditionEvent(
          {
            condition: "SessionWaitsForUser",
            status: "True",
            reason: "input_required",
            message: "blocked job: approve the push, waits for the user since 4410 min",
            lastTransitionMs: since,
            session: S5,
            subject: "blocked-job",
            cwd: "/home/user/src/other",
            kind: "background",
            severity: TRUE_SEVERITY.SessionWaitsForUser,
          },
          41,
          "//mini/idfx",
        );
        const handover = conditionEvent(
          {
            condition: "HandoverFailed",
            status: "True",
            reason: "HandoverCheckFailed",
            message: "uncommitted work",
            lastTransitionMs: since,
            session: S7,
            subject: "77777777",
            cwd: "/home/user/src/proj",
            kind: "interactive",
            severity: TRUE_SEVERITY.HandoverFailed,
          },
          42,
          "//mini/idfx",
        );
        writeFileSync(path.join(dir, EVENTS_FILE), `${JSON.stringify(known)}\n${JSON.stringify(handover)}\n`);
      });
      const out = parseJsonStdout(lines) as { sequence?: string; conditions: Array<Record<string, string>> };
      expect(out.sequence).toBe("00000000000000000042");
      const s5 = out.conditions.find((condition) => condition.session === S5);
      // The condition stays True since the log, so it keeps the time and the message of the log.
      expect(s5).toMatchObject({ lastTransitionTime: new Date(since).toISOString(), message: "blocked job: approve the push, waits for the user since 4410 min" });
      expect(out.conditions.some((condition) => condition.type === "HandoverFailed")).toBe(false);
      expect(validator()(out)).toBe(true);
    });

    test("without --all, the conditions cover only the sessions of the project", async () => {
      const { lines } = await snapshot({ dir: "/home/user/src/proj", all: false });
      const out = parseJsonStdout(lines) as { conditions: Array<{ session: string }>; items: Array<{ id: string }> };
      expect(out.items.map((item) => item.id)).toEqual([S1, S2, S7]);
      // S2 has two conditions: SessionStalled and SessionUnnamed (its name breaks the naming rule).
      expect(out.conditions.map((condition) => condition.session)).toEqual([S1, S2, S2]);
    });
  });

  test("the default reader of the tests sees no real Claude session", async () => {
    // test/setup.ts points CLAUDE_CONFIG_DIR at an empty folder.
    const rows = await defaultClaudeRows(Date.now());
    expect(rows).toEqual([]);
  });
});
