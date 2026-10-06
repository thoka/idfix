# History

This file holds the plan as it stood on 2026-10-01, with every finished step and its details. Steps finished after that date are in the section "Steps after 2026-10-01", newest first. [PLAN.md](PLAN.md) holds the open work. Research reports refer to steps by number, and the numbers here stay the same.


## Steps after 2026-10-01

## Step 25g: Claude Code sessions in `top`, `status`, and `idfx watch --all`

Done on 2026-10-06. The grill with the user settled the sources and the display (Q1 to Q7). Q6: the `¢` column shows the API price of the tokens in gray. Q7: an ended session shows for 60 minutes, a live session always, and a waiting session always and first. Designs: [claude-sessions-top.md](design/claude-sessions-top.md) and [idfx-watch.md](design/idfx-watch.md). Decisions on the open points: `docs/review-queue.md`, entries of 2026-10-06.

- 25g.1: `src/claude/` reads the session, job, and transcript files of Claude Code by polling, and the cached LiteLLM price file. `status` lists Claude sessions.
- 25g.2: Claude rows in `top --once` and the live view, gray API price, `ctx` share of the window, waiting first, ended last.
- 25g.3: the key `o` attaches a background session in a new tmux pane, or switches to the pane of an interactive session.
- W1: `idfx watch --all [--json] [--once]` writes six conditions per session as CloudEvents (protocol version 0 of `~/dv/meta/docs/research/tool-protocol.md`) to `$XDG_STATE_HOME/idfx/events.jsonl`.
- W2: the watcher wakes the supervisor with `notify-session`, only on a new wait for the user or a new API error, batched, with a baseline on the first run. The unit file is `contrib/systemd/idfx-watch.service`, and arch-helper installs it. `doctor` has the check `watch-running`.
- W3: `status --json` and `doctor --json` print one object in the protocol form.

## Step 30 follow-up: the integration tests leak cost-proxy loops

Step 30 is done (see HISTORY). Its dry run on 2026-10-04 found 3 `sh -c "while :; do bun .../cost-proxy.js ...; done"` loops in deleted `/tmp/oc-sub-it-*` folders, with their parent `/init`. The teardown of `test/integration.test.ts` stops the server, but not the restart loop of the cost proxy. Find the start of the loop, stop its process group in the teardown, and add a test that no process of the test outlives it.

Done on 2026-10-06. Root cause: `up` starts the proxy restart loop detached (`spawnDetached` with `detached: true`, so `setsid`), so the loop leads its own process group, and the teardown of `test/integration.test.ts` killed only the server PID. The fix: `down` checks the proxy command line and stops its group, also for a dead server. `up` stops the proxy group when the server start fails. The teardown calls `stopStartedGroups`, and the last integration test fails if a recorded group outlives its teardown. The test reproduced the leak with the old teardown. The 4 orphan loops of 2026-10-04 and 2026-10-05 were stopped by hand.

## Step 33: every research brief ends with the critical-research footer

Task from the supervisor, 2026-10-04. A new global rule and the skill `critical-research` (`meta/agents/skills/critical-research/SKILL.md`) say that every research question ends with a fixed footer, and every report has a section "Critical analysis" with four points. `oc-sub run --agent researcher` appends the footer, read from the skill file in `OC_SUB_SHARED_DIR`, after a line `---`. A brief that already ends with it stays unchanged. A missing skill file stops the run with an error. The researcher prompt asks for the section. A test compares the appended footer with the skill file. Done on 2026-10-04 in 20a6bb3: `src/critical-footer.ts`, 1048 tests pass in the main checkout. Known gap: in a worktree under `.claude/worktrees/`, 9 Ink tests of `top` fail with "Invalid hook call" (two copies of React), and they pass in the main checkout.

## Step 32: a sandbox for each runner job

Dropped on 2026-10-04 evening (see Direction). The runner keeps running as fix 50 set it up. Spike 32c does not go to the user, and `scripts/spike-32c-root-v2.sh` is not run. 32a and 32b stay as records. The text below is history.

Result of meta step 12f, from the supervisor on 2026-10-04 (arch-helper `alpha` 85e3ffd: `fixes/50-gh-runner.sh`, `lib/gh-runner/`, `docs/gh-runner.md`, `docs/research/self-hosted-runner.md`). The runner uses option (a) now: the Linux user `gh-runner`, rootless Docker, and a just-in-time runner for each job. A root-only token in `/etc/credstore/gh-runner.pat` mints the runners. The global rules come read-only from `/srv/meta-agents`. Option (c) is an idfix sbx sandbox for each job, and it is this step. It waits for a headless sbx login of the user `gh-runner`. Option (c) can close two gaps of (a): Docker images stay between jobs, and jobs have full network access. Fix 50 did not run on the real system yet. arch-helper belongs to the supervisor, so idfix sends it the changes that fix 50 needs.

1. 32a, research (a Claude research agent): a headless sbx login for a second Linux user, the lifecycle of one sandbox for each job, the network policy of sbx, and how the sandbox gets the one Claude Max token for exactly one job and loses it afterwards. User decision 17 (meta plan step 12): the token lives in `/etc/credstore/claude-oauth.token` of the runner and reaches each job as `CLAUDE_CODE_OAUTH_TOKEN`. Done on 2026-10-04: [runner-job-sandbox.md](research/runner-job-sandbox.md). The whole runner process of a job operates in a fresh sbx VM, and `sbx rm --force` removes it. The user `gh-runner` logs in with a Docker PAT through `sbx login --password-stdin`, fed by `LoadCredential=`. The Claude token goes in as `sbx exec -e CLAUDE_CODE_OAUTH_TOKEN`, because the secret proxy of sbx 0.45.1 cannot inject it (issue #601). An injected prompt can still copy the token. Defaults that follow from the goal of a sandbox: the daemon of `gh-runner` starts with `--policy deny-all` and an allow list for each project, the token moves to the proxy when sbx supports it, and no global Anthropic secret or `/login` exists in the store of `gh-runner`. Default until a measurement: one job at a time. The user decided on 2026-10-04 (meta plan 760d063): the existing Docker account of the user owns the PAT.
2. 32b, done on 2026-10-04: [runner-job-sandbox.md](design/runner-job-sandbox.md). idfix gets `idfx job run` and `idfx job prune`. arch-helper keeps the users, units, and credentials. No choice was open for the user.
3. Next: 32c to 32f, as in section 5 of the design. 32c is a spike by hand as the user `gh-runner`. Fix 50 is not applied here, so `scripts/spike-32c-root-v2.sh` (apply, check, undo) adds an sbx daemon for `gh-runner` next to the live runner of fix 50 and logs to `~/.local/state/user-steps/spike-32c.log`. Do not run v1: its undo deletes the user and the files of fix 50. The user runs it with sudo after a review. The script is not tested yet, because the permission check of the session blocked a dry run. After `check`, read `~/.local/state/user-steps/spike-32c.log`, fix the design, and send the final change list for fix 50 to the supervisor.

## Step 28: moved to meta step 19

On 2026-10-04 the user widened the graph view of the plans into a generic graph viewer in its own new project (meta plan step 19, name still open). Nothing is built here. The research reports stay here, because step 19 links to them: [plan-graph-tools.md](research/plan-graph-tools.md) and [plan-graph-view.md](research/plan-graph-view.md). The design [plan-graph.md](design/plan-graph.md) also stays.

## Background

In the project terminator (September 2026), four research runs with the template `researcher.md` cost 0.22 to 0.70 USD each. The earlier runs in [EXPERIENCE.md](EXPERIENCE.md) cost 0.08 to 0.09 USD.

Two effects add up. A later analysis of the stored sessions found the first one. It is described in [EXPERIENCE.md](EXPERIENCE.md#the-reported-cost-is-an-estimate-from-the-model-catalog).

1. The reported cost is an estimate. opencode multiplies the tokens by the price in its model catalog from models.dev. On 2026-09-28, the catalog price of GLM 5.3 Flash went from about 0.04 to 0.15 USD per million input tokens. The real charge at OpenRouter can differ.
2. The context grows with each fetched page. This part is below, and the token counts confirm it.

Root cause of the context growth: the template denies the `task` tool, so the researcher fetches every page itself. Each page stays in its context until the run ends, and the model reads the whole context again at every step. In the most expensive run, 67 fetches returned up to 51,000 characters each. The context grew to 395,000 tokens over 80 steps. The model re-read 17.3 million tokens of cached context, and these re-reads made up 75 percent of the cost.

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

Status: done.

1. `oc-sub watch` and `oc-sub log` add the cost and the tokens of all child sessions of the session, recursively. The output shows the total and the share of the subagents, for example `cost $0.0816 (subagents $0.0665 in 4 sessions)`.
2. `oc-sub watch` waits until the child sessions are idle too.
3. Tests with `bun test` and invented session data.

## Step 3: Check in terminator

Status: done. See [EXPERIENCE.md](EXPERIENCE.md#research-agents-of-the-plugin-in-terminator).

1. Remove `researcher.md` and `reader.md` from `~/dv/terminator/.opencode/agents/`.
2. Run `oc-sub restart`, then a small research run in a worktree of terminator.
3. Make sure that the run uses the plugin agents, calls `reader`, and reports the cost of the child sessions.
4. Add the result to [EXPERIENCE.md](EXPERIENCE.md).

## Step 4: Questions and permission requests go to the orchestrator

Status: done. A live test on 2026-09-28 paused on a question and on a permission request, and `oc-sub answer` resumed the run both times.

Root cause: the agent files deny the `question` tool and use `deny` for risky commands, because "nobody answers questions in a run" (`skills/oc-sub/reference.md`). A denied agent gets an error and looks for a detour. In the step 1 run, GLM tried `rm` after the allowlist blocked the deletion of a file. opencode has the missing channel already. The `question` tool and the `ask` permission pause the session, and the server lists and answers the pending requests.

1. Research first, with a report in `docs/research/`. How do established tools let an orchestrator answer the question or the permission request of a subagent? Cover opencode itself: the `question` tool, `ask` permissions, and the server endpoints and events in 1.18.32. Also cover `opencode-mcp`, the Claude Agent SDK (`canUseTool`), and the Agent Client Protocol (`session/request_permission`). Also cover the A2A protocol (`input-required`), MCP elicitation, the OpenAI Agents SDK, and LangGraph (`interrupt`). Name the pattern that most of them share, and what `oc-sub` can reuse.
2. Decide the design with the user, based on the report.
3. Implement it in small steps with tests. The likely parts: the agent files allow `question` and use `ask` for risky commands. `oc-sub watch` shows a pending request and ends. A new command answers or rejects it in the same session.

## Step 5: The real cost from OpenRouter

Status: done.

Root cause: `oc-sub watch` and `oc-sub log` show the cost that opencode computes from its model catalog, not the charge at OpenRouter. When the catalog price changes, the reported cost changes, although the real charge does not.

1. Research: how does OpenRouter report the real cost of a request (the `usage` object with `cost`, and `GET /api/v1/generation?id=...`)? Does opencode store the generation ID or the real cost of a step? The first research report is `docs/research/openrouter-routing.md`.
2. Decide with the user where the real cost comes from, and whether `oc-sub` reads the OpenRouter key for it.
3. Look at the real routing at OpenRouter. If requests go to an expensive provider, set a routing rule. The research report names `provider.openrouter.options.extraBody.provider` as the likely path.

## Step 6: Guards in `oc-sub watch`, and better answers

Status: done. Part A (guards) covers items 1 to 4 and 9. Part B (answers) covers items 5 to 7. Known limit: a single bash command that runs longer than three minutes sends no events, so `watch` reports a stall although nothing is wrong. The fix of the false idle report is not proven in a live run yet.

Root cause: the first step 4 run read the same 75 lines of one file 40 times in a row, with the same input each time. It cost an estimated 0.49 USD without a result. The `doom_loop` permission of opencode defaults to `ask`, but it did not stop the run (see [EXPERIENCE.md](EXPERIENCE.md#a-coder-in-a-loop)).

1. `oc-sub watch` counts tool calls with the same tool and the same input in a row. At five, it prints a warning with the call, and it ends with its own exit code. The orchestrator then aborts the run or sends a correction.
2. Tests with invented events.
3. If a model call brings no token for three minutes, `oc-sub watch` also warns. On 2026-09-29, a step 5 run hung in an empty text part for over three minutes. Only an abort and a follow-up message resumed it.
4. Bug: on 2026-09-29, `oc-sub watch` printed `idle after 0m10s` while the session was busy and waited on a new permission request. The status check probably ran in the gap after one answer and before the next request. `watch` must not report idle while `GET /session/status` shows the session as busy.
5. `oc-sub answer --reply reject --message TEXT` passes the reason to the agent. The reply endpoint accepts `message` next to `reply`.
6. A command sends a follow-up message into a session without waiting, for example `oc-sub say SESSION TEXT`. It uses `prompt_async`, because `opencode run --attach` blocks until the reply ends.
7. The documentation says that a rejected permission request ends the turn of the agent, also with a message. To continue, send a follow-up message.
8. Done differently: since commit 62ed63c, the agents allow every bash command by default. Only actions outside the worktree ask, and `.env` and `git stash` are denied.
9. `oc-sub watch` also warns when one step uses more than 16,000 reasoning tokens. Runs with 13,000 to 32,000 reasoning tokens in one step derailed on 2026-09-29.

## Step 7: Agent files keep the default system prompt

Status: open. A first A/B test found no difference (see [EXPERIENCE.md](EXPERIENCE.md#ab-test-agent-prompt-against-the-default-prompt)). The loop guard of step 6 comes first.

Root cause: the body of an opencode agent file replaces the default system prompt of opencode (`packages/opencode/src/session/llm/request.ts:60` in v1.18.32). GLM then works without the default guidance. In the TUI, with the default prompt, GLM continued 449 of 1,008 partial file reads with an `offset` and never repeated a call. In `oc-sub` runs, with our agent prompts, it continued only 29 of 776, and two runs looped 111 and 536 times on the same call.

1. A/B test: the same small coding brief two or three times with each of two variants. Variant A is the current `coder`. Variant B is a `coder` without a body. Its role rules come through the `system` field of the prompt request.
2. If the test confirms it, the agent files lose their body, and `oc-sub run` sends the role rules as `system`.

## Step 8: `oc-sub top`, a live view

Status: in progress. Decided with the user on 2026-09-29. It builds on the detection module of step 6. Since step 9, several servers can run: the host server on 8767 and one sandbox server per project. [top-view.md](research/top-view.md) covers Ink, the event stream, and the servers after step 9 (section 6).

Progress on 2026-09-30:

- 8a, done: `src/servers.ts` lists the host server and every sandbox server from the state files. `status --all` covers all of them.
- 8b, done: Ink 7.1.1 and React 19.3 run under bun 1.4.2. A counter app worked in a pseudo terminal with keys, the alternate screen, and a clean exit.
- 8c, done: `src/top/model.ts` is a pure model from server events to one row per session. The guard of step 6 gives the loop, stall, and reasoning states.
- 8d, done: `oc-sub top --once [--dir DIR | --all] [--json]` loads every server and prints one snapshot. It shows the running sessions and the sessions updated in the last 60 minutes. The time of the last activity comes from the newest message, because `time.updated` of a session changes only with the session object.
- 8e, done on 2026-09-30: `src/top/live.ts` follows one `GET /global/event` per server, reconnects with a growing delay, and seeds the server again after a reconnect. A server that was down is probed again every 30 seconds.
- 8f, done on 2026-09-30: the session column shows the last 6 characters of the session ID, like `oc-sub attach CODE` of step 9f. The folder column becomes two columns, project and worktree. The project column shows the configured short name of the project: the `shortName` in `.opencode/oc-sub.json` of the project root (step 8i), else the full project name, not shortened. The worktree column shows the folder name under `.worktrees/`, or `-` for the main folder. Without `--all`, the project column is hidden, because all rows belong to one project. The code lives in `src/top/columns.ts`, for `--once` and the live view.
- 8g, done on 2026-09-30: `oc-sub top` without `--once` opens a full-screen Ink view with a colored state, a selected row, a detail pane, and a footer with the servers, the totals, and the keys (`j`/`k`, arrows, `o`, `a`, `q`). The logic is in pure functions (`src/top/view-model.ts`), and the model got a `reasoning` state. Without a terminal, it prints the snapshot and a hint. Known gaps: a worktree that appears after the start shows only after `a` twice; the footer has no day totals and no key usage per project (item 5); the `o` command finds only runs that `oc-sub run` started; below about 110 columns the title is cut away; the SDK leaves an `AbortError` of a stopped stream unhandled, which the view ignores.
- 8h, open: `status --json`.
- 8j, done on 2026-09-30: a run worktree in the clone holds only tracked files, so it had no `node_modules`. `.opencode/oc-sub.json` can set a `setup` shell command. `oc-sub worktree` runs it inside the new worktree through `sbx exec -w`, with the PATH of the sandbox server (`sandboxToolPathEntry` in `src/sandbox.ts`). `--no-setup` skips it, and an existing worktree never runs it. A failing setup keeps the worktree and prints a shell-quoted command to run it again. An end-to-end test created a worktree with `node_modules` in about 4 seconds.
- 8i, done on 2026-09-30: the project column shows no computed short name. It shows the `shortName` from `.opencode/oc-sub.json` of the project root (`src/project-config.ts`, read once per root per process), else the full project name. The run folder maps to its root with `projectRootOfRun`, so clone-mode run folders find the config of the host root. This repository sets `{ "shortName": "opsub" }` for itself.

`oc-sub status` stays short and line-based for agents, and gets `--json`. `oc-sub top` is a full-screen live view for the user, like `htop`. `oc-sub top --once` prints one text snapshot for agents.

1. Research first, with a report in `docs/research/`. Does Ink run under bun? Does the opencode server have one event stream across all projects, or does `top` subscribe per directory?
2. Scope: the current project and its worktrees. `--all` shows all projects, like `status`.
3. One line per session: project and worktree, agent, state (busy, waiting, stalled, looping, idle), elapsed time, steps, tool calls, context size, estimated and real cost.
4. The numbers at a glance: state, time since the last token, real cost, and thinking (reasoning tokens as a share of the output, and in the current step).
5. A detail pane for the selected session: the last events as a short log, a pending question or permission request, and the subagent sessions as a tree. A footer with the server, the totals of the day, and the key usage per project.
6. Library: Ink, because models know React best, so a subagent makes fewer mistakes and uses fewer tokens.
7. First version shows only. The key `o` prints the `opencode attach` command. Keys that act (answer, abort, follow up) come in a later step.

## Step 9: A real sandbox instead of permission rules

Status: done on 2026-09-29. Steps 9a to 9e are on `alpha`. This project (opencode-subagents) runs in sandbox mode: the sandbox `oc-sub-opencode-subagents` serves port 18768, and its state file is `~/.local/state/oc-sub/sandbox-opencode-subagents.json`. Other projects still use the host server on port 8767.

State of the test on 2026-09-29: the test is done. The details are in [sandbox.md](research/sandbox.md#7-test-of-docker-sandboxes-on-2026-09-29).

- `sbx` 0.45.1 comes from the GitHub releases `docker/sbx-releases`, through `mise.toml` (`"github:docker/sbx-releases" = "0.45.1"`). It needs no Docker Desktop, but a Docker login (`sbx login`).
- `opencode serve` runs inside a sandbox. `oc-sub watch`, `say`, and `answer` reach it through `sbx ports`. The agent sees only the placeholder `proxy-managed`, and the proxy of `sbx` adds the real key of the project. A small `coder` run committed its work.
- A host process must hold `sbx exec SANDBOX opencode serve` in the foreground, because `sbx` stops a sandbox 30 seconds after the last `sbx` session ends.
- `oc-sub run` refuses the sandbox, because its key check finds `proxy-managed` instead of the project key.
- The global policy of `sbx` allows every host. A deny rule beats every allow rule, so a per-sandbox allowlist needs the global rule `default-allow-all` removed.
- The sandbox reaches the unsandboxed host server at `host.docker.internal:8767`. An agent can run commands on the host through it.

Decided with the user on 2026-09-29: the global rule `default-allow-all` of `sbx` is removed, so each sandbox may reach only the hosts of its agent kit. A test confirmed it: openrouter.ai and models.opencode.ai answer, while example.com and `host.docker.internal:8767` get 403. A project that moves into a sandbox no longer uses the host server.

Root cause: the agent files imitate a sandbox with long bash allowlists. The allowlist stops no deliberate harm (a test command can run any code), but every command outside it pauses the run until the orchestrator answers. In the step 5 and step 8 runs, most pauses were for read-only commands such as `cat`, `sed -n`, `rg`, and `ls`.

1. Research, with a report in `docs/research/`: how do other tools run a coding agent in a real sandbox? Cover a Docker or Podman container per run, bubblewrap (the sandbox of Claude Code on Linux), microVMs such as Firecracker, and container-use from Dagger. For each: how opencode runs inside, and how `oc-sub` and `opencode attach` reach it. How the OpenRouter key gets in without being readable from the worktree. How the network is limited, and the start time on WSL2. Also: does the Agent Client Protocol (ACP) fit, and do these tools speak it?
2. Decide the design with the user. Done, see above.
3. Step 9a: `oc-sub up --sandbox [--dir DIR]` and `oc-sub down --sandbox [--dir DIR]`, in a new module `src/sandbox.ts`. Details below. Done on 2026-09-29. A real `up`, `down`, and `up` cycle worked on this project. Two changes to the design came from that test: `up` writes a placeholder key file `$HOME/.config/<project>/openrouter.key` with `proxy-managed` inside the sandbox, because a project `opencode.json` with `{file:...}` is invalid without it. And a failed publish of the port counts as success when a second list shows the port, because a stopped sandbox can list no ports.
4. Step 9b: every command finds the server of a sandboxed project by itself. `oc-sub ping` must also check the project key file instead of the placeholder. Done on 2026-09-29. `up --sandbox` no longer prints `export OC_SUB_URL=...`, because the variable wins over the state files of all projects. The server URL comes from `--url`, then `OC_SUB_URL`, then the sandbox state of the project of `--dir` (or of the current folder), then the default. `oc-sub run` accepts the key `proxy-managed` of the sandbox of the project, and uses the project key file on the host for the key checks and the real cost.
5. Step 9c: inside the sandbox, the agents allow all bash commands. Done on 2026-09-29, differently than planned: the agent files stay the same. `up --sandbox` starts the server with `OPENCODE_CONFIG_CONTENT`, which sets `bash: "allow"` for `coder` and `researcher`. A string replaces the rule object of the file, while an object would be merged key by key and lose to the later `ask` rules. `git push` does not ask any more. Instead, the server starts with an empty `SSH_AUTH_SOCK`, so a push by mistake finds no SSH agent, and the sandbox has no GitHub token.
6. Step 9e: sandbox mode becomes the default of `up`, `down`, and `restart`. Done on 2026-09-30. A plain `oc-sub up` starts the sandbox of the project. `--no-sandbox` selects the host server, the old behavior. `--port` and `--url` name a host server, so they imply `--no-sandbox`. `--sandbox` stays the explicit form of the default and rejects `--no-sandbox`, `--url`, and `--port`. `--dir` is only allowed in sandbox mode. `up` reports a missing `sbx` binary and names `oc-sub up --no-sandbox` as the host alternative. Error hints that said `oc-sub up --sandbox` now say `oc-sub up`.
7. Step 9f: `oc-sub attach CODE` attaches the opencode TUI to a known run. CODE is any part of the session ID that matches exactly one run record. Done on 2026-09-30. `oc-sub run` prints `watch live: oc-sub attach <CODE>` instead of the full `opencode attach ...` command. CODE is the last 6 characters of the session ID.
8. Step 9g: the global rules and skills reach every agent. Done on 2026-09-30. The shared agents folder comes from `OC_SUB_SHARED_DIR`, else `$HOME/dv/meta/agents`. It holds `AGENTS.md` and `skills/<name>/SKILL.md` and is never copied. Reason: opencode 1.18.32 drops the global `~/.config/opencode/AGENTS.md` whenever `OPENCODE_CONFIG_DIR` is set (see [opencode-rules.md](research/opencode-rules.md)), and `up` always sets it. So `up` stops when `<shared>/AGENTS.md` is missing, and host mode and sandbox mode pass the rules file under `instructions` and the skills folder under `skills.paths` in `OPENCODE_CONFIG_CONTENT`. The sandbox gets a third read-only mount for the shared folder, `up` checks the mount and the readability of the rules file inside, and `oc-sub ping --rules` checks through a real session that the agent sees the rules.

Design of step 9a, decided on 2026-09-29:

- The project root is the folder of the main repository (`dirname` of `git rev-parse --git-common-dir`), so that all worktrees in `.worktrees/` are visible inside. The sandbox name is `oc-sub-<project>`.
- If the sandbox does not exist, `up` creates it: `sbx create --name NAME opencode ROOT ./opencode:ro`, with the plugin folder as the working directory. `sbx` 0.45.1 rejects an absolute path with `:ro`, but accepts a relative one. The plugin folder then appears read-only under its host path, and `OPENCODE_CONFIG_DIR` keeps the same value as on the host.
- `up` refuses to start without the project key file `~/.config/<project>/openrouter.key`. It sets the secret once: `sbx secret set openrouter --sandbox NAME --command 'cat KEYFILE'`.
- Each project gets a fixed host port, stored in `$XDG_STATE_HOME/oc-sub/sandbox-<project>.json` with the name, the root, and the port. The first free port from 18768 upward is the default. `up` publishes it with `sbx ports NAME --publish PORT:4096`.
- `up` starts a detached host process `sbx exec -e OPENCODE_CONFIG_DIR=... NAME opencode serve --hostname 0.0.0.0 --port 4096`. This process holds the sandbox, because `sbx` stops a sandbox 30 seconds after the last `sbx` session. The PID file and the log use the same state folder as the host server.
- `down --sandbox` keeps the busy check of `down`, then runs `sbx stop NAME`, and removes the PID file.
- `sbx` comes from `SBX_BIN`, else from `sbx` on `PATH`. The tests replace every call of `sbx` with a fake.



## State after step 9 (2026-09-29)

Step 9 is done, with 9a to 9e. A real sandbox of this project passed all checks on 2026-09-29: `bun test` ran inside with the `bun` of the host mise, the researcher used `websearch` through Exa, GET reached the internet, POST to other hosts and every request to the host server and the LAN got 403, the SSH socket was gone, and the MCP gateway was off.

- `sbx` no longer forwards the SSH agent of the host (`ssh.agentForwardingEnabled false`). The goal of the sandbox is the smallest blast radius.
- `OPENCODE_ENABLE_EXA=1` gives the researcher `websearch` (see [websearch.md](research/websearch.md)). The host server gets it at its next restart. On 2026-09-29 it could not restart, because a session of terminator was busy.
- In step 9a and in step 9d, the tests of the GLM coder were green, but a fake with an invented output format hid a bug (`sbx secret ls`, `mise env --json`). For code that parses the output of a tool, test with real output.
- Open: the Exa index lags behind. A search for the latest opencode release returned v1.18.27, while v1.18.32 exists. The researcher must confirm versions with `reader` on the source page.

## Step 10: A probe picks the approved providers

Status: open. Decided with the user on 2026-09-29.

Root cause: from the afternoon of 2026-09-28, five GLM runs in a row produced broken output. OpenRouter picked the provider by price and availability, and about a third of the providers of GLM 5.3 Flash serve it in fp4. Since then, the plugin pins GLM to Z.AI alone (`only: ["z-ai"]`, `allow_fallbacks: false` in `opencode/opencode.json`). If Z.AI is down, a run fails.

1. A small fixed probe task, like the A/B task in [EXPERIENCE.md](EXPERIENCE.md#ab-test-agent-prompt-against-the-default-prompt): find types in a large file with grep and paged reads, write the answer, and commit it. One probe costs about 0.005 USD.
2. A small test program runs the probe three times per candidate provider, with `only: [<provider>]` and `allow_fallbacks: false`. OpenRouter has curated endpoints for reliable tool calls for some models (as far as known, "Exacto"). If GLM 5.3 Flash has them, the program tests them too.
3. Pass rules, checked by code: the correct answer, a commit, no repeated identical calls, no unreadable text, and reasoning under a limit.
4. The result is two or three approved fallback providers after Z.AI. Estimated cost: 0.15 to 0.30 USD.

Sub-steps, decided on 2026-09-30:

- 10a, done on 2026-09-30. The report is [provider-probe.md](research/provider-probe.md). 31 providers serve the model, 11 of 33 endpoints in fp4. Z.AI has a p50 of 28 tokens per second, while BaseTen, Parasail, and Together reach about 100. The review of the main thread picks option B: the probe runs through `oc-sub run` with one pinned provider per run, because the failures happened inside the opencode loop. Research run cost 0.0122 USD at OpenRouter.
- 10b, done on 2026-09-30. The report is [probe-routing.md](research/probe-routing.md). Each probe run directory gets a `.opencode/opencode.json` with a model alias such as `glm-probe-baseten` (`id` is the real slug, `options.provider.only` pins one provider). The alias inherits the catalog data of the real model and cannot collide with the pin of the plugin. The file must exist before the first server request to that directory, because the server caches the configuration per directory.
- 10c, done on 2026-09-30. `probe/` holds a deterministic fixture of 11,656 lines with three interfaces, the task, and the expected answer. `src/probe/evaluate.ts` checks six rules (answer, commit, loop, unreadable text, reasoning, tool error) and reads the time to the first token, the generation time, and the tokens per second. Known gap: meaningless plain ASCII text under 20,000 characters passes.
- 10d, code done on 2026-09-30. `bun probe/run.ts --providers LIST --runs N --yes` runs the probe one run at a time and writes `probe/results/<date>.jsonl`. `oc-sub run --model PROVIDER/MODEL` picks the model per run. The control passes only on a routing refusal of OpenRouter, and a paused run fails at once. Open: the paid probe (about 30 runs, about 0.30 USD), then the new `order` list in `opencode/opencode.json`.
- Probe done on 2026-09-30, batch `193831`: 21 of 24 runs passed. Z.AI, Parasail, Together, Fireworks, SiliconFlow, Novita, and Sail Research passed 3 of 3. BaseTen failed 3 of 3 with "temporarily rate-limited upstream". Parasail and Together answer in under 1 second to the first byte and generate 1.5 to 2 times faster than Z.AI. The plugin now routes with `order` and `only` `["z-ai", "parasail", "together"]`. Probe cost about 0.15 USD, from the proxy log. The table is in [provider-probe.md](research/provider-probe.md#probe-result-2026-09-30).
- Found after the probe: an agent in a worktree that git did not know (the race of 10e) committed `answer.md` onto `alpha` of the main checkout of the clone, because git walked up to it. The main thread reset the clone `alpha` to `host/alpha`. 10e prevents the case. Known gap: the sandbox of this project runs the committed copy of `opencode/` in its clone, so a plugin change needs a fast-forward of the clone `alpha` before the restart (step 15c).
- Probe baseline on 2026-09-30. The first batch got a 404 on every request: the proxy sent `/v1/chat/completions` to `https://openrouter.ai/api/v1/v1/...` (fixed in commit 097cec8, with a test that joins the real base URL). The second batch passed 1 of 3 Z.AI runs, but the two failures came from the probe setup: opencode writes `node_modules` into the `.opencode/` folder of each run worktree, `git worktree remove` then failed on the folder, and the next batch reused the half-removed folder. The one clean run passed in 31 seconds at 0.0037 USD. The proxy log names Z.AI for every step and Google for the title model of opencode.
- 10e, done on 2026-09-30: the race fix. `worktree` accepts only folders that git knows, `worktreeRm` disposes the server instance first and retries, and the probe uses unique step names per batch and counts `setup` failures apart from the provider.
- 11c follow-up, done on 2026-09-30: `oc-sub doctor` checks `kvm-access`, and `--fix-as-root` runs `sudo chmod 0666 /dev/kvm`. `up` stops before any `sbx` call without KVM, and it prints the stderr of every failed `sbx` call.

## Step 11: A local proxy, the real cost per request, and a penalty for bad providers

Status: open. Decided with the user on 2026-09-29. It builds on step 6 (the detectors) and step 10 (the approved list).

Root cause: opencode stores neither the provider nor the real cost of a step. The OpenRouter response names both, but opencode drops them.

1. A small local proxy between opencode and OpenRouter records the provider, the generation ID, and the real cost of each request (see [real-cost.md](research/real-cost.md), option b). This also gives the exact real cost per run, also for overlapping runs.
2. The detectors of step 6 flag a run with a loop, a stall, unreadable text, or runaway reasoning. Then the provider of the flagged steps gets a strike.
3. After two or three strikes, the provider goes onto the OpenRouter `ignore` list for some days. After that, it gets a new chance.

Sub-steps, decided on 2026-09-30:

- 11a, done on 2026-09-30. The report is [cost-proxy.md](research/cost-proxy.md). A small Bun pass-through proxy runs inside the sandbox next to the server, and `provider.openrouter.options.baseURL` points opencode to it. The `sbx` gateway still injects the key, so the proxy never sees it. The last chunk of the stream carries `usage.cost`, and each chunk carries `provider`. opencode sends `X-Session-Id` and `x-parent-session-id`, so each request maps to its session. No established tool fits: LiteLLM and the gateways are too heavy, `openrouter-usage-proxy` buffers the stream. An opencode plugin cannot see the response. The review adds a `start` line per request, so `watch` knows when a model request is open (fixes the false stall of step 6).
- 11b, done on 2026-09-30. `src/proxy/` forwards every request to OpenRouter and streams the answer back without buffering. It writes a `start` line and an `end` line per request (session, provider, generation, real cost, tokens, finish reason, error) to stdout, and never the key or a body. The review found three bugs before the merge: the 10 second idle timeout of Bun, a copied `content-encoding` header, and a cut stream that looked complete. The live test of the main thread on 2026-09-30 showed that a Bun server on `127.0.0.1:4097` inside the sandbox is reachable, and its upstream fetch goes through the `sbx` gateway.
- 11c, code done on 2026-09-30. `up` starts the proxy next to the server in both modes: in the sandbox as a restart loop in the holder script, from the bundle `opencode/cost-proxy/cost-proxy.js` in the mounted plugin folder, and on the host as a second detached process on the port plus one. `sandboxConfigContent` and `serveEnv` set `provider.openrouter.options.baseURL`. `--no-cost-proxy` turns it off. Coder run cost 0.54 USD at OpenRouter, the most expensive run of the day (about one hour).
- Blocked on 2026-09-30: after `oc-sub restart`, the sandbox of this project did not start ("start runtime: 500 Internal Server Error"), and after `sbx rm --force` (approved by the user), `sbx create` failed too. Root cause from `sbx diagnose`: "/dev/kvm: permission denied". `/dev/kvm` was recreated at 20:36 with mode 660, owner root, and the group ID 109, which /etc/group does not know (the group `kvm` is 990). The grata sandbox still runs because it started before. The fix needs root and is a task of the user. Follow-ups: `upSandbox` must print the stderr of a failed `sbx` call instead of "has no git clone", and `oc-sub doctor` gets a check for `/dev/kvm` access (or runs `sbx diagnose`).
- 11d, open: the live test of the proxy (log lines, no orphan loop after `down`), then `watch` and `log` read the real cost and the open requests from the log. Then the strikes, after step 10.

[opencode-roadmap.md](research/opencode-roadmap.md), 2026-09-30: the latest release is 1.18.33 and fixes none of our issues. 2.0 is a beta channel (v2.0.20) with no date and a new server API. oc-sub stays on 1.18.32.

## Step 12: A working mise inside the sandbox

Status: open. Decided with the user on 2026-09-30. The research is in [sandbox-mise.md](research/sandbox-mise.md).

Root cause: the sandbox gets the tool folders of the host read-only, but no `mise` binary. An agent cannot add a tool. On 2026-09-30, a coder in arch-helper needed `pwsh`, found neither mise nor `pwsh`, and tried workarounds for a long time. In the same run, a user-scope install of PowerShell modules failed, because `/home/toka/.local/share` in the sandbox belongs to root.

1. `mise.toml` lists `mise` itself as a tool. The binary then lands in the mounted installs folder, in the same version as on the host.
2. `oc-sub up` passes `MISE_SHARED_INSTALL_DIRS=<installs mount>` into the server. mise then uses the host versions read-only and installs new tools into the home of the sandbox user.
3. `up` writes `trusted_config_paths` for the project root only (not `/home/**`) into the mise configuration of the sandbox.
4. Open: the feature is experimental upstream. Make sure that it works without `MISE_EXPERIMENTAL=1`, or set it. Find out why `/home/toka/.local/share` belongs to root inside the sandbox, and whether `HOME` points to `/home/toka` there.
5. Tests for the environment of the server, and one bullet each in `docs/GUIDE.md` and `skills/oc-sub/reference.md`.

## Step 13: oc-sub doctor

Status: done. 2026-09-30. The design is in [doctor.md](research/doctor.md), with the review of the main thread at the end (option A, no cache).

`oc-sub doctor` checks the project and the host for the things that break runs. A registry of named checks lives in `src/doctor.ts`, each with a status (`pass`, `warn`, `fail`, `skip`), a message, and a fix. The fast checks run on every `up` and `run` and stop the command on a fail, before any state change or paid call. The slow checks run only in `oc-sub doctor`.

1. Fast checks: no real `.env` file in the project or its `.worktrees/` folders, no `CLAUDE.md` in the project root, an `AGENTS.md` present, the global rule files are symlinks to the shared `AGENTS.md`, every skill symlink resolves, and the project agent files are permission-only. Stat and readdir only, except the frontmatter read of the agent files. Measured at about 1 ms.
2. Slow checks: the installed plugin commit matches `origin/alpha`, and the sandbox has the mounts that `up` requires. The list of the required mounts comes from one function that `upSandbox` and the check share, so the two never differ.
3. `oc-sub doctor [--dir DIR] [--json]` prints one line per check with the fix, then a summary. Exit code 1 on a fail.
4. If the fast checks ever take over 50 ms, `up` and `run` print a warning with the time.

## Step 10b: The plugin is the one source of the oc-sub agents

Status: done. 2026-09-30.

No project copies `coder.md` or `researcher.md` any more. The plugin serves the `coder` agent too, next to `researcher` and `reader`, through `OPENCODE_CONFIG_DIR`. Same-name agent files merge field by field, and the plugin file wins every field that it defines (see [agent-merge.md](research/agent-merge.md)).

1. `skills/oc-sub/templates/coder.md` moved to `opencode/agents/coder.md`, with a generic prompt body. A project adds its own bash rules with a permission-only `.opencode/agents/coder.md` whose bash map starts with `"*": allow`.
2. The researcher prompt now requires criteria-based judging: a `Criteria` section first, every option judged by every criterion (production effort and failure modes, with sources), and the recommendation last.
3. In sandbox mode, `sandboxConfigContent` also sets `external_directory: allow` for `coder` and `researcher`: inside the sandbox the host files are not visible, so the deny rule protected nothing, but it blocked a coder from creating a scratch folder in `/tmp`. The sandbox, not the rule, is the boundary.
4. This repository deleted its own `.opencode/agents/coder.md`; the base coder covers it.

Open follow-ups:

- `oc-sub say` warns when the session waits for an answer to a `question`. Today the message is queued, and the agent does not see it until the question is answered.
- Sandbox mode needs no project allowlist. The sandbox is the boundary, so `oc-sub up` allows every bash command and every path for `coder` and `researcher`. Only two kinds of rules stay. Role rules shape the job of an agent: the researcher edits only `docs/research/` and reads pages through `reader`. The `.env` read deny stays because the sandbox cannot stop a key in the context from reaching the model provider. The key of a project lives in `~/.config/<project>/`, outside the mount.

## Step 14: One run sees only its own clone

Root cause: the sandbox mounts the whole project root read-write, so a run reaches the main checkout, every other worktree, and the shared `.git` of the repository. It could move `alpha`, delete branches, or damage the main checkout. The research is in [run-isolation.md](research/run-isolation.md): every established tool gives a run its own independent clone, and `sbx create --clone` is the built-in version of that pattern.

- 14a, done on 2026-09-30. `upSandbox` creates the sandbox with `--clone`, from the main checkout root. The sandbox is in clone mode: the agent sees its own clone at the same absolute path as the host repository, the host repository read-only at `/run/sandbox/source`, the three read-only mounts, and nothing else. `sbx` adds a `sandbox-<name>` remote to the host repository for the review fetch. Clone mode is a create-time flag, so an existing direct-mount sandbox stops `up` with an error that names `sbx rm`; the pure `listsCloneRemote` detects it through the missing remote, and the `sandbox-mounts` check of `doctor` uses the same function. `sbx rm` ends the sessions of the sandbox, so an old sandbox must be created again with it. `sbx stop` keeps the clone, but it removes the remote; the next start adds it again with a new port (see 14e).
- 14b, done on 2026-09-30. `oc-sub worktree STEP` creates the worktree of a run inside the sandbox clone: it fetches from `origin`, copies the git identity of the host repository into the clone, and creates `feature/STEP` from a fresh `origin/alpha` (`--base` names another branch). `oc-sub worktree rm STEP` removes the worktree and deletes the branch inside the clone, so it destroys unfetched work. `oc-sub fetch` runs `git fetch sandbox-<name>` on the host, lists every `feature/*` branch with its commit count over `alpha`, and prints the review and merge commands. All three work only in sandbox mode, and every `sbx` call goes through an injectable runner, so the tests use fakes. A run folder `<root>/.worktrees/<name>` that is missing on the host maps to the project root (`projectRootOfRun` in `keys.ts`), so the fast checks of `doctor` and the key checks cover clone-mode runs. Open: an end-to-end test with a real sandbox, which the main thread does.
- 14c, done on 2026-09-30. Two fixes after a live test of the main thread ([run-isolation.md section 9](research/run-isolation.md#9-live-test-of-the-main-thread-with-the-oc-sub-kit-2026-09-30)). First, a read-only mount inside the project root stops the clone silently: `sbx create --clone` exits 0, but the sandbox holds only the mount point. The pure `sandboxMountPlan(root, pluginDir, installsDir, sharedDir)` in `src/sandbox.ts` leaves such a folder out; the clone holds its tracked files at the same path. `upSandbox`, the mount check of `up`, and the `sandbox-mounts` check of `doctor` share it. Known gap: the sandbox then uses the committed copy in the clone, not the live host folder, and untracked files of that folder are missing. After the create and on every `up`, `up` checks `sbx exec NAME git -C <root> rev-parse --git-dir` and stops with the fix `sbx rm --force NAME` when the clone is missing; `doctor` runs the same check. Second, the clone copies the remotes of the host, so `origin` can be an SSH URL that the sandbox cannot reach. `oc-sub worktree` now points the clone remote `host` to `/run/sandbox/source`, fetches `host`, and creates `feature/STEP` from `host/<base>`. Open: the end-to-end test with a real sandbox, which the main thread does.
- End-to-end test, done on 2026-09-30. The main thread recreated the sandbox of this project in clone mode. `oc-sub worktree r-deploy-access` created the run worktree in the clone. A research run there committed [deploy-access.md](research/deploy-access.md), and `oc-sub fetch` on the host showed the branch with two commits in the name of the user. The review and the squash-merge into `alpha` worked as before.

Open follow-ups of step 14:

- 14d, done on 2026-09-30. `oc-sub status --all` and `oc-sub top` now see the run folders of clone mode: for a sandbox server they list the project root plus the worktrees that `sbx exec NAME git -C <root> worktree list --porcelain` shows inside the clone, and without `--all` a `--dir` project with a sandbox state file gets the same list (`--dir` is mapped with `projectRootOfRun` first). The clone listing goes through the injectable `cloneDirectoriesOf` dependency of `StatusDeps` and returns an empty list when the sandbox does not answer.
- 14e, done on 2026-09-30. `oc-sub restart` in sandbox mode failed with "not in clone mode". Root cause: `sbx stop` removes the `sandbox-<name>` remote from the host repository, and `upSandbox` checked that remote before anything started the sandbox again. Any start adds the remote again, also the `sbx exec` of the clone check. `upSandbox` and the `sandbox-mounts` check of `doctor` now run the clone check first and the remote check after it. A test in each file fakes a remote that appears only after the first `sbx exec`. The main thread ran `oc-sub restart` for this project end to end, and the remote came back with a new port.
- The other project sandboxes (arch-helper, grata, meta) are still in direct-mount mode. Their next `oc-sub up` stops and names `sbx rm --force`.

## Step 15: `oc-sub doctor --fix` brings the setup up to date

Goal: one command brings the plugin, the server, and the sandbox of a project up to date. Today `oc-sub doctor` only prints a fix text for each problem, and the user or the agent must type each command by hand. The user asked for this step on 2026-09-30.

- 15a, done on 2026-09-30. The report is [doctor-fix.md](research/doctor-fix.md), with the review of the main thread at the end. Established tools apply safe fixes without a question and guard a destructive fix with a flag and with preconditions, never with a prompt. `--fix` never prompts. `doctor` without `--fix` is the dry run. The exit code comes from a second run of the checks after the fixes.
- 15b, done on 2026-09-30. A check can have a fix action. `--fix` runs the action of each check that warns or fails, in registry order, prints one line before and one after each action, then runs all checks again. The exit code is 1 when the second run has a fail or when a fix action failed. `--json --fix` prints `{fixes, results}` on stdout and the fix lines on stderr. The `plugin-fresh` fix runs the two `claude plugin` commands. The `global-rules` fix replaces a copy with a symlink only when its content equals the shared file, and re-points a wrong link. `--force` is parsed for 15d. The main thread ran `oc-sub doctor --fix` in this project: it updated the plugin, and all 8 checks passed. Coder run cost 0.1038 USD at OpenRouter.
- 15c, done on 2026-10-01, see [Step 15c](#step-15c-plugin-changes-reach-the-servers) below. Before: a check for a stale server plugin folder, and the restart of an idle server as its fix. Reason: the server takes its plugin folder from the `oc-sub` that started it. On this machine `~/.local/bin/oc-sub` links to the development checkout, so a plugin update does not change that folder. A restart helps only when the folder of the running server differs from the current one, so the state files must record the folder.
- 15d, done on 2026-10-01. The `sandbox-mounts` check got a fix action. The check and the fix share a classifier (`sandboxRecreateCase` in `src/sandbox.ts`) that says which recreate case holds: a missing mount, a missing clone, or no clone mode. With `--fix --force`, the fix recreates the sandbox: when the sandbox server runs, `oc-sub down` first (with the shared busy check of `restartServer`, so a busy session or a refused probe blocks), then `sbx rm --force NAME`, then `oc-sub up`, which creates the sandbox again in clone mode with all required mounts. Without `--force`, the fix changes nothing and names the flag, because a recreate ends all sessions of the sandbox. A second guard blocks always: work in the clone that would be lost. First the fix finds out whether the sandbox is in clone mode (`sbx exec NAME test -d /run/sandbox/source`). A direct-mount sandbox mounts the host repository itself, so nothing lives in the clone alone, and a dirty host tree is no reason to block: the guard skips. In a clone-mode sandbox, a local `feature/*` branch is safe only when a host ref outside `refs/remotes/sandbox-<name>/` and `refs/sandboxes/<name>/` contains its commit (`git for-each-ref --contains SHA` on the host). `git cat-file -e` is not enough, because `sbx rm` removes the `sandbox-<name>` remote and git then deletes those refs, so the last ref of a fetched but unmerged branch would go. The note names the three ways out: merge the branch, keep it with `git branch feature/STEP sandbox-<name>/feature/STEP`, or remove it in the clone with `oc-sub worktree rm STEP`. A squash merge does not contain the feature commits, so after a squash merge the user runs `oc-sub worktree rm STEP`. A run worktree with uncommitted changes (`git worktree list --porcelain`, then `git status --porcelain` inside the sandbox) also blocks. A failed `sbx exec` in the guard also blocks, because the fix cannot prove that no work is lost. The guard notes name `oc-sub fetch` and the branch or worktree. In the `exec-failed` case the sandbox does not start, so the fix does nothing and names `sbx diagnose`. The parsers of the guard output are pure functions with their own tests (`parseFeatureBranches`, `parseWorktrees`, `hostRefsKeepingCommit`). The review of the main thread found two guard bugs in the first turn: a direct-mount sandbox was checked against the host tree, and `git cat-file -e` ignored that `sbx rm` deletes the refs of the `sandbox-<name>` remote. The second turn fixed both. Coder run cost 0.1877 USD at OpenRouter for both turns. The live recreate is open, because the auto mode classifier of Claude Code denied it to the main thread.
- 15e, open: `oc-sub doctor --renovate` lifts a project to the current standard. Decided with the user on 2026-09-30. Every best practice is a check, and an old setup gets the new status `outdated`. Plain `doctor` reports it, and `--renovate` acts on it. So the standard lives in the checks, and a new rule is one new check. `--renovate` includes `--fix` and applies every fix, also the ones that end sessions, without `--force`. A busy session or unfetched work in a clone still blocks it. First candidates: a host-mode server (moves to sandbox mode; a missing `sbx` is added through mise, and `sbx login` stays with the user; a missing project key is reported, and nothing changes, because the user decided on 2026-09-30 that oc-sub never creates OpenRouter keys), a sandbox in direct-mount mode, a project `mise.toml` that pins its own `opencode` (the line is removed and only that file is committed; uncommitted changes in the file block it), and old agent copies. Found on 2026-09-30: nine projects in `~/dv` pin `opencode = "latest"`, so their sandbox server runs another opencode than the tested 1.18.32, and no check reports it. Research first: how `ng update` migrations, Renovate, and similar tools define a standard, detect drift, and apply migrations.
- 15c also gives the plugin folder a stable path, decided on 2026-09-30 (it follows from the goal, so it is no decision of the user). In sandbox mode the plugin folder is a mount, and a plugin update from the cache gives a new folder per commit, so `sandbox-mounts` would fail and need a recreate that ends sessions. Probably `up` and `doctor --fix` copy the `opencode/` folder of the current plugin into a fixed real folder (for example `~/.local/share/oc-sub/opencode/`), and the server and the mount use that folder. The main thread tested `sbx` 0.45.1 on 2026-09-30 with throwaway sandboxes. A symlink as a mount source is resolved once at create time: after `ln -sfn` to a new target, the sandbox still shows the old content. A fixed real folder works: new file content and new files appear inside at once, and also after `sbx stop` and the next start. So 15c uses a fixed real folder and syncs the `opencode/` folder of the current plugin into it, including the removal of files that the plugin dropped. `rsync` is not installed on this host, so the sync uses `node:fs` (`cpSync` plus a removal of stale entries) or an established npm library. The folder is replaced in place, never renamed away, because the mount holds the folder itself. Then the restart of an idle server loads the new files, and no recreate is needed.

Default decisions, open for a change by the user: the command is a flag of `doctor` and not a new `update` command, because the fixes belong to the checks. Every fix that can end a session or lose a local change needs `--force`, because the goal of the step is to repair and not to destroy.

### Step 15c: plugin changes reach the servers

Done on 2026-10-01 on the branch `feature/15c-plugin-sync`.

Root cause: a server took its plugin folder (`PLUGIN_CONFIG_DIR`, the `opencode/` folder next to `src/`) from the `oc-sub` that started it. If that folder was out of date, nothing noticed. In clone mode it was worse: the plugin folder of this project lies inside the project root, so the sandbox did not mount it and ran the committed copy in its clone.

Design:

- One fixed real folder holds the plugin config for every server: `$XDG_DATA_HOME/oc-sub/opencode/`, default `~/.local/share/oc-sub/opencode/` (`pluginDataDir` in `src/plugin-sync.ts`). It lies outside every project root, so every sandbox mounts it, also the sandbox of this project.
- `syncPluginDir` copies the `opencode/` folder of the current plugin into it with `node:fs`. It first removes every entry that the source no longer has (or that changed its kind), then copies the source over the folder with `cpSync`. It never renames or removes the folder itself, because a sandbox mount holds the folder. When the content already matches, it writes nothing. No npm library was needed for about 20 lines of code.
- opencode writes its own files into a config folder: `package.json`, a lock file, `node_modules/`, and `.gitignore`. In the development checkout they take 63 MB. The sync neither copies nor removes these top-level names, and the digest ignores them. So a host server keeps its install in the synced folder, and a sync stays fast.
- `up` syncs right before it starts a server, in host mode and in sandbox mode. Sandbox mode also syncs before `sbx create`, because a mount source must exist. A server that already runs is left alone: `up` does not sync for it. The server (`OPENCODE_CONFIG_DIR`), the cost proxy bundle, and the sandbox mount all use the synced folder.
- The state records the plugin content of each server as a digest in `serve-<port>.plugin`. `up` writes it when it spawns the server, and `down` removes it. Both modes keep their server PID in `serve-<port>.pid`, so one file per port covers both. It is not in `sandbox-<project>.json`, because `up` rewrites that file also when a server already runs. A digest there could then name content that the running server never loaded.
- The digest is `sha256:<hex>` over the sorted relative path, the kind, and the content (the target for a symlink) of every entry, without the opencode-owned names. Equal content gives an equal digest in any folder, so the digest of the source, of the synced folder, and of a server compare directly. A path would not do: the path of the synced folder never changes. A git commit would not do either: the plugin cache is not always a git checkout, and uncommitted changes would hide.
- The new slow check `server-plugin` runs right after `plugin-fresh`. It warns when the synced folder differs from the source, or when a running server (the host server on the default port, or the sandbox server of the project) recorded another digest than the folder holds. A server without a record started before 15c and counts as stale. Its fix syncs the folder, then restarts each stale server only when all its sessions are idle, with the busy check of `down`. A busy server is not restarted, and the fix fails with a note that names `oc-sub abort` and `oc-sub down`. No `--force` is needed, because an idle server loses no work. Before it stops a sandbox server, the fix checks the mounts of the sandbox with `sbx ls`. If a mount is missing, for example on a sandbox created before 15c, it does not stop the server, because `up` would then refuse to start it again. The note names the recreate of step 15d.
- A fix may now return a promise, so `runFixes` and `doctor` are async. The restart prints to stderr, so `doctor --fix --json` keeps stdout for the JSON object.
- `up` and `sandbox-mounts` name the missing mounts. When the synced plugin mount is missing, the message says that a sandbox created before 15c needs a recreate. That recreate is step 15d.
- A test preload (`bunfig.toml`, `test/setup.ts`) points `XDG_DATA_HOME` and `XDG_STATE_HOME` of the test process at temporary folders, so no test writes into the real folders.

Known gaps:

- Every sandbox of this machine lacks the new mount until it is recreated. Until then, `up` in sandbox mode stops with the recreate hint, and `sandbox-mounts` fails.
- All servers share one synced folder. A sync for one server changes the files under the others. opencode loads the agents of a folder at its first request, so a running server can mix old and new content for a new folder. The check then reports it as stale, and the fix restarts it.
- The restart of the fix does not know whether the server ran with `--no-cost-proxy`, so the server comes back with the proxy.
- The check covers only the host server on the default port and the sandbox server of the project of `--dir`. A host server on another port is not checked.
- The opencode-owned names are a fixed list. If the plugin ever ships its own `package.json`, the sync skips it.

## Check of the opencode version of each project

Done on 2026-10-01. The slow `doctor` check `opencode-version` reads the tested version from the `mise.toml` of the oc-sub repository and runs `mise current opencode` in the project root. It warns when the project pin, or else the global mise pin, differs from the tested version, also when "latest" resolves to the tested version today. It also warns when the resolved version differs. The sandbox server runs the opencode that mise resolves for the project, because `up` puts the project tool folders of the mounted installs folder in front of the sandbox PATH. Known gaps: a pin in `.mise.toml`, `mise.local.toml`, or a parent `mise.toml` is not seen, and pins are compared as exact strings. The fix action comes with step 15e.

## Step 15c fix: the sync writes the opencode `.gitignore`

Done on 2026-10-01. Root cause: the sandbox mounts the synced plugin folder read-only, and opencode 1.18.32 writes a missing `.gitignore` into each config folder at every instance start. The EROFS error failed every request, and `oc-sub top --all` showed "no sessions". `syncPluginDir` now writes the file with the exact content of opencode when it is missing ([opencode-config-writes.md](research/opencode-config-writes.md)). The npm install of opencode skips a read-only folder by itself.

## Check of new opencode releases

Done on 2026-10-01. The slow `doctor` check `opencode-release` runs `mise latest opencode`. It warns when the latest release is newer than the tested pin and than the last review in `opencode-review.json`. The global mise configuration of the user now pins opencode 1.18.32 instead of "latest". That file is not in chezmoi, so other machines still pin "latest".

## Hand-off on 2026-09-30

State for the next thread. Everything above is on `alpha` and pushed.

No run is active. `oc-sub doctor --fix` updated the installed Claude Code plugin to the commit of 15b on 2026-09-30. Step 15b is done. Step 14e finished on 2026-09-30: `oc-sub restart` works again in sandbox mode. Step 8j finished on 2026-09-30 and is on `alpha`: `oc-sub worktree` runs the `setup` command of `.opencode/oc-sub.json` inside the new run worktree. This repository sets `bun install --frozen-lockfile`, so a coder starts with `node_modules`.

The workflow in this project now (clone mode):

1. `oc-sub worktree STEP` creates the run worktree inside the sandbox clone and runs the setup command of the project.
2. `oc-sub run --agent coder --dir <root>/.worktrees/STEP --brief <file>` starts the run, and `oc-sub watch` waits.
3. `oc-sub fetch` on the host, review with `git diff alpha...sandbox-oc-sub-opencode-subagents/feature/STEP`, run `mise exec -- bun test` on the host, and squash-merge into `alpha`.
4. `oc-sub worktree rm STEP` removes the worktree inside the clone.

Next steps of the plan, in this order:

1. Step 10 first, decided with the user on 2026-09-30: fallback providers make every later run safer, and the probe also measures speed per provider. Step 10 is done: Z.AI first, Parasail and Together as fallbacks. Open for the user: a faster provider first.
1. Step 15: `oc-sub doctor --fix`, next is 15c (stable plugin folder, stale-server check, restart of an idle server), then 15d and 15e (`--renovate`). Start 15c from the 15c bullets of step 15 and from the review section of [doctor-fix.md](research/doctor-fix.md).
2. 8h: `oc-sub status --json`.
3. The known gaps of 8g: new worktrees appear in the live view only after `a` twice, the footer lacks the day totals and the key usage per project, and the title is cut below about 110 columns.
4. Step 12: a working mise inside the sandbox (open, decided with the user).
5. `oc-sub say` warns when the session waits for an answer to a `question` (open follow-up of step 10b).

Open tasks of the user:

- Give the user `toka` access to `/dev/kvm`, see step 11c "Blocked". Without it, no sandbox can start or be created.


- Recreate the sandboxes of arch-helper, grata, and meta in clone mode when no session runs there: `sbx rm --force oc-sub-<project>`, then `oc-sub up` in the project. This ends their sessions. grata had active sessions on 2026-09-30.
- Decide from [deploy-access.md](research/deploy-access.md) section 8: whether Tailscale runs on the servers, and how long a debugging window lasts.
- Optional: report the unhandled `AbortError` of the SSE client of `@opencode-ai/sdk` 1.18.32 upstream (lesson `opencode-sdk-sse-abort-unhandled.md` in meta). Then the handler in `src/top/app.tsx` can go.

Lessons of this day in `~/dv/meta/agents/lessons/`: `sbx-clone-mode-fails-silently.md`, `opencode-sdk-sse-abort-unhandled.md`, `worktree-needs-setup-command.md`, `compare-failing-test-names.md`, and `sbx-stop-removes-clone-remote.md`, `fix-mode-guards-by-flag-not-prompt.md`, and `json-output-test-parses-all-stdout.md`.

## Step 16c: the real cost from the proxy log

Done on 2026-10-01. Root cause: `watch` and `log` read the real cost from the OpenRouter key usage, so a DeepInfra run showed $0, and overlapping runs mixed their costs.

`src/proxycost.ts` sums the `cost` of the proxy `end` lines over the session tree (`SessionTree.ids`), across every `serve-*.log` and `proxy-*.log` in the state folder. Session IDs are unique, so no port mapping is needed. If the log has no line for the tree, the old OpenRouter line stays. The line reads `real cost $0.0550 from the cost proxy (48 requests, deepinfra $0.0550)`. A DeepInfra coder run wrote the step, and it was the live test of itself (see [EXPERIENCE.md](EXPERIENCE.md)). Known gap: the reader scans whole log files on each call, which gets slow once the logs grow large.

## Step 2b: say keeps the model of the run

Root cause: `run --model` set the model only on the first message, and `say` sent no model, so opencode fell back to the model of the agent file. A DeepInfra run moved to OpenRouter on the first follow-up, and no error showed it. The proxy log of the research run of step 18 showed 3 DeepInfra and 60 OpenRouter requests. `say` now sends the model of the last user message, and `--model PROVIDER/MODEL` overrides it. A coder run made the change (cost $0.0237 real, partly on DeepInfra before its stream error). The review added one fix: `--agent` on a session without a user message goes on without a model. 829 tests pass.

## Step 12: a working mise inside the sandbox

Root cause: the sandbox got the tool folders of the host read-only, but no `mise` binary, so an agent could not add a tool. `up` now asks the host mise for its version and installs that version as the tool `aqua:jdx/mise` into the shared installs folder. A plain `mise@<version>` fails, because `mise` is not in the mise tool registry. `up` takes the bin folder from `mise bin-paths` and puts it on the sandbox PATH after the project tools. The server gets `MISE_SHARED_INSTALL_DIRS`, `MISE_TRUSTED_CONFIG_PATHS` with the project root, and data, cache, and state folders in `/home/agent`, because `/home/toka/.local/share` belongs to root inside the sandbox. `MISE_EXPERIMENTAL=1` is not needed. Any failure is a warning, and the server starts without mise.

The coder run started on DeepInfra and stopped on its stream error, then continued on OpenRouter. The first version used `mise@<version>` and a fixed bin layout. Its unit tests passed with a fake runner, but the review found both errors on the host, and a follow-up message fixed them. The run cost $0.2309 real ($0.0613 DeepInfra, $0.1696 OpenRouter), 99 requests. Live test after `oc-sub restart`: the server has the variables, `mise ls bun` shows `1.4.2 (shared)`, and `mise x jq@latest` installed jq 1.8.2 into the sandbox home. 836 tests pass.

## Step 3: the tools of the worktree exist before the agent starts

Done on 2026-10-01. Root cause: `oc-sub worktree` ran the setup command without the sandbox mise, and nothing ran `mise install` in the new worktree. `sandboxMiseBinDir` in `src/sandbox.ts` now holds the lookup of the sandbox mise, and `upSandbox` and `worktree` share it. `worktree` runs `mise install && <setup>` in one `sbx exec`, with the mise bin folder on the PATH and the `sandboxMiseEnv` variables. Without a sandbox mise, the old command runs. The sandbox mise gets `MISE_DISABLE_UPDATE_WARNING=true`, so it no longer suggests `mise self-update` on the read-only mount (`MISE_DISABLE_HINTS=all` does not hide it). The fix text of `sandbox-mounts` now names `oc-sub doctor --fix --force` first. A GLM coder run made the change ($0.0680 real). 293 tests of the touched files pass.

## Step 4: say warns on a pending request

Done on 2026-10-01. `say` lists the pending questions and permission requests of the session tree before it sends. If one exists, it prints a warning and the `oc-sub answer` command to stderr, and it still sends the message. A failing list call prints nothing. A GLM coder run made the change ($0.0542 real).

## Step 5 (11d): watch sees open model requests

Done on 2026-10-01. Root cause of the false stall: a long model request sends no event, and `watch` only counted events. `createOpenRequestReader` in `src/proxycost.ts` reads only the new bytes of each proxy log and pairs the `start` and `end` lines by request number. A `listening` line clears the open requests, because the proxy restarted. A request that is open less than 10 minutes suppresses the stall. A longer one gives the new finding `slow-request`. The review fixed one bug: the first version dropped the `start` lines of sessions outside the tree, so a subagent that joined the tree on a later poll lost its first request. A GLM coder run made the change ($0.0568 real). The live test of the proxy (no orphan restart loop after `down`) is still open.

## Research on 2026-10-01

Five GLM researcher runs for $0.1361 in total:

- [renovate-standard.md](research/renovate-standard.md) (step 15e, $0.0308): a stateless `--renovate` that reuses the fix pass, a clean git tree as a precondition, no state file, and no commits by default.
- [deepinfra-logprob.md](research/deepinfra-logprob.md) (step 16, $0.0321): no public report of the error, the client never asks for log probabilities, and opencode 1.18.32 does not retry this error class (opencode issue #21893). A proxy retry is safe only before the first content chunk.
- [recurring-research.md](research/recurring-research.md) (step 17a, $0.0374): a review date plus an interval in front matter is the common pattern. Only the Windows Task Scheduler can start a stopped WSL2.
- [wsl-kvm-access.md](research/wsl-kvm-access.md) (task of the user, $0.0180): the report guessed a missing `kvm` group, but the host check found the group with gid 990 and udev rules with mode 0666. So another WSL distro likely changes the shared device node.
- [jev-decisions-api.md](research/jev-decisions-api.md) (step 18, $0.0178): the format of `POST /api/alpha/decisions`.

## Step 18 probe: Jev through OpenRouter

Done on 2026-10-01. `probe/jev.ts` sent one chat request to each Jev slug ($0.0002 in total). `typesafe/jev-router` is not Jev: it routed the request to `deepseek/deepseek-v4.1-flash` at Together. `~typesafe/jev-latest` refuses chat: "is a decisions model and cannot be used with the chat/completions endpoint. Use the /api/alpha/decisions endpoint instead." The decisions endpoint takes the normal project key and charges $0.042 per million input tokens.

## Step 2b: the reader takes the model of the run

Done in code on 2026-10-01. Root cause ([subagent-model.md](research/subagent-model.md)): in opencode 1.18.32, `task.ts` uses the `model` of the subagent file first and the model of the calling session only as the fallback. `reader.md` set its own model, so `--model` never reached it. The line is gone, so the reader inherits the model of the run. The live test is open.

## Step 8h: `status --json`, and a host worktree finds its project

Done on 2026-10-01. `oc-sub status --json` prints one JSON array with `id`, `state`, `title`, `folder`, and with `--all` also `project` and `server`; messages go to stderr. Bug: `status` from a host worktree such as `<root>/.claude/worktrees/x` reported "no server", because `projectRootOfRun` took the folder itself as the project. It now maps an existing folder to its project root through the git common dir. Live test from the main thread worktree passed. GLM coder run, $0.1921 real.

## Step 15e: `oc-sub doctor --renovate`

Done on 2026-10-01, from [renovate-standard.md](research/renovate-standard.md). `--renovate` runs the fix pass with force, and the guards inside a fix still block. New fixes: `agent-copies` keeps only the permission block of an old agent copy or deletes a copy without one (needs `--force` under `--fix`), and `opencode-version` sets a project pin to the tested version and runs `mise install`. A pin in the global mise configuration stays manual. The review replaced a whole-tree clean check with a per-file check: an untracked `.claude/` folder blocked every fix, and one project ignores `.opencode/`, so its agent files are not in git at all (lesson `clean-tree-check-per-target-file.md`). GLM coder run with one follow-up, $0.2559 real.

## Step 16d: the logs keep older starts

Done on 2026-10-01. Root cause: `up` opened the server log and the host proxy log with mode `w`, so a restart erased the proxy `end` lines, and `oc-sub log` lost the real cost of older runs. The lines of the two failed DeepInfra runs were lost this way. Both logs now open in append mode, each start writes a `--- oc-sub up <time> ---` marker, and a failed start prints only the lines after the last marker. GLM coder run, $0.0995 real.

## Step 17b and 17c: recheck heads and `research-due`

Done in this project on 2026-10-01. A report can start with front matter `checked`, `recheck` (an interval, a date, or a trigger `on ...`), and `decisions`. The slow doctor check `research-due` warns on a due report or an invalid head and never fails. Eleven reports of the six topics got heads. The meta part (global rule, index script) is open. GLM coder run, $0.0368 real.

## Step 18a and 18b: the trace pipeline, stages one and two

Done on 2026-10-01. `oc-sub trace` cuts a session tree into steps (`step-start` to `step-finish`) and writes one JSON line per step with cheap signals. Live test: 26 steps for a session with 26 model requests. `oc-sub trace --tag` sends each step to `typesafe/jev-1.13` through the OpenRouter decisions endpoint with three typed questions. Live test: 34 steps, no error, $0.0011 real (estimate $0.0029); 32 `ok`, 2 `ungrounded-claim`. One of the two was wrong, because its evidence was in the step before (lesson `per-step-judge-misses-earlier-evidence.md`). GLM coder runs, $0.0411 and $0.0708 real.

## Step 17b, meta part, and one head format

Done on 2026-10-02. Meta commit 4939c82 (meta step 1g) made `bin/research-index.py` read the heads, and `mise run due` lists the due reports. A run of the meta script on our eleven heads showed a drift. Root cause: two parsers for one format, written in two sessions. Our heads used `biweekly` and `quarterly`, and meta reads every text that is not a date or an `Nd`, `Nw`, or `Nm` interval as a trigger, so our reports never became due in meta. The fix follows the global format: `src/research-head.ts` reads `Nd`, `Nw`, and `Nm`, treats every other text as a trigger, and marks an old named interval as invalid with its replacement. The eleven heads now use `2w` and `3m`. Both tools give the same due dates (checked with `--today 2026-10-20`). Lesson in `docs/outbox/`. Done by the main thread, no paid run.

## Step 19: `oc-sub worktree` in a repository without `alpha`

Done on 2026-10-02, a task of the meta supervisor. `oc-sub worktree` took `host/alpha` as the fixed base, so in meta (only `main`) `git worktree add` failed with a message that did not name the branch. Now an explicit `--base` must exist on the host, or the command stops with an error that names the branch. Without `--base`, the base is the first of `alpha`, `main`, and `master` that exists, and the command prints it when it is not `alpha`. Three new tests in `test/clone.test.ts`. The live test in meta waits for a clone-mode sandbox there. Done by the main thread, because a subagent run would have started from the old local `alpha`.

## Cost of the session of 2026-10-01, evening

All GLM runs went through OpenRouter. Research: $0.1483 in six runs. Coding: $0.9232 in eleven runs, including one follow-up, plus $0.0276 for the type check run. Probes: $0.0002 (chat) and $0.0000185 (decisions), plus $0.0011 for the live Jev tagging.

## Step 25: a compact `top` table

On 2026-10-03 the user asked for a table that says as much as possible in a narrow terminal. The `top` table now has one space between columns. One `where` column holds `project/worktree`, and 🔬 replaces the worktree prefix `research-`. The agent icon stands in front of the CODE. The state has no icon: the color of the `id` shows it, and a `--once` table in a pipe gets a `state` word column instead (changed the same day on request of the user). The cost shows in cents without `$`, and it comes right after `where`, so that a cut line still shows it. Times have at most five characters and drop the seconds after ten minutes. Numbers align to the right. The padding counts display cells with `string-width`, because an icon is two cells wide. The detail pane still names the agent and the state in words.

## Step 26: empty researcher runs in meta

On 2026-10-03 three researcher runs of the supervisor in meta ended idle after 8 seconds, with 0 tokens and no text. Root cause: `run` sent them to the meta sandbox server because a sandbox state exists, but the worktree existed only on the host. opencode then cached a broken instance for that folder, and it kept failing with `NotFound: FileSystem.realPath` after `oc-sub worktree` created the folder in the clone. `POST /instance/dispose` for the folder fixed it, and a probe prompt answered for $0.0013. Fixes: `run` refuses a folder that the sandbox clone lacks, `worktree` disposes the instance of the folder, and `doctor` takes the project name from the main checkout, not from the worktree folder. Open: `run` and `watch` do not show a `session.error` that came before `watch` connected, because opencode does not store it in a message.

## Step 28: `attach` ends on its own, and `o` in `top` opens a tmux pane

On 2026-10-03 the user asked for three changes. First, `oc-sub attach` polls the server every 2 seconds. It ends the TUI when the session answers 404 or when the server misses three checks in a row. An idle session keeps the TUI open. A live check showed that opencode answers `GET /session/{id}` for a missing session with 404 `NotFoundError`. Second, `attach` keeps only `[A-Za-z0-9_]` of CODE, so a CODE pasted with its agent icon matches. Third, inside tmux the key `o` in `top` runs the attach in a new pane. If the `top` pane has more than twice as many columns as rows, the new pane is side by side. Otherwise it is below. Two GLM runs cost $0.019 before the OpenRouter key hit its total limit. After the user raised the limit, they cost $0.049 more. Open: a tmux pane gets the environment of the tmux server, not that of `top`. A variable such as `OC_SUB_URL` that is set only in the shell of `top` does not reach the pane.

## `down --all`

On 2026-10-04 the user asked for `idfx down --all`. It stops each sandbox with a state file that `sbx ls` shows as `running`, and each host server with a PID file `serve-<port>.pid`. Each server keeps the busy check of a single `down`, so a busy server stays up without `--force`, and the other servers still stop. `downSandbox` now calls the new `stopSandbox`, which takes a state instead of a folder. Open: `restart --all` does not exist, and `test/` has one flaky test that fails in about half of the full runs, also without this change.

## Step 30: `doctor` stops leaked processes

Done on 2026-10-04. Two new slow checks read `/proc` (no new npm dependency; all process access is injected, so the tests use fakes). `top-memory` warns for each process of the user that runs the `top` command of oc-sub with more than 1 GiB RSS; the fix (with `--force`) sends SIGTERM. `orphan-processes` warns for each process of the user whose parent is PID 1 or `/init` and whose working folder is deleted; the fix (with `--force`) sends SIGTERM to each orphan and its descendants, waits 5 seconds, and SIGKILLs survivors. Without the descendants, the `bun` child of a stopped `sh` loop stays as a new orphan. Both skip on a platform without `/proc` and never touch another user's process or doctor itself. `--fix-as-root --force` runs both fixes. Known gap from the plan stays: an orphan whose folder still exists is not found. The main thread tightened the `top` match (the argument right after the CLI entry must be `top`) and added the descendants. A dry run on the host found 3 `sh` loops of the cost proxy in deleted `/tmp/oc-sub-it-*` folders: the integration tests of oc-sub leak them (follow-up in the plan). Coder run cost 0.0759 USD.
