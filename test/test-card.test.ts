import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "..", "scripts", "test-card.ts");
let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "idfix-card-"));
  const pass = join(root, "pass");
  const fail = join(root, "fail");
  mkdirSync(pass);
  mkdirSync(fail);
  writeFileSync(join(pass, "ok.test.ts"), `import { test, expect } from "bun:test";\ntest("one", () => expect(1).toBe(1));\ntest("two", () => expect(2).toBe(2));\n`);
  writeFileSync(
    join(fail, "bad.test.ts"),
    `import { test, expect } from "bun:test";\ntest("good", () => expect(1).toBe(1));\ntest("bad one", () => {\n  const x = 1;\n  expect(x).toBe(2);\n});\ntest("bad two", () => {\n  const x = 1;\n  expect(x).toBe(3);\n});\n`,
  );
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

async function run(dir: string) {
  const logs = join(root, "logs");
  const proc = Bun.spawn(["bun", script], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, DV_TEST_CARD_DIR: logs },
  });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  const lines = (out + err).replace(/\x1b\[[0-9;]*m/g, "").trimEnd().split("\n");
  return { code, lines };
}

test("a passing suite ends with a PASS card and exit 0", async () => {
  const { code, lines } = await run(join(root, "pass"));
  expect(code).toBe(0);
  const last = lines.slice(-2);
  expect(last[0]).toMatch(/^verdict PASS exit 0: 2 total 2 passed 0 failed 0 skipped in [\d.]+s$/);
  expect(last[1]).toMatch(/^full output: .+\.log$/);
  const log = last[1]!.replace("full output: ", "");
  expect(readFileSync(log, "utf8")).toContain("verdict PASS");
}, 60000);

test("a failing suite ends with a FAIL card, the first failure, a cut note, and exit 1", async () => {
  const { code, lines } = await run(join(root, "fail"));
  expect(code).toBe(1);
  const i = lines.findIndex((l) => l.startsWith("verdict "));
  const card = lines.slice(i);
  expect(card[0]).toMatch(/^verdict FAIL exit 1: 3 total 1 passed 2 failed 0 skipped in [\d.]+s$/);
  expect(card[1]).toMatch(/^first failure: .*bad\.test\.ts:\d+ bad one$/);
  expect(card[2]).toMatch(/^full output: /);
  expect(card[3]).toBe("cut: 1 more failures (see the full output)");
  expect(card.length).toBe(4);
}, 60000);
