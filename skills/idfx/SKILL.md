---
name: idfx
description: Route a step to the right subagent and drive it with the idfx tool (formerly oc-sub). Run Claude Code in a Docker Sandbox, or a cheap opencode subagent with GLM when the routing rules allow it. Watch the run and review the result.
when_to_use: A plan step goes to a subagent, and you must pick Claude Code or opencode with GLM. The user asks to delegate work to Claude Code in the sandbox, to opencode, GLM, or a cheap subagent. The user asks about an idfx run (start, watch, follow up, abort, cost, usage limit).
allowed-tools: Bash(idfx *)
---

# Delegate a step with idfx

`idfx` starts and drives two kinds of subagent runs: Claude Code in a Docker Sandbox (`idfx run --driver claude`), and opencode subagents on an `opencode serve` server on 127.0.0.1. You write a brief, start a run, follow it, and review the result yourself. The full command reference is in [reference.md](reference.md). The details of the Claude runs are in the guide, section [Run Claude Code in the sandbox](../../docs/GUIDE.md#run-claude-code-in-the-sandbox-idfx-run---driver-claude).

## Route the step

The routing rules of your user decide. idfix adds no policy of its own. The rules that this skill was written for:

- Every subagent runs on Claude, with the Opus model that the rules name. That is the default for each step.
- A step goes to opencode with GLM only when the user agrees, or when the Claude plan hit its usage limit. Then use only the model `z-ai/glm-5.3-flash`.
- On a usage limit or an auth error, stop and report. Do not switch to another paid service. The only exception is GLM on a Claude plan limit.

So:

- A Claude step runs as a Claude Code subagent on the host in a worktree. That is the default for your own cooperating subagents.
- Use the sandbox (`idfx run --driver claude --model opus`) only in two cases: the agent is unknown to you, or the step is an experiment that can harm the whole infrastructure. The sandbox keeps the step away from the host checkout, but it costs start time.
- An opencode step (GLM) follows [When to delegate to opencode](#when-to-delegate-to-opencode) and the [Workflow of an opencode run](#workflow-of-an-opencode-run) below. Without the agreement of the user or a plan limit, do not start it.
- If your rules say otherwise, follow your rules.

## Claude Code in the sandbox

Use this only for the two sandbox cases in [Route the step](#route-the-step). Run every command in the host checkout of the project. The sandbox is `claude-<project>`, in clone mode: the run changes only the clone in the sandbox, never the host checkout.

1. Write the brief into a file outside the checkout. Tell Claude to commit its work on a branch. It cannot push, because the sandbox has no SSH access.
2. Start the run: `idfx run --driver claude --dir <host path of the checkout> --brief <scratch>/brief.md --model opus --title "<short title>"`. Inside the sandbox, the clone lies at the same path as the host checkout, so `--dir` names the host path. The command blocks until Claude Code ends, so start it as a background command. It prints the session ID, the cost, the transcript path, and the answer. For a worktree, create it in the clone first: `sbx exec claude-<project> git -C <checkout path> worktree add <folder>`. `idfx worktree` works only for the opencode sandbox so far.
3. Follow the run with `idfx status` (`busy`, `idle`, `failed`, `aborted`) and `idfx top` (live view). In `top`, the guards `looping` and `stalled` only mark the row red. They never stop the run.
4. Read the result with `idfx log <session>`: the last answer, the tokens, the status, and the cost.
5. Follow up with `idfx say <session> "<message>"`. For a Claude run, `say` resumes the session and blocks until the turn ends. A session with a running turn is refused.
6. Stop a run with `idfx abort <session>`. The blocking `run` or `say` then ends with exit code 1.
7. Bring the work to the host. The remote `sandbox-claude-<project>` exists only while the sandbox runs, because `sbx stop` removes it. So start a stopped sandbox first with `sbx exec claude-<project> true`. Then run `git fetch sandbox-claude-<project>` in the host checkout, review `git diff alpha...sandbox-claude-<project>/<branch>`, and run the tests yourself. `idfx fetch` covers only the opencode sandbox so far. Uncommitted work stays in the clone.

The clone does not follow the host: it keeps the commit of its creation, so a run can start on a stale base. idfix does not update the clone of a Claude sandbox. Before a run, create the work branch from a fresh host commit: `sbx exec claude-<project> git -C <checkout path> fetch /run/sandbox/source alpha`, then `sbx exec claude-<project> git -C <checkout path> worktree add -b feature/<step> <folder> FETCH_HEAD`. A live test on 2026-10-13 passed. `/run/sandbox/source` is the read-only host repository of a clone-mode sandbox; `idfx worktree` uses it for the opencode sandbox. If the fetch fails, remove the sandbox with `sbx rm claude-<project>`, and the next run creates it again from the current host.

### Max plan and usage limits

- The cost of a Claude run is an API-equivalent estimate. On a Max plan it costs nothing extra. Report it as an estimate.
- All Claude Code activity of the account shares one usage pool: your own session, host subagents, and sandbox runs. No API tells the remaining quota. Keep runs few, and keep the number of parallel runs small.
- On a usage limit, the run fails with exit code 1 and a limit message. Stop and report it. Switch to GLM only by the rules above.

### Known gaps

- `idfx watch` does not work for Claude runs. Use `status`, `top`, and `log`.
- `log` shows only the last answer and the totals, not the whole conversation.
- The clone does not follow the host. Create the work branch from a fresh host commit (step 7).
- The stall guard also marks a run that waits more than 3 minutes for a long command or a subagent.
- In a headless turn, Claude Code can move a long command into the background and end the turn before the command ends. Check the answer with `log`, and send a `say` to finish the work.

## Ask Jev one question: `idfx decide`

When your project needs a cheap typed answer from a model, for example to sort an item into one of a few classes, call `idfx decide --json` instead of a client of your own. Pipe one JSON object with `state`, `question`, `options` (name to criterion, at least 2), and an optional `title` into it. It prints one line with `choice`, `confidence`, and `cost`. On the error type `limit` or `auth`, stop and report; do not switch to another paid service. Details: the README section "idfx decide".

## When to delegate to opencode

Use this section only when the routing above allows opencode with GLM.

Delegate:

- A research question. The agent writes a report into the repository, for example `docs/research/<topic>.md`. Research needs no agent file in the project: `idfx up` serves the `researcher` agent and its hidden `reader` subagent from the plugin. The researcher cannot fetch pages itself. It calls `reader`, which fetches the pages in a fresh context and returns at most 600 words of quotes. This keeps the cost low.
- A small or medium coding step with a precise brief: the files to read, the scope, what not to touch, the test command, and the content of the final report.

Do not delegate:

- A large step across many files (more than about ten). Big steps get slow and incomplete. Split them into several briefs.
- Design of prompts for production, or a step that needs judgment across the whole project. Do these yourself or with a Claude subagent.

## Workflow of an opencode run

1. The plugin serves the `coder`, `researcher`, and `reader` agents itself through `OPENCODE_CONFIG_DIR`. No project agent file is needed. If the project has an old copy of `.opencode/agents/coder.md` or `researcher.md`, delete it, so that the plugin stays the one source. If the project needs its own bash rules, it keeps a `.opencode/agents/coder.md` with only a `permission` block (see [Agent files](reference.md#agent-files)).
2. Create a git worktree with its own branch, for example `git worktree add -b feature/x ../proj-x main`. The agent works only there. In sandbox mode, use `idfx worktree STEP` instead: it creates the worktree with `feature/STEP` inside the sandbox clone.
3. Write the brief into a file outside the worktree, for example in your scratch folder. `idfx run` sends its text, so the agent never needs the file, and it cannot commit it by mistake. The agent cannot read files outside its project folder. If it needs other files, copy them into `.opencode/context/` of the worktree, which git ignores, or paste their content into the brief.
4. In a new project, run `idfx doctor` once. It checks the project and the host for the things that break runs: a real `.env` file in the project or a worktree, a `CLAUDE.md` instead of `AGENTS.md`, global rule files that are copies instead of symlinks, broken skill links, and old agent file copies. It also warns about old names of the time when the tool had the name `oc-sub`: the state folder `~/.local/state/oc-sub/` and the file `.opencode/oc-sub.json`. The old names still work, and `idfx doctor --fix` moves the folder and renames the file. Every finding names its fix. `up` and `run` repeat the fast checks on every call and stop on a failure.
5. Start the server once: `idfx up`. Without mode flags, this runs the server in a Docker Sandbox per project (see the [sandbox section](reference.md#sandbox-mode) in the reference). It needs `sbx` and a project key. For a host server, use `idfx up --no-sandbox`. It sets `OPENCODE_CONFIG_DIR` to the plugin folder, so the server also loads the research agents of the plugin. It also loads your shared rules and skills from the folder in `IDFX_SHARED_DIR` (no default; `up` stops without it). After `up`, run `idfx ping --rules --dir <project>` once: it checks that the agent really sees your shared rules. To stop the server, use `idfx down` (in the same mode as `up`). After a change to the agent files or the opencode configuration, use `idfx restart`. After an update of the plugin, use `idfx restart` too, because the running server keeps the plugin folder that it got at start in `OPENCODE_CONFIG_DIR`. If `up` asks you to remove an old sandbox with `sbx rm --force NAME`, do it: the removal ends the sessions of that sandbox, so run `up` again and restart pending runs.
6. Start the run: `idfx run --agent coder --dir <worktree> --brief <scratch>/brief.md --title "<short title>"`. For a research step, use `--agent researcher`. `run` then appends the footer of the skill `critical-research` to the brief, so do not paste it yourself. The report then has a section "Critical analysis". It prints the session ID, a short `watch live` line with the CODE for `idfx attach`, and the paths of the run record. If the project shares its OpenRouter key with another project, `run` stops and says so. Each project needs its own key.
7. Give the user the `idfx attach CODE` command from the output of `run`, so that they can watch the run live. CODE is the short code after `watch live: idfx attach`.
8. Wait with `idfx watch <session-id> --dir <worktree>` as a background command. When the session and its subagent sessions are idle, it prints the elapsed time, the tool calls, and the cost, and it ends.
9. `watch` ends with one of three exit codes. The output of `watch` tells you what to do:
   - 0: the run ended. Read the result with `idfx log`.
   - 3: the run paused on a question or a permission request. Read the request in the output of `watch`. Decide yourself if it is safe, or ask the user. Then answer it with `idfx answer <request-id> ...` (the output names the exact command) and start `watch` again. With `--reply reject --message "<reason>"`, the agent sees the reason as the error of the tool call. A rejected permission request ends the turn of the agent. To continue, send a follow-up message with `idfx say`.
   - 4: `watch` saw a warning sign: a loop of identical tool calls, a stalled session, or runaway reasoning in one step. Read the block in the output of `watch`. Then abort the run with `idfx abort <session-id> --dir <worktree>`, or send a correction with `idfx say` and start `watch` again. The run itself keeps running. A session whose model claims broken tools is poisoned. Do not send a follow-up message into it. Start a fresh session with the same brief instead.
10. Read the result with `idfx log <session-id> --dir <worktree>`.
11. Review the work yourself: read `git -C <worktree> diff main...HEAD`, and run the tests yourself. Do not trust the report of the agent alone. In sandbox mode, first run `idfx fetch` on the host, then review with `git diff alpha...sandbox-<name>/feature/STEP`.
12. If the diff is correct and the tests pass, merge. Then remove the worktree. In sandbox mode, remove it with `idfx worktree rm STEP` inside the clone, after the fetch.

Tell the user the cost of each run. `watch` and `log` print two cost lines in USD. The first line is the estimate of opencode: it multiplies the tokens by the prices in its model catalog from models.dev. The second line is the real cost. `watch` and `log` first sum the `cost` of the cost-proxy log over the session and all of its subagent sessions; when the proxy log has none of them, they fall back to the growth of the OpenRouter key usage during the run. Both lines cover the session and all of its subagent sessions. With subagents, the first line reads `cost $0.0816 (subagents $0.0665 in 4 sessions)`. The proxy line reads `real cost $0.0115 from the cost proxy (20 requests, deepinfra $0.0115)`, and failed requests add a part like `2 requests without cost`. The fallback reads `real cost $0.0512 at OpenRouter (key usage since the start of the run)` and names other runs with the same key that overlap in time. To compare runs, compare their tokens.

## Follow up and abort an opencode run

To send a correction or a question, write into the same session with `idfx say`. The command returns at once. It does not wait for the reply to end. Without `--agent`, it uses the agent of the last user message of the session:

```
idfx say <session-id> --dir <worktree> "<message>"
```

If the session or one of its subagent sessions waits for a question or permission request, `say` warns on stderr and prints the matching `idfx answer` command: the message stays queued until that request has an answer.

Then wait again with `idfx watch`. After a rejected permission request, the turn of the agent has ended. Always send a follow-up message with `idfx say` to continue. To stop a run, use `idfx abort <session-id> --dir <worktree>`.

## Rules

- Send follow-up messages with `idfx say`. It returns at once. If you use `opencode run` directly instead, always give it the input `< /dev/null`. Without it, the command waits for input and hangs.
- Do not use `opencode run --auto`. The Claude Code permission check blocks it, and it approves too much. The agent files of the plugin and of the project give the permission rules instead.
- The permission rules stop some mistakes, but they are not a sandbox. A test command such as `bun test` or `pytest` can run any code. The real protection is the worktree, no access to `.env`, and your review of every diff.
- Never read or print `.env` files or keys. Keep the server on 127.0.0.1.
- Each project needs its own OpenRouter key in `~/.config/<project>/openrouter.key`. A key that two projects share is not allowed: `idfx run` refuses to start and names the other project. Create a key for one of the projects and run `idfx restart`. The real cost of a run is only correct with a project key of its own.
- For a pure JSON answer without tools, GLM needs `reasoning: {"effort": "low"}`. With the default thinking, it can use all output tokens and give no answer. See [reference.md](reference.md#reasoning-effort).
- If a command is denied or a run fails, report it to the user. Do not go around the block.
