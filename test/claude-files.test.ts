import { describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  claudeRoot,
  isLive,
  listSubagents,
  listTranscripts,
  nodeClaudeFs,
  parseJobState,
  parseSessionFile,
  procStartOf,
  projectDirName,
  readJobs,
  readLiveSessions,
  type ClaudeFs,
} from "../src/claude/files";
import { FIXTURE_ROOT, fixtureFs, S1, S2, S7, statLine } from "./claude-fixture";

describe("paths", () => {
  test("the root is $CLAUDE_CONFIG_DIR, else ~/.claude", () => {
    expect(claudeRoot({ CLAUDE_CONFIG_DIR: "/c" })).toBe("/c");
    expect(claudeRoot({ HOME: "/home/user" })).toBe("/home/user/.claude");
  });

  test("the transcript folder replaces each character that is not a letter or a digit", () => {
    expect(projectDirName("/home/user/src/proj-a/.claude/worktrees/x")).toBe("-home-user-src-proj-a--claude-worktrees-x");
  });
});

describe("liveness", () => {
  test("field 22 of /proc/<pid>/stat is the start time, also with a space and a parenthesis in the name", () => {
    expect(procStartOf(statLine(7, "12345"))).toBe("12345");
    expect(procStartOf("garbage")).toBeUndefined();
  });

  const session = parseSessionFile(JSON.stringify({ pid: 9, procStart: "50", sessionId: "s", cwd: "/w" }));

  test("a session file of a live process with the same start time counts", () => {
    const fs = { ...nodeClaudeFs, procStat: () => statLine(9, "50") };
    expect(session !== undefined && isLive(session, fs)).toBe(true);
  });

  test("a session file of a dead pid does not count", () => {
    const fs = { ...nodeClaudeFs, procStat: () => undefined };
    expect(session !== undefined && isLive(session, fs)).toBe(false);
  });

  test("a session file of a reused pid (another start time) does not count", () => {
    const fs = { ...nodeClaudeFs, procStat: () => statLine(9, "51") };
    expect(session !== undefined && isLive(session, fs)).toBe(false);
  });

  test("readLiveSessions keeps only the live files of the fixture", () => {
    const sessions = readLiveSessions(FIXTURE_ROOT, fixtureFs());
    expect(sessions.map((s) => s.sessionId).sort()).toEqual([S1, S2]);
    const interactive = sessions.find((s) => s.sessionId === S1);
    expect(interactive).toMatchObject({
      kind: "interactive",
      status: "waiting",
      waitingFor: "Bash permission",
      tmux: "5:@5.%40",
      updatedAtMs: 1791284100000,
    });
    expect(sessions.find((s) => s.sessionId === S2)).toMatchObject({ kind: "background", jobId: "22222222" });
  });
});

describe("the .key files", () => {
  test("the reader never opens a .key file in the sessions folder", () => {
    const root = mkdtempSync(path.join(tmpdir(), "idfix-claude-keys-"));
    cpSync(FIXTURE_ROOT, root, { recursive: true });
    writeFileSync(path.join(root, "sessions", "1001.key"), "FAKE-SECRET");
    writeFileSync(path.join(root, "sessions", "1001.json.key"), "FAKE-SECRET");
    const opened: string[] = [];
    const guard: ClaudeFs = {
      ...nodeClaudeFs,
      readText(file) {
        if (file.endsWith(".key")) throw new Error(`opened a key file: ${file}`);
        return nodeClaudeFs.readText(file);
      },
      readBytes(file, offset) {
        if (file.endsWith(".key")) throw new Error(`opened a key file: ${file}`);
        return nodeClaudeFs.readBytes(file, offset);
      },
    };
    const sessions = readLiveSessions(root, fixtureFs({ base: guard, opened }));
    expect(sessions).toHaveLength(2);
    expect(opened.filter((file) => file.includes(`${path.sep}sessions${path.sep}`)).every((file) => file.endsWith(".json"))).toBe(true);
    expect(opened.some((file) => file.endsWith(".key"))).toBe(false);
  });
});

describe("job states", () => {
  test("keeps the state, the texts, the times, and the join keys, and drops intent and providerEnv", () => {
    const job = parseJobState(
      JSON.stringify({
        state: "blocked",
        needs: "approve",
        detail: "d",
        createdAt: "2026-10-06T10:00:00.000Z",
        updatedAt: "2026-10-06T10:30:00.000Z",
        intent: "FAKE INTENT TEXT",
        providerEnv: { X: "FAKE-PROVIDER-ENV" },
        sessionId: "s",
        cwd: "/p",
        worktreePath: "/p/.worktrees/w",
      }),
      "j1",
    );
    expect(job).toEqual({
      jobId: "j1",
      sessionId: "s",
      cwd: "/p/.worktrees/w",
      name: undefined,
      state: "blocked",
      detail: "d",
      needs: "approve",
      createdAtMs: Date.parse("2026-10-06T10:00:00.000Z"),
      updatedAtMs: Date.parse("2026-10-06T10:30:00.000Z"),
    });
  });

  test("readJobs reads every job of the fixture without intent or providerEnv", () => {
    const jobs = readJobs(FIXTURE_ROOT, fixtureFs());
    expect(jobs.map((job) => job.jobId).sort()).toEqual(["22222222", "55555555", "66666666"]);
    const text = JSON.stringify(jobs);
    expect(text).not.toContain("FAKE INTENT");
    expect(text).not.toContain("FAKE-PROVIDER-ENV");
  });
});

describe("transcripts", () => {
  test("listTranscripts finds the top-level transcripts by session ID", () => {
    const transcripts = listTranscripts(FIXTURE_ROOT, fixtureFs());
    expect(transcripts.get(S1)?.file).toBe(path.join(FIXTURE_ROOT, "projects", "-home-user-src-proj", `${S1}.jsonl`));
    expect(transcripts.get(S2)?.file).toContain("-home-user-src-proj--worktrees-w2");
    expect(transcripts.has(S7)).toBe(true);
    // The subagent transcripts are not top-level sessions.
    expect([...transcripts.keys()].some((id) => id.startsWith("agent-"))).toBe(false);
  });

  test("listSubagents reads the agent type and the description of the meta file", () => {
    const transcript = path.join(FIXTURE_ROOT, "projects", "-home-user-src-proj", `${S1}.jsonl`);
    expect(listSubagents(transcript, fixtureFs())).toEqual([
      {
        agentId: "a1",
        file: path.join(FIXTURE_ROOT, "projects", "-home-user-src-proj", S1, "subagents", "agent-a1.jsonl"),
        agentType: "Explore",
        description: "Find files",
      },
    ]);
  });
});
