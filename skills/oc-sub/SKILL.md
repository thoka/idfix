---
name: oc-sub
description: Delegate research or a small coding step to a cheap opencode subagent with the oc-sub tool. Watch the run and review the result.
when_to_use: The user asks to delegate work to opencode, GLM, or a cheap subagent. The user asks about an oc-sub run (start, watch, follow up, abort, cost). A plan has a research question or a small coding step with a precise brief.
allowed-tools: Bash(oc-sub *)
---

# Delegate work to an opencode subagent

`oc-sub` drives an `opencode serve` server on 127.0.0.1. You write a brief, start a run, give the user a command to watch it live, and review the result yourself. The full command reference and the details are in [reference.md](reference.md). The plugin serves the `coder`, `researcher`, and `reader` agents itself; the project needs no agent file (see [Agent files](reference.md#agent-files)).

## When to delegate

Delegate:

- A research question. The agent writes a report into the repository, for example `docs/research/<topic>.md`. Research needs no agent file in the project: `oc-sub up` serves the `researcher` agent and its hidden `reader` subagent from the plugin. The researcher cannot fetch pages itself. It calls `reader`, which fetches the pages in a fresh context and returns at most 600 words of quotes. This keeps the cost low.
- A small or medium coding step with a precise brief: the files to read, the scope, what not to touch, the test command, and the content of the final report.

Do not delegate:

- A large step across many files (more than about ten). Big steps get slow and incomplete. Split them into several briefs.
- Design of prompts for production, or a step that needs judgment across the whole project. Do these yourself or with a Claude subagent.

## Workflow

1. The plugin serves the `coder`, `researcher`, and `reader` agents itself through `OPENCODE_CONFIG_DIR`. No project agent file is needed. If the project has an old copy of `.opencode/agents/coder.md` or `researcher.md`, delete it, so that the plugin stays the one source. If the project needs its own bash rules, it keeps a `.opencode/agents/coder.md` with only a `permission` block (see [Agent files](reference.md#agent-files)).
2. Create a git worktree with its own branch, for example `git worktree add -b feature/x ../proj-x main`. The agent works only there.
3. Write the brief into a file outside the worktree, for example in your scratch folder. `oc-sub run` sends its text, so the agent never needs the file, and it cannot commit it by mistake. The agent cannot read files outside its project folder. If it needs other files, copy them into `.opencode/context/` of the worktree, which git ignores, or paste their content into the brief.
4. In a new project, run `oc-sub doctor` once. It checks the project and the host for the things that break runs: a real `.env` file in the project or a worktree, a `CLAUDE.md` instead of `AGENTS.md`, global rule files that are copies instead of symlinks, broken skill links, and old agent file copies. Every finding names its fix. `up` and `run` repeat the fast checks on every call and stop on a failure.
5. Start the server once: `oc-sub up`. Without mode flags, this runs the server in a Docker Sandbox per project (see the [sandbox section](reference.md#sandbox-mode) in the reference). It needs `sbx` and a project key. For a host server, use `oc-sub up --no-sandbox`. It sets `OPENCODE_CONFIG_DIR` to the plugin folder, so the server also loads the research agents of the plugin. It also loads your shared rules and skills from `OC_SUB_SHARED_DIR` (default `$HOME/dv/meta/agents`). After `up`, run `oc-sub ping --rules --dir <project>` once: it checks that the agent really sees your shared rules. To stop the server, use `oc-sub down` (in the same mode as `up`). After a change to the agent files or the opencode configuration, use `oc-sub restart`. After an update of the plugin, use `oc-sub restart` too, because the running server keeps the plugin folder that it got at start in `OPENCODE_CONFIG_DIR`. If `up` asks you to remove an old sandbox with `sbx rm NAME`, do it: the removal ends the sessions of that sandbox, so run `up` again and restart pending runs.
6. Start the run: `oc-sub run --agent coder --dir <worktree> --brief <scratch>/brief.md --title "<short title>"`. For a research step, use `--agent researcher`. It prints the session ID, a short `watch live` line with the CODE for `oc-sub attach`, and the paths of the run record. If the project shares its OpenRouter key with another project, `run` stops and says so. Each project needs its own key.
7. Give the user the `oc-sub attach CODE` command from the output of `run`, so that they can watch the run live. CODE is the short code after `watch live: oc-sub attach`.
8. Wait with `oc-sub watch <session-id> --dir <worktree>` as a background command. When the session and its subagent sessions are idle, it prints the elapsed time, the tool calls, and the cost, and it ends.
9. `watch` ends with one of three exit codes. The output of `watch` tells you what to do:
   - 0: the run ended. Read the result with `oc-sub log`.
   - 3: the run paused on a question or a permission request. Read the request in the output of `watch`. Decide yourself if it is safe, or ask the user. Then answer it with `oc-sub answer <request-id> ...` (the output names the exact command) and start `watch` again. With `--reply reject --message "<reason>"`, the agent sees the reason as the error of the tool call. A rejected permission request ends the turn of the agent. To continue, send a follow-up message with `oc-sub say`.
   - 4: `watch` saw a warning sign: a loop of identical tool calls, a stalled session, or runaway reasoning in one step. Read the block in the output of `watch`. Then abort the run with `oc-sub abort <session-id> --dir <worktree>`, or send a correction with `oc-sub say` and start `watch` again. The run itself keeps running. A session whose model claims broken tools is poisoned. Do not send a follow-up message into it. Start a fresh session with the same brief instead.
10. Read the result with `oc-sub log <session-id> --dir <worktree>`.
11. Review the work yourself: read `git -C <worktree> diff main...HEAD`, and run the tests yourself. Do not trust the report of the agent alone.
12. If the diff is correct and the tests pass, merge. Then remove the worktree.

Tell the user the cost of each run. `watch` and `log` print two cost lines in USD. The first line is the estimate of opencode: it multiplies the tokens by the prices in its model catalog from models.dev. The second line is the real cost at OpenRouter: the growth of the key usage of the project key during the run. Both lines cover the session and all of its subagent sessions. With subagents, the first line reads `cost $0.0816 (subagents $0.0665 in 4 sessions)`. The real cost line reads `real cost $0.0512 at OpenRouter (key usage since the start of the run)`. Other runs with the same key that overlap in time add their cost to the same number, so the line names them: `, includes other runs: ses_a, ses_b`. OpenRouter counts a request a minute or two late, so a `log` some minutes later can show a slightly higher real cost. To compare runs, compare their tokens.

## Follow up and abort

To send a correction or a question, write into the same session with `oc-sub say`. The command returns at once. It does not wait for the reply to end. Without `--agent`, it uses the agent of the last user message of the session:

```
oc-sub say <session-id> --dir <worktree> "<message>"
```

Then wait again with `oc-sub watch`. After a rejected permission request, the turn of the agent has ended. Always send a follow-up message with `oc-sub say` to continue. To stop a run, use `oc-sub abort <session-id> --dir <worktree>`.

## Rules

- Send follow-up messages with `oc-sub say`. It returns at once. If you use `opencode run` directly instead, always give it the input `< /dev/null`. Without it, the command waits for input and hangs.
- Do not use `opencode run --auto`. The Claude Code permission check blocks it, and it approves too much. The agent files of the plugin and of the project give the permission rules instead.
- The permission rules stop some mistakes, but they are not a sandbox. A test command such as `bun test` or `pytest` can run any code. The real protection is the worktree, no access to `.env`, and your review of every diff.
- Never read or print `.env` files or keys. Keep the server on 127.0.0.1.
- Each project needs its own OpenRouter key in `~/.config/<project>/openrouter.key`. A key that two projects share is not allowed: `oc-sub run` refuses to start and names the other project. Create a key for one of the projects and run `oc-sub restart`. The real cost of a run is only correct with a project key of its own.
- For a pure JSON answer without tools, GLM needs `reasoning: {"effort": "low"}`. With the default thinking, it can use all output tokens and give no answer. See [reference.md](reference.md#reasoning-effort).
- If a command is denied or a run fails, report it to the user. Do not go around the block.
