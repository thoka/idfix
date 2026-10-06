import { describe, expect, test } from "bun:test";
import { firstHeading, sharedAgentsDir, sharedAgentsFile, sharedConfigEntries } from "../src/shared";

describe("sharedAgentsDir", () => {
  test("comes from OC_SUB_SHARED_DIR", () => {
    expect(sharedAgentsDir({ OC_SUB_SHARED_DIR: "/srv/agents" })).toBe("/srv/agents");
  });

  test("an empty OC_SUB_SHARED_DIR counts as unset", () => {
    expect(sharedAgentsDir({ OC_SUB_SHARED_DIR: "  ", HOME: "/home/user" })).toBe("/home/user/dv/meta/agents");
  });

  test("falls back to $HOME/dv/meta/agents", () => {
    expect(sharedAgentsDir({ HOME: "/home/user" })).toBe("/home/user/dv/meta/agents");
    expect(sharedAgentsDir({})).toBe("~/dv/meta/agents");
  });
});

describe("sharedAgentsFile", () => {
  test("is AGENTS.md inside the shared folder", () => {
    expect(sharedAgentsFile({ OC_SUB_SHARED_DIR: "/srv/agents" })).toBe("/srv/agents/AGENTS.md");
    expect(sharedAgentsFile({ HOME: "/home/user" })).toBe("/home/user/dv/meta/agents/AGENTS.md");
  });
});

describe("sharedConfigEntries", () => {
  test("names the rules file and the skills folder of the shared dir", () => {
    expect(sharedConfigEntries("/srv/agents")).toEqual({
      instructions: ["/srv/agents/AGENTS.md"],
      skills: { paths: ["/srv/agents/skills"] },
    });
  });
});

describe("firstHeading", () => {
  test("returns the first line that starts with '# '", () => {
    expect(firstHeading("intro\n# Agent rules\nmore\ndefinitions\n# Agent rules\n")).toBe("# Agent rules");
    expect(firstHeading("# First\n# Second\n")).toBe("# First");
  });

  test("does not match level 2+ headings or missing ones", () => {
    expect(firstHeading("## Sub\n")).toBeNull();
    expect(firstHeading("#No space\n")).toBeNull();
    expect(firstHeading("")).toBeNull();
  });
});
