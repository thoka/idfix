# idfix

Status: experimental alpha. The tool and the skill were built in September 2026 and have few real runs so far. The command line and the file formats can change.

This project makes cheap opencode subagents usable from Claude Code. Its name is idfix 🐕, after the dog Idefix in Asterix, because it will support clients other than opencode. Until 2026-10-05 its name was opencode-subagents. It contains a small command line tool `oc-sub` and a Claude Code skill `oc-sub`, packaged as a Claude Code plugin. The research of the design is in [.plan/research/prior-art.md](.plan/research/prior-art.md). The lessons from the first use are in [.plan/EXPERIENCE.md](.plan/EXPERIENCE.md).

## Use it in another project

The repository is a Claude Code plugin and a plugin marketplace. Install it once:

```
claude plugin marketplace add thoka/idfix
claude plugin install idfix@idfix
```

You need no agent file in the project: the plugin serves the `coder`, `researcher`, and `reader` agents itself, through `OPENCODE_CONFIG_DIR`. [docs/GUIDE.md](docs/GUIDE.md) explains the setup, how to watch a run live, how to follow up and abort, how to read the cost, and the security notes.

### Updates

The manifest has no `version` field, so Claude Code uses the git commit as the version, and every pushed commit counts as an update. Claude Code does not update a third-party marketplace by itself. To get the new commits, run these commands and then start a new Claude session:

```
claude plugin marketplace update idfix
claude plugin update idfix@idfix
```

To update at every start instead, open `/plugin`, select the marketplace, and enable auto-update. On the machine where you develop the plugin, add the marketplace from the local folder (`claude plugin marketplace add /path/to/idfix`). Claude Code then reads the files live, and `/reload-plugins` loads a change. [.plan/research/plugin-updates.md](.plan/research/plugin-updates.md) has the sources.

## Plugin layout

- `.claude-plugin/plugin.json` — the plugin manifest (name `idfix`)
- `.claude-plugin/marketplace.json` — a marketplace `idfix` that lists this folder as the plugin
- `skills/oc-sub/SKILL.md` — the skill: when to delegate, the workflow, and the rules
- `skills/oc-sub/reference.md` — the full command reference and the details
- `opencode/agents/` — the agents of the plugin: `coder`, `researcher`, and its hidden subagent `reader`. `oc-sub up` serves them through `OPENCODE_CONFIG_DIR`.
- `bin/idfx` — a second launcher with the short name of the project idfix. It calls `bin/oc-sub`. The link `~/.local/bin/idfix` also calls it.
- `bin/oc-sub` — the launcher. Claude Code puts `bin/` on the PATH of its Bash tool while the plugin is enabled. The launcher finds bun (or gets it through mise), runs `bun install --frozen-lockfile --production` on each call (a few milliseconds when nothing changed), and runs `src/cli.ts`.

Check the plugin with `claude plugin validate .` and `claude --plugin-dir . plugin details idfix`.

## Setup

Install the tools with mise, then the packages with bun:

```
mise install
bun install
mise run hooks-install   # once after clone: the pre-push hook runs the tests
```

The project gives only its start scripts `bin/oc-sub` and `bin/idfx`. Both run the same CLI. It does not link them into a folder on your PATH. To use them from any folder, link them yourself, for example `~/.local/bin/oc-sub`, `~/.local/bin/idfx`, and `~/.local/bin/idfix`, or let your dotfiles manager make the links. The link `idfix` points to `bin/idfx`. The launcher follows a symlink back to this repository, so updates to the repository take effect at once. The help and the usage hints show the name that you called, for example `idfix` for a link `~/.local/bin/idfix` to `bin/idfx`. Each launcher passes the base name of its `$0` in the variable `IDFX_PROG`. Without it, the CLI uses `oc-sub`.

`mise.toml` pins `bun`, `opencode`, and `lefthook`. Check the setup with:

```
mise run test       # bun install --frozen-lockfile, then typecheck and bun test
```

`mise run test` is also the pre-push hook. `lefthook.yml` defines it, and `mise run hooks-install` (`lefthook install`) installs it into `.git/hooks`. A push runs the tests on your machine first, and a failed test stops the push. The task first runs `bun install --frozen-lockfile` each time. A fresh git worktree has no `node_modules`, and a merge can add a package to `bun.lock`. With no change, the install takes a few milliseconds. Without this step, a test can leave a partial `node_modules`, and the Ink tests then fail with two copies of React.

This repository is public, so its tracked files name no local path of a developer and no private project. The pre-commit hook runs `public-check` on the staged files when that tool is on your PATH, and else prints a note and passes. `test/public.test.ts` checks the paths of all tracked files in every test run, also without the tool. The file `.public-check-allow` lists the exact strings that both checks allow, for example the example home folder `/home/user` of the tests.

## oc-sub

`oc-sub` drives an opencode server: start it, launch subagent runs, watch them live, and read the results. Entry point: `src/cli.ts`. Run it with `bin/oc-sub`, `bun run src/cli.ts`, or `bun src/cli.ts`. With the plugin enabled, Claude runs it as `oc-sub`.

The server URL comes from `--url` or the environment variable `OC_SUB_URL`, default `http://127.0.0.1:8767`. `up`, `down`, and `restart` run the server in sandbox mode by default (one Docker Sandbox per project, in clone mode: the agent works in a private clone of the repository; see `docs/GUIDE.md`). `--no-sandbox` selects the host server, which the sections below describe. `--port N` and `--url URL` name a host server, so they imply `--no-sandbox`. With `--port N`, they target port N and keep the host of the URL; a `--url` flag whose port differs from `--port` is a usage error. When `OPENCODE_SERVER_PASSWORD` is set, every request uses HTTP basic auth (username from `OPENCODE_SERVER_USERNAME`, default `opencode`, as opencode itself does). The secret is never printed. Every command except `up`, `down`, and `restart` first checks the health of the server. If no server answers within 2 seconds, `status` prints `no server on <url>` and exits with code 0. The other commands print `error: no server on <url>. Start it with: oc-sub up` and exit with code 1. If a server answers with HTTP 401 or 403, every command exits with code 1 and says that the server rejected the password in `OPENCODE_SERVER_PASSWORD`, or that it needs one. `up` then does not start a second server. Sessions belong to a project directory, so `run` needs `--dir`; `status`, `ping`, `watch`, `log`, `abort`, and `answer` take an optional `--dir` (default: the current directory). Run the commands from the same directory that started the run, or pass the same `--dir`.

### oc-sub up

```
bun run src/cli.ts up [--dir DIR] [--idle-minutes N]
bun run src/cli.ts up --no-sandbox [--port N] [--idle-minutes N]
```

Checks the health of the host server (`GET /global/health`). When nothing answers, it starts `opencode serve --port N --hostname 127.0.0.1` in the background (detached, so it outlives the command), waits until it is healthy, and prints the URL and the version. Without `--port`, the port comes from the URL, then from 8767. With `--port N`, `up` checks and starts the server on port N and keeps the host of the URL (so `OC_SUB_URL` keeps its host). When both `--url` and `--port` are given and their ports differ, `up` stops with a usage error. Without `--no-sandbox`, `up` starts a sandbox instead (see `docs/GUIDE.md`).

`up` sets `OPENCODE_CONFIG_DIR` in the environment of the child process to the `opencode/` folder of this repository (computed from the location of the source file, not from the working directory). opencode then loads the research agents of the plugin for every project, after the project `.opencode` folder, so its agent wins over a project agent with the same name. If the environment already sets `OPENCODE_CONFIG_DIR` to another value, `up` keeps that value and prints a warning to stderr, because the research agents are then not loaded. If `OPENCODE_CONFIG_DIR` already holds the folder of the plugin, `up` prints no warning.

`up` also needs the shared agents folder. Set `OC_SUB_SHARED_DIR` to it; there is no default. It holds your global rules in `AGENTS.md` and your skills in `skills/<name>/SKILL.md`. It is the only source, and `up` never copies it. When `OC_SUB_SHARED_DIR` is not set or blank, `up` stops before it starts anything, with an error that names the variable and what the folder must hold. When `<shared>/AGENTS.md` is missing, `up` stops with an error that names the path and `OC_SUB_SHARED_DIR`. Otherwise `up` sets `OPENCODE_CONFIG_CONTENT` for the child, with the rules file under `instructions` and the skills folder under `skills.paths`. The reason: opencode 1.18.32 drops the global `~/.config/opencode/AGENTS.md` whenever `OPENCODE_CONFIG_DIR` is set, and `up` always sets it. An absolute path in `instructions` still loads (see `.plan/research/opencode-rules.md`). If the environment already sets `OPENCODE_CONFIG_CONTENT`, `up` keeps it and prints a warning, because the shared entries are then not added.

DeepInfra is an optional second model provider. When the project has the key file `~/.config/<project>/deepinfra.key`, `up` sets it up: in sandbox mode the key stays on the host as a custom secret of `sbx`, and in host mode the server gets `DEEPINFRA_API_KEY` (the environment first, then the key file). A run picks it with `--model deepinfra/zai-org/GLM-5.3-Flash`. DeepInfra serves this model only in fp4 precision, see `.plan/research/deepinfra.md`. The setup and the cost log are in `docs/GUIDE.md`, section "DeepInfra as a direct provider".

One server serves many project folders, so its state lives in one folder per user, `$XDG_STATE_HOME/oc-sub/` (default `~/.local/state/oc-sub/`):

- `serve-<port>.log` holds the output of the server.
- `serve-<port>.pid` holds its PID.
- `serve-<port>.dirs` lists the folders that `oc-sub run` sent sessions to. `oc-sub down` checks these folders for busy sessions.
- `idle-<port>.pid` holds the PID of the idle watchdog of the server.
- `serve-<port>.lock` is the server lock. `oc-sub run` holds it while it starts a session, and the idle watchdog holds it while it stops the server. It is a folder, because the lock library `proper-lockfile` locks with `mkdir`.
- `runs/` holds a copy of every run record, so `watch` and `log` find the real cost from any working directory.

#### The idle watchdog

After a new server is healthy, `up` also starts an idle watchdog in the background. The watchdog stops the server when it is idle, so an unused server does not run for days. It works in both modes.

- The server is idle when no session is busy and no event came for 30 minutes. A heartbeat of the server is not an event. The watchdog follows the event stream of all folders (`GET /global/event`). A session counts as busy from `session.status` with `busy` or `retry` until `session.status` with `idle` or `session.idle`.
- `--idle-minutes N` sets the limit. `0` turns the watchdog off. The option also works with `restart`.
- Before the stop, the watchdog asks `GET /session/status` of each folder in `serve-<port>.dirs` and of each folder that the event stream named. A busy session resets the timer.
- The watchdog stops the server the same way as `oc-sub down` without `--force`: the busy check, then SIGTERM to the process group. In sandbox mode, it uses the stop of `oc-sub down`, which also runs `sbx stop`. So the VM stops too.
- It writes one line with the reason into `serve-<port>.log`, for example `idle-stop port=8767 idle=30m`, and then exits.
- It also exits without a stop when the server PID file changes or disappears, or when the server does not answer the health check 3 times in a row. So it never outlives its server for long.
- `down`, `down --all`, and `restart` stop the watchdog after the server stops. A stale `idle-<port>.pid` does no harm.
- An `up` that finds a running server starts no watchdog.
- The watchdog takes the server lock `serve-<port>.lock` before its final check and keeps it through the stop. It does not wait for the lock. When `oc-sub run` holds it, a run starts a session now. Then the watchdog resets its timer and writes one line into the log.
- After an idle stop, the next `oc-sub run` starts a sandbox server again (see `oc-sub run`).

### oc-sub down

```
oc-sub down --no-sandbox [--port N] [--force]
```

Stops the server that `oc-sub up` started on the port. It reads the PID file and makes sure that the process is still `opencode serve` on that port. If a session in one of the listed folders is still busy, `down` lists it and stops with code 1. With `--force`, it stops the server anyway. Then it sends SIGTERM to the process group of the server, waits up to 15 seconds, and removes the state files. If no server runs, it says so and exits with code 0. If a server answers but `oc-sub up` did not start it, `down` does not touch it and exits with code 1.

`down` knows only the sessions that `oc-sub run` started. It does not see a session that you started in the opencode interface.

```
oc-sub down --all [--force]
```

Stops every server that oc-sub started: each sandbox with a state file that `sbx ls` shows as `running`, and each host server with a PID file `serve-<port>.pid`. Each server gets the same busy check as a single `down`. Without `--force`, a busy server stays up, and the other servers still stop. If one server does not stop, `down --all` exits with code 1. `--all` takes no other flag, and `restart` does not accept it.

### oc-sub restart

```
oc-sub restart --no-sandbox [--port N] [--force] [--idle-minutes N]
```

Runs `down` and then `up` on the same port. If `down` fails, `restart` stops there. In sandbox mode (`oc-sub restart` without `--no-sandbox`), it restarts the sandbox of the project.

### oc-sub run

```
bun run src/cli.ts run --agent NAME --dir DIR (--brief FILE | TEXT) [--title T]
```

Creates a session for the directory DIR, sends the brief to the agent asynchronously (`POST /session/:id/prompt_async`), and returns immediately. The brief is either a file (`--brief brief.md`) or positional text. With `--title T` the session gets that title.

With `--agent researcher`, `run` appends the critical-research footer to the brief, after a blank line. It reads the footer from `<OC_SUB_SHARED_DIR>/skills/critical-research/SKILL.md`: the first fenced block after the heading `## The footer`. The footer starts with a line `---` and asks for a section "Critical analysis" with four points. A brief that already ends with the footer stays unchanged. If the skill file or the block is missing, `run` stops with an error that names the file. Other agents get no footer.

When the project has a sandbox state and you pass neither `--url` nor `OC_SUB_URL`, `run` sends the run to the sandbox server. It first checks with `sbx exec NAME test -d DIR` that DIR exists inside the sandbox clone. A worktree that `git worktree add` created on the host is not in the clone. In that case `run` stops with exit code 1 before any session exists, and it names the two fixes: `oc-sub worktree STEP`, or a host server with `--url`. Without this check, opencode fails the prompt with `NotFound: FileSystem.realPath`, and the session ends idle without an answer.

When `run` uses the sandbox server in this way and the server does not answer `GET /global/health`, `run` starts it first. It runs the same steps as `oc-sub up` for the project, with the defaults, so the idle watchdog starts too. It prints `started the sandbox server of <project> (it was down)` to stderr and goes on. The output of the start also goes to stderr, so the session ID stays the first line on stdout. If the start fails, `run` stops with the error and the exit code of `up`. The start comes before the folder check, because that check runs `sbx exec` in the sandbox. With `--url`, with `OC_SUB_URL`, or without a sandbox state, `run` starts nothing and keeps its old error for a server that is down.

`run` holds the server lock `serve-<port>.lock` in the state folder from its health check until the prompt of the new session is sent. It releases the lock also on an error. The lock keeps the idle watchdog from stopping the server while a run starts a session on it. It also keeps two runs from starting the same sandbox server twice: the second run waits up to about one minute for the lock. If the lock stays held, `run` stops with an error that names the lock. A lock of a dead process counts as stale after 10 seconds, and the next run takes it over.

Before it creates the session, `run` checks the OpenRouter key. Each project needs its own key. The run directory must use its project key file `~/.config/<project>/openrouter.key`, and no directory of another project may resolve to the same key. The known directories come from the same sources as `status --all`: the folders of past runs, the projects of the server, and their git worktrees. A directory of the same project may share the key, because it has the same git common dir. When another project shares the key, or when the run directory uses the global key from auth.json or the environment, `run` stops with exit code 1 before any session exists. The message names the other project and tells you to create `~/.config/<project>/openrouter.key` for one of the projects and to run `oc-sub restart`. A directory that cannot be checked prints `warning: <directory>: <message>` to stderr and does not stop the run.

`run` also reads the cumulative usage of the key at OpenRouter (`GET https://openrouter.ai/api/v1/key`, which costs nothing) for the start value of the real cost (see `watch` and `log`). If OpenRouter does not answer, the run still starts.

The command prints, one per line:

1. the session ID (so `oc-sub run ... | head -1` gives it to a script),
2. the short `oc-sub attach CODE` hint for a person to watch the run live (CODE is the last 6 characters of the session ID),
3. the path of the run record in the current directory,
4. the path of the run record copy in the state folder.

The run record is a JSON file `.opencode/runs/<session-id>.json` in the current directory, with the session ID, directory, agent, title (`null` when unset), and start time. It also holds the first 8 hex digits of the SHA-256 of the key (`keyFingerprint`, never the key) and the key usage at the start in USD (`usageAtStart`, `null` without an answer). A copy goes to `~/.local/state/oc-sub/runs/` (or `$XDG_STATE_HOME/oc-sub/runs/`), so `watch` and `log` find the record from any working directory.

### oc-sub attach

```
bun run src/cli.ts attach CODE [--url URL]
```

Attaches the opencode TUI to a known run, like `opencode attach URL --dir DIR --session ID`. CODE is any part of the session ID that matches exactly one known run (case-sensitive substring). The known runs come from the run records of the state folder and of the current directory.

- No match: `error: no run matches "CODE"`, exit code 1.
- Two or more matches: it lists the session ID, the title, and the directory of each match, tells you to give a longer part, and exits with code 1.
- One match: it starts `opencode attach URL --dir DIR --session ID` with the current terminal. The URL comes from `--url`, then `OC_SUB_URL`, then the sandbox state of the directory, then the default. The command returns the exit code of the opencode process.
- CODE may carry the agent icon of the `oc-sub top` line (for example `🔧3NcXxn`): attach keeps only the letters, digits, and `_` of CODE before it matches.

While attach runs, it polls the server every 2 seconds. If the session is deleted, or if the server does not answer for about 6 seconds, attach ends the TUI. An idle session keeps the TUI open, so you can read the last screen and type a follow-up.

### oc-sub status

```
bun run src/cli.ts status [--dir DIR | --all] [--json]
```

One line per session: ID, state (`busy`, `waiting`, `idle`, or `retry`), title. A session with a pending question or permission request shows `waiting` instead of `busy`, because it makes no progress until it gets an answer. Without `--all`, it lists the sessions of the directory and of each of its git worktrees. A session of the directory itself has no suffix. A session of another worktree gets its folder at the end: relative to the directory when the worktree is inside it (for example `.worktrees/x`), else absolute. Child sessions (internal subagent runs) are not listed. If no server runs, it prints `no server on <url>` and exits with code 0.

With `--all`, it lists the running sessions of all projects, each as `<id> <state> <title> (<absolute folder>)`. Idle sessions and child sessions are not listed. The folders come from the folders of past `oc-sub run` calls, from the projects that the server knows, and from their git worktrees. Folders that no longer exist are skipped. When no session runs, it prints `no running sessions`. `--all` and `--dir` together are a usage error.

With `--json`, stdout is one object of the tool protocol: `{tool, version, time, source, sequence, conditions, items}`. `items` holds the sessions, and `conditions` the True conditions of the Claude Code sessions, as `idfx watch --all` computes them. The fields are in `docs/GUIDE.md`, section "Check what runs".

A directory that fails to list does not stop the listing. It prints `warning: <directory>: <message>` to stderr, and the command continues with the next directory. This covers a project whose configuration references a missing key file.

### oc-sub top

```
bun run src/cli.ts top [--dir DIR | --all]
bun run src/cli.ts top --once [--dir DIR | --all] [--json]
```

A live view of the sessions, like `htop`. Without `--all`, it covers the directory of `--dir` (default: the current directory) and its git worktrees. With `--all`, it covers every directory of every known server (the host server and every sandbox). It shows the sessions that are not idle and the sessions with activity in the last 60 minutes.

One compact line per session, with one space between the columns: `id` (the agent icon, then the CODE for `oc-sub attach CODE`, the last 6 characters of the session ID; agents 🔧 coder, 🔎 researcher, 📖 reader, another agent shows its first two letters), `where` (the folder name under `.worktrees/`, or `-` for the main folder; with `--all` it is `project/worktree`, or only `project` for the main folder, and the project is the `shortName` from `.opencode/oc-sub.json` of the project root when the project has set one, else the full project name; a worktree name that starts with `research-` shows 🔬 instead of the prefix), `¢` (the cost in US cents, without a unit), `run` (elapsed time), `last` (time since the last event), `stp` (steps), `tls` (tool calls), `ctx` (context tokens), `rsn` (reasoning share), and title. The state has no column: the color of the `id` shows it, green `busy`, yellow `waiting` and `retry`, red `stalled` and `looping`, magenta `reasoning`, gray `idle`. `--once` colors the `id` only on a terminal. In a pipe it adds a `state` column with the word after `id`. The times have at most five characters: `42s`, `4m05s`, `34m`, `3h12m`, `2d04h`. Seconds show only below ten minutes. The numbers align to the right. Icons are two cells wide, and the padding counts display cells. The cost and the tokens include the subagent sessions.

Without `--once`, it opens a full-screen view in the alternate screen. It follows `GET /global/event` of every server, reconnects after an error, and redraws on each change and once per second. `j`/`k` or the arrow keys select a session. A detail pane shows its pending requests, its subagent sessions as a tree, and its last 20 events. The footer shows the servers with their state, the totals, and the keys. `o` attaches to the selected session: inside tmux it splits the window and runs the attach in the new pane (side by side when the pane of `top` is wide, else below; tmux closes the pane when attach ends), without tmux it only shows the attach command. When the split fails, the footer shows the error and the attach command. `a` switches between the scope of `--dir` and `--all`, and `q` or Ctrl-C quit. The view has no keys that act on a session. When stdin or stdout is not a terminal, it prints the `--once` snapshot and a one-line hint to stderr.

With `--once`, it prints one text snapshot and exits: a header line, one line per session, and the pending requests indented below their session. `--json` prints the rows as JSON. It prints `no sessions` when nothing matches and `no server on <url>` when no server answers, both with exit code 0.

### oc-sub ping

```
bun run src/cli.ts ping [--dir DIR]
```

Shows which OpenRouter key the opencode server uses for DIR, where the key comes from, and whether OpenRouter accepts it:

```
directory: /home/user/src/proj
project: proj
key: sha256 87ea509a
source: global auth.json /home/user/.local/share/opencode/auth.json
openrouter: ok, limit $1.00, used $0.00, remaining $1.00
```

The `key:` line shows the first 8 hex digits of the SHA-256 of the key. It never prints the key itself. `source` names the origin: the project key file `~/.config/<project>/openrouter.key`, the environment variable `OPENROUTER_API_KEY`, or the global `~/.local/share/opencode/auth.json`. The project name is the folder that holds the main repository, so a worktree counts as its repository.

The last line asks `GET https://openrouter.ai/api/v1/key`, which costs nothing. It shows the limit, the usage, and the remaining amount in USD. With no limit, it prints `limit none` and the usage. When the server uses another key than the project key file, `ping` prints a warning, because the cost then goes to another key. Exit code 0 when OpenRouter accepts the key, even with the warning. Exit code 1 when the provider is not configured for the directory, when no key is set, when OpenRouter rejects the key (`openrouter: rejected (HTTP 401: ...)`), or when the key endpoint is unreachable (`openrouter: unreachable (...)`).

The server caches the configuration. After a change of a configuration file, `ping` reports the old key until `oc-sub restart`.

`ping --rules` checks that the agent on the server really sees the shared rules:

```
bun run src/cli.ts ping --rules [--dir DIR]
```

It reads the first line that starts with `# ` in `<shared>/AGENTS.md` on the host. Then it creates a session on the server of `--dir` (the normal URL resolution), sends one short prompt to the `researcher` agent with low reasoning effort, and asks it to reply with the first heading of its loaded instructions file, verbatim, or NONE. It prints `rules: pass` or `rules: FAIL` with the cost of the session, and it deletes the session afterwards when the API allows it. A failed deletion prints a warning and does not change the exit code. Exit code 0 on pass, 1 on fail. Run it once after `oc-sub up`.

### oc-sub watch

```
bun run src/cli.ts watch SESSION [--dir DIR] [--json]
```

Follows the server's event stream and prints one short line per event of that session: tool calls with their main argument (`tool bash: git status`), failed tool calls (`tool bash failed: ...`), finished assistant texts (`assistant: ...`), and session errors. When the session and its subagent sessions become idle, it prints a summary line with the elapsed time, the number of tool calls, the cost in USD, and the tokens, then the real-cost line from OpenRouter (see `log`), and exits with code 0. The cost and the tokens cover the session and all of its subagent sessions (child sessions, recursively). With subagent sessions, the cost part reads `cost $0.0816 (subagents $0.0665 in 4 sessions)`. Without subagent sessions, the line shows only the total.

When the session or one of its subagent sessions has a pending question or permission request, the run is paused. `watch` then prints one block per request with the request ID, the session ID, and the content, plus the exact `oc-sub answer ...` command, and exits with code 3. It detects the pause at the start, in every status poll, and on the `question.asked` and `permission.asked` events, so a request that was already pending is found too.

The guards tell the orchestrator early when a run goes wrong, without waiting for the end of the run. They cover the session and all of its subagent sessions, and they check three warning signs: a loop of five tool calls in a row with the same tool and the same input (the input is compared as JSON with sorted keys), a busy session with no event for 180 seconds, and one step with more than 16,000 reasoning tokens. On a finding, `watch` prints one block with the kind (`loop`, `stall`, or `reasoning`), the session ID, and the details, and exits with code 4. The run itself keeps running. The orchestrator reads the block, then aborts the run or sends a correction. The detectors are pure functions in `src/detect.ts`, so a later live view and a provider penalty can reuse them. Each finding is reported once.

The watch ends as idle only when the session and all its descendant sessions are idle or missing in the status map, and no request of the tree is pending. The status of a session can flip to idle for a moment between two requests, so `watch` checks the pending lists even when the status map says idle. Without a readable pending list it keeps watching.

It never misses the end of a run: it checks the status of the session and of all its subagent sessions when it starts, after every reconnect of the event stream, and every two seconds as a safety net. The final summary is computed from the messages of the session tree, not from the watched events. The server lists only sessions that are not idle in `GET /session/status`. A session that is missing from that map has either ended, or it was started a moment ago and the server has not marked it busy yet. So `watch` reads the messages of a missing main session. If the last message is a finished assistant message, the session has ended, and the watch ends at once. Otherwise the watch ends only when the session was quiet for 10 seconds (no update and no new message). This closes the race when `watch` starts right after `run`. A missing subagent session counts as ended. With `--json`, it prints the filtered events as JSON lines instead, and the summary and the request blocks go to stderr.

### oc-sub answer

```
bun run src/cli.ts answer REQUEST_ID [--dir DIR] (--reply once|always|reject [--message TEXT] | --reject | ANSWER...)
```

Answers a pending question or permission request of the run in DIR. The command looks the request ID up in the two pending lists of the server (`GET /question` and `GET /permission`) to learn its kind. If the ID is in neither list, it stops with an error.

For a question, pass one positional ANSWER per question, in order. The answer is the label of an option or free text. `--reject` rejects the question, and the tool call of the agent fails with a clear message. For a permission request, `--reply` is required: `once` allows the tool call one time, `always` allows it for the rest of the session, and `reject` refuses it. With `--reply reject`, `--message TEXT` gives the agent the reason. The agent sees the message as the error of the tool call.

A rejected permission request ends the turn of the agent. After such a rejection, the command prints a hint to send a follow-up message with `oc-sub say`. `--message` is only allowed with `--reply reject`.

An unknown ID, a wrong kind (for example `--reply` on a question), and an answer count that does not match the questions stop with an error before anything is sent. After the answer, start `watch` again to follow the rest of the run.

### oc-sub say

```
bun run src/cli.ts say SESSION [--dir DIR] [--agent NAME] TEXT
```

Sends TEXT as a follow-up message into the session and returns at once. It uses `prompt_async`, so it does not wait for the reply to end. Without `--agent`, it takes the agent from the last user message of the session. A session without a user message needs `--agent NAME`. It prints one line:

```
sent to ses_abc123 (agent coder). Watch it with: oc-sub watch ses_abc123 --dir /path/to/worktree
```

### oc-sub log

```
bun run src/cli.ts log SESSION [--dir DIR]
```

Prints the final assistant text of the session, one summary line with the cost and the token totals (input, output, reasoning, cache read, cache write), and one real-cost line. The totals cover the session and all of its subagent sessions (child sessions, recursively). With subagent sessions, the cost part reads `cost $0.0816 (subagents $0.0665 in 4 sessions)`.

The real-cost line is the real charge at OpenRouter, not the estimate of opencode. `run` stores the key usage at the start in the run record, and `log` reads the usage now. The line shows the difference: `real cost $0.0512 at OpenRouter (key usage since the start of the run)`. The real cost is only exact when no other run used the project key during the run. Other runs with the same key that overlap in time add their cost to the same number, so the line names them: `, includes other runs: ses_a, ses_b`. OpenRouter counts a request a minute or two late, so a `log` some minutes later can show a slightly higher real cost. Without a run record or without the usage at the start, the line reads `real cost: unknown (no key usage at the start of the run)`.

### oc-sub abort

```
bun run src/cli.ts abort SESSION [--dir DIR]
```

Aborts the session (`POST /session/:id/abort`).

### oc-sub doctor

```
bun run src/cli.ts doctor [--dir DIR] [--json]
bun run src/cli.ts doctor --fix [--force] [--dir DIR] [--json]
```

Runs the health checks of the project of `--dir` (default: the current folder) and of the host, prints one line per check (status, name, message, and the fix on the next line), and ends with a summary line. `--json` prints one object of the tool protocol, `{tool, version, status, checks}`, as the whole stdout; each check has a stable `type` `urn:dv:idfx:doctor:<name>`, and a check that throws gets the status `error`. Exit code 1 when a check fails, 2 when the doctor itself cannot run, else 0. The slow checks (a git call, one `mise current opencode` call, and the `sbx` calls) run only here.

With `--fix`, the command first runs the checks, then the fix action of every check in the registry order whose result is `warn` or `fail` and that has a fix action. It prints `fixing <name>: <fix text>` before each action and `fixed <name>: <note>` or `fix failed (<name>): <note>` after it. A failing action does not stop the other actions. Then it runs all checks again and prints their results. With `--json`, the fix lines go to stderr, and stdout holds the same object with `fixes`. Exit code 1 when the re-run has a `fail` or when any fix action failed, else 0. `--fix` never prompts. `--force` is only valid together with `--fix` and is reserved for the destructive fixes of later steps. With `--fix --json`, the object has `fixes` (`[{name, ok, note}]`), and `checks` holds the re-run results.

Which checks have a fix action:

- `plugin-fresh`: runs `claude plugin marketplace update idfix` and, when that exited 0, `claude plugin update idfix@idfix`. A non-zero exit is a failed fix. When only the old key `opencode-subagents@opencode-subagents` is installed, the check warns and names the reinstall commands, and the fix runs nothing, because the reinstall changes the plugin configuration of the user.
- `global-rules`: for each of the three rule paths, a copy whose content equals the shared `AGENTS.md` exactly becomes a symlink to it; a copy with different content is left alone (the fix fails and names it), so no edit is lost. A broken or wrong symlink is re-pointed. A missing path is not created. Without the shared file, the fix fails and changes nothing.

The checks:

```tbl
check: Check
what-it-checks: What it checks
fail-means: Fail means
--
check: `env-files`
what-it-checks: No real `.env` or `.env.*` file in the project root or in any folder of `.worktrees/`, except names that end in `.example` or `.sample`. It never opens the file.
fail-means: A key file sits in the project. Move the keys to `~/.config/<project>/<provider>.key` and delete the file.
--
check: `claude-md`
what-it-checks: No `CLAUDE.md` or `CLAUDE.local.md` in the project root.
fail-means: Claude Code would read the wrong rules file. Rename it to `AGENTS.md`.
--
check: `agents-md`
what-it-checks: The project root has `AGENTS.md`.
fail-means: Warn only. The agent misses the rules of the project.
--
check: `global-rules`
what-it-checks: `~/.claude/CLAUDE.md`, `~/.config/opencode/AGENTS.md`, and `~/.codex/AGENTS.md` are symlinks to `<shared>/AGENTS.md`.
fail-means: A copy drifts from the source, or a link is broken. Missing paths are a warn, because the tool may not be installed. `--fix` replaces an equal copy or a broken link with a symlink; a copy with different content is not changed.
--
check: `skill-links`
what-it-checks: Every symlink in `~/.claude/skills/` and `~/.agents/skills/` resolves to an existing folder.
fail-means: A skill is gone. Remove the broken link or point it back.
--
check: `agent-copies`
what-it-checks: `.opencode/agents/coder.md`, `researcher.md`, and `reader.md` are permission-only files or absent (see `.plan/research/agent-merge.md`).
fail-means: A project copy overrides the plugin agent. Delete it, or keep only a permission block.
--
check: `opencode-version`
what-it-checks: The opencode version that `mise current opencode` resolves in the project root equals the `opencode` pin in the `mise.toml` of oc-sub, the tested version, and the pin that decides it (the project `mise.toml`, else the global mise configuration) is that exact version. A pin such as `"latest"` warns even when it resolves to the tested version today, because the next release changes it.
fail-means: Warn. Set the tested version in the project `mise.toml` (or in the global mise configuration when the project has no pin) and run `mise install`. No `--fix` action yet.
--
check: `opencode-release`
what-it-checks: The latest opencode release (`mise latest opencode`) is not newer than the tested version, or not newer than the reviewed version in `opencode-review.json` of the oc-sub repository. It reminds you to review a new release from time to time. A failed or empty `mise latest` call (no network) skips the check, and so does a missing tested pin.
fail-means: Warn. Read the release notes of the new version, then either raise the pin in the `mise.toml` of oc-sub and run the tests, or record the decision in `opencode-review.json`. No `--fix` action.
--
check: `plugin-fresh`
what-it-checks: The installed plugin commit matches `origin/alpha` of the plugin repository.
fail-means: Warn. `--fix` runs the plugin update commands that the fix names.
--
check: `sandbox-mounts`
what-it-checks: When a sandbox state file exists, `sbx ls` lists all mounts that `up` requires (a folder inside the project root is not mounted, the clone holds it), the project has the `sandbox-<name>` git remote of clone mode, and the clone exists inside the sandbox (`git -C <root> rev-parse --git-dir`).
fail-means: Run `sbx rm --force NAME` and then `oc-sub up`, which creates the sandbox again in clone mode.
--
check: `deepinfra-key`
what-it-checks: The optional DeepInfra key file `~/.config/<project>/deepinfra.key` has mode 600 or stricter. It only reads the mode, never the content. Without the file, it skips (DeepInfra is off).
fail-means: Warn only. Other users may read the key. Run `chmod 600` on the file.
```

The fast checks `env-files` to `agent-copies` also run on every `oc-sub up` and `oc-sub run`. A fail stops the command with exit code 1 before anything changes state and before any paid call, and names the fixes plus the hint `run oc-sub doctor for details`. A warn prints one line and the command continues. The checks take about 1 ms. When they take over 50 ms, the command prints a warning with the time.

### oc-sub worktree

```
bun run src/cli.ts worktree STEP [--dir ROOT] [--base BRANCH]
bun run src/cli.ts worktree rm STEP [--dir ROOT]
```

Sandbox clone mode only. `worktree STEP` creates the worktree of a run inside the sandbox clone at `<root>/.worktrees/STEP`. It points the clone remote `host` to the read-only host repository `/run/sandbox/source`, fetches `host` (never `origin`, which the sandbox may not reach), copies the git identity of the host repository into the clone, and creates `feature/STEP` from `host/alpha` (`--base` names another branch). When the worktree exists, it says so and exits 0. In both cases it then disposes the cached opencode instance of the folder (`POST /instance/dispose`). opencode keeps one instance per directory, and a run that reached the folder before it existed leaves a broken instance that fails every later prompt there. A failed dispose is only a warning. `worktree rm STEP` removes the worktree and deletes `feature/STEP` inside the clone. Work that was not fetched is lost. Both commands exit 1 without a sandbox state file for the project.

### oc-sub fetch

```
bun run src/cli.ts fetch [--dir ROOT]
```

Sandbox clone mode only. Runs `git fetch sandbox-<name>` on the host and prints every fetched `feature/*` branch with its commit count over `alpha`, plus the review and merge commands. Exit 1 without a sandbox state file.

`sbx stop` removes the remote `sandbox-<name>` from the host repository, and the next start of the sandbox adds it again. So `fetch` fails while the sandbox is stopped, for example after an idle stop. Then `fetch` prints the hint `the sandbox <name> is stopped. Start it with oc-sub up, then fetch again.`

### Typical flow

```
bun run src/cli.ts up --port 8767
bun run src/cli.ts run --agent researcher --dir <repo> --brief brief.md --title "Research X" | head -1
bun run src/cli.ts watch <session-id> --dir <repo>
bun run src/cli.ts log <session-id> --dir <repo>
```

## Tests

`bun test` runs the unit tests in `test/` (argument parsing, event filtering and line formatting, cost and token summary, the end check of a session missing from the status map, the child sessions of a session and their usage, run records, state files, the process check of `down`, client helpers, the pending question and permission requests, and the pause detection of `watch` against a fake server) and integration tests. The integration tests start a real `opencode serve` on a free port from 8790 upward, run `up`, create sessions over the SDK without sending any prompt, check `status`, run `abort`, check the pending lists and `answer` against a server without pending requests, and stop the server with `restart` and `down`. They never call a model and cost nothing. They skip themselves with a clear message when the command `opencode` is not on the PATH.

The preload `test/setup.ts` gives each test run one temporary folder, `oc-sub-test-run-*` in the system temp folder. It points `TMPDIR` and the XDG data and state folders at it, and a global `afterAll` hook removes it after the last test. So a test can create temporary folders with `mkdtempSync(tmpdir())` and leaves nothing in `/tmp`. The preload also removes run folders older than six hours, which a killed run left behind. `test/temp-hygiene.test.ts` makes sure that the redirect is active.

A git hook sets repository-local git variables such as `GIT_DIR` and `GIT_INDEX_FILE`. A git command in a temporary folder would then act on the idfix repository. So the preload removes every variable that `git rev-parse --local-env-vars` names. Bun 1.4 has a trap here: `Bun.spawn` and `Bun.spawnSync` without an `env` option pass the environment of the process start, not the current `process.env`. So the preload wraps both, and a call without `env` passes `process.env`. `test/git-env.test.ts` checks this. To prove it, run `GIT_DIR=$PWD/.git GIT_INDEX_FILE=$PWD/.git/index mise run test` and check that `git status` does not change.

## Layout

- `src/cli.ts` — entry point and command dispatch
- `src/args.ts` — argument parsing (pure)
- `src/config.ts` — server URL and basic-auth resolution (pure)
- `src/client.ts` — SDK client, health check, result handling
- `src/summary.ts` — cost/token accounting and formatting (pure)
- `src/events.ts` — event filtering and watch lines (pure)
- `src/detect.ts` — the guards of `watch`: loop, stall, and reasoning detectors (pure)
- `src/tree.ts` — the descendant sessions of a session, their messages, and their cost
- `src/requests.ts` — pending questions and permissions: list, filter, format, answer
- `src/keys.ts` — OpenRouter key handling: fingerprint, key sources, key check, shared-key refusal; the DeepInfra key path and placeholder
- `src/runs.ts` — run records in `.opencode/runs/` and in the state folder, real-cost line
- `src/realcost.ts` — the real-cost output of `watch` and `log`
- `src/settled.ts` — decides whether a session missing from the status map has ended (pure)
- `src/state.ts`: per-user state files of the server (PID, log, folders with runs, lock)
- `src/lock.ts`: the server lock `serve-<port>.lock` of `run` and the idle watchdog
- `src/idle.ts`: the idle watchdog of a server: the pure busy tracker, the hidden `idle-watch` command, and its start and stop
- `src/attach.ts` — the `attach` command
- `src/doctor.ts` — the health checks, the fast gate for `up` and `run`, and the `doctor` command
- `src/top/` — `oc-sub top`: `model.ts` (the pure session model), `load.ts` (the REST seed and `--once`), `live.ts` (the event streams), `columns.ts` and `format.ts` (the columns and the text table, pure), `view-model.ts` (the pure view logic), `view.tsx` and `app.tsx` (the Ink view)
- `src/up.ts`, `src/down.ts`, `src/down-all.ts`, `src/run.ts`, `src/status.ts`, `src/ping.ts`, `src/watch.ts`, `src/log.ts`, `src/abort.ts`, `src/answer.ts` — the commands

## License

MIT. See [LICENSE](LICENSE).
