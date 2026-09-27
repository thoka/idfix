# Guide: cheap opencode subagents in your project

This guide is for you, the user. It says how to install the plugin in a project, how to watch a run, and how to stay safe. Claude learns the rest from the skill `oc-sub`.

## What you get

- The command `oc-sub`. It starts an opencode server, starts runs, watches them, and prints the result and the cost.
- The skill `oc-sub`. It tells Claude when to delegate work to a cheap opencode agent. It also tells Claude how to review the result.
- Two agent templates, `researcher` and `coder`, in `skills/oc-sub/templates/`.

## Requirements

- Claude Code 2.1 or newer, with the `claude` command.
- `opencode` and `bun` on the PATH. With mise: `mise use -g opencode bun`. If only mise is installed, the `oc-sub` launcher gets bun through mise.
- A model provider for opencode, for example an OpenRouter key. Configure it once with `opencode auth login`.

## Install the plugin

The repository is a plugin and a plugin marketplace at the same time. Run these commands once, in any folder:

```
claude plugin marketplace add thoka/opencode-subagents
claude plugin install opencode-subagents@opencode-subagents
```

This installs the plugin for you in all projects (user scope). To enable it only in one project, run the install command in that project with `--scope local`. To enable it for everyone who works in the repository, use `--scope project`.

Check the install:

```
claude plugin list
claude plugin details opencode-subagents
```

To get a newer version, run `claude plugin marketplace update opencode-subagents`, then `/reload-plugins` in a session. If you work on a local clone instead, add the clone as the marketplace (`claude plugin marketplace add <path-to-a-clone>`). Claude Code then reads it in place, and a `git pull` plus `/reload-plugins` is enough.

To try the plugin for one session without an install:

```
claude --plugin-dir <path-to-a-clone>
```

To remove it:

```
claude plugin uninstall opencode-subagents@opencode-subagents
claude plugin marketplace remove opencode-subagents
```

## Set up a project

1. Copy the agent templates into the project:

   ```
   mkdir -p .opencode/agents
   cp <path-to-a-clone>/skills/oc-sub/templates/*.md .opencode/agents/
   ```

2. In `.opencode/agents/coder.md`, replace the lines `"bun test*"` and `"bun run typecheck*"` with the test and lint commands of your project. For a Python project with uv, for example:

   ```
   "uv run pytest*": allow
   "uv run ruff*": allow
   ```

3. Set the model in both files. The templates use `openrouter/z-ai/glm-5.3-flash`.
4. Add `.opencode/runs/`, `.opencode/serve-*`, and `.opencode/context/` to `.gitignore`.
5. Commit the agent files.

Then ask Claude, for example: "Delegate step 4 to the opencode coder." Claude invokes the skill by itself. You can also type `/opencode-subagents:oc-sub`.

## Watch a run live

When Claude starts a run, it gives you a command like this one:

```
opencode attach http://127.0.0.1:8767 --dir /path/to/worktree --session ses_abc123
```

You have three ways to watch:

- **Terminal**: run the `opencode attach ...` command in a second terminal. You see the full opencode interface, with each tool call and each answer.
- **tmux**: keep a tmux window for the runs. Start the server there (`opencode serve --port 8767 --hostname 127.0.0.1`), and open each run with `opencode attach ...` in a new pane.
- **Browser**: start `opencode web --port 8767 --hostname 127.0.0.1` instead of `opencode serve`. Then open `http://127.0.0.1:8767` in a browser. The home page lists the sessions.

A short live view is also available in the shell:

```
oc-sub watch ses_abc123 --dir /path/to/worktree
```

## Follow up, abort, and read the cost

- **Follow up**: tell Claude what to change. Claude sends the message into the same session with `opencode run --attach ... --session <id>`. You can also type into the attached opencode interface yourself.
- **Abort**: tell Claude to stop the run, or run `oc-sub abort <session-id> --dir <worktree>`.
- **Cost**: `oc-sub log <session-id> --dir <worktree>` prints the report of the agent and a line with the cost in USD and the tokens. `opencode stats` shows the totals of all sessions. Claude reports the cost of each run to you.

## Security

- **The server listens only on 127.0.0.1.** Do not start it with `--hostname 0.0.0.0`. The server can read and change every file of a project, and it can run the allowed commands.
- **Set a password on a shared machine.** Put `OPENCODE_SERVER_PASSWORD` into the environment before you start the server. `oc-sub`, `opencode run`, and `opencode attach` read it from there. The username is `opencode`, unless you set `OPENCODE_SERVER_USERNAME`. Never commit the password.
- **The allowlist is not a sandbox.** It stops mistakes of the agent. But a test command such as `bun test` or `pytest` runs any code that the agent wrote.
- **The real protection** is a separate git worktree for each run, no access to `.env` files or keys, and a review of every diff. Claude reviews the diff and runs the tests itself before a merge. Check the merge yourself for risky changes.
- **Do not use `--auto`.** `opencode run --auto` approves every request that is not explicitly denied. Use the agent files instead.

## Troubleshooting

| Problem | Cause and fix |
| --- | --- |
| `oc-sub: command not found` | The plugin is not enabled in this session. Run `claude plugin list`, then `/reload-plugins`. |
| `opencode run` hangs | The command waits for input. Add `< /dev/null`. |
| `oc-sub status` shows nothing | The server lists only busy sessions in its status map. Use `oc-sub log` for a finished run. Also check that `--dir` is the folder of the run. |
| The agent cannot read a file | The agent cannot leave its project folder. Copy the file into the worktree, or put its content into the brief. |
| A run takes very long | The step is too big. Abort it and split the brief into smaller steps. |
