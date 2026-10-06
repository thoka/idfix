/** Tests for the project config of `idfx top`. */
import { describe, expect, test } from "bun:test";
import {
  makeProjectNameResolver,
  oldProjectConfigFile,
  projectConfigFile,
  projectSetupCommand,
  projectShortName,
  setupFromConfigText,
  shortNameFromConfigText,
  type ProjectConfigDeps,
} from "../src/project-config";

/** Fake file system: the config file of a project root, or null. */
function depsWith(files: Record<string, string>, existing: string[] = []): ProjectConfigDeps & { reads: () => number } {
  let reads = 0;
  return {
    readTextSync: (file) => {
      reads += 1;
      return Object.hasOwn(files, file) ? files[file] ?? null : null;
    },
    exists: (file) => existing.includes(file),
    reads: () => reads,
  };
}

describe("shortNameFromConfigText", () => {
  test("a missing file gives undefined", () => {
    expect(shortNameFromConfigText(null)).toBeUndefined();
  });

  test("invalid JSON gives undefined", () => {
    expect(shortNameFromConfigText("{ not json")).toBeUndefined();
  });

  test("a non-object or a missing or empty shortName gives undefined", () => {
    expect(shortNameFromConfigText("[]")).toBeUndefined();
    expect(shortNameFromConfigText('"text"')).toBeUndefined();
    expect(shortNameFromConfigText("{}")).toBeUndefined();
    expect(shortNameFromConfigText('{"shortName": 3}')).toBeUndefined();
    expect(shortNameFromConfigText('{"shortName": ""}')).toBeUndefined();
    expect(shortNameFromConfigText('{"shortName": null}')).toBeUndefined();
  });

  test("a valid shortName comes through", () => {
    expect(shortNameFromConfigText('{"shortName": "opsub"}')).toBe("opsub");
  });
});

describe("setupFromConfigText", () => {
  test("a missing file gives undefined", () => {
    expect(setupFromConfigText(null)).toBeUndefined();
  });

  test("invalid JSON gives undefined", () => {
    expect(setupFromConfigText("{ not json")).toBeUndefined();
  });

  test("an empty or non-string setup gives undefined", () => {
    expect(setupFromConfigText("{}")).toBeUndefined();
    expect(setupFromConfigText('{"setup": ""}')).toBeUndefined();
    expect(setupFromConfigText('{"setup": 3}')).toBeUndefined();
    expect(setupFromConfigText('{"setup": null}')).toBeUndefined();
  });

  test("a valid setup comes through", () => {
    expect(setupFromConfigText('{"setup": "bun install"}')).toBe("bun install");
  });
});

describe("the file names", () => {
  test("the new file is .opencode/idfx.json, the old file .opencode/oc-sub.json", () => {
    expect(projectConfigFile("/p")).toBe("/p/.opencode/idfx.json");
    expect(oldProjectConfigFile("/p")).toBe("/p/.opencode/oc-sub.json");
  });

  test("the new file wins over the old file", () => {
    const deps = depsWith({
      [projectConfigFile("/p")]: '{"shortName": "new", "setup": "new setup"}',
      [oldProjectConfigFile("/p")]: '{"shortName": "old", "setup": "old setup"}',
    });
    expect(projectShortName("/p", deps, new Map())).toBe("new");
    expect(projectSetupCommand("/p", deps)).toBe("new setup");
  });

  test("the old file still works alone", () => {
    const deps = depsWith({ [oldProjectConfigFile("/p")]: '{"shortName": "old", "setup": "old setup"}' });
    expect(projectShortName("/p", deps, new Map())).toBe("old");
    expect(projectSetupCommand("/p", deps)).toBe("old setup");
  });
});

describe("projectSetupCommand", () => {
  test("no file gives undefined", () => {
    expect(projectSetupCommand("/p", depsWith({}))).toBeUndefined();
  });

  test("a valid file gives the setup command", () => {
    const deps = depsWith({ [projectConfigFile("/p")]: '{"setup": "bun install --frozen-lockfile"}' });
    expect(projectSetupCommand("/p", deps)).toBe("bun install --frozen-lockfile");
  });
});

describe("projectShortName", () => {
  test("no file gives undefined", () => {
    const deps = depsWith({});
    expect(projectShortName("/p", deps, new Map())).toBeUndefined();
  });

  test("a valid file gives the shortName", () => {
    const deps = depsWith({ [projectConfigFile("/p")]: '{"shortName": "opsub"}' });
    expect(projectShortName("/p", deps, new Map())).toBe("opsub");
  });

  test("each root is read at most once per cache", () => {
    const deps = depsWith({ [projectConfigFile("/p")]: '{"shortName": "opsub"}' });
    const cache = new Map<string, string | undefined>();
    projectShortName("/p", deps, cache);
    projectShortName("/p", deps, cache);
    projectShortName("/p", deps, cache);
    expect(deps.reads()).toBe(1);
  });
});

describe("makeProjectNameResolver", () => {
  test("without config it shows the full project name", () => {
    const deps = depsWith({});
    const resolve = makeProjectNameResolver(deps, new Map());
    expect(resolve("/d/terminator")).toBe("terminator");
    expect(resolve("/d/terminator/.worktrees/8i")).toBe("terminator");
  });

  test("a row uses the configured shortName of its project root", () => {
    const deps = depsWith(
      { [projectConfigFile("/d/idfix")]: '{"shortName": "opsub"}' },
      ["/d/idfix"],
    );
    const resolve = makeProjectNameResolver(deps, new Map());
    expect(resolve("/d/idfix")).toBe("opsub");
    expect(resolve("/d/idfix/.worktrees/8i")).toBe("opsub");
  });

  test("a folder that exists only in the sandbox maps to its host root", () => {
    // The worktree folder does not exist on the host; the root does. The
    // config of the root decides.
    const deps = depsWith(
      { [projectConfigFile("/d/idfix")]: '{"shortName": "opsub"}' },
      ["/d/idfix"],
    );
    const resolve = makeProjectNameResolver(deps, new Map());
    expect(resolve("/d/idfix/.worktrees/8i")).toBe("opsub");
  });
});
