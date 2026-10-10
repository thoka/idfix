import { afterAll, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_PROG, helpExitHint, helpText, progName } from "../src/cli";

const ROOT = path.join(import.meta.dir, "..");
const linkDir = mkdtempSync(path.join(os.tmpdir(), "idfx-launcher-"));
afterAll(() => rmSync(linkDir, { recursive: true, force: true }));

/** Runs a launcher without an inherited IDFX_PROG. */
function runHelp(launcher: string, extraArgs: string[] = ["--help"]) {
  const env = { ...process.env };
  delete env.IDFX_PROG;
  const result = Bun.spawnSync([launcher, ...extraArgs], { env });
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
}

/** Links a launcher of bin/ under a new name, like ~/.local/bin does. */
function link(target: string, name: string): string {
  const file = path.join(linkDir, name);
  symlinkSync(path.join(ROOT, "bin", target), file);
  return file;
}

describe("bin/idfx", () => {
  test("runs the CLI and shows its own name", () => {
    const idfx = runHelp(path.join(ROOT, "bin", "idfx"));
    expect(idfx.code).toBe(0);
    expect(idfx.out).toBe(helpText("idfx") + "\n");
  });

  test("a symlink idfx to bin/idfx runs the CLI", () => {
    const { code, out } = runHelp(link("idfx", "idfx"));
    expect(code).toBe(0);
    expect(out).toBe(helpText("idfx") + "\n");
  });
});

describe("the command name in the help", () => {
  test("a symlink idfix to bin/idfx shows idfix in each usage line", () => {
    const { code, out } = runHelp(link("idfx", "idfix"));
    expect(code).toBe(0);
    expect(out.startsWith("idfix - drive an opencode server")).toBe(true);
    expect(out).toContain("\n  idfix up [--dir DIR] [--no-cost-proxy] [--idle-minutes N]\n");
    expect(out).not.toContain("\n  oc-sub ");
  });

  test("a usage error names the called command in the hint", () => {
    const { code, err } = runHelp(link("idfx", "idfix-hint"), ["no-such-command"]);
    expect(code).toBe(2);
    expect(err).toContain("run `idfix-hint --help` for usage");
  });
});

describe("progName", () => {
  test("defaults to idfx without IDFX_PROG", () => {
    expect(DEFAULT_PROG).toBe("idfx");
    expect(progName({})).toBe("idfx");
    expect(progName({ IDFX_PROG: "" })).toBe("idfx");
    expect(progName({ IDFX_PROG: "  " })).toBe("idfx");
  });

  test("takes the base name of IDFX_PROG", () => {
    expect(progName({ IDFX_PROG: "idfx" })).toBe("idfx");
    expect(progName({ IDFX_PROG: "/home/user/.local/bin/idfix" })).toBe("idfix");
  });

  test("helpText and helpExitHint default to idfx", () => {
    expect(helpText().split("\n")[0]).toBe("idfx - drive an opencode server for subagent runs");
    expect(helpText()).toContain("\n  idfx up [--dir DIR] [--no-cost-proxy] [--idle-minutes N]\n");
    expect(helpExitHint()).toBe("run `idfx --help` for usage");
  });

  test("the help does not name the old name oc-sub", () => {
    for (const prog of ["idfx", "idfix"]) {
      expect(helpText(prog)).not.toContain("oc-sub");
      expect(helpText(prog).split("\n")[1]).toBe("");
    }
  });
});

describe("the dependency install of bin/idfx", () => {
  /**
   * Builds a copy of the launcher next to a tiny package with one local
   * dependency, so that bun installs it without the network.
   */
  function fakeProject(): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), "idfx-install-"));
    mkdirSync(path.join(dir, "bin"));
    copyFileSync(path.join(ROOT, "bin", "idfx"), path.join(dir, "bin", "idfx"));
    mkdirSync(path.join(dir, "src"));
    writeFileSync(path.join(dir, "src", "cli.ts"), 'console.log(JSON.stringify({ ok: true }));\n');
    mkdirSync(path.join(dir, "dep"));
    writeFileSync(path.join(dir, "dep", "package.json"), '{ "name": "dep", "version": "1.0.0" }\n');
    writeFileSync(
      path.join(dir, "package.json"),
      '{ "name": "fake", "private": true, "dependencies": { "dep": "file:./dep" } }\n',
    );
    // Write bun.lock with a first install.
    const first = Bun.spawnSync([process.execPath, "install"], { cwd: dir });
    expect(first.exitCode).toBe(0);
    return dir;
  }

  test("installs a package of the lockfile that node_modules lacks, with a clean stdout", () => {
    const dir = fakeProject();
    try {
      // The old guard looked only for this folder and skipped the install.
      rmSync(path.join(dir, "node_modules", "dep"), { recursive: true, force: true });
      mkdirSync(path.join(dir, "node_modules", "@opencode-ai", "sdk"), { recursive: true });
      const env = { ...process.env, PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? ""}` };
      const result = Bun.spawnSync([path.join(dir, "bin", "idfx")], { env });
      expect(result.exitCode).toBe(0);
      expect(existsSync(path.join(dir, "node_modules", "dep", "package.json"))).toBe(true);
      expect(result.stdout.toString()).toBe('{"ok":true}\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("skips the install and prints nothing to stderr while the lockfile is unchanged", () => {
    const dir = fakeProject();
    try {
      const env = { ...process.env, PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? ""}` };
      const first = Bun.spawnSync([path.join(dir, "bin", "idfx")], { env });
      expect(first.exitCode).toBe(0);
      expect(existsSync(path.join(dir, "node_modules", ".idfx-install-stamp"))).toBe(true);
      // With a matching stamp, a missing package proves that no install ran.
      rmSync(path.join(dir, "node_modules", "dep"), { recursive: true, force: true });
      const second = Bun.spawnSync([path.join(dir, "bin", "idfx")], { env });
      expect(second.exitCode).toBe(0);
      expect(second.stderr.toString()).toBe("");
      expect(existsSync(path.join(dir, "node_modules", "dep"))).toBe(false);
      // A changed package.json changes the checksum and installs again.
      writeFileSync(
        path.join(dir, "package.json"),
        '{ "name": "fake", "private": true, "dependencies": { "dep": "file:./dep" }, "x": 1 }\n',
      );
      const third = Bun.spawnSync([path.join(dir, "bin", "idfx")], { env });
      expect(third.exitCode).toBe(0);
      expect(existsSync(path.join(dir, "node_modules", "dep", "package.json"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
