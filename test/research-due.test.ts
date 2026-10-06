import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseResearchHead, recheckState, todayString } from "../src/research-head";
import { makeDoctorDeps, PLAN_DIR_FIX, RESEARCH_DUE_FIX, researchDueCheck, type DoctorDeps } from "../src/doctor";
import { readPlanDir } from "../src/plan-dir";

/** A report text with a recheck head. */
function report(head: string): string {
  return `---\n${head}\n---\n\n# Title\n\nBody.\n`;
}

describe("parseResearchHead", () => {
  test("parses checked, recheck, and decisions", () => {
    const head = parseResearchHead(report('checked: 2026-10-01\nrecheck: monthly\ndecisions:\n  - "PLAN step 16: DeepInfra"\n  - "the provider order"'));
    expect(head).toEqual({
      checked: "2026-10-01",
      recheck: "monthly",
      decisions: ["PLAN step 16: DeepInfra", "the provider order"],
    });
  });

  test("parses every interval form", () => {
    for (const interval of ["30d", "2w", "1m", "12m"]) {
      const head = parseResearchHead(report(`checked: 2026-10-01\nrecheck: ${interval}`));
      expect(head?.recheck).toBe(interval);
    }
  });

  test("parses a date recheck", () => {
    const head = parseResearchHead(report("checked: 2026-10-01\nrecheck: 2026-11-01"));
    expect(head?.recheck).toBe("2026-11-01");
  });

  test("parses a trigger recheck", () => {
    const head = parseResearchHead(report("checked: 2026-10-01\nrecheck: on new opencode release"));
    expect(head?.recheck).toBe("on new opencode release");
  });

  test("keeps a head with only checked", () => {
    const head = parseResearchHead(report("checked: 2026-10-01"));
    expect(head).toEqual({ checked: "2026-10-01", decisions: [] });
  });

  test("ignores front matter with other keys only", () => {
    expect(parseResearchHead(report("title: Some report\ntags: [a, b]"))).toBeNull();
  });

  test("returns null without front matter", () => {
    expect(parseResearchHead("# Title\n\nBody.\n")).toBeNull();
  });

  test("returns null without a closing fence", () => {
    expect(parseResearchHead("---\nchecked: 2026-10-01\nrecheck: monthly\n")).toBeNull();
  });
});

describe("recheckState", () => {
  test("1w from checked", () => {
    const head = { checked: "2026-09-24", recheck: "1w", decisions: [] };
    expect(recheckState(head, "2026-10-01")).toEqual({ kind: "due", due: "2026-10-01" });
    expect(recheckState(head, "2026-09-30")).toEqual({ kind: "not-due", due: "2026-10-01" });
  });

  test("2w, 30d, 3m, 12m", () => {
    const base = { checked: "2026-10-01", recheck: "2w", decisions: [] };
    expect(recheckState(base, "2026-10-15")).toEqual({ kind: "due", due: "2026-10-15" });
    expect(recheckState(base, "2026-10-14")).toEqual({ kind: "not-due", due: "2026-10-15" });
    expect(recheckState({ ...base, recheck: "30d" }, "2026-10-31")).toEqual({ kind: "due", due: "2026-10-31" });
    expect(recheckState({ ...base, recheck: "3m" }, "2027-01-01")).toEqual({ kind: "due", due: "2027-01-01" });
    expect(recheckState({ ...base, recheck: "12m" }, "2027-09-30")).toEqual({ kind: "not-due", due: "2027-10-01" });
  });

  test("1m clamps to the end of the month", () => {
    const head = { checked: "2026-01-31", recheck: "1m", decisions: [] };
    expect(recheckState(head, "2026-02-28")).toEqual({ kind: "due", due: "2026-02-28" });
  });

  test("a date recheck is due on and after that date", () => {
    const head = { checked: "2026-09-01", recheck: "2026-10-01", decisions: [] };
    expect(recheckState(head, "2026-10-01")).toEqual({ kind: "due", due: "2026-10-01" });
    expect(recheckState(head, "2026-09-30")).toEqual({ kind: "not-due", due: "2026-10-01" });
  });

  test("a trigger is never due", () => {
    const head = { checked: "2020-01-01", recheck: "on new opencode release", decisions: [] };
    expect(recheckState(head, "2026-10-01")).toEqual({ kind: "trigger" });
  });

  test("a missing checked is invalid", () => {
    expect(recheckState({ recheck: "monthly", decisions: [] }, "2026-10-01")).toEqual({
      kind: "invalid",
      problem: "checked is missing",
    });
  });

  test("any other text is a trigger, like in the meta index", () => {
    const head = { checked: "2020-01-01", recheck: "each new sbx release", decisions: [] };
    expect(recheckState(head, "2026-10-01")).toEqual({ kind: "trigger" });
  });

  test("an old named interval is invalid and names the replacement", () => {
    expect(recheckState({ checked: "2026-10-01", recheck: "biweekly", decisions: [] }, "2026-10-01")).toEqual({
      kind: "invalid",
      problem: "recheck biweekly is the old format, write 2w",
    });
  });
});

describe("researchDueCheck", () => {
  /** A temporary project folder with a docs/research folder. */
  function tempProject(reports: Record<string, string>): { root: string; deps: ReturnType<typeof makeDoctorDeps> } {
    const root = mkdtempSync(path.join(tmpdir(), "oc-sub-research-"));
    mkdirSync(path.join(root, "docs", "research"), { recursive: true });
    for (const [name, text] of Object.entries(reports)) {
      writeFileSync(path.join(root, "docs", "research", name), text);
    }
    return { root, deps: makeDoctorDeps(process.env, root, { today: "2026-10-01" }) };
  }

  test("no docs/research folder passes", () => {
    const root = mkdtempSync(path.join(tmpdir(), "oc-sub-research-"));
    try {
      const result = researchDueCheck(makeDoctorDeps(process.env, root, { today: "2026-10-01" }));
      expect(result.status).toBe("pass");
      expect(result.message).toBe("no docs/research folder, so no report has a recheck head");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a due report warns with its due date and its decisions", () => {
    const { root, deps } = tempProject({
      "DUE.md": report("checked: 2026-09-17\nrecheck: 2w\ndecisions:\n  - \"DeepInfra as a direct provider\"\n"),
    });
    try {
      const result = researchDueCheck(deps);
      expect(result.status).toBe("warn");
      expect(result.message).toContain("DUE.md was due on 2026-10-01");
      expect(result.message).toContain("DeepInfra as a direct provider");
      expect(result.fix).toBe(RESEARCH_DUE_FIX);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a not-due report passes", () => {
    const { root, deps } = tempProject({
      "FRESH.md": report("checked: 2026-10-01\nrecheck: 1m\ndecisions:\n  - \"the provider order\"\n"),
    });
    try {
      const result = researchDueCheck(deps);
      expect(result.status).toBe("pass");
      expect(result.message).toBe("no report in docs/research is due");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a trigger head never warns and is listed as information", () => {
    const { root, deps } = tempProject({
      "TRIGGER.md": report("checked: 2020-01-01\nrecheck: on new opencode release\n"),
    });
    try {
      const result = researchDueCheck(deps);
      expect(result.status).toBe("pass");
      expect(result.message).toContain("TRIGGER.md rechecks on new opencode release");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an invalid head warns and names the file and the problem", () => {
    const { root, deps } = tempProject({
      "BAD.md": report("recheck: monthly\ndecisions:\n  - \"x\"\n"),
      "WORSE.md": report("checked: 2026-10-01\nrecheck: quarterly\n"),
    });
    try {
      const result = researchDueCheck(deps);
      expect(result.status).toBe("warn");
      expect(result.message).toContain("BAD.md: checked is missing");
      expect(result.message).toContain("WORSE.md: recheck quarterly is the old format, write 3m");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reports without a head do not count", () => {
    const { root, deps } = tempProject({
      "PLAIN.md": "# No head\n\nJust text.\n",
      "OTHER.md": "---\ntitle: other front matter\n---\n\nBody.\n",
    });
    try {
      const result = researchDueCheck(deps);
      expect(result.status).toBe("pass");
      expect(result.message).toBe("no report in docs/research has a recheck head");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("todayString returns YYYY-MM-DD", () => {
  expect(todayString()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});

/** A reader of an in-memory file tree: path relative to /p to text. */
function memoryFiles(files: Record<string, string>): (file: string) => string | null {
  return (file) => files[path.relative("/p", file)] ?? null;
}

describe("readPlanDir", () => {
  const read = (toml: string | undefined) => readPlanDir("/p", memoryFiles(toml === undefined ? {} : { ".handover.toml": toml }));

  test("no file or no key gives docs without a problem", () => {
    expect(read(undefined)).toEqual({ planDir: "docs" });
    expect(read("local_only = true\n")).toEqual({ planDir: "docs" });
  });

  test("a relative folder is used, normalized like a POSIX path", () => {
    expect(read('plan_dir = ".plan"\n')).toEqual({ planDir: ".plan" });
    expect(read('plan_dir = " ./notes//plan/ "\n')).toEqual({ planDir: "notes/plan" });
  });

  test("a bad TOML gives docs and a problem", () => {
    const got = read("plan_dir = \n");
    expect(got.planDir).toBe("docs");
    expect(got.problem).toStartWith("bad .handover.toml: ");
  });

  test("a value that is not a non-empty string gives docs and a problem", () => {
    for (const value of ["42", "true", "[\".plan\"]", '""', '"   "']) {
      expect(read(`plan_dir = ${value}\n`)).toEqual({
        planDir: "docs",
        problem: "bad .handover.toml: plan_dir is not a non-empty string",
      });
    }
  });

  test("an absolute path, a path with .., or a backslash gives docs and a problem", () => {
    for (const value of ["/abs/plan", "../plan", "a/../../b", "a\\\\b"]) {
      const got = read(`plan_dir = "${value}"\n`);
      expect(got.planDir).toBe("docs");
      expect(got.problem).toStartWith("bad .handover.toml: plan_dir is not a relative path inside the project: ");
    }
  });

  test("the project root itself gives docs and a problem", () => {
    for (const value of [".", "./", "./."]) {
      expect(read(`plan_dir = "${value}"\n`)).toEqual({
        planDir: "docs",
        problem: "bad .handover.toml: plan_dir must not be the project root",
      });
    }
  });
});

describe("researchDueCheck with plan_dir", () => {
  /** Doctor deps whose project root /p holds only the given files. */
  function memoryDeps(files: Record<string, string>): DoctorDeps {
    const base = makeDoctorDeps(process.env, "/p", { today: "2026-10-01" });
    return {
      ...base,
      readText: memoryFiles(files),
      readdir: (folder) => {
        const rel = path.relative("/p", folder);
        const names = Object.keys(files)
          .filter((file) => path.dirname(file) === rel)
          .map((file) => path.basename(file));
        return names.length > 0 ? names : null;
      },
    };
  }

  const DUE = report("checked: 2026-09-17\nrecheck: 2w\n");

  test("with plan_dir = .plan it reads .plan/research and not docs/research", () => {
    const deps = memoryDeps({ ".handover.toml": 'plan_dir = ".plan"\n', "docs/research/DUE.md": DUE });
    expect(researchDueCheck(deps)).toMatchObject({
      status: "pass",
      message: "no .plan/research folder, so no report has a recheck head",
    });
    const due = researchDueCheck(memoryDeps({ ".handover.toml": 'plan_dir = ".plan"\n', ".plan/research/DUE.md": DUE }));
    expect(due.status).toBe("warn");
    expect(due.message).toContain("DUE.md was due on 2026-10-01");
    expect(due.fix).toBe(RESEARCH_DUE_FIX);
  });

  test("a bad plan_dir reads docs/research and warns with the problem", () => {
    const fresh = report("checked: 2026-10-01\nrecheck: 1m\n");
    const result = researchDueCheck(memoryDeps({ ".handover.toml": 'plan_dir = "../x"\n', "docs/research/FRESH.md": fresh }));
    expect(result.status).toBe("warn");
    expect(result.message).toBe(
      "bad .handover.toml: plan_dir is not a relative path inside the project: '../x', so the check read docs/research; no report in docs/research is due",
    );
    expect(result.fix).toBe(PLAN_DIR_FIX);
    const due = researchDueCheck(memoryDeps({ ".handover.toml": "plan_dir = 1\n", "docs/research/DUE.md": DUE }));
    expect(due.status).toBe("warn");
    expect(due.message).toContain("plan_dir is not a non-empty string, so the check read docs/research; DUE.md was due");
    expect(due.fix).toBe(RESEARCH_DUE_FIX);
  });
});
