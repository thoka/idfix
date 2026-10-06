import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { OpencodeClient } from "@opencode-ai/sdk";
import { realCostOutput } from "../src/realcost";

const TMP = "/tmp/opencode/realcost-test";
const ENV = { XDG_STATE_HOME: path.join(TMP, "state") };
const STATE = path.join(ENV.XDG_STATE_HOME, "idfx");

/** An SDK client that realCostOutput never reaches in these tests. */
const CLIENT = {} as OpencodeClient;

function endLine(session: string): string {
  return JSON.stringify({
    source: "oc-sub-cost-proxy",
    event: "end",
    session,
    upstream: "deepinfra",
    cost: 0.0005,
  });
}

describe("realCostOutput", () => {
  test("shows the proxy line when the log covers the session tree", async () => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(STATE, { recursive: true });
    writeFileSync(path.join(STATE, "serve-4096.log"), `${endLine("ses_main")}\n${endLine("ses_sub")}\n`);
    const line = await realCostOutput(CLIENT, "ses_main", ENV, ["ses_main", "ses_sub"]);
    expect(line).toBe("real cost $0.0010 from the cost proxy (2 requests, deepinfra $0.0010)");
    rmSync(TMP, { recursive: true, force: true });
  });

  test("falls back to the OpenRouter path when the log has no line for the tree", async () => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(STATE, { recursive: true });
    writeFileSync(path.join(STATE, "proxy-4097.log"), `${endLine("ses_other")}\n`);
    const line = await realCostOutput(CLIENT, "ses_main", ENV, ["ses_main"]);
    expect(line).toBe("real cost: unknown (no key usage at the start of the run)");
    rmSync(TMP, { recursive: true, force: true });
  });
});
