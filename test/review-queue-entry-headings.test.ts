import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { metaSchemas } from "./meta-schemas";

// Step 4sWEeYpu (phase 0 item 4 of the switch of the data tool): the review queue moves its dated headings to the heading
// form of an entry, `## Entry <id>: <date>`, through `mg migrate --to entry-headings`. A fixture copy with dated headings
// and entries runs through mg, and the result equals the golden file with no lost word. The test skips without an mg
// that knows the change, and reads no live data.

const FIXTURES = join(import.meta.dir, "fixtures", "review-queue");

function mg(args: string[], cwd: string) {
  const found = Bun.which("mg");
  if (found === null) return null;
  const result = Bun.spawnSync([found, ...args], { cwd, env: { ...process.env, MARKGRAF_ROOTS: cwd, MARKGRAF_SCHEMAS: metaSchemas() } });
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
}

function knowsChange(): boolean {
  const probe = mg(["migrate", "--to", "entry-headings", "/nonexistent.md"], tmpdir());
  // An mg that knows the change refuses only the missing file; an old or broken mg says something else.
  return probe !== null && probe.err.includes("the file or folder does not exist");
}

function words(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const word of text.split(/[^\p{L}\p{N}]+/u)) if (word !== "") counts.set(word, (counts.get(word) ?? 0) + 1);
  return counts;
}

describe("the review queue in the heading form of an entry (step 4sWEeYpu)", () => {
  test.skipIf(!knowsChange())("mg migrate --to entry-headings gives each dated heading an ID and loses no word", () => {
    const root = mkdtempSync(join(tmpdir(), "idfix-review-queue-"));
    mkdirSync(join(root, "docs"));
    const file = join(root, "docs", "review-queue.md");
    const old = readFileSync(join(FIXTURES, "old.md.txt"), "utf8");
    writeFileSync(file, old);

    const moved = mg(["migrate", "--to", "entry-headings", "docs/review-queue.md"], root)!;
    expect(moved.err).toBe("");
    expect(moved.code).toBe(0);
    const text = readFileSync(file, "utf8");
    expect(text).toBe(readFileSync(join(FIXTURES, "golden.md.txt"), "utf8"));

    const dump = mg(["dump", "docs/review-queue.md"], root)!;
    expect(dump.code).toBe(0);
    const data = JSON.parse(dump.out) as { nodes: { id: string; type: string; props: Record<string, unknown> }[]; problems: unknown[] };
    expect(data.problems).toEqual([]);
    const entries = data.nodes.filter((node) => node.type === "review-entry");
    // Three dated headings and two entries that had an ID.
    expect(entries.length).toBe(5);
    for (const entry of entries) expect(entry.id).toMatch(/^[A-Za-z0-9]{8}$/);
    // Each dated heading is the first line of the text of one entry.
    for (const line of old.split("\n").filter((each) => /^## \d{4}-/.test(each))) {
      expect(entries.some((entry) => String(entry.props.text).startsWith(line.slice(3)))).toBe(true);
    }
    // The words: the old words, and per new heading the word Entry, its date, and its new ID.
    const want = words(old);
    for (const entry of entries.filter((each) => !old.includes(each.id))) {
      for (const [word, n] of words(`Entry ${String(entry.props.title)} ${entry.id}`)) want.set(word, (want.get(word) ?? 0) + n);
    }
    expect(Object.fromEntries([...words(text)].sort())).toEqual(Object.fromEntries([...want].sort()));
  });
});
