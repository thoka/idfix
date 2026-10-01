# Guide: cheap opencode subagents in your project

This guide is for you, the user. It says how to install the plugin in a project, how to watch a run, and how to stay safe. Claude learns the rest from the skill `oc-sub`.

## What you get

- The command `oc-sub`. It starts an opencode server, starts runs, watches them, and prints the result and the cost.
- The skill `oc-sub`. It tells Claude when to delegate work to a cheap opencode agent. It also tells Claude how to review the result.
- The agents of the plugin. The plugin serves the `coder`, `researcher`, and `reader` agents itself, through `OPENCODE_CONFIG_DIR`. You need no agent file in your project.

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

1. No agent file is needed: the plugin serves the `coder` agent for coding steps, and the `researcher` agent with its hidden `reader` subagent for research. Delete an old `.opencode/agents/coder.md` copy if your project has one, so that the plugin file stays the one source.

2. If the project needs its own bash rules, add `.opencode/agents/coder.md` that holds only a `permission` block whose `bash` map starts with `"*": allow` and then lists the project rules. Same-name agent files merge field by field, and the plugin file wins every field that it defines, so the prompt, the description, and the model of the plugin stay (see `docs/research/AGENT_MERGE.md` in the plugin repository, case 2b). The project rules must come after the catch-all, because the last matching pattern wins.

3. Add `.opencode/runs/` and `.opencode/context/` to `.gitignore`.
4. Give the project its own OpenRouter key, so that OpenRouter shows the cost of this project and `oc-sub` can show the real cost of a run. Each project needs its own key. A key that two projects share is not allowed: `oc-sub run` refuses to start and names the other project. Create a key with a monthly limit in the OpenRouter dashboard and put it into the project key file. The file holds only the key. Never commit it.

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

   Then run the health check once. It looks for the things that break runs: a real `.env` file in the project or a worktree, a `CLAUDE.md` instead of `AGENTS.md`, global rule files that are copies instead of symlinks, and old agent file copies:

   ```
   oc-sub doctor
   ```

   Every finding names its fix. The first lines should read `pass` for `env-files`, `claude-md`, and `agent-copies`. With `oc-sub doctor --fix`, the command repairs the safe findings itself (it turns an equal copy of the global rules into a symlink, re-points a broken link, and updates the plugin), then runs the checks again. `--fix` never calls sudo.

   The check `opencode-version` compares the opencode version of the project with the version that oc-sub is tested with (the pin in the `mise.toml` of oc-sub). It asks `mise current opencode` in the project root, so a pin in the project and a global pin both count. A pin other than the tested version, such as `opencode = "latest"`, warns even when it resolves to the tested version today, because the next release changes it without notice. The project pin counts first; without one, the global pin counts. The sandbox server runs the same version, because `up` puts the mise tool folders of the project in front of the sandbox PATH. On a warn, set the tested version in the file that the fix names and run `mise install`. The check has no `--fix` action yet.

   The check `opencode-release` reminds you to review a new opencode release from time to time. It runs `mise latest opencode` and warns when the latest release is newer than the tested version and newer than the version of the last review. Without the reminder, the pin in the `mise.toml` of oc-sub would stay on an old version silently. On a warn, read the release notes of the new version. Then either raise the pin in the `mise.toml` of oc-sub and run the tests, or record the decision in `opencode-review.json` in the oc-sub repository: `{"reviewed": "1.18.33", "date": "2026-09-30", "decision": "stay on 1.18.32", "notes": "docs/research/OPENCODE_ROADMAP.md"}`. The check passes again as soon as the latest release is not newer than the reviewed version. A failed `mise latest` call (often no network) skips the check.

   On Linux, the check `kvm-access` tests that you can read and write `/dev/kvm`. The sandbox needs this access. Without it, `sbx create` and the start of a sandbox fail with an error that does not name the cause, and `oc-sub up` stops before its first `sbx` call. To repair it, run `oc-sub doctor --fix-as-root`. It does the same as `--fix`, and it also runs `sudo chmod 0666 /dev/kvm`. sudo may ask for your password, so run it in a terminal. The repair lasts until the next WSL restart, because WSL then creates `/dev/kvm` again. A permanent repair is a task of the machine setup.

   Then start the server and check the key and the shared rules:

   ```
   oc-sub up
   oc-sub ping --dir <project>
   oc-sub ping --rules --dir <project>
   ```

   The key command must print `source: project key file ...` and `openrouter: ok`. If it warns that the server uses another key, follow the warning. The rules command must print `rules: pass`.

Then ask Claude, for example: "Delegate step 4 to the opencode coder." Claude invokes the skill by itself. You can also type `/opencode-subagents:oc-sub`.

## Research agents

Research needs no agent file in your project. `oc-sub up` starts the server with `OPENCODE_CONFIG_DIR` set to the synced copy of the `opencode/` folder of the plugin (see below). opencode loads the agents of that folder for every project, after the project `.opencode` folder. An agent from `OPENCODE_CONFIG_DIR` overrides a project agent with the same name.

The plugin serves two agents there: the `researcher`, and its hidden `reader` subagent. The researcher cannot fetch pages itself. It calls `reader`, which fetches the pages in a fresh context and returns at most 600 words of quotes with URLs. The reader fetches only the URLs that it gets, and it stops after six steps (`steps: 6`). Without this limit, one reader call with an open task made 42 fetches. This keeps the cost low, because each fetched page would otherwise stay in the context of the researcher until the run ends.

The researcher also gets the `websearch` tool. `oc-sub up` starts the server with `OPENCODE_ENABLE_EXA=1`, so that opencode offers the tool to an OpenRouter model. The tool calls `https://mcp.exa.ai/mcp` with POST, without a key and without cost.

Every server loads the plugin from one fixed folder: `$XDG_DATA_HOME/oc-sub/opencode/`, default `~/.local/share/oc-sub/opencode/`. Before `oc-sub up` starts a server, it copies the `opencode/` folder of the current plugin into it, removes the files that the plugin dropped, and records a digest of the content for that server. After an update of the plugin, run `oc-sub doctor`. The `server-plugin` check warns when the folder or a running server has old plugin content. `oc-sub doctor --fix` syncs the folder and restarts each idle server. A busy server keeps running, and the fix names `oc-sub abort` and `oc-sub down`.

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

It prints one short line per tool call. When the run ends, it prints a summary line with the cost, then the real-cost line. The cost covers the session and all of its subagent sessions. When the run pauses on a question or a permission request, it prints the request and ends. Claude answers it and watches again.

`watch` also warns early when a run goes wrong, for example when the agent repeats the same tool call five times in a row. Then it prints a block that names the problem and the session, and it ends with exit code 4. The run itself keeps running. Claude reads the block and then aborts the run or sends a correction. You do not need to act yourself.

### See all runs at once: `oc-sub top`

`oc-sub top` opens a full-screen live view of the runs, like `htop`. It shows the runs of the current project and its worktrees. `oc-sub top --all` shows the runs of all projects and all known servers.

- The table has one line per run: the CODE for `oc-sub attach CODE`, the project (only with `--all`), the worktree (`-` is the main folder), the agent, the state, the elapsed time, the time since the last event, the steps, the tool calls, the context size, the cost, the reasoning share, and the title.
- The state has a color: `busy` green, `waiting` yellow (the run waits for an answer), `stalled`, `looping` red, `reasoning` magenta (the last step used too many reasoning tokens), `retry` yellow, and `idle` gray.
- Below the table, the detail pane shows the selected run: a pending question or permission request, the subagent sessions as a tree, and the last events.
- The footer shows each server and its state (`up`, `down`, or `reconnecting`), the number of runs, their cost, and the keys.

Keys: `j`/`k` or the arrow keys select a run. `o` shows the attach command of the selected run. `a` switches between this project and all projects. `q` or Ctrl-C quit. The view only shows. Claude still answers, aborts, and follows up.

The project column shows the full project name. A project can set a short name for it in the file `.opencode/oc-sub.json` of the project root: `{ "shortName": "opsub" }`. Without the file, the full name shows. The column is as wide as its longest name, like the other columns.

## Follow up, abort, and read the cost

- **Follow up**: tell Claude what to change. Claude sends the message into the same session with `oc-sub say <session-id> --dir <worktree> "<message>"`. The command returns at once and does not block. You can also type into the attached opencode interface yourself.
- **Questions**: an agent can ask a question, and a command with an `ask` rule can raise a permission request. The run then pauses until Claude answers. `oc-sub watch` ends with exit code 3 and prints the request. Claude decides whether it is safe, asks you if it is not, and answers with `oc-sub answer <request-id> ...`. With a rejected permission request, the agent gets the reason as a tool error, and its turn ends. Claude then sends a follow-up message with `oc-sub say` to continue. Then Claude watches again.
- **Abort**: tell Claude to stop the run, or run `oc-sub abort <session-id> --dir <worktree>`.
- **Cost**: `oc-sub log <session-id> --dir <worktree>` prints the report of the agent and two cost lines in USD. The first line is the estimate of opencode: it multiplies the tokens by the prices in its model catalog from models.dev. The second line is the real cost. `watch` and `log` first sum the `cost` of the proxy log (`end` lines) over the session and all of its subagent sessions; when the proxy log has none of them, they fall back to the OpenRouter real cost: the growth of the usage of the project key during the run. Both lines cover the session and all of its subagent sessions. With subagents, the first line reads `cost $0.0816 (subagents $0.0665 in 4 sessions)`. The proxy line reads `real cost $0.0115 from the cost proxy (20 requests, deepinfra $0.0115)`: it sums the upstreams of the run, and lines with `cost: null` add a part like `2 requests without cost`. The fallback reads `real cost $0.0512 at OpenRouter (key usage since the start of the run)`. Other runs with the same key that overlap in time add their cost to the same number, so that line names them. OpenRouter counts a request a minute or two late, so a `log` some minutes later can show a slightly higher real cost. `opencode stats` shows the totals of all sessions. Claude reports the cost of each run to you.

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
- The sandbox is in clone mode (`sbx create --clone`): `sbx` makes a private in-container clone of your repository. The agent sees its own clone at the same absolute path as the host repository, the host repository read-only at `/run/sandbox/source`, the read-only mounts below, and nothing else. It cannot touch your `alpha`, your other worktrees, or the main checkout. `sbx` adds a `sandbox-<name>` remote to the host repository; fetch from it to review the work of the agent. See `docs/research/RUN_ISOLATION.md` for the research behind this.
- `down` stops the sandbox and keeps the state file, so the port stays the same. `sbx stop` keeps the clone, but it removes the `sandbox-<name>` remote from the host repository. The next start of the sandbox adds the remote again, with a new ephemeral port of the git daemon. So `up` checks the remote only after its first `sbx exec`, which starts a stopped sandbox. `doctor` uses the same order.
- The tools of the project come from the mise of the host. `up` runs `mise install` in the project root first, so that every tool of `mise.toml` exists. If it fails, `up` stops.
- The sandbox mounts up to three host folders read-only: the synced plugin folder `~/.local/share/oc-sub/opencode/`, the mise installs folder `~/.local/share/mise/installs`, and the shared agents folder. The shared agents folder comes from `OC_SUB_SHARED_DIR`, else `$HOME/dv/meta/agents`. It holds your global rules in `AGENTS.md` and your skills in `skills/<name>/SKILL.md`. It is the only source, and `up` never copies it. Each mount keeps its host absolute path inside the sandbox, so the paths in the configuration reach the same files. The sync writes the `.gitignore` that opencode expects into the folder, so that a read-only mount does not fail the server.
- A folder inside the project root (or equal to it) gets no mount, because `sbx create --clone` then exits 0 but makes no clone. The clone holds the tracked files of that folder at the same absolute path, so the paths in the configuration still work. This applies to the project `meta` (the shared agents folder `~/dv/meta/agents`). The synced plugin folder lies outside every project root, so every sandbox mounts it, also the sandbox of the plugin repository itself. A sandbox created before step 15c lacks this mount. `up` and the `sandbox-mounts` check then name the missing mount, and the sandbox needs a recreate. `up` prints a note for each such folder. Known gap: the sandbox then uses the committed copy in the clone, not the live host folder. A change on the host reaches the sandbox only after a commit and a new clone, and untracked files of that folder are missing.
- After the create, and on every `up` of an existing sandbox, `up` checks that the clone exists: `sbx exec NAME git -C <root> rev-parse --git-dir` must succeed. If not, `up` stops with the error `the sandbox NAME has no git clone at <root> (git -C <root> rev-parse --git-dir fails inside it)` and names the fix `sbx rm --force NAME`, then `oc-sub up`.
- If the sandbox exists but lacks one of the required mounts (for example after an update of this plugin), or it is an old sandbox without clone mode (no `sandbox-<name>` git remote), `up` stops with an error. It names the fix: remove the sandbox with `sbx rm --force NAME`, then run `oc-sub up` again, which creates it in clone mode with all required mounts. `sbx rm` without a terminal needs `--force`. Clone mode and the mounts are create-time flags and cannot be changed on an existing sandbox. `up` does not remove the sandbox itself, because it holds the sessions. Note that `sbx rm` ends the sessions of the sandbox.
- The server inside the sandbox starts with the tool folders of the project at the front of `PATH`, read from `mise env`, in front of the PATH of the sandbox. So `bun`, `node`, and `python` inside the sandbox are the versions of `mise.toml`. The holder process is a `sh -c` script: it starts the cost proxy (see above) in a restart loop in the background and `exec`s `opencode serve` in the front. With `--no-cost-proxy`, it runs `opencode serve` directly.
- Every `up` checks the network rules before the server starts: `sbx policy check network` must deny `host.docker.internal:8767` and `localhost:8767`. If one is allowed, `up` stops and names the deny command. This protects the host server of an old sandbox without the rules.
- Inside the sandbox, `up` passes `OPENCODE_CONFIG_CONTENT` into the server. It turns bash into `allow` for `coder` and `researcher`, and it also sets `external_directory: allow` for them: inside the sandbox the host files are not visible, so the deny rule of the agent files protects nothing, but it blocked an agent from creating a scratch folder in `/tmp`. The sandbox, not the rule, is the boundary. It also turns the MCP gateway of the `sbx` kit off. It also lists the shared rules file under `instructions` and the shared skills folder under `skills.paths`, because opencode 1.18.32 drops the global `~/.config/opencode/AGENTS.md` whenever `OPENCODE_CONFIG_DIR` is set (see `docs/research/OPENCODE_RULES.md`). The agent files stay the same, and the host server keeps their rules. The other permissions still apply, for example `edit` of `researcher`.
- Before `up` starts the server, it checks that the shared rules and skills are in place. When `<shared>/AGENTS.md` is missing on the host, `up` stops with an error that names the path and `OC_SUB_SHARED_DIR`, before anything changes state. Before the server starts, `up` runs `sbx exec NAME test -r <shared>/AGENTS.md` and stops with an error when the sandbox cannot read the file. After `up`, run `oc-sub ping --rules --dir <project>` once to check that the agent really sees the rules.
- The network rules of a new sandbox: GET and HEAD to every host (`**`), so research can read any page. Every method to `mcp.exa.ai:443`, because the websearch of opencode calls it with POST. Deny for the host and the private networks (`host.docker.internal,localhost,127.0.0.0/8,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16`); the proxy of `sbx` rewrites `host.docker.internal` to `localhost`, so a deny rule for `host.docker.internal` alone is not enough. GET to every host means that data can still leave in a GET URL; the host server and the LAN stay closed.
- `git push` over SSH fails in the sandbox, because no SSH agent is forwarded (setup step 3). As a second guard, `up` also starts the server with an empty `SSH_AUTH_SOCK`. You review and merge from the host: fetch the `sandbox-<name>` remote that clone mode creates.
- The project `opencode.json` can read the key with `{file:~/.config/<project>/openrouter.key}`. That file does not exist inside the sandbox, so `up` writes a placeholder file with the value `proxy-managed` there. The proxy of `sbx` replaces it with the real key.
- Every command finds its server on its own. The URL comes from `--url`, then `OC_SUB_URL`, then the sandbox state of the project of `--dir` (or of the current folder), then the default `http://127.0.0.1:8767`. `run`, `ping`, `watch`, `log`, `abort`, `answer`, `say`, and `status` follow that order. `status --all` covers every known server: the host server (from `--url`, `OC_SUB_URL`, or the default) plus every sandbox with a valid state file. `up`, `down`, and `restart` keep their own target resolution with `--port`.
- `run`, `ping`, and the real cost work with a sandboxed server. The sandbox reports the placeholder key `proxy-managed`; `oc-sub` then reads the project key file on the host and checks that key at OpenRouter. The shared-key check of `run` and the real-cost line use it too. `ping` prints the source as `sbx proxy with the project key file <path>`. It prints only fingerprints, never a key.

### Recreating a sandbox

The `sandbox-mounts` check fails when the sandbox lacks a required mount, has no clone, or is not in clone mode. All three need the same repair: remove the sandbox and create it again. `oc-sub doctor --fix --force` does this for you. It runs `oc-sub down` (when the server of the sandbox runs), then `sbx rm --force NAME`, then `oc-sub up`, which creates the sandbox again in clone mode with all required mounts.

A recreate ends all sessions of the sandbox. Without `--force`, the fix changes nothing and names the flag. Two guards always block it, also with `--force`: a busy session on the sandbox server, and work in the clone that would be lost. In both cases the fix names the cause and the next step: end the sessions with `oc-sub abort` or `oc-sub down`, or bring the work to the host with `oc-sub fetch`.

The work guard runs only for a sandbox in clone mode. The fix finds that out with `sbx exec NAME test -d /run/sandbox/source`: only a clone-mode sandbox has that path. A direct-mount sandbox mounts the host repository itself, so a dirty host tree is no reason to block, and the guard skips. In a clone-mode sandbox, a local `feature/*` branch is safe only when a host ref outside `refs/remotes/sandbox-<name>/` and `refs/sandboxes/<name>/` contains its commit, because `sbx rm` removes the `sandbox-<name>` remote and git then deletes those refs. The fix then offers three ways out: merge the branch, keep it with `git branch feature/STEP sandbox-<name>/feature/STEP`, or remove it in the clone with `oc-sub worktree rm STEP`. A squash merge does not contain the feature commits, so after a squash merge you run `oc-sub worktree rm STEP`. A run worktree with uncommitted changes also blocks. When a probe of the guard fails, the fix blocks too, because it cannot prove that no work is lost.

When the sandbox does not start at all (`sbx exec` fails), a recreate does not help, and the fix names `sbx diagnose` instead.

### The worktree of a run in clone mode

In clone mode, the worktree of a run lives only inside the sandbox clone, at `<root>/.worktrees/<step>`. The host does not have this folder. Use these commands:

- `oc-sub worktree STEP` creates the worktree inside the clone. It makes sure that the remote `host` of the clone points to the read-only host repository at `/run/sandbox/source` (it adds the remote, or sets its URL when it exists), fetches new host commits from `host`, copies the git identity of the host repository into the clone, and creates the branch `feature/STEP` from a fresh `host/alpha`. It does not fetch `origin`: the clone copies the remotes of the host, so `origin` can be an SSH URL, and the sandbox has no SSH access. `--base BRANCH` names another branch instead of `alpha`. The command prints the folder and the `run` command. An existing folder only counts when git knows it as a worktree; a folder without git registration is a stale leftover, and the command stops with the `oc-sub worktree rm STEP` fix.
- When the project sets a `setup` command in `.opencode/oc-sub.json`, `oc-sub worktree` runs it inside the new worktree after the creation. A run worktree holds only tracked files and no `node_modules`, so the setup command usually is `bun install --frozen-lockfile`. The command runs with the PATH of the sandbox server, so it finds the mise tools of the project. When the setup fails, the worktree stays, and the output tells you how to run the command again by hand. `--no-setup` skips the setup, and an existing worktree never runs it.
- `oc-sub run --dir <root>/.worktrees/STEP ...` starts the run in that worktree. The folder exists only inside the sandbox, and the commands resolve it to the project root on the host.
- `oc-sub fetch` fetches the branches of the sandbox clone on the host through the `sandbox-<name>` remote. It prints every `feature/*` branch with its commit count over `alpha` and the review commands. Review with `git diff alpha...sandbox-<name>/feature/STEP`.
- `oc-sub worktree rm STEP` removes the worktree and deletes the branch `feature/STEP` inside the clone. It first disposes the opencode instance of the folder (so that the background package install of opencode stops writing into it), retries a failing `git worktree remove` once, falls back to `rm -rf` plus `git worktree prune`, and exits 1 with a message when a folder or a branch is left behind. `rm` deletes work that was not fetched. Run `oc-sub fetch` before you remove a worktree whose work you want to keep.
- `oc-sub status` and `oc-sub top` also see the run worktrees in clone mode: for a sandbox server, and for a `--dir` project with a sandbox state file, they list the project root plus the worktrees that `git worktree list` shows inside the clone, so the sessions of clone-mode runs appear there.

## Cost proxy

The module `src/proxy/` holds a small pass-through HTTP proxy between opencode and its model providers (plan step 11b, research in `docs/research/COST_PROXY.md`). It appends the request path to the upstream URL (default `https://openrouter.ai/api`), so `/v1/chat/completions` goes to `https://openrouter.ai/api/v1/chat/completions`. A path that starts with `/deepinfra/` goes to DeepInfra instead (see [DeepInfra as a direct provider](#deepinfra-as-a-direct-provider)). It streams the response back without buffering, and writes one JSON log line per request to stdout:

- A `start` line when the request opens: the upstream (`openrouter` or `deepinfra`), the opencode session (`X-Session-Id` header), the parent session, the method, and the path.
- An `end` line when the response ends: the upstream, the status, the latency, the generation id, the provider, the model, the real cost from the last stream chunk (`usage.cost` of OpenRouter, or `usage.estimated_cost` of DeepInfra), the token counts, and the finish reason.

The log lines carry the tag `"source":"oc-sub-cost-proxy"`. The proxy never logs the `Authorization` header or any request body, so the key stays out of the log in host mode. For a manual test run: `bun src/proxy/main.ts --port 4097`.

`oc-sub up` starts the proxy by default, next to the server, and points opencode at it:

- The proxy runs from a committed single-file bundle, `opencode/cost-proxy/cost-proxy.js`, built with `bun run build:proxy`. The server and the proxy load the bundle from the synced plugin folder `~/.local/share/oc-sub/opencode/cost-proxy/cost-proxy.js`. It needs a `bun` binary, nothing else.
- **Sandbox mode**: the holder process runs `sh -c` with a restart loop for the proxy in the background and `exec opencode serve` in the front, for example:

  ```
  while :; do '<bun>' '<home>/.local/share/oc-sub/opencode/cost-proxy/cost-proxy.js' --port 4097 --hostname '127.0.0.1' ; sleep 1; done & exec opencode serve --hostname 0.0.0.0 --port 4096
  ```

  `<bun>` is the absolute path of a bun inside the read-only mounted mise installs folder: first the bun of the project `mise.toml`, else the newest bun installed for any project (a project may have no bun in its own `mise.toml`). Without any bun, `up` stops and names `--no-cost-proxy`. The proxy listens on `127.0.0.1:4097` inside the sandbox; loopback traffic stays in the microVM, so the deny rules do not catch it. Its stdout lands in the host file `serve-<port>.log` next to the server output. `OPENCODE_CONFIG_CONTENT` sets `provider.openrouter.options.baseURL` to `http://127.0.0.1:4097/v1`, so the model calls of opencode go through the proxy. The real key still never enters the sandbox: the proxy forwards only the placeholder key, and the proxy of `sbx` injects the real one.
- **Host mode**: `up` starts the proxy as a second detached process on `127.0.0.1:<port+1>` with the host bun, in the same restart loop. Its log is `proxy-<port>.log` and its PID file is `proxy-<port>.pid`, in the same state folder as the server files. The serve environment merges `provider.openrouter.options.baseURL` (`http://127.0.0.1:<port+1>/v1`) into `OPENCODE_CONFIG_CONTENT`. In host mode the real key travels in the `Authorization` header through the proxy; the proxy never logs it.
- `oc-sub down` stops the proxy process (host mode). In sandbox mode, the proxy ends with the holder process.
- A crash of the proxy stops the model calls of the server. The restart loop bounds it: the proxy starts again after one second. If the proxy breaks your runs, start without it:

  ```
  oc-sub up --no-cost-proxy
  oc-sub restart --no-cost-proxy
  ```

  The flag works in sandbox mode and in host mode, and the server then calls OpenRouter directly.

## DeepInfra as a direct provider

opencode has a built-in provider `deepinfra`. DeepInfra serves GLM 5.3 Flash (`zai-org/GLM-5.3-Flash`) directly, at about half the price of the OpenRouter providers of oc-sub. `oc-sub up` sets it up for a project when the project has a DeepInfra key file. Without that file, nothing changes.

**Precision risk.** DeepInfra serves GLM 5.3 Flash only in fp4 precision. An fp4 provider was the main suspect of the broken-output incident of 2026-09-28, so the OpenRouter routing of oc-sub excludes fp4 providers. Use DeepInfra for runs whose result you check closely, and compare it with the OpenRouter model. See [DEEPINFRA.md](research/DEEPINFRA.md).

Set it up:

1. Create a DeepInfra API key in the DeepInfra dashboard. Put it into the project key file, next to the OpenRouter key file. The file holds only the key. Never commit it.

   ```
   ~/.config/<project>/deepinfra.key     # mode 600
   ```

   `oc-sub doctor` shows the `deepinfra-key` check: a pass with mode 600, a warn with a wider mode (fix: `chmod 600 <file>`), and a skip without the file. The check never reads the key.

2. Start the server again, so that `up` sets DeepInfra up:

   ```
   oc-sub restart
   ```

   A recreate of the sandbox also works (`oc-sub doctor --fix --force` for a stale sandbox, or `sbx rm --force oc-sub-<project>` and then `oc-sub up`).

3. Start a run with the DeepInfra model. The model ID has a slash; `--model` splits at the first slash only, so the provider is `deepinfra` and the model is `zai-org/GLM-5.3-Flash`:

   ```
   oc-sub run --agent coder --dir <worktree> --model deepinfra/zai-org/GLM-5.3-Flash --brief brief.md
   ```

What `up` does:

- **Sandbox mode.** The real key stays on the host, as with OpenRouter (research: [DEEPINFRA_KEY_PATH.md](research/DEEPINFRA_KEY_PATH.md), option A). Once per sandbox, `up` runs:

  ```
  sbx policy allow network --sandbox oc-sub-<project> api.deepinfra.com:443
  sbx secret set-custom --sandbox oc-sub-<project> --host api.deepinfra.com --env DEEPINFRA_API_KEY --placeholder oc-sub-deepinfra-proxy-managed --command 'cat <config>/<project>/deepinfra.key'
  ```

  The sandbox allows only GET and HEAD to every host, and a model call is a POST, so the DeepInfra API needs its own allow rule. `up` checks `sbx secret ls --sandbox oc-sub-<project>` first and skips both commands when its `CUSTOM SECRETS` table has a row with the sandbox as SCOPE and `api.deepinfra.com` as TARGETS. The holder command passes `-e DEEPINFRA_API_KEY=oc-sub-deepinfra-proxy-managed` to the server. The proxy of `sbx` replaces this placeholder with the real key in the request headers of every request to `api.deepinfra.com`.
- **Host mode** (`up --no-sandbox`). The server gets `DEEPINFRA_API_KEY`: the value of the environment first, else the content of the DeepInfra key file of the project of the current folder.
- **Cost proxy.** With the proxy on (the default), `OPENCODE_CONFIG_CONTENT` sets `provider.deepinfra.options.baseURL` to `http://127.0.0.1:<proxy port>/deepinfra/v1`. The SDK of opencode appends `/openai/chat/completions`. The proxy sends every path that starts with `/deepinfra/` to `https://api.deepinfra.com` without that prefix, and every other path to OpenRouter. With `--no-cost-proxy`, opencode calls DeepInfra directly.

Where the cost shows: in the proxy log (`serve-<port>.log` in sandbox mode, `proxy-<port>.log` in host mode). Each line has the field `upstream`, `openrouter` or `deepinfra`, so the cost of each provider stays apart. For DeepInfra, the `cost` field comes from `usage.estimated_cost` of the response, in USD. The `provider` field is empty for DeepInfra, because its chunks carry no provider name.

Known gaps:

- The cost estimate of opencode for DeepInfra uses the models.dev prices without the current 50% discount, so it shows about twice the real cost. The proxy log has the real cost.
- With `--no-cost-proxy`, a DeepInfra run has no proxy log lines, so the real-cost line of `watch` and `log` falls back to the OpenRouter key usage and shows about zero.
- In host mode, one server serves several projects, but it gets the DeepInfra key of one project: the project of the folder where `up` ran.

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
| An old research agent runs | The server still runs the plugin content that it got at start. Run `oc-sub doctor`: the `server-plugin` check names the stale server, and `oc-sub doctor --fix` restarts it when it is idle. |
