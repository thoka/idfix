# oc-sub reference

This file holds the details for the skill `oc-sub`. [SKILL.md](SKILL.md) has the short workflow.

## Contents

- [Setup](#setup)
- [Commands](#commands)
- [Sandbox mode](#sandbox-mode)
- [Follow-up messages](#follow-up-messages)
- [Guards](#guards)
- [Questions and permission requests](#questions-and-permission-requests)
- [Cost and tokens](#cost-and-tokens)
- [Agent files](#agent-files)
- [Reasoning effort](#reasoning-effort)
- [Brief template](#brief-template)
- [Known behavior of the server](#known-behavior-of-the-server)
- [Security](#security)
- [Speed and size of steps](#speed-and-size-of-steps)

## Setup

- `oc-sub` needs `bun` and `opencode` on the PATH. If `bun` is missing, the launcher uses mise, if mise is installed.
- The plugin puts `oc-sub` on the PATH of the Bash tool. Outside Claude Code, run `bun run src/cli.ts` in the repository of the tool, or link `bin/oc-sub` into a folder on your PATH.
- On the first call from a fresh plugin copy, the launcher runs `bun install --frozen-lockfile --production` once.

## Commands

Every command accepts `--url URL`. The default URL comes from the environment variable `OC_SUB_URL`, else it is `http://127.0.0.1:8767`. With `--port N`, `up`, `down`, and `restart` target port N and keep the host of the URL; a `--url` flag whose port differs from `--port` is a usage error. Sessions belong to a project folder, so give the same `--dir` to every command of one run. The default of `--dir` is the current folder.

| Command | What it does |
| --- | --- |
| `oc-sub up [--port N]` | Checks `GET /global/health` on the target URL (the URL with the port of `--port`, see above). If no server answers, it starts `opencode serve --port N --hostname 127.0.0.1` in the background. It sets `OPENCODE_CONFIG_DIR` to the `opencode/` folder of the plugin, so the server loads the research agents (see [Agent files](#agent-files)). If the environment already sets `OPENCODE_CONFIG_DIR`, `up` keeps that value and prints a warning to stderr, because the research agents are then not loaded. The log goes to `serve-<port>.log` and the PID to `serve-<port>.pid`, in `~/.local/state/oc-sub/` (or `$XDG_STATE_HOME/oc-sub/`). With `--sandbox`, it runs the server in a Docker Sandbox instead (see [Sandbox mode](#sandbox-mode)). |
| `oc-sub down [--port N] [--force]` | Stops the server that `oc-sub up` started on the target port (see `--port` above). If a session that `oc-sub run` started is still busy, it lists the session and exits with code 1. `--force` stops the server anyway and kills the running sessions. With `--sandbox`, it stops the sandbox of the project instead (see [Sandbox mode](#sandbox-mode)). |
| `oc-sub restart [--port N] [--force]` | Runs `down`, then `up` on the same target port. With `--sandbox`, it restarts the sandbox of the project. |
| `oc-sub run --agent NAME --dir DIR (--brief FILE \| TEXT) [--title T]` | Creates a session in DIR and sends the brief to the agent without waiting. Before it creates the session, it checks the OpenRouter key: the run directory must use its project key file, and no directory of another project may resolve to the same key. On a shared key it prints an error that names the other project and exits with code 1. It also reads the usage of the key at OpenRouter for the start value of the real cost. It prints four lines: the session ID, the `opencode attach ...` command, and the two paths of the run record (`.opencode/runs/<session-id>.json` in the start directory, and a copy in `~/.local/state/oc-sub/runs/`). |
| `oc-sub status [--dir DIR \| --all]` | One line per session: ID, state (`busy`, `waiting`, `idle`, `retry`), title. `waiting` means that the session has a pending question or permission request and waits for an answer. Without `--all`, it lists the folder and each of its git worktrees. A session of another worktree shows its folder at the end (`.worktrees/x` when it is inside the folder, else absolute). With `--all`, it lists the running sessions of all projects and their worktrees, each with the absolute folder, or `no running sessions`. A directory that fails to list prints `warning: <directory>: <message>` to stderr and does not stop the listing. |
| `oc-sub ping [--dir DIR]` | Shows which OpenRouter key the server uses for DIR, where it comes from (project key file, environment, or global auth.json), and whether OpenRouter accepts it. Prints a SHA-256 fingerprint of the key, never the key itself. Warns when the server does not use the project key file, because the cost then goes to another key. |
| `oc-sub watch SESSION [--dir DIR] [--json]` | Prints one short line per tool call, failed tool call, assistant text, and session error. When the session and its subagent sessions are idle, it prints a summary line and then the real-cost line (see [Cost and tokens](#cost-and-tokens)), and exits with code 0. The summary covers the session and all of its subagent sessions. When the session or one of its subagent sessions has a pending question or permission request, it prints one block per request and exits with code 3 (see [Questions and permission requests](#questions-and-permission-requests)). When a guard sees a warning sign (see [Guards](#guards)), it prints one block per finding and exits with code 4. The run itself keeps running. With `--json`, it prints the events as JSON lines, and the summary and the blocks go to stderr. |
| `oc-sub log SESSION [--dir DIR]` | Prints the last assistant text (the report of the agent), a line with the cost and the tokens, and the real-cost line. The totals cover the session and all of its subagent sessions (see [Cost and tokens](#cost-and-tokens)). |
| `oc-sub abort SESSION [--dir DIR]` | Stops the session. |
| `oc-sub answer REQUEST_ID [--dir DIR] (--reply once\|always\|reject \| --reject \| ANSWER...)` | Answers a pending question or permission request of the run in DIR. The command looks the ID up in the two pending lists to learn its kind. A question takes one positional ANSWER per question, in order. An ANSWER is the label of an option or free text. `--reject` rejects a question. A permission request takes `--reply once`, `--reply always`, or `--reply reject`. With `--reply reject`, `--message TEXT` gives the agent the reason. It sees the message as the error of the tool call. A rejected permission request ends the turn of the agent. The command prints a hint to send a follow-up message with `oc-sub say`. `--message` is only allowed with `--reply reject`. An unknown ID, a wrong kind, and a wrong answer count stop with an error before anything is sent. After the answer, start `watch` again. |
| `oc-sub say SESSION [--dir DIR] [--agent NAME] TEXT` | Sends TEXT as a follow-up message into the session and returns at once. It uses `prompt_async`, so it does not wait for the reply to end. Without `--agent`, it takes the agent from the last user message of the session. A session without a user message needs `--agent NAME`. It prints one line with the session, the agent, and the `watch` command. |

Exit codes: 0 for success, 1 for an error (including a shared OpenRouter key in `run`), 2 for wrong arguments, 3 when `watch` found a pending question or permission request (the run is paused), and 4 when `watch` saw a warning sign in the run (see [Guards](#guards)). If no server runs, `status` prints `no server on <url>` and exits with code 0. The other commands exit with code 1 and tell you to run `oc-sub up`. If the server rejects the password in `OPENCODE_SERVER_PASSWORD`, every command exits with code 1 and says so.

## Sandbox mode

`up`, `down`, and `restart` accept `--sandbox`. The server then runs inside a Docker Sandbox (`sbx`) per project, instead of on the host. The agent works in a microVM and reaches OpenRouter through the credential proxy of `sbx`, so it cannot read the project key.

One-time setup:

- Install `sbx` (for example with mise from `github:docker/sbx-releases`) and run `sbx login` once.
- Remove the global network rule of `sbx`, so that each sandbox may reach only the hosts of its agent kit: `sbx policy rm network --id default-allow-all`. A deny rule beats every allow rule, so the per-sandbox allowlist works only without it.

What the commands do:

- `oc-sub up --sandbox [--dir DIR]` resolves the project from `--dir` (default: the current folder). It refuses to start when the project key file `~/.config/<project>/openrouter.key` is missing. It only checks that the file exists; it never reads it. It creates the sandbox `oc-sub-<project>` if needed, mounts the plugin folder read-only, sets the `openrouter` secret once from the key file, publishes the port, and starts the server inside. It prints the URL, the sandbox, the log, and one line `export OC_SUB_URL=http://127.0.0.1:<port>`. Use that URL for `oc-sub run`, `watch`, `say`, and `answer`.
- `oc-sub down --sandbox [--dir DIR] [--force]` keeps the busy check of `down`, then stops the sandbox with `sbx stop`. It removes the PID file. It keeps the state file, so the port stays the same.
- `oc-sub restart --sandbox [--dir DIR]` is `down --sandbox` followed by `up --sandbox`.

State file and ports:

- Each project sandbox has the state file `$XDG_STATE_HOME/oc-sub/sandbox-<project>.json` (default `~/.local/state/oc-sub/`) with `{"name", "root", "port"}`.
- The host port is picked once: the first port from 18768 upward that no other sandbox state uses and that is free on 127.0.0.1. Later `up` calls keep it.
- The `sbx` binary comes from `SBX_BIN` in the environment, else from `sbx` on the PATH.

Notes:

- `--dir` is only allowed with `--sandbox`, and `--sandbox` cannot be combined with `--url` or `--port`, because the URL comes from the sandbox state.
- A host process holds `sbx exec ... opencode serve` in the foreground, because `sbx` stops a sandbox 30 seconds after the last `sbx` session ends. Stop the server with `oc-sub down --sandbox`, not by killing the sandbox yourself.
- In sandbox mode, the agent files can allow all bash commands (step 9c of `docs/PLAN.md`). Until then, the permission rules of the project still apply.
- `up` writes the placeholder key file `$HOME/.config/<project>/openrouter.key` with the value `proxy-managed` inside the sandbox. Without it, a project `opencode.json` with `{file:~/.config/<project>/openrouter.key}` is invalid inside the sandbox. The proxy of `sbx` replaces the placeholder with the real key.
- If a publish of the port fails, `up` lists the ports again and accepts the port when it is there. A stopped sandbox can list no ports although its publication persists.
- Known limit until step 9b: `oc-sub run` refuses the sandboxed server, and `oc-sub ping` reports the key as rejected, because both check the placeholder.

### Watch in the background

`oc-sub watch` blocks until the run ends. A run can take 5 to 50 minutes. Start it as a background command. Claude Code then tells you when it ends:

```
oc-sub watch <session-id> --dir <worktree>
```

The last lines look like this:

```
idle after 6m12s, 41 tool calls, cost $0.0816 (subagents $0.0665 in 4 sessions), tokens in 812345, out 15234, reasoning 4012, cache read 700123, cache write 0
real cost $0.0834 at OpenRouter (key usage since the start of the run)
```

The cost and the tokens cover the session and all of its subagent sessions. Without subagent sessions, the line omits the part in parentheses. The watch ends only when the session and its subagent sessions are all done and no request of the tree is pending. The status of a session can flip to idle for a moment between two requests. So the watch checks the pending lists even when the status map says idle. It ends as idle only when the session and all its descendants are idle or missing in the status map, and no request is pending. You can start `watch` right after `run`. A session that the server has not yet marked busy does not end the watch.

### Guards

The watch tells you early when a run goes wrong. It does not wait for the end of the run. It checks three warning signs, for the watched session and for all of its subagent sessions:

- **Loop**: five tool calls in a row with the same tool and the same input. The comparison sorts the keys of the input, so the order of the keys does not matter.
- **Stall**: the session is busy, and no event of the session arrived for 180 seconds.
- **Reasoning**: one step used more than 16,000 reasoning tokens. Runs with 13,000 to 32,000 reasoning tokens in one step derailed on 2026-09-29.

On a finding, the watch prints one block and ends with exit code 4:

```
needs attention: loop
session ses_9f2a
tool read, 5 calls in a row with the same input: /repo/sdk.gen.d.ts

The run keeps running. Abort it, or send a correction to the session.
```

Each finding is reported once. The run itself keeps running. As the orchestrator, you decide:

- Read the block. A loop usually needs a correction that names the right file or the next step. Send it into the session (see [Follow-up messages](#follow-up-messages)), or abort the run with `oc-sub abort`.
- A stall usually needs an abort and a follow-up message.
- A session whose model claims broken tools is poisoned. Do not send a follow-up message into it. Start a fresh session with the same brief instead.

Then start `watch` again to follow the rest of the run.

### Questions and permission requests

An agent can ask a question with the `question` tool, and a command with an `ask` rule can raise a permission request. Both pause the session until an answer arrives. There is no timeout. The session stays `busy` in the status map, so `watch` detects the pause through the two pending lists of the server.

When `watch` finds a pending request for the watched session or for one of its subagent sessions, it prints one block per request and ends with exit code 3:

```
question que_01j4 in ses_9f2a
  1. [Delete file] Should I delete build/tmp.txt?
     - Yes: delete the file
     - No: keep the file
answer with: oc-sub answer que_01j4 --dir /path/to/worktree "<answer>" (or --reject)

The session waits for an answer. After answering, watch again.
```

To answer, run the command from the hint. For a question, pass one answer per question, in order. The answer is the label of an option or free text:

```
oc-sub answer que_01j4 --dir /path/to/worktree "Yes"
oc-sub answer que_01j4 --dir /path/to/worktree --reject
```

For a permission request, pass the reply:

```
oc-sub answer per_07b1 --dir /path/to/worktree --reply once
```

- `once` allows the tool call one time. `always` allows it for the rest of the session. `reject` refuses it.
- `--reject` on a question makes the tool call of the agent fail. The agent then continues and can react to it.
- `--reply reject --message TEXT` on a permission request gives the agent the reason. It sees the message as the error of the tool call.
- A rejected permission request ends the turn of the agent. To continue, send a follow-up message with `oc-sub say`.
- Decide yourself whether the request is safe. For a risky command or a deletion, ask the user first.
- After the answer, start `watch` again to follow the rest of the run.
- `oc-sub status` shows the session as `waiting` while it pauses.

### Commands for the user

`oc-sub run` prints the command for the user. It has this form:

```
opencode attach http://127.0.0.1:8767 --dir <worktree> --session <session-id>
```

The user runs it in a second terminal or in a tmux window. It opens the full opencode interface on the running session. The user can also open `opencode web` in a browser (see docs/GUIDE.md of the tool).

## Follow-up messages

Send a correction or a new question into the same session with `oc-sub say`. The agent keeps its context, and the cost stays low:

```
oc-sub say <session-id> --dir <worktree> "<message>"
```

- The command returns at once. `opencode run --attach` instead blocks until the reply ends, so use `oc-sub say`.
- Without `--agent`, the command takes the agent from the last user message of the session. Give `--agent NAME` for a session without a user message.
- After a rejected permission request, the turn of the agent has ended. Always send a follow-up message with `oc-sub say` to continue.
- Wait with `oc-sub watch` as usual after the message.

## Cost and tokens

- `oc-sub watch` and `oc-sub log` print two cost lines.
- The first line is the estimate of opencode. It sums `cost` and `tokens` over all assistant messages of the session and of all its subagent sessions (child sessions, recursively). opencode computes it by multiplying the tokens by the prices in its model catalog from models.dev, so it can differ from the real charge. With subagent sessions, the line names their share, for example `cost $0.0816 (subagents $0.0665 in 4 sessions)`. Without subagent sessions, the line shows only the total.
- The second line is the real cost at OpenRouter. `oc-sub run` reads the cumulative usage of the project key at OpenRouter (`GET https://openrouter.ai/api/v1/key`, field `data.usage`) before it sends the brief, and stores it in the run record. When the run ends, `watch` and `log` read the usage again. The line shows the difference: `real cost $0.0512 at OpenRouter (key usage since the start of the run)`.
- The real cost is only exact when the project key did nothing else during the run. Other `oc-sub` runs with the same key that overlap in time add their cost to the same number, so the line names them: `..., includes other runs: ses_a, ses_b`.
- OpenRouter counts a request a minute or two late. A `log` some minutes after the run can therefore show a slightly higher real cost than `watch` did.
- Without a run record, without the usage at the start, or when OpenRouter does not answer, the line reads `real cost: unknown (no key usage at the start of the run)` or `real cost: unknown (OpenRouter did not answer)`.
- The run record is a JSON file with the session ID, directory, agent, title, start time, `keyFingerprint` (the first 8 hex digits of the SHA-256 of the key, never the key), and `usageAtStart` in USD. `run` writes it to `.opencode/runs/` in the start directory and to `~/.local/state/oc-sub/runs/` (or `$XDG_STATE_HOME/oc-sub/runs/`), so `watch` and `log` find it from any working directory.
- Each project needs its own OpenRouter key in `~/.config/<project>/openrouter.key`. A key that two projects share is not allowed. `oc-sub run` checks every known directory (the same sources as `status --all`) and refuses to start when a directory of another project resolves to the same key, or when the run directory uses the global key from auth.json or the environment. It names the other project and tells you to create a key for one of the projects and run `oc-sub restart`. A directory that cannot be checked prints a warning and does not stop the run.
- Tell the user the cost of each run, for example "Run 2: 6 minutes, 0.07 USD, real cost 0.08 USD".
- `opencode stats` shows the totals over all sessions.
- Benchmark with GLM 5.3 Flash through OpenRouter: 0.07 to 0.33 USD for one coding step of 5 to 11 files.

## Agent files

An agent file is `.opencode/agents/<name>.md` in the project. The file name is the agent name. The frontmatter sets the model and the permissions, and the body is the system prompt.

A coding step needs `.opencode/agents/coder.md` in the project. Copy it from [templates/coder.md](templates/coder.md). The permissions allow every bash command, except the commands that act outside the worktree or destroy work. Those ask first: `git push`, `merge`, `rebase`, `reset`, `switch`, and `checkout`, `rm -r` and `rm -f`, `curl` and `wget`, and package installs. A bash command that names a `.env` file and `git stash` are denied.

Research needs no agent file in the project. `oc-sub up` starts `opencode serve` with `OPENCODE_CONFIG_DIR` set to the `opencode/` folder of the plugin. opencode searches that folder for agents like the project `.opencode` folder, and it loads that folder after the project folders. So an agent from `OPENCODE_CONFIG_DIR` overrides a project agent with the same name. The plugin serves two agents there: the `researcher` agent, and its hidden `reader` subagent. The researcher cannot fetch pages itself. It calls `reader` through the task tool, which fetches the pages in a fresh context and returns at most 600 words of quotes with URLs. The reader fetches only the URLs that it gets, and it stops after six steps (`steps: 6`). Without this limit, one reader call with an open task made 42 fetches. This keeps the cost low, because each fetched page would otherwise stay in the context of the researcher until the run ends. See `docs/PLAN.md` in the repository of the plugin.

Permission rules:

- Each key is `allow`, `ask`, or `deny`. `ask` pauses the run with a permission request. `oc-sub watch` shows it and ends with exit code 3, and `oc-sub answer` replies. Use `deny` only for what the agent must never do, for example reading `.env` files.
- Allow the `question` tool. The agent then asks instead of guessing or looking for a detour.
- For `bash`, `edit`, and `read`, you can give a map of patterns. The last pattern that matches wins. So put the catch-all `"*": allow` first, the commands that ask after it, and the denies last.
- `external_directory: deny` keeps the agent inside the project folder. `task: deny` stops it from starting more agents.
- Deny `*.env` and `*.env.*` for `read`.
- A long allowlist pauses the run at every command outside it, also at read-only commands such as `cat` or `rg`. In September 2026, that cost minutes per pause. The worktree and the review protect the repository, not the list. See step 9 of `docs/PLAN.md` for a real sandbox.

The server reads the agent files of the folder that you pass with `--dir`. The server loads the agent files of a folder once, when that folder gets its first request. A new worktree gets the current files. A changed agent file takes effect for a folder that the server already knows only after `oc-sub restart`. After an update of the plugin, run `oc-sub restart`. The running server keeps the plugin folder that it got at start in `OPENCODE_CONFIG_DIR`, and a plugin update can install into a new folder.

Do not use `opencode run --auto` instead of agent files. The Claude Code permission check blocks the flag, and it approves every request that is not explicitly denied.

## Reasoning effort

For a pure JSON answer without tools, GLM needs low reasoning effort. With the default thinking, it planned each item in its reasoning, used all 40,000 output tokens, and gave no answer.

- In a direct OpenRouter request, set `"reasoning": {"effort": "low"}` in the request body.
- In an opencode agent file, extra keys of the frontmatter go to the provider as model options. Add these lines to the frontmatter:

```yaml
reasoning:
  effort: low
```

A test on 2026-09-27 with opencode 1.18.25 and `openrouter/z-ai/glm-5.3-flash` confirmed it: the same question used 125 reasoning tokens without the setting and 6 with it.
- If the model has variants, `opencode run --variant <name>` selects one.

## Brief template

A good brief is precise. The agent cannot ask questions.

```
# Step <id>: <title>

## Read first
- CLAUDE.md, <files>

## Scope
- <what to build or find out>
- Tests: <test command>. They must pass.

## Do not touch
- <files and folders>

## Context
<everything the agent needs from outside the worktree, copied in here>

## Final report
The commits, the changed files, the test results, and the open decisions.
```

For research, name the output file, for example `docs/research/<topic>.md`, and ask for a source for each fact.

## Known behavior of the server

- `GET /session/status?directory=<dir>` lists only sessions that are not idle. An empty object means that no session is busy. `oc-sub watch` handles this, also for the subagent sessions of the watched session.
- A session that waits for a question or a permission answer counts as `busy` in `GET /session/status`. The pending requests are visible in `GET /question` and `GET /permission`. `oc-sub watch` and `oc-sub status` read them for you.
- The end of an `opencode run --attach` process does not mean the end of the session. Ask the server, for example with `oc-sub status --dir <dir>`.
- A research agent cannot read files outside its project folder (`external_directory: deny`). Copy the needed context into the worktree or into the brief.
- `opencode session list` shows all sessions. `opencode -s <id>` opens a finished session.

## Security

- The permission rules stop some mistakes of the agent. They are not a sandbox. A test command such as `bun test` or `pytest` runs any code that the agent wrote.
- The real protection is: a separate git worktree, no access to `.env` or keys, and your review of every diff before a merge.
- Keep the server on `127.0.0.1`. If other users share the machine, set `OPENCODE_SERVER_PASSWORD`. `oc-sub` and `opencode` read it from the environment. Never print it.
- If a command is denied, the agent reports it. Do not go around the denial. Tell the user.

## Speed and size of steps

- The benchmark steps took 6 to 49 minutes. The speed was 30 to 140 tokens per second.
- A step with 5 files took about 6 to 18 minutes. A step with 11 files took 49 minutes and was not complete.
- Split a step that changes more than about ten files into several briefs.
- Review each result like the work of a junior developer. In the benchmark, GLM missed edge cases and interface names, but it made small commits and wrote honest reports.
