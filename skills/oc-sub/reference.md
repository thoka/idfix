# oc-sub reference

This file holds the details for the skill `oc-sub`. [SKILL.md](SKILL.md) has the short workflow.

## Contents

- [Setup](#setup)
- [Commands](#commands)
- [Doctor checks](#doctor-checks)
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
- Keep your global agent files in one shared folder: `OC_SUB_SHARED_DIR`, else `$HOME/dv/meta/agents`. Put your global rules into `AGENTS.md` and each skill into `skills/<name>/SKILL.md`. It is the only source. `oc-sub` never copies it.
- `up` refuses to start when `<shared>/AGENTS.md` is missing. It names the path and `OC_SUB_SHARED_DIR`.

### The opencode bug with the global rules

opencode 1.18.32 has a bug: with `OPENCODE_CONFIG_DIR` set, it silently drops the global `~/.config/opencode/AGENTS.md`. `oc-sub up` always sets `OPENCODE_CONFIG_DIR`, so every session would lose the global rules. The fix: `up` passes the shared rules file under `instructions` and the shared skills folder under `skills.paths` in `OPENCODE_CONFIG_CONTENT` (host mode and sandbox mode). An absolute path in `instructions` still loads despite the bug, and the skills object form is the form that opencode 1.18.32 reads. Both facts are verified by real runs, see [docs/research/OPENCODE_RULES.md](../../docs/research/OPENCODE_RULES.md) and [docs/research/OPENCODE_SKILLS.md](../../docs/research/OPENCODE_SKILLS.md). Check the result after every `up` with `oc-sub ping --rules`.

## Commands

Every command accepts `--url URL`. The URL comes from `--url`, then the environment variable `OC_SUB_URL`, then the sandbox state of the project of `--dir` (or of the current folder), then the default `http://127.0.0.1:8767`. The sandbox step applies to `run`, `status`, `top`, `ping`, `watch`, `log`, `abort`, `answer`, and `say`. `status --all` and `top --all` skip it, because they cover every known server: the host server (from `--url`, `OC_SUB_URL`, or the default) plus every sandbox with a state file. `up`, `down`, and `restart` run in sandbox mode by default. With `--no-sandbox`, `--port N`, or `--url URL` they target the host server, and `--port N` targets port N and keeps the host of the URL; a `--url` flag whose port differs from `--port` is a usage error. Sessions belong to a project folder, so give the same `--dir` to every command of one run. The default of `--dir` is the current folder.

| Command | What it does |
| --- | --- |
| `oc-sub up [--dir DIR]` | Sandbox mode is the default (see [Sandbox mode](#sandbox-mode)). With `--no-sandbox`, it checks `GET /global/health` on the target URL (the URL with the port of `--port`, see above). If no server answers, it starts `opencode serve --port N --hostname 127.0.0.1` in the background. It sets `OPENCODE_CONFIG_DIR` to the `opencode/` folder of the plugin, so the server loads the research agents (see [Agent files](#agent-files)). It also sets `OPENCODE_CONFIG_CONTENT` with the shared rules file under `instructions` and the shared skills folder under `skills.paths` (see [The opencode bug with the global rules](#the-opencode-bug-with-the-global-rules)). If the environment already sets `OPENCODE_CONFIG_DIR` or `OPENCODE_CONFIG_CONTENT`, `up` keeps that value and prints a warning to stderr, because the research agents or the shared rules are then not loaded. It stops with an error when `<shared>/AGENTS.md` is missing. The log goes to `serve-<port>.log` and the PID to `serve-<port>.pid`, in `~/.local/state/oc-sub/` (or `$XDG_STATE_HOME/oc-sub/`). |
| `oc-sub down --no-sandbox [--port N] [--force]` | Stops the host server that `oc-sub up --no-sandbox` started on the target port (see `--port` above). If a session that `oc-sub run` started is still busy, it lists the session and exits with code 1. `--force` stops the server anyway and kills the running sessions. Without `--no-sandbox`, it stops the sandbox of the project instead (see [Sandbox mode](#sandbox-mode)). |
| `oc-sub restart --no-sandbox [--port N] [--force]` | Runs `down`, then `up` on the same target port. Without `--no-sandbox`, it restarts the sandbox of the project. |
| `oc-sub run --agent NAME --dir DIR (--brief FILE \| TEXT) [--title T]` | Creates a session in DIR and sends the brief to the agent without waiting. Before it creates the session, it checks the OpenRouter key: the run directory must use its project key file, and no directory of another project may resolve to the same key. On a shared key it prints an error that names the other project and exits with code 1. It also reads the usage of the key at OpenRouter for the start value of the real cost. It prints four lines: the session ID, a `watch live: oc-sub attach CODE` line (CODE is the last 6 characters of the session ID), and the two paths of the run record (`.opencode/runs/<session-id>.json` in the start directory, and a copy in `~/.local/state/oc-sub/runs/`). |
| `oc-sub attach CODE [--url URL]` | Attaches the opencode TUI to a known run, like `opencode attach URL --dir DIR --session ID`. CODE is any part of the session ID that matches exactly one known run (case-sensitive substring). The known runs come from the run records of the state folder and of the current directory. No match prints `error: no run matches "CODE"` and exits with code 1. Two or more matches print the session ID, the title, and the directory of each match, ask for a longer part, and exit with code 1. One match starts `opencode attach` with the current terminal and returns its exit code. |
| `oc-sub status [--dir DIR \| --all]` | One line per session: ID, state (`busy`, `waiting`, `idle`, `retry`), title. `waiting` means that the session has a pending question or permission request and waits for an answer. Without `--all`, it lists the folder and each of its git worktrees. A session of another worktree shows its folder at the end (`.worktrees/x` when it is inside the folder, else absolute). With `--all`, it asks every known server: the host server (from `--url`, `OC_SUB_URL`, or the default) and every sandbox with a valid state file. A server that does not answer is skipped. A server that rejects the password or fails to list its projects prints `warning: <url>: <message>` to stderr and is skipped. It lists the running sessions of all projects and worktrees of each answering server, each with the absolute folder, or `no running sessions`. A session that two servers share appears once. A directory that fails to list prints `warning: <directory>: <message>` to stderr and does not stop the listing. |
| `oc-sub top --once [--dir DIR \| --all] [--json]` | Prints one text snapshot of the sessions: one header line, one padded line per session (session ID, folder, agent, state, elapsed time, time since the last activity, steps, tool calls, context tokens in k, estimated cost, reasoning share, title), and one indented line per pending request. Without `--all`, it reads the folder of `--dir` (default: the current folder) and its git worktrees. With `--all`, it reads every directory of every known server, like `status --all`. A session counts when it is not idle or when its last update is at most 60 minutes old. The elapsed time of an idle session stops at its newest message. The cost and the tokens cover the session and all of its subagent sessions. `--json` prints the rows as one JSON array, with the pending requests of each row. It prints `no sessions` when nothing matches, and `no server on <url>` when no server answers, both with exit code 0. Without `--once`, it prints a hint and exits with code 2, because the live view comes in a later step. |
| `oc-sub ping [--dir DIR]` | Shows which OpenRouter key the server uses for DIR, where it comes from (project key file, environment, global auth.json, or the `sbx` proxy of a sandbox), and whether OpenRouter accepts it. Prints a SHA-256 fingerprint of the key, never the key itself. Warns when the server does not use the project key file, because the cost then goes to another key. |
| `oc-sub ping --rules [--dir DIR]` | Checks that the agent on the server sees the shared rules. It reads the first line that starts with `# ` in `<shared>/AGENTS.md` on the host. Then it creates a session on the server of `--dir` (the normal URL resolution), sends one short prompt with low reasoning effort to the agent `researcher`, and asks it to reply with the first heading of its loaded instructions file, verbatim, or NONE. It prints `rules: pass` or `rules: FAIL` with the expected heading and the reply, plus the cost of the session. It deletes the session afterwards when the API allows it, and prints a warning when the deletion fails. Exit code 0 on pass, 1 on fail. Run it once after every `up`. |
| `oc-sub watch SESSION [--dir DIR] [--json]` | Prints one short line per tool call, failed tool call, assistant text, and session error. When the session and its subagent sessions are idle, it prints a summary line and then the real-cost line (see [Cost and tokens](#cost-and-tokens)), and exits with code 0. The summary covers the session and all of its subagent sessions. When the session or one of its subagent sessions has a pending question or permission request, it prints one block per request and exits with code 3 (see [Questions and permission requests](#questions-and-permission-requests)). When a guard sees a warning sign (see [Guards](#guards)), it prints one block per finding and exits with code 4. The run itself keeps running. With `--json`, it prints the events as JSON lines, and the summary and the blocks go to stderr. |
| `oc-sub log SESSION [--dir DIR]` | Prints the last assistant text (the report of the agent), a line with the cost and the tokens, and the real-cost line. The totals cover the session and all of its subagent sessions (see [Cost and tokens](#cost-and-tokens)). |
| `oc-sub abort SESSION [--dir DIR]` | Stops the session. |
| `oc-sub answer REQUEST_ID [--dir DIR] (--reply once\|always\|reject \| --reject \| ANSWER...)` | Answers a pending question or permission request of the run in DIR. The command looks the ID up in the two pending lists to learn its kind. A question takes one positional ANSWER per question, in order. An ANSWER is the label of an option or free text. `--reject` rejects a question. A permission request takes `--reply once`, `--reply always`, or `--reply reject`. With `--reply reject`, `--message TEXT` gives the agent the reason. It sees the message as the error of the tool call. A rejected permission request ends the turn of the agent. The command prints a hint to send a follow-up message with `oc-sub say`. `--message` is only allowed with `--reply reject`. An unknown ID, a wrong kind, and a wrong answer count stop with an error before anything is sent. After the answer, start `watch` again. |
| `oc-sub doctor [--dir DIR] [--json]` | Runs the health checks of the project of `--dir` (default: the current folder) and of the host, and prints one line per check with the status, the name, the message, and the fix. It ends with a summary line and exits with code 1 when a check fails. `--json` prints the results as one JSON array. The checks and their fixes are in [Doctor checks](#doctor-checks). |
| `oc-sub say SESSION [--dir DIR] [--agent NAME] TEXT` | Sends TEXT as a follow-up message into the session and returns at once. It uses `prompt_async`, so it does not wait for the reply to end. Without `--agent`, it takes the agent from the last user message of the session. A session without a user message needs `--agent NAME`. It prints one line with the session, the agent, and the `watch` command. |

Exit codes: 0 for success, 1 for an error (including a shared OpenRouter key in `run`), 2 for wrong arguments, 3 when `watch` found a pending question or permission request (the run is paused), and 4 when `watch` saw a warning sign in the run (see [Guards](#guards)).

## Doctor checks

`oc-sub doctor` runs all checks. The fast checks also run on every `up` and `run`: a fail stops the command before anything changes state and before any paid call, and the output names the fixes plus the hint `run oc-sub doctor for details`. A warn prints one line and the command continues. The fast checks take about 1 ms. Over 50 ms, the command prints a warning with the time. The slow checks run only in `oc-sub doctor`.

| Check | Status on a problem | What it checks and how to fix it |
| --- | --- | --- |
| `env-files` | fail | No real `.env` or `.env.*` file in the project root or in any folder of `<root>/.worktrees/`, except names that end in `.example` or `.sample`. The file is never opened. Fix: move the keys to `~/.config/<project>/<provider>.key` and delete the file. |
| `claude-md` | fail | No `CLAUDE.md` or `CLAUDE.local.md` in the project root. Fix: rename it to `AGENTS.md`. |
| `agents-md` | warn | The project root has `AGENTS.md`. Fix: create it with the rules of the project. |
| `global-rules` | warn or fail | `~/.claude/CLAUDE.md`, `~/.config/opencode/AGENTS.md`, and `~/.codex/AGENTS.md` are symlinks whose target resolves to `<shared>/AGENTS.md` (the folder from `OC_SUB_SHARED_DIR`). A missing path is a warn, because the tool may not be installed. A regular file (a copy) or a broken link is a fail. Fix: replace it with a symlink. |
| `skill-links` | fail | Every entry of `~/.claude/skills/` and `~/.agents/skills/` that is a symlink resolves to an existing folder. A missing folder skips the check. Fix: remove the broken link or point it back. |
| `agent-copies` | fail | `.opencode/agents/coder.md`, `researcher.md`, and `reader.md` exist only as permission-only files: the frontmatter has `permission`, no `description`, `model`, or `prompt`, and the body is empty (see [Agent files](#agent-files)). Fix: delete the file, the plugin serves the agent, or keep only a permission block. |
| `plugin-fresh` | warn | The `gitCommitSha` of the `opencode-subagents@opencode-subagents` entry in `~/.claude/plugins/installed_plugins.json` matches `origin/alpha` of the plugin repository. A missing file or key skips the check. Fix: `claude plugin marketplace update opencode-subagents && claude plugin update opencode-subagents@opencode-subagents`. |
| `sandbox-mounts` | fail | When a sandbox state file exists for the project, `sbx ls` lists all mounts that `up` requires. Without a state file, or without the sandbox in `sbx ls`, it skips. Fix: `sbx rm NAME`, then `oc-sub up` creates the sandbox again with all three mounts. |

## Sandbox mode If no server runs, `status` and `top --once` print `no server on <url>` and exit with code 0. The other commands exit with code 1 and tell you to run `oc-sub up`. If the server rejects the password in `OPENCODE_SERVER_PASSWORD`, every command exits with code 1 and says so.

## Sandbox mode

`up`, `down`, and `restart` run in sandbox mode by default. The server then runs inside a Docker Sandbox (`sbx`) per project, instead of on the host. The agent works in a microVM and reaches OpenRouter through the credential proxy of `sbx`, so it cannot read the project key. A host server needs `--no-sandbox`. `--port` and `--url` name a host server, so they imply `--no-sandbox`. `--sandbox` is the explicit form of the default.

One-time setup:

- Install `sbx` (for example with mise from `github:docker/sbx-releases`) and run `sbx login` once.
- Remove the global network rule of `sbx`, so that each sandbox may reach only the hosts of its agent kit: `sbx policy rm network --id default-allow-all`. A deny rule beats every allow rule, so the per-sandbox allowlist works only without it.
- Turn off the forwarding of the host SSH agent, then restart the daemon: `sbx settings set ssh.agentForwardingEnabled false` and `sbx daemon restart`. With forwarding on, an agent can log in with the SSH keys of the user, for example to push to GitHub.

What the commands do:

- `oc-sub up [--dir DIR]` resolves the project from `--dir` (default: the current folder). It stops with an error when `<shared>/AGENTS.md` is missing on the host, before anything changes state. It refuses to start when the project key file `~/.config/<project>/openrouter.key` is missing. It only checks that the file exists; it never reads it. It runs `mise install` in the project root, creates the sandbox `oc-sub-<project>` if needed, mounts the plugin folder, the mise installs folder, and the shared agents folder read-only, sets the network rules on a new sandbox, sets the `openrouter` secret once from the key file, publishes the port, checks the network rules, and starts the server inside. It prints the URL, the sandbox, and the log. The other commands find that URL by themselves through the sandbox state. Do not set `OC_SUB_URL` to it, because the variable wins over the state files of all projects. When the `sbx` binary is missing, `up` stops and names `oc-sub up --no-sandbox` as the host alternative.
- `oc-sub down [--dir DIR] [--force]` keeps the busy check of `down`, then stops the sandbox with `sbx stop`. It removes the PID file. It keeps the state file, so the port stays the same.
- `oc-sub restart [--dir DIR]` is `down` followed by `up` in sandbox mode.

State file and ports:

- Each project sandbox has the state file `$XDG_STATE_HOME/oc-sub/sandbox-<project>.json` (default `~/.local/state/oc-sub/`) with `{"name", "root", "port"}`.
- The host port is picked once: the first port from 18768 upward that no other sandbox state uses and that is free on 127.0.0.1. Later `up` calls keep it.
- The `sbx` binary comes from `SBX_BIN` in the environment, else from `sbx` on the PATH.

Notes:

- `--dir` is only allowed in sandbox mode, and the sandbox flags cannot be combined with `--url` or `--port`, because the URL comes from the sandbox state. A host server needs `--no-sandbox`, `--url`, or `--port`.
- The tools of the project come from the mise of the host. `up` runs `mise install` in the project root (binary from `MISE_BIN`, else `mise`) and stops when it fails. It reads the tool folders with `mise env -C ROOT --json` and keeps only the folders inside the mise installs folder (`$MISE_DATA_DIR/installs`, default `$XDG_DATA_HOME/mise/installs`, default `~/.local/share/mise/installs`). The holder command gets these folders at the front of `PATH`, in front of the PATH of the sandbox image. So `bun`, `node`, and `python` inside the sandbox are the versions of `mise.toml`, and mise itself is not needed inside.
- The create mounts three host folders read-only under their host paths: the `opencode/` folder of the plugin, the mise installs folder, and the shared agents folder (`OC_SUB_SHARED_DIR`, else `$HOME/dv/meta/agents`). No tool is downloaded twice, the versions are the same as on the host, the agent cannot change the tools, and the shared rules and skills stay on the host. `sbx` accepts read-only mounts only with relative paths, so the create runs with the working directory `/` and names all mounts relative from there.
- If the sandbox exists but its WORKSPACE column lacks one of the three mounts, `up` stops with an error. It names `sbx rm NAME` and says that `oc-sub up` then creates the sandbox again with all three mounts. `up` does not remove the sandbox itself, because it holds the sessions. Note that `sbx rm` ends the sessions of the sandbox.
- On a new sandbox, `up` sets the network rules: `sbx policy allow network --sandbox NAME "**" --method GET,HEAD`, then `sbx policy allow network --sandbox NAME mcp.exa.ai:443` (all methods, the websearch calls it with POST), then `sbx policy deny network --sandbox NAME "host.docker.internal,localhost,127.0.0.0/8,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16"`. The reason: research needs to read any page with GET or HEAD, but the host server and the LAN must stay closed. The proxy of `sbx` rewrites `host.docker.internal` to `localhost`, so a deny rule for `host.docker.internal` alone is not enough. GET to every host means that data can still leave in a GET URL.
- On every `up`, before the server starts, `up` runs `sbx exec NAME test -r <shared>/AGENTS.md` and stops with an error when the sandbox cannot read the file. Then it runs `sbx policy check network --sandbox NAME host.docker.internal:8767` and `... localhost:8767`. Both must print `Denied`. If one is allowed, `up` stops and names the deny command. This protects the host server of an old sandbox without the rules.
- A host process holds `sbx exec ... opencode serve` in the foreground, because `sbx` stops a sandbox 30 seconds after the last `sbx` session ends. Stop the server with `oc-sub down`, not by killing the sandbox yourself.
- Inside the sandbox, `up` passes `OPENCODE_CONFIG_CONTENT` into the server. It replaces the whole bash rule object of the sandbox agents with `allow`, so `coder` and `researcher` run every bash command without a permission request. It turns the MCP gateway of the `sbx` kit off (`mcp.mcp-gateway.enabled: false`), so an agent cannot call its tools. It also lists the shared rules file under `instructions` and the shared skills folder under `skills.paths` (see [The opencode bug with the global rules](#the-opencode-bug-with-the-global-rules)). The agent files stay the same, and the host server keeps their rules. The other permissions of the files still apply, for example `edit` of `researcher` and `external_directory`. `reader` is not affected: its file denies bash on purpose, because it only reads web pages.
- `git push` over SSH fails inside the sandbox, because the setup turns off the SSH agent forwarding. As a second guard, `up` sets `SSH_AUTH_SOCK` to empty. The user pushes from the host.
- If the host sets `OPENCODE_CONFIG_CONTENT`, `up` prints a warning: that value does not go into the sandbox. Only a value that the holder command names with `-e` reaches the sandbox.
- `up` writes the placeholder key file `$HOME/.config/<project>/openrouter.key` with the value `proxy-managed` inside the sandbox. Without it, a project `opencode.json` with `{file:~/.config/<project>/openrouter.key}` is invalid inside the sandbox. The proxy of `sbx` replaces the placeholder with the real key.
- If a publish of the port fails, `up` lists the ports again and accepts the port when it is there. A stopped sandbox can list no ports although its publication persists.
- `run`, `ping`, and the real cost work with a sandboxed server. The server reports the placeholder key `proxy-managed`, and the proxy of `sbx` adds the real key from the project key file on the host. `oc-sub` reads that file, checks it at OpenRouter, and uses it for the shared-key check of `run` and the real-cost line. `ping` prints the source as `sbx proxy with the project key file <path>`, or `sbx proxy without a project key file (<path> is missing)`. Only fingerprints appear in the output, never a key.

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
oc-sub attach <code>
```

CODE is the last 6 characters of the session ID. The command finds the run in the run records and starts the full command itself, like `opencode attach http://127.0.0.1:8767 --dir <worktree> --session <session-id>`. The user runs it in a second terminal or in a tmux window. It opens the full opencode interface on the running session. The user can also open `opencode web` in a browser (see docs/GUIDE.md of the tool).

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

The plugin serves the `coder`, `researcher`, and `reader` agents itself. `oc-sub up` starts `opencode serve` with `OPENCODE_CONFIG_DIR` set to the `opencode/` folder of the plugin. opencode searches that folder for agents like the project `.opencode` folder, and it loads that folder after the project folders.

Same-name agent files do not replace each other: they merge field by field, and the plugin file wins every field that it defines (see `docs/research/AGENT_MERGE.md` in the repository of the plugin). So the plugin keeps the prompt, the description, and the model of `coder` and `researcher`. A project cannot change the model in its own agent file; the plugin model line wins.

A project that needs its own bash rules adds `.opencode/agents/coder.md` that holds only a `permission` block whose `bash` map starts with `"*": allow` and then lists the project rules, for example `"bun test*": allow`. The project rules must come after the catch-all, because the last matching pattern wins; without the catch-all first, the plugin `"*": allow` appends after the project keys and silently shadows them. The plugin deny rules (`.env` reads, `git stash`) still merge in last and cannot be re-allowed. A `bash` map in the project `opencode.json` does not work: its keys land before the plugin file rules and stay inert.

The plugin serves the `coder` agent itself through `OPENCODE_CONFIG_DIR`; the project needs no agent file for a coding step. The permissions of the plugin coder allow every bash command, except the commands that act outside the worktree or destroy work. Those ask first: `git push`, `merge`, `rebase`, `reset`, `switch`, and `checkout`, `rm -r` and `rm -f`, `curl` and `wget`, and package installs. A bash command that names a `.env` file and `git stash` are denied.

Research needs no agent file in the project. `oc-sub up` starts `opencode serve` with `OPENCODE_CONFIG_DIR` set to the `opencode/` folder of the plugin. opencode searches that folder for agents like the project `.opencode` folder, and it loads that folder after the project folders. So an agent from `OPENCODE_CONFIG_DIR` overrides a project agent with the same name. The plugin serves three agents there: the `coder` agent, the `researcher` agent, and the hidden `reader` subagent of the researcher. The researcher cannot fetch pages itself. It calls `reader` through the task tool, which fetches the pages in a fresh context and returns at most 600 words of quotes with URLs. The reader fetches only the URLs that it gets, and it stops after six steps (`steps: 6`). Without this limit, one reader call with an open task made 42 fetches. This keeps the cost low, because each fetched page would otherwise stay in the context of the researcher until the run ends. See `docs/PLAN.md` in the repository of the plugin.

The researcher also gets the `websearch` tool. `oc-sub up` starts the server with `OPENCODE_ENABLE_EXA=1` (only when the environment does not set the variable itself). opencode offers the tool to an OpenRouter model only then. The tool calls `https://mcp.exa.ai/mcp` with POST, without a key and without cost. The sandbox network rules allow `mcp.exa.ai:443` for all methods.

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
