# Plan

## Background

In the project terminator (September 2026), four research runs with the template `researcher.md` cost 0.22 to 0.70 USD each. The earlier runs in [EXPERIENCE.md](EXPERIENCE.md) cost 0.08 to 0.09 USD.

Root cause: the template denies the `task` tool, so the researcher fetches every page itself. Each page stays in its context until the run ends, and the model reads the whole context again at every step. In the most expensive run, 67 fetches returned up to 51,000 characters each. The context grew to 395,000 tokens over 80 steps. The model re-read 17.3 million tokens of cached context, and these re-reads made up 75 percent of the cost.

The option `compaction.prune` of opencode does not help. It prunes tool output only after the run ends, and it skips the current user turn (`packages/opencode/src/session/compaction.ts`).

Fix, tested in terminator: the researcher cannot fetch pages. It calls a hidden subagent `reader` through the task tool. The reader fetches the pages in a fresh context and returns at most 600 words of quotes with URLs. A small test run then re-read only 191,000 tokens in the main session and cost 0.08 USD with four reader calls.

The test also showed a reporting gap. `oc-sub watch` reported 0.015 USD, because it counts only the main session. The reader calls run in child sessions (`session.parent_id`), and they cost another 0.067 USD.

The tested agent files are in the terminator repository: `~/dv/terminator/.opencode/agents/researcher.md` and `~/dv/terminator/.opencode/agents/reader.md`.

## Step 1: The plugin serves the research agents

Status: done.

1. Add `opencode/agents/researcher.md` and `opencode/agents/reader.md` to the plugin, with the content of the tested files in terminator.
2. `oc-sub up` starts `opencode serve` with `OPENCODE_CONFIG_DIR` set to the absolute path of `opencode/` in the plugin. If the environment already sets `OPENCODE_CONFIG_DIR`, `oc-sub up` keeps it and prints a warning. See the opencode documentation, "Custom directory": https://opencode.ai/docs/config/
3. Remove `skills/oc-sub/templates/researcher.md`. Keep `templates/coder.md`, because each project has its own test command.
4. Update `SKILL.md`, `reference.md`, and `docs/GUIDE.md`: research needs no agent file in the project. An agent from `OPENCODE_CONFIG_DIR` overrides a project agent with the same name.
5. Tests with `bun test`: the spawn environment of `oc-sub up` contains `OPENCODE_CONFIG_DIR`, and an existing value stays.

## Step 2: Cost of child sessions

Status: open.

1. `oc-sub watch` and `oc-sub log` add the cost and the tokens of all child sessions of the session, recursively. The output shows the total and the share of the subagents, for example `cost $0.0816 (subagents $0.0665 in 4 sessions)`.
2. `oc-sub watch` waits until the child sessions are idle too.
3. Tests with `bun test` and invented session data.

## Step 3: Check in terminator

Status: open.

1. Remove `researcher.md` and `reader.md` from `~/dv/terminator/.opencode/agents/`.
2. Run `oc-sub restart`, then a small research run in a worktree of terminator.
3. Make sure that the run uses the plugin agents, calls `reader`, and reports the cost of the child sessions.
4. Add the result to [EXPERIENCE.md](EXPERIENCE.md).

## Step 4: Questions and permission requests go to the orchestrator

Status: open.

Root cause: the agent files deny the `question` tool and use `deny` for risky commands, because "nobody answers questions in a run" (`skills/oc-sub/reference.md`). A denied agent gets an error and looks for a detour. In the step 1 run, GLM tried `rm` after the allowlist blocked the deletion of a file. opencode has the missing channel already. The `question` tool and the `ask` permission pause the session, and the server lists and answers the pending requests.

1. Research first, with a report in `docs/research/`. How do established tools let an orchestrator answer the question or the permission request of a subagent? Cover at least opencode itself (the `question` tool, `ask` permissions, the server endpoints and events in 1.18.32), `opencode-mcp`, the Claude Agent SDK (`canUseTool`), the Agent Client Protocol (`session/request_permission`), the A2A protocol (`input-required`), MCP elicitation, the OpenAI Agents SDK, and LangGraph (`interrupt`). Name the pattern that most of them share, and what `oc-sub` can reuse.
2. Decide the design with the user, based on the report.
3. Implement it in small steps with tests. The likely parts: the agent files allow `question` and use `ask` for risky commands. `oc-sub watch` shows a pending request and ends. A new command answers or rejects it in the same session.
