/** Tests for the refusal of a run whose folder is missing in the sandbox clone. */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { missingSandboxFolder } from "../src/run";

const BASE = "/tmp/opencode/run-sandbox-folder-test";
const STATE = path.join(BASE, "state");
const ENV = { XDG_STATE_HOME: STATE };
mkdirSync(path.join(STATE, "idfx"), { recursive: true });
writeFileSync(
  path.join(STATE, "idfx", "sandbox-proj-a.json"),
  JSON.stringify({ name: "oc-sub-proj-a", root: "/h/proj-a", port: 18770 }),
);
afterAll(() => rmSync(BASE, { recursive: true, force: true }));

const projectName = () => "proj-a";
const DIR = "/h/proj-a/.worktrees/r-claude-glm";

describe("missingSandboxFolder", () => {
  test("refuses a host worktree that the sandbox clone lacks, and names both fixes", () => {
    const asked: string[] = [];
    const message = missingSandboxFolder({ dir: DIR }, ENV, {
      projectName,
      existsInSandbox: (sandbox, directory) => {
        asked.push(`${sandbox} ${directory}`);
        return false;
      },
    });
    expect(asked).toEqual([`oc-sub-proj-a ${DIR}`]);
    expect(message).toContain(`${DIR} does not exist in the sandbox oc-sub-proj-a`);
    expect(message).toContain("idfx worktree r-claude-glm");
    expect(message).toContain("idfx up --no-sandbox");
  });

  test("passes a folder that exists in the sandbox", () => {
    expect(missingSandboxFolder({ dir: DIR }, ENV, { projectName, existsInSandbox: () => true })).toBeNull();
  });

  test("never asks the sandbox with --url, with OC_SUB_URL, or without a sandbox state", () => {
    const never = () => {
      throw new Error("must not ask the sandbox");
    };
    expect(missingSandboxFolder({ dir: DIR, url: "http://127.0.0.1:8767" }, ENV, { projectName, existsInSandbox: never })).toBeNull();
    expect(
      missingSandboxFolder({ dir: DIR }, { ...ENV, OC_SUB_URL: "http://127.0.0.1:8767" }, { projectName, existsInSandbox: never }),
    ).toBeNull();
    expect(missingSandboxFolder({ dir: DIR }, ENV, { projectName: () => "other", existsInSandbox: never })).toBeNull();
  });
});
