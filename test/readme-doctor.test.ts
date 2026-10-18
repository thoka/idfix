import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { FAST_CHECKS, SLOW_CHECKS } from "../src/doctor";

// The README section "### idfx doctor" documents each check of the registry.
// This test ties the two together, so a new check cannot ship undocumented.

const readme = readFileSync(path.join(import.meta.dir, "..", "README.md"), "utf8");

/** The text from "### idfx doctor" up to the next heading of level 1 to 3. */
function doctorSection(text: string): string {
  const start = text.indexOf("\n### idfx doctor\n");
  if (start < 0) throw new Error("README has no section ### idfx doctor");
  const rest = text.slice(start + 1);
  const end = rest.slice(1).search(/\n#{1,3} /);
  return end < 0 ? rest : rest.slice(0, end + 1);
}

const section = doctorSection(readme);
const tableRows = [...section.matchAll(/^check: `([a-z0-9-]+)`$/gm)].map((m) => m[1] ?? "");
const fixItems = new Set([...section.matchAll(/^- `([a-z0-9-]+)`:/gm)].map((m) => m[1] ?? ""));
const checks = [...FAST_CHECKS, ...SLOW_CHECKS];

describe("README section idfx doctor", () => {
  test("each check of the registry has exactly one table row", () => {
    for (const check of checks) {
      expect({ check: check.name, rows: tableRows.filter((n) => n === check.name).length }).toEqual({ check: check.name, rows: 1 });
    }
  });

  test("no table row names an unknown check", () => {
    const known = new Set(checks.map((c) => c.name));
    expect(tableRows.filter((n) => !known.has(n))).toEqual([]);
  });

  test("each check with a fix or a root fix is in the fix list", () => {
    const missing = checks.filter((c) => (c.fix || c.rootFix) && !fixItems.has(c.name)).map((c) => c.name);
    expect(missing).toEqual([]);
  });
});
