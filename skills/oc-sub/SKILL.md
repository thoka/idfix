---
name: oc-sub
description: Delegate research or a small coding step to a cheap opencode subagent with the oc-sub tool. Watch the run and review the result.
when_to_use: The user asks to delegate work to opencode, GLM, or a cheap subagent. The user asks about an oc-sub run (start, watch, follow up, abort, cost). A plan has a research question or a small coding step with a precise brief.
allowed-tools: Bash(oc-sub *)
---

# Delegate work to an opencode subagent

`oc-sub` drives an `opencode serve` server on 127.0.0.1. You write a brief, start a run, give the user a command to watch it live, and review the result yourself. The full command reference and the details are in [reference.md](reference.md). The coder agent template is in [templates/coder.md](templates/coder.md).

## When to delegate

Delegate:

- A research question. The agent writes a report into the repository, for example `docs/research/<topic>.md`. Research needs no agent file in the project: `oc-sub up` serves the `researcher` agent and its hidden `reader` subagent from the plugin. The researcher cannot fetch pages itself. It calls `reader`, which fetches the pages in a fresh context and returns at most 600 words of quotes. This keeps the cost low.
- A small or medium coding step with a precise brief: the files to read, the scope, what not to touch, the test command, and the content of the final report.

Do not delegate:

- A large step across many files (more than about ten). Big steps get slow and incomplete. Split them into several briefs.
- Design of prompts for production, or a step that needs judgment across the whole project. Do these yourself or with a Claude subagent.

## Workflow

1. Check that the project has `.opencode/agents/coder.md`. If not, copy it from [templates/coder.md](templates/coder.md) and adapt the bash allowlist to the test command of the project. Research needs no agent file in the project: the plugin serves the `researcher` agent and its hidden `reader` subagent itself.
2. Create a git worktree with its own branch, for example `git worktree add -b feature/x ../proj-x main`. The agent works only there.
3. Write the brief into a file outside the worktree, for example in your scratch folder. `oc-sub run` sends its text, so the agent never needs the file, and it cannot commit it by mistake. The agent cannot read files outside its project folder. If it needs other files, copy them into `.opencode/context/` of the worktree, which git ignores, or paste their content into the brief.
4. Start the server once: `oc-sub up`. It sets `OPENCODE_CONFIG_DIR` to the plugin folder, so the server also loads the research agents of the plugin. To stop it, use `oc-sub down`. After a change to the agent files or the opencode configuration, use `oc-sub restart`. After an update of the plugin, use `oc-sub restart` too, because the running server keeps the plugin folder that it got at start in `OPENCODE_CONFIG_DIR`.
5. Start the run: `oc-sub run --agent coder --dir <worktree> --brief <scratch>/brief.md --title "<short title>"`. For a research step, use `--agent researcher`. It prints the session ID, an `opencode attach ...` command, and the path of the run record.
6. Give the user the `opencode attach ...` command, so that they can watch the run live.
7. Wait with `oc-sub watch <session-id> --dir <worktree>` as a background command. When the session and its subagent sessions are idle, it prints the elapsed time, the tool calls, and the cost, and it ends.
8. Read the result with `oc-sub log <session-id> --dir <worktree>`.
9. Review the work yourself: read `git -C <worktree> diff main...HEAD`, and run the tests yourself. Do not trust the report of the agent alone.
10. If the diff is correct and the tests pass, merge. Then remove the worktree.

Tell the user the cost of each run. `watch` and `log` print it in USD, with the tokens. The cost covers the session and all of its subagent sessions. With subagents, the cost part reads `cost $0.0816 (subagents $0.0665 in 4 sessions)`.

## Follow up and abort

To send a correction or a question, write into the same session. Do not start a new agent for the same step:

```
opencode run --attach http://127.0.0.1:8767 --dir <worktree> --session <session-id> --agent coder "<message>" < /dev/null
```

Then wait again with `oc-sub watch`. To stop a run, use `oc-sub abort <session-id> --dir <worktree>`.

## Rules

- Always give `opencode run` the input `< /dev/null`. Without it, the command waits for input and hangs.
- Do not use `opencode run --auto`. The Claude Code permission check blocks it, and it approves too much. Give each agent an agent file with a permission allowlist instead.
- The allowlist stops mistakes, but it is not a sandbox. A test command such as `bun test` or `pytest` can run any code. The real protection is the worktree, no access to `.env`, and your review of every diff.
- Never read or print `.env` files or keys. Keep the server on 127.0.0.1.
- For a pure JSON answer without tools, GLM needs `reasoning: {"effort": "low"}`. With the default thinking, it can use all output tokens and give no answer. See [reference.md](reference.md#reasoning-effort).
- If a command is denied or a run fails, report it to the user. Do not go around the block.
