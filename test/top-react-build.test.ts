/**
 * Tests that the live view of `top` loads the production build of React.
 * The development build keeps data of every render, so a long `top` leaked
 * gigabytes. Each test runs `loadView` in a child bun process, because a
 * module that loaded once stays in the cache of the test process.
 */
import { describe, expect, test } from "bun:test";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");

/** The child script: load the view like `top` does, then print the loaded React files. */
const CHILD = `
const { loadView } = await import(${JSON.stringify(path.join(ROOT, "src/top/load.ts"))});
await loadView();
const files = Object.keys(require.cache).filter((key) => /\\/react\\/cjs\\/react\\.[a-z]+\\.js$/.test(key));
console.log(JSON.stringify({ nodeEnv: process.env.NODE_ENV, files: files.map((file) => path.basename(file)) }));
`;

/** The environment of the child: no git variables of a hook, and no NODE_ENV unless given. */
function childEnv(nodeEnv?: string): Record<string, string> {
  const git = Bun.spawnSync(["git", "rev-parse", "--local-env-vars"], { cwd: ROOT });
  const drop = new Set([...git.stdout.toString().split("\n").filter(Boolean), "NODE_ENV"]);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !drop.has(key)) env[key] = value;
  }
  if (nodeEnv !== undefined) env.NODE_ENV = nodeEnv;
  return env;
}

function runChild(nodeEnv?: string): { nodeEnv?: string; files: string[] } {
  const child = Bun.spawnSync([process.execPath, "-e", `import path from "node:path";${CHILD}`], {
    cwd: ROOT,
    env: childEnv(nodeEnv),
  });
  if (child.exitCode !== 0) throw new Error(`child failed: ${child.stderr.toString()}`);
  return JSON.parse(child.stdout.toString().trim().split("\n").at(-1) ?? "{}");
}

describe("loadView", () => {
  test("loads the production build of React when NODE_ENV is not set", () => {
    const result = runChild();
    expect(result.files).toEqual(["react.production.js"]);
    expect(result.nodeEnv).toBe("production");
  });

  test("keeps NODE_ENV=development that the user set", () => {
    const result = runChild("development");
    expect(result.files).toEqual(["react.development.js"]);
    expect(result.nodeEnv).toBe("development");
  });
});
