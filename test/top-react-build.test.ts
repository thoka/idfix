/**
 * Tests that the live view of `top` loads the production build of React and
 * renders, on the real start path from a folder outside the repository.
 *
 * The development build of React keeps data of every render, so a long `top`
 * leaked gigabytes. Bun picks its JSX transform, and React picks
 * its build, from `NODE_ENV` when the process starts. So `bin/idfx` must
 * set `NODE_ENV`, and nothing may change it later.
 *
 * Each test runs the real `bin/idfx` in a temp folder, with a fake `bun`
 * first on the PATH. The fake answers `--version` with the real bun. For the
 * final `exec`, it runs a child script instead of `src/cli.ts`, with the same
 * environment and folder. The child loads the view like `top` does, renders
 * `TopView` once with ink-testing-library and a stub `start`, and prints the
 * result as JSON: the error of a render, the frame, and the loaded React build.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const TEMP = mkdtempSync(path.join(tmpdir(), "idfx-react-build-"));
afterAll(() => rmSync(TEMP, { recursive: true, force: true }));

/** Resolve a package from the repository, because the child runs outside it. */
const fromRoot = (name: string) => Bun.resolveSync(name, ROOT);

/** The child script: no JSX of its own, so only the transform of the start path matters. */
const CHILD = `
const result = { nodeEnv: process.env.NODE_ENV, threw: null, frame: "", files: [] };
try {
  const { loadView } = await import(${JSON.stringify(path.join(ROOT, "src/top/load.ts"))});
  await loadView();
  const { TopView } = await import(${JSON.stringify(path.join(ROOT, "src/top/view.tsx"))});
  const React = (await import(${JSON.stringify(fromRoot("react"))})).default;
  const { render } = await import(${JSON.stringify(fromRoot("ink-testing-library"))});
  const source = {
    model: { rows: () => [], session: () => undefined },
    onChange: () => {},
    servers: () => [],
    stop: () => {},
  };
  // Ink swallows an error of a component, so a boundary records it.
  class Catch extends React.Component {
    state = { failed: false };
    static getDerivedStateFromError() { return { failed: true }; }
    componentDidCatch(error) { result.threw = String(error); }
    render() { return this.state.failed ? null : this.props.children; }
  }
  const view = render(React.createElement(Catch, null, React.createElement(TopView, {
    start: async () => source,
    initialAll: true,
    scopeLabel: "~/probe",
    nowMs: () => 0,
    redrawMs: 60000,
  })));
  await new Promise((resolve) => setTimeout(resolve, 100));
  result.frame = view.lastFrame() ?? "";
  view.unmount();
} catch (error) {
  result.threw = String(error);
}
result.files = Object.keys(require.cache)
  .filter((key) => /\\/react\\/cjs\\/react\\.[a-z]+\\.js$/.test(key))
  .map((key) => key.split("/").at(-1));
console.log(JSON.stringify(result));
process.exit(0);
`;

const childFile = path.join(TEMP, "child.ts");
writeFileSync(childFile, CHILD);

/** The fake `bun`: the real one for `--version` and `install`, else the child script. */
const fakeBin = path.join(TEMP, "bin");
Bun.spawnSync(["mkdir", "-p", fakeBin]);
writeFileSync(
  path.join(fakeBin, "bun"),
  `#!/bin/sh
case "$1" in
  --version|install) exec ${JSON.stringify(process.execPath)} "$@" ;;
esac
exec ${JSON.stringify(process.execPath)} ${JSON.stringify(childFile)}
`,
);
chmodSync(path.join(fakeBin, "bun"), 0o755);

/** The environment of the start: no git variables of a hook, no NODE_ENV unless given, the fake bun first. */
function startEnv(nodeEnv?: string): Record<string, string> {
  const git = Bun.spawnSync(["git", "rev-parse", "--local-env-vars"], { cwd: ROOT });
  const drop = new Set([...git.stdout.toString().split("\n").filter(Boolean), "NODE_ENV"]);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !drop.has(key)) env[key] = value;
  }
  env.PATH = `${fakeBin}:${env.PATH ?? ""}`;
  if (nodeEnv !== undefined) env.NODE_ENV = nodeEnv;
  return env;
}

type ChildResult = { nodeEnv?: string; threw: string | null; frame: string; files: string[] };

/** Run `bin/idfx top --all` in the temp folder, outside the repository. */
function startTop(nodeEnv?: string): ChildResult {
  const child = Bun.spawnSync([path.join(ROOT, "bin/idfx"), "top", "--all"], {
    cwd: TEMP,
    env: startEnv(nodeEnv),
  });
  if (child.exitCode !== 0) throw new Error(`start failed: ${child.stderr.toString()}`);
  return JSON.parse(child.stdout.toString().trim().split("\n").at(-1) ?? "{}");
}

describe("the start path of top outside the repository", () => {
  test("loads the production build of React and renders when NODE_ENV is not set", () => {
    const result = startTop();
    expect(result.threw).toBeNull();
    expect(result.frame).toContain("scope: all projects");
    expect(result.files).toEqual(["react.production.js"]);
    expect(result.nodeEnv).toBe("production");
  }, 20_000);

  test("keeps NODE_ENV=development that the user set, and renders", () => {
    const result = startTop("development");
    expect(result.threw).toBeNull();
    expect(result.frame).toContain("scope: all projects");
    expect(result.files).toEqual(["react.development.js"]);
    expect(result.nodeEnv).toBe("development");
  }, 20_000);
});
