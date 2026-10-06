import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
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
  test("runs the same CLI as bin/oc-sub, with its own name", () => {
    const idfx = runHelp(path.join(ROOT, "bin", "idfx"));
    const ocSub = runHelp(path.join(ROOT, "bin", "oc-sub"));
    expect(idfx.code).toBe(0);
    expect(ocSub.code).toBe(0);
    expect(idfx.out).toBe(helpText("idfx") + "\n");
    expect(ocSub.out).toBe(helpText("oc-sub") + "\n");
  });
});

describe("the command name in the help", () => {
  test("a symlink idfix to bin/idfx shows idfix in each usage line", () => {
    const { code, out } = runHelp(link("idfx", "idfix"));
    expect(code).toBe(0);
    expect(out.startsWith("idfix - drive an opencode server")).toBe(true);
    expect(out).toContain("\n  idfix up [--dir DIR] [--no-cost-proxy]\n");
    expect(out).not.toContain("oc-sub ");
  });

  test("a symlink oc-sub to bin/oc-sub shows oc-sub", () => {
    const { out } = runHelp(link("oc-sub", "oc-sub"));
    expect(out).toContain("\n  oc-sub status [--dir DIR | --all] [--json]\n");
  });

  test("a usage error names the called command in the hint", () => {
    const { code, err } = runHelp(link("idfx", "idfix-hint"), ["no-such-command"]);
    expect(code).toBe(2);
    expect(err).toContain("run `idfix-hint --help` for usage");
  });
});

describe("progName", () => {
  test("defaults to oc-sub without IDFX_PROG", () => {
    expect(DEFAULT_PROG).toBe("oc-sub");
    expect(progName({})).toBe("oc-sub");
    expect(progName({ IDFX_PROG: "" })).toBe("oc-sub");
    expect(progName({ IDFX_PROG: "  " })).toBe("oc-sub");
  });

  test("takes the base name of IDFX_PROG", () => {
    expect(progName({ IDFX_PROG: "idfx" })).toBe("idfx");
    expect(progName({ IDFX_PROG: "/home/user/.local/bin/idfix" })).toBe("idfix");
  });

  test("helpText and helpExitHint default to oc-sub", () => {
    expect(helpText().split("\n")[0]).toBe("oc-sub - drive an opencode server for subagent runs");
    expect(helpText()).toContain("\n  oc-sub up [--dir DIR] [--no-cost-proxy]\n");
    expect(helpExitHint()).toBe("run `oc-sub --help` for usage");
  });
});
