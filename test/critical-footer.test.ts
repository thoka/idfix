import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  appendCriticalFooter,
  criticalFooterFile,
  extractCriticalFooter,
  readCriticalFooter,
} from "../src/critical-footer";
import { run, type RunDeps } from "../src/run";

const FOOTER = "---\nCritical analysis. Answer in this structure:\n1. Premises.\n4. The cost of autonomy.";
const SKILL = [
  "# Critical research",
  "",
  "```",
  "not the footer",
  "```",
  "",
  "## The footer",
  "",
  "Add this footer to the end of every research question.",
  "",
  "```",
  FOOTER,
  "```",
  "",
  "## In a report",
  "",
  "```",
  "---",
  "later block",
  "```",
  "",
].join("\n");

const BASE = "/tmp/opencode/critical-footer-test";
const SHARED = path.join(BASE, "shared");
const ENV = { OC_SUB_SHARED_DIR: SHARED };

beforeAll(() => {
  rmSync(BASE, { recursive: true, force: true });
  mkdirSync(path.join(SHARED, "skills", "critical-research"), { recursive: true });
  writeFileSync(path.join(SHARED, "skills", "critical-research", "SKILL.md"), SKILL);
});

afterAll(() => rmSync(BASE, { recursive: true, force: true }));

describe("extractCriticalFooter", () => {
  test("returns the first fenced block after the footer heading", () => {
    expect(extractCriticalFooter(SKILL)).toBe(FOOTER);
  });

  test("returns null without the heading, without a block, or when the block does not start with ---", () => {
    expect(extractCriticalFooter("# Skill\n```\n---\nx\n```\n")).toBeNull();
    expect(extractCriticalFooter("## The footer\n\ntext\n\n## Next\n```\n---\n```\n")).toBeNull();
    expect(extractCriticalFooter("## The footer\n```\nno rule line\n```\n")).toBeNull();
    expect(extractCriticalFooter("## The footer\n```\n---\nunclosed\n")).toBeNull();
  });
});

describe("readCriticalFooter", () => {
  test("reads the skill file in the shared folder", () => {
    expect(criticalFooterFile(ENV)).toBe(path.join(SHARED, "skills", "critical-research", "SKILL.md"));
    expect(readCriticalFooter(ENV)).toBe(FOOTER);
  });

  test("a missing file names the file", () => {
    const env = { OC_SUB_SHARED_DIR: path.join(BASE, "missing") };
    expect(() => readCriticalFooter(env)).toThrow(path.join(BASE, "missing", "skills", "critical-research", "SKILL.md"));
  });

  test("without OC_SUB_SHARED_DIR there is no file, and the error names the variable", () => {
    expect(criticalFooterFile({ HOME: "/home/user" })).toBeUndefined();
    expect(criticalFooterFile({ OC_SUB_SHARED_DIR: " " })).toBeUndefined();
    expect(() => readCriticalFooter({ HOME: "/home/user" })).toThrow(
      "cannot read the critical-research footer: OC_SUB_SHARED_DIR is not set.",
    );
  });

  test("a missing block names the file", () => {
    expect(() => readCriticalFooter(ENV, () => "# Skill without footer\n")).toThrow(
      `no footer in ${criticalFooterFile(ENV)}`,
    );
  });

  test("the real skill file in the shared folder of this machine has the footer", () => {
    const env = { OC_SUB_SHARED_DIR: process.env.OC_SUB_SHARED_DIR };
    const file = criticalFooterFile(env);
    if (file === undefined || !existsSync(file)) {
      console.log(`skip: ${file ?? "OC_SUB_SHARED_DIR is not set, so the skill file"} does not exist`);
      return;
    }
    const footer = readCriticalFooter(env);
    expect(footer.startsWith("---")).toBe(true);
    expect(footer).toContain("Critical analysis.");
    expect(readFileSync(file, "utf8")).toContain(footer);
  });
});

describe("appendCriticalFooter", () => {
  test("appends the footer after a blank line", () => {
    expect(appendCriticalFooter("The question?\n", FOOTER)).toBe(`The question?\n\n${FOOTER}\n`);
  });

  test("does not append the footer twice", () => {
    const once = appendCriticalFooter("The question?", FOOTER);
    expect(appendCriticalFooter(once, FOOTER)).toBe(once);
    expect(appendCriticalFooter(`Q\n\n${FOOTER}\n\n  `, FOOTER)).toBe(`Q\n\n${FOOTER}\n\n  `);
  });
});

describe("idfx run and the critical-research footer", () => {
  async function sentText(agent: string, text: string, env: Record<string, string>): Promise<string> {
    const bodies: { parts: { text: string }[] }[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (request) => {
        const url = new URL(request.url);
        if (url.pathname === "/global/health") return Response.json({ healthy: true, version: "1.0.0" });
        if (url.pathname === "/config/providers") return Response.json({ providers: [], default: {} });
        if (url.pathname === "/project") return Response.json([]);
        if (url.pathname === "/session" && request.method === "POST") return Response.json({ id: "ses_f" });
        if (url.pathname.endsWith("/prompt_async") && request.method === "POST") {
          bodies.push((await request.json()) as { parts: { text: string }[] });
          return new Response(null, { status: 200 });
        }
        return new Response("not found", { status: 404 });
      },
    });
    const deps: RunDeps = {
      fetch: async () => Response.json({ data: {} }),
      projectName: (d) => d,
      worktreesOf: (d) => [d],
      exists: () => true,
      cwd: path.join(BASE, "cwd"),
      existsInSandbox: () => true,
    };
    const fullEnv = { ...env, XDG_STATE_HOME: path.join(BASE, "state") };
    try {
      await run({ agent, dir: "/x", text, url: `http://127.0.0.1:${server.port}` }, fullEnv, deps);
    } finally {
      server.stop(true);
    }
    expect(bodies).toHaveLength(1);
    return bodies[0]?.parts[0]?.text ?? "";
  }

  test("appends the footer to the brief of the researcher", async () => {
    expect(await sentText("researcher", "The question?", ENV)).toBe(`The question?\n\n${FOOTER}\n`);
  });

  test("keeps a researcher brief that already ends with the footer", async () => {
    const brief = `The question?\n\n${FOOTER}\n`;
    expect(await sentText("researcher", brief, ENV)).toBe(brief);
  });

  test("gives the coder no footer and needs no skill file", async () => {
    expect(await sentText("coder", "Do it.", { OC_SUB_SHARED_DIR: path.join(BASE, "missing") })).toBe("Do it.");
  });

  test("stops a researcher run when the skill file is missing", async () => {
    const env = { OC_SUB_SHARED_DIR: path.join(BASE, "missing"), XDG_STATE_HOME: path.join(BASE, "state") };
    const deps: RunDeps = {
      fetch: async () => Response.json({ data: {} }),
      projectName: (d) => d,
      worktreesOf: (d) => [d],
      exists: () => true,
      cwd: path.join(BASE, "cwd"),
      existsInSandbox: () => true,
    };
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (request) =>
        new URL(request.url).pathname === "/global/health"
          ? Response.json({ healthy: true, version: "1.0.0" })
          : new Response("not found", { status: 404 }),
    });
    try {
      await expect(
        run({ agent: "researcher", dir: "/x", text: "Q", url: `http://127.0.0.1:${server.port}` }, env, deps),
      ).rejects.toThrow(path.join(BASE, "missing", "skills", "critical-research", "SKILL.md"));
    } finally {
      server.stop(true);
    }
  });
});
