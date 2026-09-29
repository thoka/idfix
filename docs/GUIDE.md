# Guide: cheap opencode subagents in your project

This guide is for you, the user. It says how to install the plugin in a project, how to watch a run, and how to stay safe. Claude learns the rest from the skill `oc-sub`.

## What you get

- The command `oc-sub`. It starts an opencode server, starts runs, watches them, and prints the result and the cost.
- The skill `oc-sub`. It tells Claude when to delegate work to a cheap opencode agent. It also tells Claude how to review the result.
- The agent template `coder` in `skills/oc-sub/templates/`. Research needs no agent file in your project: the plugin serves the `researcher` agent and its hidden `reader` subagent itself, through `OPENCODE_CONFIG_DIR`.

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

1. Copy the coder agent template into the project:

   ```
   mkdir -p .opencode/agents
   cp <path-to-a-clone>/skills/oc-sub/templates/coder.md .opencode/agents/
   ```

2. In `.opencode/agents/coder.md`, replace the lines `"bun test*"` and `"bun run typecheck*"` with the test and lint commands of your project. For a Python project with uv, for example:

   ```
   "uv run pytest*": allow
   "uv run ruff*": allow
   ```

3. Set the model in the file. The template uses `openrouter/z-ai/glm-5.3-flash`.
4. Add `.opencode/runs/` and `.opencode/context/` to `.gitignore`.
5. Commit the agent files.
6. Give the project its own OpenRouter key, so that OpenRouter shows the cost of this project and `oc-sub` can show the real cost of a run. Each project needs its own key. A key that two projects share is not allowed: `oc-sub run` refuses to start and names the other project. Create a key with a monthly limit in the OpenRouter dashboard and put it into the project key file. The file holds only the key. Never commit it.

   ```
   ~/.config/<project>/openrouter.key
   ```

   Create `opencode.json` in the project root:

   ```json
   {
     "provider": {
       "openrouter": {
         "options": {
           "apiKey": "{file:~/.config/<project>/openrouter.key}"
         }
       }
     }
   }
   ```

   Then start the server and check the key:

   ```
   oc-sub up
   oc-sub ping --dir <project>
   ```

   The command must print `source: project key file ...` and `openrouter: ok`. If it warns that the server uses another key, follow the warning.

Then ask Claude, for example: "Delegate step 4 to the opencode coder." Claude invokes the skill by itself. You can also type `/opencode-subagents:oc-sub`.

## Research agents

Research needs no agent file in your project. `oc-sub up` starts the server with `OPENCODE_CONFIG_DIR` set to the `opencode/` folder of the plugin. opencode loads the agents of that folder for every project, after the project `.opencode` folder. An agent from `OPENCODE_CONFIG_DIR` overrides a project agent with the same name.

The plugin serves two agents there: the `researcher`, and its hidden `reader` subagent. The researcher cannot fetch pages itself. It calls `reader`, which fetches the pages in a fresh context and returns at most 600 words of quotes with URLs. The reader fetches only the URLs that it gets, and it stops after six steps (`steps: 6`). Without this limit, one reader call with an open task made 42 fetches. This keeps the cost low, because each fetched page would otherwise stay in the context of the researcher until the run ends.

After an update of the plugin, run `oc-sub restart`. The running server keeps the plugin folder that it got at start in `OPENCODE_CONFIG_DIR`, and a plugin update can install into a new folder.

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

It prints one short line per tool call. When the run ends, it prints a summary line with the cost, then the real-cost line from OpenRouter. The cost covers the session and all of its subagent sessions. When the run pauses on a question or a permission request, it prints the request and ends. Claude answers it and watches again.

## Follow up, abort, and read the cost

- **Follow up**: tell Claude what to change. Claude sends the message into the same session with `opencode run --attach ... --session <id>`. You can also type into the attached opencode interface yourself.
- **Questions**: an agent can ask a question, and a command outside its allowlist can raise a permission request. The run then pauses until Claude answers. `oc-sub watch` ends with exit code 3 and prints the request. Claude decides whether it is safe, asks you if it is not, and answers with `oc-sub answer <request-id> ...`. Then Claude watches again.
- **Abort**: tell Claude to stop the run, or run `oc-sub abort <session-id> --dir <worktree>`.
- **Cost**: `oc-sub log <session-id> --dir <worktree>` prints the report of the agent and two cost lines in USD. The first line is the estimate of opencode: it multiplies the tokens by the prices in its model catalog from models.dev. The second line is the real cost at OpenRouter: the growth of the usage of the project key during the run. Both cover the session and all of its subagent sessions. With subagents, the first line reads `cost $0.0816 (subagents $0.0665 in 4 sessions)`. The second reads `real cost $0.0512 at OpenRouter (key usage since the start of the run)`. Other runs with the same key that overlap in time add their cost to the same number, so the real cost line names them. OpenRouter can count a request some seconds late, so a `log` some minutes later can show a slightly higher real cost. `opencode stats` shows the totals of all sessions. Claude reports the cost of each run to you.

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
| `oc-sub status` shows nothing | The server lists only busy sessions in its status map. Use `oc-sub log` for a finished run. Also check that `--dir` is the folder of the run. `oc-sub status --all` shows the running sessions of all projects and their worktrees, each with its folder. |
| A run seems stuck | The agent may wait for an answer to a question or a permission request. Run `oc-sub watch <session-id> --dir <worktree>` again. It ends with exit code 3 and prints the request. |
| The agent cannot read a file | The agent cannot leave its project folder. Copy the file into the worktree, or put its content into the brief. |
| A run takes very long | The step is too big. Abort it and split the brief into smaller steps. |
| `oc-sub ping` shows an old key after a configuration change | The server caches the configuration. Run `oc-sub restart`. |
| An old research agent runs | The server still uses the plugin folder that it got at start. After an update of the plugin, run `oc-sub restart`. |
