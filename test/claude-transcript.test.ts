import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createTranscriptReader, summarizeTranscript, tokensOf } from "../src/claude/transcript";
import { FIXTURE_ROOT, S1 } from "./claude-fixture";

const encoder = new TextEncoder();
const main = readFileSync(path.join(FIXTURE_ROOT, "projects", "-home-u-dv-proj", `${S1}.jsonl`));

describe("summarizeTranscript", () => {
  const summary = summarizeTranscript(main);

  test("counts one usage per message id, although each line repeats it", () => {
    expect(summary.steps).toBe(2);
    expect(summary.usageByModel.get("claude-opus-5-5")).toEqual({
      input: 15,
      output: 80,
      thinking: 20,
      cacheRead: 1000,
      cacheWrite5m: 200,
      cacheWrite1h: 1000,
    });
  });

  test("keeps the model of the last real assistant line, not the synthetic one", () => {
    expect(summary.model).toBe("claude-opus-5-5");
    expect([...summary.usageByModel.keys()]).toEqual(["claude-opus-5-5"]);
  });

  test("the context size is input plus cache read plus cache write of the last request", () => {
    expect(summary.contextTokens).toBe(5 + 1000 + 200);
    expect(summary.lastThinking).toBe(0);
  });

  test("counts tool calls, titles, the folder, API errors, and the times", () => {
    expect(summary.toolCalls).toBe(1);
    expect(summary.customTitle).toBe("fixture-title");
    expect(summary.aiTitle).toBe("Fixture work");
    expect(summary.agentName).toBe("proj");
    expect(summary.cwd).toBe("/home/u/dv/proj");
    expect(summary.apiErrors).toBe(1);
    expect(summary.firstActivityMs).toBe(Date.parse("2026-10-06T10:00:05.000Z"));
    expect(summary.lastActivityMs).toBe(Date.parse("2026-10-06T10:01:30.000Z"));
  });

  test("keeps no prompt text of user and last-prompt lines", () => {
    const text = JSON.stringify({ ...summary, usageByModel: [...summary.usageByModel] });
    expect(text).not.toContain("FAKE PROMPT");
    expect(text).not.toContain("FAKE LAST PROMPT");
  });

  test("a nested object of a user line does not count as a system line", () => {
    // The tool result line has `"type":"system"` inside `toolUseResult`.
    expect(summary.apiErrors).toBe(1);
  });
});

describe("createTranscriptReader", () => {
  test("keeps an incomplete last line for the next feed", () => {
    const reader = createTranscriptReader();
    const cut = main.indexOf(encoder.encode('"msg_2"')) + 3;
    reader.feed(main.subarray(0, cut));
    expect(reader.summary().steps).toBe(1);
    expect(reader.offset()).toBe(cut);
    reader.feed(main.subarray(cut));
    expect(reader.summary().steps).toBe(2);
    expect(reader.summary()).toEqual(summarizeTranscript(main));
  });

  test("a feed in many small pieces gives the same summary, also across a multibyte character", () => {
    const line = `{"type":"custom-title","customTitle":"Überschrift ✳","sessionId":"x"}\n`;
    const bytes = new Uint8Array([...main, ...encoder.encode(line)]);
    const reader = createTranscriptReader();
    for (let i = 0; i < bytes.length; i += 7) reader.feed(bytes.subarray(i, i + 7));
    expect(reader.summary().customTitle).toBe("Überschrift ✳");
    expect(reader.summary().steps).toBe(2);
  });

  test("a broken line is skipped", () => {
    const reader = createTranscriptReader();
    reader.feed(encoder.encode('{"type":"assistant", broken\n{"type":"ai-title","aiTitle":"ok"}\n'));
    expect(reader.summary().aiTitle).toBe("ok");
  });
});

describe("tokensOf", () => {
  test("without a cache split, all cache writes count as 5-minute writes", () => {
    expect(tokensOf({ input_tokens: 1, cache_creation_input_tokens: 30, output_tokens: 2 })).toEqual({
      input: 1,
      output: 2,
      thinking: 0,
      cacheRead: 0,
      cacheWrite5m: 30,
      cacheWrite1h: 0,
    });
  });
});
