# Plan

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

1. Research: how does OpenRouter report the real cost of a request (the `usage` object with `cost`, and `GET /api/v1/generation?id=...`)? Does opencode store the generation ID or the real cost of a step? The first research report is `docs/research/OPENROUTER_ROUTING.md`.
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

Status: open. Decided with the user on 2026-09-29. It builds on the detection module of step 6. It is the next step. Since step 9, several servers can run: the host server on 8767 and one sandbox server per project. `top` finds the sandbox servers through the state files `~/.local/state/oc-sub/sandbox-<project>.json` (`sandboxUrlFor` in `src/sandbox.ts`). `status --all` still covers only one server. The research report [TOP_VIEW.md](research/TOP_VIEW.md) predates step 9, so check it against this change.

`oc-sub status` stays short and line-based for agents, and gets `--json`. `oc-sub top` is a full-screen live view for the user, like `htop`. `oc-sub top --once` prints one text snapshot for agents.

1. Research first, with a report in `docs/research/`. Does Ink run under bun? Does the opencode server have one event stream across all projects, or does `top` subscribe per directory?
2. Scope: the current project and its worktrees. `--all` shows all projects, like `status`.
3. One line per session: project and worktree, agent, state (busy, waiting, stalled, looping, idle), elapsed time, steps, tool calls, context size, estimated and real cost.
4. The numbers at a glance: state, time since the last token, real cost, and thinking (reasoning tokens as a share of the output, and in the current step).
5. A detail pane for the selected session: the last events as a short log, a pending question or permission request, and the subagent sessions as a tree. A footer with the server, the totals of the day, and the key usage per project.
6. Library: Ink, because models know React best, so a subagent makes fewer mistakes and uses fewer tokens.
7. First version shows only. The key `o` prints the `opencode attach` command. Keys that act (answer, abort, follow up) come in a later step.

## Step 9: A real sandbox instead of permission rules

Status: done on 2026-09-29. Steps 9a to 9c are on `alpha`. This project (opencode-subagents) runs in sandbox mode: the sandbox `oc-sub-opencode-subagents` serves port 18768, and its state file is `~/.local/state/oc-sub/sandbox-opencode-subagents.json`. Other projects still use the host server on port 8767.

State of the test on 2026-09-29: the test is done. The details are in [SANDBOX.md](research/SANDBOX.md#7-test-of-docker-sandboxes-on-2026-09-29).

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

Design of step 9a, decided on 2026-09-29:

- The project root is the folder of the main repository (`dirname` of `git rev-parse --git-common-dir`), so that all worktrees in `.worktrees/` are visible inside. The sandbox name is `oc-sub-<project>`.
- If the sandbox does not exist, `up` creates it: `sbx create --name NAME opencode ROOT ./opencode:ro`, with the plugin folder as the working directory. `sbx` 0.45.1 rejects an absolute path with `:ro`, but accepts a relative one. The plugin folder then appears read-only under its host path, and `OPENCODE_CONFIG_DIR` keeps the same value as on the host.
- `up` refuses to start without the project key file `~/.config/<project>/openrouter.key`. It sets the secret once: `sbx secret set openrouter --sandbox NAME --command 'cat KEYFILE'`.
- Each project gets a fixed host port, stored in `$XDG_STATE_HOME/oc-sub/sandbox-<project>.json` with the name, the root, and the port. The first free port from 18768 upward is the default. `up` publishes it with `sbx ports NAME --publish PORT:4096`.
- `up` starts a detached host process `sbx exec -e OPENCODE_CONFIG_DIR=... NAME opencode serve --hostname 0.0.0.0 --port 4096`. This process holds the sandbox, because `sbx` stops a sandbox 30 seconds after the last `sbx` session. The PID file and the log use the same state folder as the host server.
- `down --sandbox` keeps the busy check of `down`, then runs `sbx stop NAME`, and removes the PID file.
- `sbx` comes from `SBX_BIN`, else from `sbx` on `PATH`. The tests replace every call of `sbx` with a fake.



## Open points from 2026-09-29

- `alpha` holds step 9 and is not pushed. The user agreed: when the sandbox mode runs stably for a few real steps (after the mise fix and a first part of step 8), merge `alpha` into `main` and push.
- Done: `sbx` no longer forwards the SSH agent of the host (`ssh.agentForwardingEnabled false`, set on 2026-09-29). The goal of the sandbox is the smallest blast radius, so actions outside in the name of the user stay on the host.
- Step 9d, next before step 8: the sandbox has no `bun`, so an agent in the sandbox cannot run `bun test`. The 9c run reported this correctly. Root cause: the sandbox image of `sbx` has only its own tools, not the tools of the project from `mise.toml`. Design, tested on 2026-09-29: the host binaries of mise run unchanged in the sandbox (bun 1.4.2, node 22, Python 3.13, although the host is Arch Linux and the sandbox Ubuntu 26.04).
  1. `up --sandbox` runs `mise install` on the host in the project root, so that every tool of `mise.toml` exists.
  2. `sbx create` mounts `~/.local/share/mise/installs` read-only under the same path (relative path with `:ro`, like the plugin folder). No download happens twice, the versions are the same as on the host, and the network policy needs no new hosts. The agent cannot change the tools.
  3. `up` reads the tool paths of the project with `mise env -C ROOT` on the host, and passes them to the holder command as the start of `PATH`. mise itself is not needed inside.
  4. A mount can only be set at `sbx create`. An existing sandbox without the mount must be removed and created again. `up` detects this in the output of `sbx ls` and says so.
- In step 9a, the tests of the GLM coder were green, but three bugs stayed hidden, because its fake of `sbx` used an invented output format. For code that parses the output of a tool, test with real output.

## Step 10: A probe picks the approved providers

Status: open. Decided with the user on 2026-09-29.

Root cause: from the afternoon of 2026-09-28, five GLM runs in a row produced broken output. OpenRouter picked the provider by price and availability, and about a third of the providers of GLM 5.3 Flash serve it in fp4. Since then, the plugin pins GLM to Z.AI alone (`only: ["z-ai"]`, `allow_fallbacks: false` in `opencode/opencode.json`). If Z.AI is down, a run fails.

1. A small fixed probe task, like the A/B task in [EXPERIENCE.md](EXPERIENCE.md#ab-test-agent-prompt-against-the-default-prompt): find types in a large file with grep and paged reads, write the answer, and commit it. One probe costs about 0.005 USD.
2. A small test program runs the probe three times per candidate provider, with `only: [<provider>]` and `allow_fallbacks: false`. OpenRouter has curated endpoints for reliable tool calls for some models (as far as known, "Exacto"). If GLM 5.3 Flash has them, the program tests them too.
3. Pass rules, checked by code: the correct answer, a commit, no repeated identical calls, no unreadable text, and reasoning under a limit.
4. The result is two or three approved fallback providers after Z.AI. Estimated cost: 0.15 to 0.30 USD.

## Step 11: A local proxy, the real cost per request, and a penalty for bad providers

Status: open. Decided with the user on 2026-09-29. It builds on step 6 (the detectors) and step 10 (the approved list).

Root cause: opencode stores neither the provider nor the real cost of a step. The OpenRouter response names both, but opencode drops them.

1. A small local proxy between opencode and OpenRouter records the provider, the generation ID, and the real cost of each request (see [REAL_COST.md](research/REAL_COST.md), option b). This also gives the exact real cost per run, also for overlapping runs.
2. The detectors of step 6 flag a run with a loop, a stall, unreadable text, or runaway reasoning. Then the provider of the flagged steps gets a strike.
3. After two or three strikes, the provider goes onto the OpenRouter `ignore` list for some days. After that, it gets a new chance.
