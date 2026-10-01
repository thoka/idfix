import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseResearchHead, recheckState, todayString } from "../src/research-head";
import { makeDoctorDeps, RESEARCH_DUE_FIX, researchDueCheck } from "../src/doctor";

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

  test("parses every interval", () => {
    for (const interval of ["weekly", "biweekly", "monthly", "quarterly", "yearly"]) {
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
  test("weekly from checked", () => {
    const head = { checked: "2026-09-24", recheck: "weekly", decisions: [] };
    expect(recheckState(head, "2026-10-01")).toEqual({ kind: "due", due: "2026-10-01" });
    expect(recheckState(head, "2026-09-30")).toEqual({ kind: "not-due", due: "2026-10-01" });
  });

  test("biweekly, quarterly, yearly", () => {
    const base = { checked: "2026-10-01", recheck: "biweekly", decisions: [] };
    expect(recheckState(base, "2026-10-15")).toEqual({ kind: "due", due: "2026-10-15" });
    expect(recheckState(base, "2026-10-14")).toEqual({ kind: "not-due", due: "2026-10-15" });
    expect(recheckState({ ...base, recheck: "quarterly" }, "2027-01-01")).toEqual({ kind: "due", due: "2027-01-01" });
    expect(recheckState({ ...base, recheck: "yearly" }, "2027-09-30")).toEqual({ kind: "not-due", due: "2027-10-01" });
  });

  test("monthly clamps to the end of the month", () => {
    const head = { checked: "2026-01-31", recheck: "monthly", decisions: [] };
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

  test("an unknown interval is invalid", () => {
    expect(recheckState({ checked: "2026-10-01", recheck: "someday", decisions: [] }, "2026-10-01")).toEqual({
      kind: "invalid",
      problem: "unknown recheck interval (someday)",
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
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a due report warns with its due date and its decisions", () => {
    const { root, deps } = tempProject({
      "DUE.md": report("checked: 2026-09-17\nrecheck: biweekly\ndecisions:\n  - \"DeepInfra as a direct provider\"\n"),
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
      "FRESH.md": report("checked: 2026-10-01\nrecheck: monthly\ndecisions:\n  - \"the provider order\"\n"),
    });
    try {
      const result = researchDueCheck(deps);
      expect(result.status).toBe("pass");
      expect(result.message).toBe("no report is due");
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
      "WORSE.md": report("checked: 2026-10-01\nrecheck: fortnightly\n"),
    });
    try {
      const result = researchDueCheck(deps);
      expect(result.status).toBe("warn");
      expect(result.message).toContain("BAD.md: checked is missing");
      expect(result.message).toContain("WORSE.md: unknown recheck interval (fortnightly)");
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
      expect(result.message).toBe("no report has a recheck head");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("todayString returns YYYY-MM-DD", () => {
  expect(todayString()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});
