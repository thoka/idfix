---
checked: 2026-10-04
recheck: each new Claude Code release
decisions: ["step 25g: idfx top and status poll local Claude Code files", "step 25g: no proxy and no hooks for Claude sessions"]
---

# Claude Code sessions: local data sources

## Question

Which local data sources let `idfx top` and `idfx status` list and watch Claude Code sessions, and what does each source give? A research agent (Claude, Opus) measured this on 2026-10-04 on this machine, with Claude Code 2.1.285. It read files and ran commands, and it changed nothing.

Commands: `claude --version`, `claude --help`, `claude agents --help`, `claude agents --json [--all]`, `claude {attach,logs,stop,rm} --help`, `claude logs <id>`. It also read `~/.claude/{sessions,jobs,daemon,projects}`, the strings of the binary, and `~/dv/meta/dv/bin/claude-glm`.

## 1. `claude agents --json`: the session list

The command lists interactive and background sessions. At the measurement, it listed 15 sessions: 9 interactive and 6 background. `--all` adds finished background sessions (`state: "done"`). `--cwd <path>` filters only the background sessions.

Fields:

- `sessionId`, `name`, `cwd`, `startedAt` (milliseconds)
- `kind`: `interactive` or `background`
- `pid`: only while the process is alive
- `id`: a short id of 8 characters, only for background sessions
- `status`: only for interactive sessions, `busy` or `idle`
- `state`: only for background sessions, `working`, `blocked`, or `done`

The list gives no tokens, no model, and no state "waits for a permission".

## 2. Files under `~/.claude`

`sessions/<pid>.json` exists for each live process, also for `--bg`. Its fields are `pid`, `procStart`, `sessionId`, `cwd`, `name`, `nameSource`, and `kind` (`interactive` or `bg`). More fields are `entrypoint`, `version`, `jobId` (background only), `status`, `waitingFor`, `updatedAt`, and `statusUpdatedAt`. `tmux` holds the pane id, for example `4:@4.%14`. `messagingSocketPath` holds the socket of the session.

The binary sets `status: "waiting"` with a reason in `waitingFor`: the title of a permission dialog, "input needed", "dialog open", "sandbox request", or "worker request". Else it sets `busy` or `idle`. The agent also saw `status: "shell"` while a shell command ran, and `claude agents` showed it as `busy`. This file is the only source that tells that an interactive session waits for the user. A crash can leave the file behind, so a reader compares `pid` and `procStart` with the live process. The `.key` files next to these files are secrets, and idfx never reads them.

`jobs/<id>/state.json` exists only for background sessions. Its fields are `state`, `tempo`, `inFlight`, `fan`, `tokens`, `respawnFlags`, `createdAt`, and `updatedAt`. `detail` is a one-line progress text. If the session is blocked, `needs` tells what the user must do. `intent` is the first prompt, and idfx keeps it out of its view. `providerEnv` holds the model variables. `jobs/<id>/timeline.jsonl` holds one line for each change of state: `{at, state, detail, text}`.

`projects/<cwd with dashes>/<sessionId>.jsonl` is the transcript. Each line has a type. The main types are `user`, `assistant`, `attachment`, and `system`. A `system` line has a subtype, for example `turn_duration`, `api_error`, or `compact_boundary`. Other types are `custom-title`, `agent-name`, `ai-title`, `permission-mode`, `last-prompt`, and `cost-state`. Common fields are `timestamp`, `uuid`, `parentUuid`, `isSidechain`, `cwd`, `gitBranch`, `version`, `entrypoint`, and `sessionKind`. An `assistant` line has `message.model`, `message.id`, and `message.usage` with the input, output, and cache tokens.

Each subagent of the Agent tool writes its own transcript, `projects/<dir>/<sessionId>/subagents/agent-<id>.jsonl`, with `isSidechain: true`. Next to it, `agent-<id>.meta.json` holds `agentType`, `description`, `model`, and `spawnDepth`.

No transcript line records a permission prompt. Only the result shows: `toolDenialKind` on a denied tool call. `history.jsonl` holds the prompts of the user, and idfx keeps it out.

## 3. Live events

Claude Code gives no public event stream for a session that it did not start. `--output-format stream-json` works only for runs with `-p` or the SDK. Hooks can write events to a file, but they need a change to the configuration of the user. Examples are `SessionStart`, `Stop`, `PermissionRequest`, and `Notification` with `permission_prompt` and `idle_prompt`. OpenTelemetry gives `claude_code.token.usage` and `claude_code.cost.usage`, but it needs a collector. The messaging socket is internal.

## 4. GLM sessions

`claude-glm` sets the OpenRouter endpoint and the GLM model, then runs `claude`. So a GLM session shows in the same places. The transcript tells it apart: `message.model` is `z-ai/glm-5.3-flash`. The name of a session is not a reliable mark. No file records the endpoint.

## 5. Attach

`claude attach <id>` opens a background session in the terminal, and the session keeps running. `claude logs <id>` prints its recent terminal output. Claude Code has no attach for an interactive session. If the session runs in tmux, the pane id in `sessions/<pid>.json` lets a tool switch to that pane.

## 6. Cost

One API response spans several `assistant` lines, and each line repeats the same `message.usage`. So a reader counts one `usage` for each `message.id` and adds the subagent transcripts. The line `type: "cost-state"` holds `totalCostUSD` and the usage for each model. Claude Code writes it near the end of a transcript, so it is not live. For a Claude session on the Max plan, the USD value is the API price of the same tokens, not a real charge. For GLM, the value is wrong (`hasUnknownModelCost: true`).

## Critical analysis

1. Premises of the question: the question assumes that idfx must read Claude Code state itself. A view in Claude Code can exist one day. The format of `~/.claude` is undocumented and can change with a release.
2. The standard solution and its control mechanisms: the standard is OpenTelemetry to a vendor dashboard, or Remote Control on claude.ai. Both send the data to a third party or a central service.
3. Autonomous alternatives: the local files, read by polling, need no service and no change to the configuration. Hooks that write a local log are the next step.
4. The cost of autonomy: an undocumented format breaks without notice. A test against a recorded sample of each file finds the break, and `recheck` names each new Claude Code release.
