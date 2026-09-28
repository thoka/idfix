import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  displayFolder,
  formatStatusLine,
  parseWorktreeList,
  status,
  uniqueDirectories,
  worktreesOf,
  type StatusDeps,
} from "../src/status";

const DIR = "/repo";

function captureLog(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map((part) => String(part)).join(" "));
  });
  return { lines, restore: () => spy.mockRestore() };
}

type FakeSession = { id: string; directory: string; title: string; parentID?: string };

type FakeServer = { url: string; port: number; stop: () => void };

/** A fake opencode server for /global/health, /session, /session/status, and /project. */
function startFakeServer(options: {
  sessions?: FakeSession[];
  states?: Record<string, { type: string }>;
  projects?: Array<{ id: string; worktree: string }>;
}): FakeServer {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/global/health") return Response.json({ healthy: true, version: "1.0.0" });
      if (url.pathname === "/project") return Response.json(options.projects ?? []);
      const directory = url.searchParams.get("directory") ?? "";
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

const testDeps: StatusDeps = { worktreesOf: (directory) => [directory], exists: () => true };

async function runStatus(options: {
  server: FakeServer;
  dir?: string;
  all?: boolean;
  deps?: Partial<StatusDeps>;
  env?: Record<string, string | undefined>;
}): Promise<{ code: number; lines: string[] }> {
  const captured = captureLog();
  try {
    const code = await status(
      { url: options.server.url, dir: options.dir, all: options.all ?? false },
      options.env ?? {},
      { ...testDeps, ...options.deps },
    );
    return { code, lines: captured.lines };
  } finally {
    captured.restore();
  }
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
    expect(parseWorktreeList("worktree /home/u/my repo/.worktrees/wt one\n")).toEqual([
      "/home/u/my repo/.worktrees/wt one",
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
      const dirsFile = path.join(stateHome, "oc-sub", `serve-${server.port}.dirs`);
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
});
