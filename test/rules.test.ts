import { describe, expect, spyOn, test } from "bun:test";
import { pingRules, RULES_AGENT, RULES_PROMPT, RULES_VARIANT, type RulesClient, type RulesDeps } from "../src/rules";
import type { MessageEntry } from "../src/summary";

const HEADING = "# ZEPHYR-8817 scratch rules";
const SHARED_DIR = "/home/user/agents";
const SHARED_FILE = `${SHARED_DIR}/AGENTS.md`;
const ENV = { HOME: "/home/user", IDFX_SHARED_DIR: SHARED_DIR };
const DIR = "/repo";

/** A message entry with one text part, in the shape of the SDK. */
function message(role: "user" | "assistant", text: string, cost = 0): MessageEntry {
  return {
    info: {
      id: "msg_1",
      role,
      sessionID: "ses_1",
      cost,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 0 },
    },
    parts: [{ type: "text", text, time: { start: 0, end: 0 } }],
  } as unknown as MessageEntry;
}

type Calls = { prompt: Array<{ session: string; text: string }>; deleted: string[] };

/** A fake client with a scripted reply, recording what it got. */
function fakeClient(reply: string | null, failDelete = false): { client: RulesClient; calls: Calls; cost: number } {
  const calls: Calls = { prompt: [], deleted: [] };
  const cost = 0.0012;
  const client: RulesClient = {
    createSession: async () => "ses_check1",
    prompt: async (session, _dir, text) => {
      calls.prompt.push({ session, text });
    },
    messages: async () => [message("user", RULES_PROMPT), message("assistant", reply ?? "", cost)],
    deleteSession: async (session) => {
      if (failDelete) return false;
      calls.deleted.push(session);
      return true;
    },
  };
  return { client, calls, cost };
}

function makeDeps(
  files: Record<string, string | null>,
  client: RulesClient,
): RulesDeps {
  return {
    readText: async (file) => files[file] ?? null,
    checkServer: async () => {},
    client: () => client,
  };
}

function capturePrint(): { out: string[]; err: string[]; restore: () => void } {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...args: unknown[]) => out.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => err.push(args.map(String).join(" "));
  return { out, err, restore: () => { console.log = log; console.error = error; } };
}

describe("the rules prompt constants", () => {
  test("uses the researcher agent with low reasoning effort", () => {
    expect(RULES_AGENT).toBe("researcher");
    expect(RULES_VARIANT).toBe("low");
    expect(RULES_PROMPT).toContain("AGENTS.md");
    expect(RULES_PROMPT).toContain("NONE");
  });
});

describe("pingRules", () => {
  test("passes when the reply contains the first heading, and deletes the session", async () => {
    const { client, calls } = fakeClient(HEADING);
    const printed = capturePrint();
    let code: number;
    try {
      code = await pingRules({ dir: DIR }, ENV, makeDeps({ [SHARED_FILE]: `${HEADING}\n\nbody\n` }, client));
    } finally {
      printed.restore();
    }
    expect(code).toBe(0);
    expect(calls.prompt).toEqual([{ session: "ses_check1", text: RULES_PROMPT }]);
    expect(calls.deleted).toEqual(["ses_check1"]);
    expect(printed.out).toEqual(["rules: pass ($0.0012)"]);
  });

  test("passes when the reply wraps the heading", async () => {
    const { client } = fakeClient(`The heading is:\n${HEADING}\n`);
    const printed = capturePrint();
    let code: number;
    try {
      code = await pingRules({ dir: DIR }, ENV, makeDeps({ [SHARED_FILE]: `${HEADING}\n` }, client));
    } finally {
      printed.restore();
    }
    expect(code).toBe(0);
  });

  test("fails on NONE, keeps the exit code, and still deletes the session", async () => {
    const { client, calls } = fakeClient("NONE");
    const printed = capturePrint();
    let code: number;
    try {
      code = await pingRules({ dir: DIR }, ENV, makeDeps({ [SHARED_FILE]: `${HEADING}\n` }, client));
    } finally {
      printed.restore();
    }
    expect(code).toBe(1);
    expect(calls.deleted).toEqual(["ses_check1"]);
    expect(printed.out[0]).toContain("rules: FAIL");
    expect(printed.out[0]).toContain(HEADING);
  });

  test("fails without any assistant reply", async () => {
    const { client } = fakeClient(null);
    const printed = capturePrint();
    let code: number;
    try {
      code = await pingRules({ dir: DIR }, ENV, makeDeps({ [SHARED_FILE]: `${HEADING}\n` }, client));
    } finally {
      printed.restore();
    }
    expect(code).toBe(1);
  });

  test("warns but keeps the exit code when the session deletion fails", async () => {
    const { client } = fakeClient(HEADING, true);
    const printed = capturePrint();
    let code: number;
    try {
      code = await pingRules({ dir: DIR }, ENV, makeDeps({ [SHARED_FILE]: `${HEADING}\n` }, client));
    } finally {
      printed.restore();
    }
    expect(code).toBe(0);
    expect(printed.err[0]).toContain("could not delete");
  });

  test("stops with an error when the shared file is missing", async () => {
    const { client, calls } = fakeClient(HEADING);
    const printed = capturePrint();
    let code: number;
    try {
      code = await pingRules({ dir: DIR }, ENV, makeDeps({}, client));
    } finally {
      printed.restore();
    }
    expect(code).toBe(1);
    expect(calls.prompt).toHaveLength(0);
    expect(calls.deleted).toHaveLength(0);
    expect(printed.err.join("\n")).toContain(SHARED_FILE);
    expect(printed.err.join("\n")).toContain("IDFX_SHARED_DIR");
  });

  test("stops with an error when the shared file has no heading", async () => {
    const { client, calls } = fakeClient(HEADING);
    const printed = capturePrint();
    let code: number;
    try {
      code = await pingRules({ dir: DIR }, ENV, makeDeps({ [SHARED_FILE]: "no heading here\n" }, client));
    } finally {
      printed.restore();
    }
    expect(code).toBe(1);
    expect(calls.prompt).toHaveLength(0);
    expect(printed.err[0]).toContain('starts with "# "');
  });

  test("reads the shared file from IDFX_SHARED_DIR", async () => {
    const { client } = fakeClient(HEADING);
    const printed = capturePrint();
    let code: number;
    try {
      code = await pingRules(
        { dir: DIR },
        { HOME: "/home/user", IDFX_SHARED_DIR: "/srv/agents" },
        makeDeps({ "/srv/agents/AGENTS.md": `${HEADING}\n` }, client),
      );
    } finally {
      printed.restore();
    }
    expect(code).toBe(0);
  });

  for (const [label, env] of [
    ["unset", { HOME: "/home/user" }],
    ["blank", { HOME: "/home/user", IDFX_SHARED_DIR: "  " }],
  ] as const) {
    test(`stops with an error that names the variable when IDFX_SHARED_DIR is ${label}`, async () => {
      const { client, calls } = fakeClient(HEADING);
      const printed = capturePrint();
      let code: number;
      try {
        code = await pingRules({ dir: DIR }, env, makeDeps({ [SHARED_FILE]: `${HEADING}\n` }, client));
      } finally {
        printed.restore();
      }
      expect(code).toBe(1);
      expect(calls.prompt).toHaveLength(0);
      expect(printed.err).toEqual([
        "error: IDFX_SHARED_DIR is not set.",
        "Set IDFX_SHARED_DIR to the folder that holds AGENTS.md (your global rules) and skills/<name>/SKILL.md (your skills).",
      ]);
    });
  }

});
