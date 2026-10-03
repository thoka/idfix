import { describe, expect, test } from "bun:test";
import { run, splitModel } from "../src/run";
import { parseArgs, UsageError } from "../src/args";

describe("splitModel", () => {
  test("splits at the first slash", () => {
    expect(splitModel("openrouter/glm-probe-baseten")).toEqual({
      providerID: "openrouter",
      modelID: "glm-probe-baseten",
    });
    expect(splitModel("a/b/c")).toEqual({ providerID: "a", modelID: "b/c" });
  });

  test("keeps the slash of a DeepInfra model ID in the model ID", () => {
    expect(splitModel("deepinfra/zai-org/GLM-5.3-Flash")).toEqual({
      providerID: "deepinfra",
      modelID: "zai-org/GLM-5.3-Flash",
    });
  });

  test("rejects a value without a slash", () => {
    expect(() => splitModel("glm")).toThrow("PROVIDER/MODEL");
    expect(() => splitModel("/glm")).toThrow("PROVIDER/MODEL");
    expect(() => splitModel("glm/")).toThrow("PROVIDER/MODEL");
  });
});

describe("run --model argument", () => {
  test("parses and forwards the model flag", () => {
    const args = parseArgs(["run", "--agent", "coder", "--dir", "/x", "hi", "--model", "openrouter/glm-probe-baseten"]);
    expect(args.command === "run" && args.model).toBe("openrouter/glm-probe-baseten");
  });

  test("accepts a DeepInfra model with a slash in its model ID", () => {
    const args = parseArgs(["run", "--agent", "coder", "--dir", "/x", "hi", "--model", "deepinfra/zai-org/GLM-5.3-Flash"]);
    expect(args.command === "run" && args.model).toBe("deepinfra/zai-org/GLM-5.3-Flash");
  });

  test("rejects a model value without a slash", () => {
    expect(() => parseArgs(["run", "--agent", "coder", "--dir", "/x", "hi", "--model", "glm"])).toThrow(UsageError);
  });
});

describe("run --model request body", () => {
  test("passes the model in the prompt request only with the flag", async () => {
    const bodies: unknown[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (request) => {
        const url = new URL(request.url);
        if (url.pathname === "/global/health") return Response.json({ healthy: true, version: "1.0.0" });
        if (url.pathname === "/config/providers") return Response.json({ providers: [], default: {} });
        if (url.pathname === "/project") return Response.json([]);
        if (url.pathname === "/session" && request.method === "POST") return Response.json({ id: "ses_m" });
        if (url.pathname.endsWith("/prompt_async") && request.method === "POST") {
          bodies.push(await request.json());
          return new Response(null, { status: 200 });
        }
        return new Response("not found", { status: 404 });
      },
    });
    const url = `http://127.0.0.1:${server.port}`;
    const deps = {
      fetch: async () => Response.json({ data: {} }),
      projectName: (d: string) => d,
      worktreesOf: (d: string) => [d],
      exists: () => true,
      cwd: "/tmp/opencode/run-model-test",
      existsInSandbox: () => true,
    };
    try {
      await run({ agent: "coder", dir: "/x", text: "hi", url, model: "openrouter/glm-probe-baseten" }, {}, deps);
      await run({ agent: "coder", dir: "/x", text: "hi", url }, {}, deps);
    } finally {
      server.stop(true);
    }
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toMatchObject({
      agent: "coder",
      model: { providerID: "openrouter", modelID: "glm-probe-baseten" },
    });
    expect(bodies[1]).not.toHaveProperty("model");
  });
});
