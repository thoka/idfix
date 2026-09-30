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

2. Read the permissions in `.opencode/agents/coder.md`. The permissions allow every bash command, except the commands that act outside the worktree or destroy work. Those ask first: `git push`, `merge`, `rebase`, `reset`, `switch`, and `checkout`, `rm -r` and `rm -f`, `curl` and `wget`, and package installs. A bash command that names a `.env` file and `git stash` are denied.

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

The researcher also gets the `websearch` tool. `oc-sub up` starts the server with `OPENCODE_ENABLE_EXA=1`, so that opencode offers the tool to an OpenRouter model. The tool calls `https://mcp.exa.ai/mcp` with POST, without a key and without cost.

After an update of the plugin, run `oc-sub restart`. The running server keeps the plugin folder that it got at start in `OPENCODE_CONFIG_DIR`, and a plugin update can install into a new folder.

## Watch a run live

When Claude starts a run, it gives you a command like this one:

```
oc-sub attach abc123
```

CODE is the last part of the session ID. The command finds the run in the run records and starts the opencode interface for it. You have three ways to watch:

- **Terminal**: run the `oc-sub attach CODE` command in a second terminal. You see the full opencode interface, with each tool call and each answer.
- **tmux**: keep a tmux window for the runs. Start the server there (`opencode serve --port 8767 --hostname 127.0.0.1`), and open each run with `oc-sub attach CODE` in a new pane.
- **Browser**: start `opencode web --port 8767 --hostname 127.0.0.1` instead of `opencode serve`. Then open `http://127.0.0.1:8767` in a browser. The home page lists the sessions.

A short live view is also available in the shell:

```
oc-sub watch ses_abc123 --dir /path/to/worktree
```

It prints one short line per tool call. When the run ends, it prints a summary line with the cost, then the real-cost line from OpenRouter. The cost covers the session and all of its subagent sessions. When the run pauses on a question or a permission request, it prints the request and ends. Claude answers it and watches again.

`watch` also warns early when a run goes wrong, for example when the agent repeats the same tool call five times in a row. Then it prints a block that names the problem and the session, and it ends with exit code 4. The run itself keeps running. Claude reads the block and then aborts the run or sends a correction. You do not need to act yourself.

## Follow up, abort, and read the cost

- **Follow up**: tell Claude what to change. Claude sends the message into the same session with `oc-sub say <session-id> --dir <worktree> "<message>"`. The command returns at once and does not block. You can also type into the attached opencode interface yourself.
- **Questions**: an agent can ask a question, and a command with an `ask` rule can raise a permission request. The run then pauses until Claude answers. `oc-sub watch` ends with exit code 3 and prints the request. Claude decides whether it is safe, asks you if it is not, and answers with `oc-sub answer <request-id> ...`. With a rejected permission request, the agent gets the reason as a tool error, and its turn ends. Claude then sends a follow-up message with `oc-sub say` to continue. Then Claude watches again.
- **Abort**: tell Claude to stop the run, or run `oc-sub abort <session-id> --dir <worktree>`.
- **Cost**: `oc-sub log <session-id> --dir <worktree>` prints the report of the agent and two cost lines in USD. The first line is the estimate of opencode: it multiplies the tokens by the prices in its model catalog from models.dev. The second line is the real cost at OpenRouter: the growth of the usage of the project key during the run. Both cover the session and all of its subagent sessions. With subagents, the first line reads `cost $0.0816 (subagents $0.0665 in 4 sessions)`. The second reads `real cost $0.0512 at OpenRouter (key usage since the start of the run)`. Other runs with the same key that overlap in time add their cost to the same number, so the real cost line names them. OpenRouter counts a request a minute or two late, so a `log` some minutes later can show a slightly higher real cost. `opencode stats` shows the totals of all sessions. Claude reports the cost of each run to you.

## Sandbox mode

By default, `oc-sub up`, `down`, and `restart` run the server in sandbox mode. In sandbox mode, the server runs inside a Docker Sandbox (`sbx`): one microVM per project. The agent gets sudo in the VM, but it can only reach the file system and network that you share. It reaches OpenRouter through the credential proxy of `sbx`, so it cannot read your project key.

The old default, the server on the host with the permission rules of the agent files, still exists. Use `--no-sandbox` for it. The permission rules limit what the agent may do, but a test command can always run any code.

Setup, once:

1. Install `sbx` and run `sbx login` once.
2. Remove the global network rule, so that each sandbox can reach only the hosts of its agent kit: `sbx policy rm network --id default-allow-all`.
3. Turn off the forwarding of your SSH agent into the sandboxes, then restart the daemon: `sbx settings set ssh.agentForwardingEnabled false` and `sbx daemon restart`. Otherwise an agent can log in with your SSH keys, for example to push to GitHub in your name.

Use it:

```
oc-sub up
oc-sub down
oc-sub restart
```

A plain `oc-sub up` starts the sandbox of the project of the current folder. Add `--dir DIR` to name another project folder. `--sandbox` is the explicit form of the same default. `--no-sandbox` starts the host server instead, and `--port N` or `--url URL` also name a host server, so they imply `--no-sandbox`. `--dir` is only allowed in sandbox mode. You do not need `OC_SUB_URL`: every other command finds the sandboxed server of the project of `--dir` by itself (see the URL order below).

Details:

- Each project gets the sandbox `oc-sub-<project>` and a fixed host port, stored in `~/.local/state/oc-sub/sandbox-<project>.json`. The port stays the same across restarts.
- `up` needs the project key file `~/.config/<project>/openrouter.key`. It checks only that the file exists; it never reads it.
- `down` stops the sandbox and keeps the state file, so the port stays the same.
- The tools of the project come from the mise of the host. `up` runs `mise install` in the project root first, so that every tool of `mise.toml` exists. If it fails, `up` stops.
- The sandbox mounts two host folders read-only: the `opencode/` folder of the plugin, and the mise installs folder `~/.local/share/mise/installs`. No tool is downloaded twice, the versions are the same as on the host, and the agent cannot change the tools.
- If the sandbox exists but lacks one of the two mounts (for example after an update of this plugin), `up` stops with an error. It names the fix: remove the sandbox with `sbx rm NAME`, then run `oc-sub up` again, which creates it with both mounts. `up` does not remove the sandbox itself, because it holds the sessions.
- The server inside the sandbox starts with the tool folders of the project at the front of `PATH`, read from `mise env`, in front of the PATH of the sandbox. So `bun`, `node`, and `python` inside the sandbox are the versions of `mise.toml`.
- Every `up` checks the network rules before the server starts: `sbx policy check network` must deny `host.docker.internal:8767` and `localhost:8767`. If one is allowed, `up` stops and names the deny command. This protects the host server of an old sandbox without the rules.
- Inside the sandbox, `up` passes `OPENCODE_CONFIG_CONTENT` into the server. It turns bash into `allow` for `coder` and `researcher`, and it turns the MCP gateway of the `sbx` kit off. The agent files stay the same, and the host server keeps their rules. The other permissions still apply, for example `edit` of `researcher` and `external_directory`.
- The network rules of a new sandbox: GET and HEAD to every host (`**`), so research can read any page. Every method to `mcp.exa.ai:443`, because the websearch of opencode calls it with POST. Deny for the host and the private networks (`host.docker.internal,localhost,127.0.0.0/8,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16`); the proxy of `sbx` rewrites `host.docker.internal` to `localhost`, so a deny rule for `host.docker.internal` alone is not enough. GET to every host means that data can still leave in a GET URL; the host server and the LAN stay closed.
- `git push` over SSH fails in the sandbox, because no SSH agent is forwarded (setup step 3). As a second guard, `up` also starts the server with an empty `SSH_AUTH_SOCK`. You push from the host, where the commits of the agent appear at once.
- The project `opencode.json` can read the key with `{file:~/.config/<project>/openrouter.key}`. That file does not exist inside the sandbox, so `up` writes a placeholder file with the value `proxy-managed` there. The proxy of `sbx` replaces it with the real key.
- Every command finds its server on its own. The URL comes from `--url`, then `OC_SUB_URL`, then the sandbox state of the project of `--dir` (or of the current folder), then the default `http://127.0.0.1:8767`. `run`, `ping`, `watch`, `log`, `abort`, `answer`, `say`, and `status` follow that order. `status --all` covers every known server: the host server (from `--url`, `OC_SUB_URL`, or the default) plus every sandbox with a valid state file. `up`, `down`, and `restart` keep their own target resolution with `--port`.
- `run`, `ping`, and the real cost work with a sandboxed server. The sandbox reports the placeholder key `proxy-managed`; `oc-sub` then reads the project key file on the host and checks that key at OpenRouter. The shared-key check of `run` and the real-cost line use it too. `ping` prints the source as `sbx proxy with the project key file <path>`. It prints only fingerprints, never a key.

## Security

- **The server listens only on 127.0.0.1.** Do not start it with `--hostname 0.0.0.0`. The server can read and change every file of a project, and it can run the allowed commands.
- **Set a password on a shared machine.** Put `OPENCODE_SERVER_PASSWORD` into the environment before you start the server. `oc-sub`, `opencode run`, and `opencode attach` read it from there. The username is `opencode`, unless you set `OPENCODE_SERVER_USERNAME`. Never commit the password.
- **The permission rules are not a sandbox.** They stop some mistakes of the agent. But a test command such as `bun test` or `pytest` runs any code that the agent wrote.
- **The real protection** is a separate git worktree for each run, no access to `.env` files or keys, and a review of every diff. Claude reviews the diff and runs the tests itself before a merge. Check the merge yourself for risky changes.
- **Do not use `--auto`.** `opencode run --auto` approves every request that is not explicitly denied. Use the agent files instead.

## Troubleshooting

| Problem | Cause and fix |
| --- | --- |
| `oc-sub: command not found` | The plugin is not enabled in this session. Run `claude plugin list`, then `/reload-plugins`. |
| `opencode run` hangs | The command waits for input. Add `< /dev/null`. |
| `oc-sub status` shows nothing | The server lists only busy sessions in its status map. Use `oc-sub log` for a finished run. Also check that `--dir` is the folder of the run. `oc-sub status --all` shows the running sessions of all known servers, all projects, and their worktrees, each with its folder. |
| A run seems stuck | The agent may wait for an answer to a question or a permission request. Run `oc-sub watch <session-id> --dir <worktree>` again. It ends with exit code 3 and prints the request. |
| `watch` ends with exit code 4 | The watch saw a warning sign: a loop of identical tool calls, a stalled session, or runaway reasoning in one step. The run itself keeps running. Claude reads the block, then aborts the run or sends a correction. A session whose model claims broken tools is poisoned. Claude starts a fresh session with the same brief instead of a follow-up message. |
| The agent cannot read a file | The agent cannot leave its project folder. Copy the file into the worktree, or put its content into the brief. |
| A run takes very long | The step is too big. Abort it and split the brief into smaller steps. |
| `oc-sub ping` shows an old key after a configuration change | The server caches the configuration. Run `oc-sub restart`. |
| An old research agent runs | The server still uses the plugin folder that it got at start. After an update of the plugin, run `oc-sub restart`. |
