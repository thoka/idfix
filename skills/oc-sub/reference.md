# oc-sub reference

This file holds the details for the skill `oc-sub`. [SKILL.md](SKILL.md) has the short workflow.

## Contents

- [Setup](#setup)
- [Commands](#commands)
- [Follow-up messages](#follow-up-messages)
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

Every command accepts `--url URL`. The default URL comes from the environment variable `OC_SUB_URL`, else it is `http://127.0.0.1:8767`. Sessions belong to a project folder, so give the same `--dir` to every command of one run. The default of `--dir` is the current folder.

| Command | What it does |
| --- | --- |
| `oc-sub up [--port N]` | Checks `GET /global/health`. If no server answers, it starts `opencode serve --port N --hostname 127.0.0.1` in the background. The log goes to `serve-<port>.log` and the PID to `serve-<port>.pid`, in `~/.local/state/oc-sub/` (or `$XDG_STATE_HOME/oc-sub/`). |
| `oc-sub down [--port N] [--force]` | Stops the server that `oc-sub up` started. If a session that `oc-sub run` started is still busy, it lists the session and exits with code 1. `--force` stops the server anyway and kills the running sessions. |
| `oc-sub restart [--port N] [--force]` | Runs `down`, then `up` on the same port. |
| `oc-sub run --agent NAME --dir DIR (--brief FILE \| TEXT) [--title T]` | Creates a session in DIR and sends the brief to the agent without waiting. It prints three lines: the session ID, the `opencode attach ...` command, and the path of the run record `.opencode/runs/<session-id>.json`. |
| `oc-sub status [--dir DIR]` | One line per session: ID, state (`busy`, `idle`, `retry`), title. |
| `oc-sub ping [--dir DIR]` | Shows which OpenRouter key the server uses for DIR, where it comes from (project key file, environment, or global auth.json), and whether OpenRouter accepts it. Prints a SHA-256 fingerprint of the key, never the key itself. Warns when the server does not use the project key file, because the cost then goes to another key. |
| `oc-sub watch SESSION [--dir DIR] [--json]` | Prints one short line per tool call, failed tool call, assistant text, and session error. When the session is idle, it prints a summary line and exits with code 0. With `--json`, it prints the events as JSON lines, and the summary goes to stderr. |
| `oc-sub log SESSION [--dir DIR]` | Prints the last assistant text (the report of the agent) and a line with the cost and the tokens. |
| `oc-sub abort SESSION [--dir DIR]` | Stops the session. |

Exit codes: 0 for success, 1 for an error, 2 for wrong arguments. If no server runs, `status` prints `no server on <url>` and exits with code 0. The other commands exit with code 1 and tell you to run `oc-sub up`. If the server rejects the password in `OPENCODE_SERVER_PASSWORD`, every command exits with code 1 and says so.

### Watch in the background

`oc-sub watch` blocks until the run ends. A run can take 5 to 50 minutes. Start it as a background command. Claude Code then tells you when it ends:

```
oc-sub watch <session-id> --dir <worktree>
```

The last line looks like this:

```
idle after 6m12s, 41 tool calls, cost $0.0712, tokens in 812345, out 15234, reasoning 4012, cache read 700123, cache write 0
```

You can start `watch` right after `run`. A session that the server has not yet marked busy does not end the watch.

### Commands for the user

`oc-sub run` prints the command for the user. It has this form:

```
opencode attach http://127.0.0.1:8767 --dir <worktree> --session <session-id>
```

The user runs it in a second terminal or in a tmux window. It opens the full opencode interface on the running session. The user can also open `opencode web` in a browser (see docs/GUIDE.md of the tool).

## Follow-up messages

Send a correction or a new question into the same session. The agent keeps its context, and the cost stays low:

```
opencode run --attach http://127.0.0.1:8767 --dir <worktree> --session <session-id> --agent <agent> "<message>" < /dev/null
```

- `< /dev/null` is necessary. Without it, `opencode run` waits for input and hangs.
- The `opencode run` process can end before the session ends. Wait with `oc-sub watch` as usual.
- If the server has a password, `opencode run` reads it from `OPENCODE_SERVER_PASSWORD`.

## Cost and tokens

- `oc-sub watch` and `oc-sub log` sum `cost` and `tokens` over all assistant messages of the session. The cost is in USD, as the provider reports it.
- Tell the user the cost of each run, for example "Run 2: 6 minutes, 0.07 USD".
- `opencode stats` shows the totals over all sessions.
- Benchmark with GLM 5.3 Flash through OpenRouter: 0.07 to 0.33 USD for one coding step of 5 to 11 files.

## Agent files

An agent file is `.opencode/agents/<name>.md` in the project. The file name is the agent name. The frontmatter sets the model and the permissions, and the body is the system prompt. Templates: [templates/researcher.md](templates/researcher.md) and [templates/coder.md](templates/coder.md).

Permission rules:

- Each key is `allow`, `ask`, or `deny`. Use `deny` instead of `ask`, because nobody answers questions in a run.
- For `bash`, `edit`, and `read`, you can give a map of patterns. The last pattern that matches wins, so put `"*": deny` first and the allowed commands after it.
- `external_directory: deny` keeps the agent inside the project folder. `task: deny` stops it from starting more agents.
- Deny `*.env` and `*.env.*` for `read`.
- Adapt the `bash` allowlist to the test command of the project, for example `"uv run pytest*": allow` or `"npm test*": allow`.

The server reads the agent files of the folder that you pass with `--dir`. A new or changed agent file in a worktree needs no server restart.

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

- `GET /session/status?directory=<dir>` lists only sessions that are not idle. An empty object means that no session is busy. `oc-sub watch` handles this.
- The end of an `opencode run --attach` process does not mean the end of the session. Ask the server, for example with `oc-sub status --dir <dir>`.
- A research agent cannot read files outside its project folder (`external_directory: deny`). Copy the needed context into the worktree or into the brief.
- `opencode session list` shows all sessions. `opencode -s <id>` opens a finished session.

## Security

- The allowlist stops mistakes of the agent. It is not a sandbox. A test command such as `bun test` or `pytest` runs any code that the agent wrote.
- The real protection is: a separate git worktree, no access to `.env` or keys, and your review of every diff before a merge.
- Keep the server on `127.0.0.1`. If other users share the machine, set `OPENCODE_SERVER_PASSWORD`. `oc-sub` and `opencode` read it from the environment. Never print it.
- If a command is denied, the agent reports it. Do not go around the denial. Tell the user.

## Speed and size of steps

- The benchmark steps took 6 to 49 minutes. The speed was 30 to 140 tokens per second.
- A step with 5 files took about 6 to 18 minutes. A step with 11 files took 49 minutes and was not complete.
- Split a step that changes more than about ten files into several briefs.
- Review each result like the work of a junior developer. In the benchmark, GLM missed edge cases and interface names, but it made small commits and wrote honest reports.
