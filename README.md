# opencode-subagents

Status: experimental alpha (0.1.0). The tool and the skill were built in September 2026 and have few real runs so far. The command line and the file formats can change.

This project makes cheap opencode subagents usable from Claude Code. It contains a small command line tool `oc-sub` and a Claude Code skill `oc-sub`, packaged as a Claude Code plugin. The research of the design is in [docs/research/PRIOR_ART.md](docs/research/PRIOR_ART.md). The lessons from the first use are in [docs/EXPERIENCE.md](docs/EXPERIENCE.md).

## Use it in another project

The repository is a Claude Code plugin and a plugin marketplace. Install it once:

```
claude plugin marketplace add thoka/opencode-subagents
claude plugin install opencode-subagents@opencode-subagents
```

Then copy the agent templates into the project and adapt the test command. [docs/GUIDE.md](docs/GUIDE.md) explains the setup, how to watch a run live, how to follow up and abort, how to read the cost, and the security notes.

## Plugin layout

- `.claude-plugin/plugin.json` — the plugin manifest (name `opencode-subagents`)
- `.claude-plugin/marketplace.json` — a marketplace `opencode-subagents` that lists this folder as the plugin
- `skills/oc-sub/SKILL.md` — the skill: when to delegate, the workflow, and the rules
- `skills/oc-sub/reference.md` — the full command reference and the details
- `skills/oc-sub/templates/` — generic `researcher` and `coder` agent files for `.opencode/agents/`
- `bin/oc-sub` — the launcher. Claude Code puts `bin/` on the PATH of its Bash tool while the plugin is enabled. The launcher finds bun (or gets it through mise), installs the locked dependencies on the first call, and runs `src/cli.ts`.

Check the plugin with `claude plugin validate .` and `claude --plugin-dir . plugin details opencode-subagents`.

## Setup

Install the tools with mise, then the packages with bun:

```
mise install
bun install
```

To run `oc-sub` from any shell on this machine, link the launcher into a folder on your PATH:

```
ln -sfn "$PWD/bin/oc-sub" ~/.local/bin/oc-sub
```

The launcher follows the symlink back to this repository. Updates to the repository take effect at once.

`mise.toml` pins `bun` and `opencode`. Check the setup with:

```
bun test            # unit tests plus one integration test
bun run typecheck   # tsc --noEmit
```

## oc-sub

`oc-sub` drives an opencode server: start it, launch subagent runs, watch them live, and read the results. Entry point: `src/cli.ts`. Run it with `bin/oc-sub`, `bun run src/cli.ts`, or `bun src/cli.ts`. With the plugin enabled, Claude runs it as `oc-sub`.

The server URL comes from `--url` or the environment variable `OC_SUB_URL`, default `http://127.0.0.1:8767`. When `OPENCODE_SERVER_PASSWORD` is set, every request uses HTTP basic auth (username from `OPENCODE_SERVER_USERNAME`, default `opencode`, as opencode itself does). The secret is never printed. Every command except `up`, `down`, and `restart` first checks the health of the server. If no server answers within 2 seconds, `status` prints `no server on <url>` and exits with code 0. The other commands print `error: no server on <url>. Start it with: oc-sub up` and exit with code 1. Sessions belong to a project directory, so `run` needs `--dir`; `status`, `watch`, `log`, and `abort` take an optional `--dir` (default: the current directory). Run the commands from the same directory that started the run, or pass the same `--dir`.

### oc-sub up

```
bun run src/cli.ts up [--port N]
```

Checks the health of the server (`GET /global/health`). When nothing answers, it starts `opencode serve --port N --hostname 127.0.0.1` in the background (detached, so it outlives the command), waits until it is healthy, and prints the URL and the version. `--port` defaults to the port of the URL, then to 8767.

One server serves many project folders, so its state lives in one folder per user, `$XDG_STATE_HOME/oc-sub/` (default `~/.local/state/oc-sub/`):

- `serve-<port>.log` holds the output of the server.
- `serve-<port>.pid` holds its PID.
- `serve-<port>.dirs` lists the folders that `oc-sub run` sent sessions to. `oc-sub down` checks these folders for busy sessions.

### oc-sub down

```
oc-sub down [--port N] [--force]
```

Stops the server that `oc-sub up` started on the port. It reads the PID file and makes sure that the process is still `opencode serve` on that port. If a session in one of the listed folders is still busy, `down` lists it and stops with code 1. With `--force`, it stops the server anyway. Then it sends SIGTERM to the process group of the server, waits up to 15 seconds, and removes the state files. If no server runs, it says so and exits with code 0. If a server answers but `oc-sub up` did not start it, `down` does not touch it and exits with code 1.

`down` knows only the sessions that `oc-sub run` started. It does not see a session that you started in the opencode interface.

### oc-sub restart

```
oc-sub restart [--port N] [--force]
```

Runs `down` and then `up` on the same port. If `down` fails, `restart` stops there.

### oc-sub run

```
bun run src/cli.ts run --agent NAME --dir DIR (--brief FILE | TEXT) [--title T]
```

Creates a session for the directory DIR, sends the brief to the agent asynchronously (`POST /session/:id/prompt_async`), and returns immediately. The brief is either a file (`--brief brief.md`) or positional text. With `--title T` the session gets that title. The command prints, one per line:

1. the session ID (so `oc-sub run ... | head -1` gives it to a script),
2. the exact `opencode attach ...` command for a person to watch the run live,
3. the path of the run record.

The run record is a JSON file `.opencode/runs/<session-id>.json` in the current directory, with the session ID, directory, agent, title (`null` when unset), and start time.

### oc-sub status

```
bun run src/cli.ts status [--dir DIR]
```

One line per session of the directory: ID, state (`busy`, `idle`, or `retry`), title. Child sessions (internal subagent runs) are not listed. If no server runs, it prints `no server on <url>` and exits with code 0.

### oc-sub watch

```
bun run src/cli.ts watch SESSION [--dir DIR] [--json]
```

Follows the server's event stream and prints one short line per event of that session: tool calls with their main argument (`tool bash: git status`), failed tool calls (`tool bash failed: ...`), finished assistant texts (`assistant: ...`), and session errors. When the session becomes idle, it prints a summary line — elapsed time, number of tool calls, cost in USD, tokens — and exits with code 0.

It never misses the end of a session: it checks the session status when it starts, after every reconnect of the event stream, and every two seconds as a safety net; the final summary is computed from the session's messages, not from the watched events. The server lists only sessions that are not idle in `GET /session/status`. A session that is missing from that map has either ended, or it was started a moment ago and the server has not marked it busy yet. So `watch` reads the messages of a missing session. If the last message is a finished assistant message, the session has ended, and the watch ends at once. Otherwise the watch ends only when the session was quiet for 10 seconds (no update and no new message). This closes the race when `watch` starts right after `run`. With `--json`, it prints the filtered events as JSON lines instead, and the summary goes to stderr.

### oc-sub log

```
bun run src/cli.ts log SESSION [--dir DIR]
```

Prints the final assistant text of the session and one summary line with the cost and the token totals (input, output, reasoning, cache read, cache write) over all assistant messages.

### oc-sub abort

```
bun run src/cli.ts abort SESSION [--dir DIR]
```

Aborts the session (`POST /session/:id/abort`).

### Typical flow

```
bun run src/cli.ts up --port 8767
bun run src/cli.ts run --agent researcher --dir <repo> --brief brief.md --title "Research X" | head -1
bun run src/cli.ts watch <session-id> --dir <repo>
bun run src/cli.ts log <session-id> --dir <repo>
```

## Tests

`bun test` runs the unit tests in `test/` (argument parsing, event filtering and line formatting, cost and token summary, the end check of a session missing from the status map, run records, state files, the process check of `down`, client helpers) and one integration test. The integration test starts a real `opencode serve` on a free port from 8790 upward, runs `up`, creates a session over the SDK without sending any prompt, checks `status`, runs `abort`, and stops the server with `restart` and `down`. It never calls a model and costs nothing. It skips itself with a clear message when the command `opencode` is not on the PATH.

## Layout

- `src/cli.ts` — entry point and command dispatch
- `src/args.ts` — argument parsing (pure)
- `src/config.ts` — server URL and basic-auth resolution (pure)
- `src/client.ts` — SDK client, health check, result handling
- `src/summary.ts` — cost/token accounting and formatting (pure)
- `src/events.ts` — event filtering and watch lines (pure)
- `src/runs.ts` — run records under `.opencode/runs/`
- `src/settled.ts` — decides whether a session missing from the status map has ended (pure)
- `src/state.ts` — per-user state files of the server (PID, log, folders with runs)
- `src/up.ts`, `src/down.ts`, `src/run.ts`, `src/status.ts`, `src/watch.ts`, `src/log.ts`, `src/abort.ts` — the commands

## License

MIT. See [LICENSE](LICENSE).
