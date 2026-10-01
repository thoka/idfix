---
checked: 2026-09-27
recheck: quarterly
decisions:
  - "build oc-sub instead of an existing tool"
---

# Prior art and interfaces for Claude Code subagents on opencode

Research date: 2026-09-27. Written by the `researcher` opencode agent.

Question: What already exists for "Claude Code delegates work to opencode (or other coding-agent CLIs)", what does the current opencode programmatic interface look like, what is the current Claude Code skills format, and what should we reuse or build?

All facts below carry a source (URL, or file with line number). Statements marked **[guess]** are my judgment or an unverified reading. Where I could not find something, I say so.

## 0. Short answers

1. Prior art exists in three flavors: an MCP server (`opencode-mcp`, npm, MIT, active), pure-skill/plugin approaches (`delegate-to-agents`, `invoke-opencode-acp`, `sub-agents-skills`), and GUI orchestrators that run agents in git worktrees (`vibe-kanban` — sunsetting, `claude-squad` — AGPL, Conductor — closed macOS app). None of them delivers our combination: cheap GLM subagents through opencode, the user watching a run live, and a reusable skill. We can copy patterns and reuse opencode itself. We should build the small tool and the skill. (Section 1)
2. opencode's stable line is 1.18.x (latest 1.18.32, released 2026-09-21). The repo moved to `github.com/anomalyco/opencode` (old `sst/opencode` redirects). `opencode serve` exposes an OpenAPI 3.1 HTTP API with SSE events; the official TypeScript SDK is generated from it and is versioned in lockstep (also 1.18.32). The Python SDK is a stale pre-release. Follow-ups, abort, status, cost, and tokens all have documented endpoints. A "v2" is announced with a different server architecture. (Section 2)
3. opencode agents are markdown files with frontmatter (or JSON in `opencode.json`). Permissions support per-tool glob patterns, with last-match-wins. Per-agent model options pass through to the provider, which covers OpenRouter routing and reasoning effort. (Section 3)
4. Claude Code skills are a `SKILL.md` with YAML frontmatter plus optional supporting files. They follow the Agent Skills open standard with Claude Code extensions (`context: fork`, `allowed-tools`, dynamic `!` commands). Locations: personal, project, nested, plugin, enterprise, claude.ai-synced. Plugins bundle skills into marketplaces. (Section 4)
5. Runtime choice: TypeScript with bun and the official SDK, or Python with uv and hand-written HTTP. The official SDK exists only for TypeScript today. Both runtimes install through mise. (Section 5)
6. Recommendation: build a small CLI (`oc-sub`, name open) that drives the opencode HTTP API, plus a Claude Code skill that knows when and how to use it. Do not take on a third-party MCP server or a GUI orchestrator. (Section 6)

## 1. Prior art

### 1.1 MCP servers that wrap opencode

**AlaeddineMessadi/opencode-mcp** (npm package `opencode-mcp`) — the most complete and most active bridge.

- What it does: an MCP server that connects MCP clients (Claude Code, Claude Desktop, Cursor, VS Code) to opencode's headless HTTP API. It exposes about 70 tools, 10 resources, and 5 prompts. Tool groups: setup and orientation (`opencode_setup`, `opencode_context`, `opencode_provider_models`), quick questions (`opencode_ask`, `opencode_reply`), run-and-wait (`opencode_run`), background jobs (`opencode_fire`, `opencode_check`, `opencode_wait`), job records (`opencode_job_list`, `opencode_job_get`, `opencode_job_cancel`), permission and question answering, and review (`opencode_review_changes`, `opencode_conversation`). Source: repo README, fetched 2026-09-27, https://raw.githubusercontent.com/AlaeddineMessadi/opencode-mcp/main/README.md
- Activity: repo created 2026-02-08, last push 2026-09-18, 139 stars, 25 forks. Version 3.0.0 (changelog entry dated 2026-09-16) requires Node.js 22 or newer. Source: GitHub API `api.github.com/repos/AlaeddineMessadi/opencode-mcp` (fetched 2026-09-27), README.
- License: MIT. Source: GitHub API metadata (above).
- Fit for us: it already solves "Claude Code delegates to opencode and polls for results". Reuse is one command: `claude mcp add opencode -- npx -y opencode-mcp`. It supports `OPENCODE_BASE_URL`, `OPENCODE_SERVER_PASSWORD`/`OPENCODE_SERVER_USERNAME`, and an opt-in `OPENCODE_AUTO_SERVE`. Source: README (above).
- Caveats **[fact from README, judgment on impact]**: 70 MCP tools put tool descriptions in Claude's context on every turn (the README offers an `OPENCODE_TOOL_PROFILE=essential` smaller set). Results come by polling; the README says the package "does not promise to wake an idle assistant with completion notifications". It is third-party software with its own roadmap. It gives Claude a way to check jobs, but it does not give the *user* a live view; the user would still use `opencode web` or `attach`. It also does not encode our conventions (agent files, review docs).

A smaller project, **alejandro-technology/opencode-mcp** (2 stars, no license file found in the repo metadata, last push 2026-08-29), drives "an OpenCode instance and delegate[s] work to its subagents". Source: GitHub API `api.github.com/repos/alejandro-technology/opencode-mcp` (fetched 2026-09-27). Search results also show `abduznik/opencode-mcp-claude`, described as a fork of `dmdboi/opencode-mcp`, which lets Claude Desktop send prompts to running OpenCode sessions. Source: DuckDuckGo result snippet, fetched 2026-09-27. I did not examine these in depth.

### 1.2 Claude Code skills and plugins that drive other CLIs

**phonowell/invoke-opencode-acp** — the closest shape to our plan.

- What it does: a Claude Code skill plus a ~191-line Node script (`acp_client.cjs`) that launches `opencode acp`, speaks JSON-RPC over stdio (ACP protocol), sends the task to a session, streams `session/update` events, and writes the result to a file. Claude only sees a summary. Source: repo README, fetched 2026-09-27, https://raw.githubusercontent.com/phonowell/invoke-opencode-acp/main/README.md
- Activity: created 2026-01-08, last push 2026-01-22, 9 stars. Inactive for eight months. Source: GitHub API (fetched 2026-09-27).
- License: MIT. Source: GitHub API (above) and README.
- Notable content: it documents the honest tradeoffs — cheap models are slower and weaker; it recommends minimum timeouts of 180 s for simple tasks and 30 min for complex ones, because "OpenCode is slow". Source: README (above).

**josephyaduvanshi/delegate-to-agents** — a Claude Code plugin that is pure skill files, no daemon.

- What it does: routes "delegate this to X" to per-CLI driver skills (`drive-codex`, `drive-gemini`, `drive-qwen`, `drive-openclaude`, `drive-claude-code`, `drive-opencode`), each with that CLI's flags and auth preflight. It adds `multi-agent-lane` (isolate the patch in a git worktree, review the diff, run tests, accept/reject) and a `/delegate` entry command. It maps Hermes' `terminal`/`process`/`delegate_task` tools onto Claude Code's background `Bash`, tmux, and the `Agent` tool. Source: repo README, fetched 2026-09-27, https://raw.githubusercontent.com/josephyaduvanshi/delegate-to-agents/main/README.md
- Activity: created and last pushed 2026-05-24 (one-shot port), 0 stars. It is a port of the `autonomous-ai-agents` skill from NousResearch/hermes-agent (MIT). Source: GitHub API (fetched 2026-09-27) and README.
- License: MIT. Source: GitHub API.
- Installable as a marketplace plugin: `/plugin marketplace add josephyaduvanshi/delegate-to-agents`. Source: README.
- Fit for us: the structure (router skill + driver skill + review lane) is exactly the knowledge shape our skill needs. The `drive-opencode` driver presumably uses the CLI flags, not the HTTP API. The repo has no users yet (0 stars), so I would copy ideas, not depend on it.

**shinpr/sub-agents-skills** — cross-LLM sub-agent orchestration packaged as Agent Skills.

- What it does: routes tasks to Codex, Claude Code, Grok, GLM, Kimi, Cursor, Gemini, OpenCode, or Command Code "from any compatible tool". Written up by the author on dev.to (2025-09-04) as "bringing Claude Code's sub-agents to any MCP-compatible tool", later rebuilt on the Agent Skills format after Codex added skills support in December 2025. Sources: repo description, GitHub API `api.github.com/repos/shinpr/sub-agents-skills` (fetched 2026-09-27); dev.to article https://dev.to/shinpr/bringing-claude-codes-sub-agents-to-any-mcp-compatible-tool-1hb9 (found via search snippet).
- Activity: created 2026-01-16, last push 2026-09-06, 91 stars, 17 forks, Python. Source: GitHub API (above).
- License: MIT. Source: GitHub API (above).

**oh-my-openagent** (previously `oh-my-opencode`) — a very large community project.

- What it does: the opencode ecosystem page lists it as "Background agents, pre-built LSP/AST/MCP tools, curated agents, Claude Code compatible". Source: opencode ecosystem docs, https://opencode.ai/docs/ecosystem/ (fetched 2026-09-27).
- Activity and size: 69,508 stars, 5,722 forks, last push 2026-09-27. The repo was renamed from `code-yeongyu/oh-my-opencode` to `code-yeongyu/oh-my-openagent`; its current description no longer mentions opencode. Source: GitHub API (fetched 2026-09-27).
- License: GitHub reports "Other" / `NOASSERTION`. Source: GitHub API (above). **[guess]** With no clear license, treat it as not reusable for code, only as a design reference.

### 1.3 Orchestrators for parallel agents in git worktrees

**vibe-kanban** (BloopAI) — kanban UI that runs coding agents in isolated workspaces.

- What it does: kanban issues, workspaces (each gives an agent a branch, terminal, dev server), diff review with inline comments, PR creation. It supports 10+ coding agents, including OpenCode. Source: repo README, fetched 2026-09-27, https://raw.githubusercontent.com/BloopAI/vibe-kanban/main/README.md
- Activity and status: 28,196 stars, Apache-2.0, Rust, created 2025-06-14, last push 2026-09-19. Source: GitHub API (fetched 2026-09-27).
- **Sunsetting**: the README's headline says "Vibe Kanban is sunsetting". The company (bloop) shut down on 2026-04-10; the announcement says the project "will live on, open source and community maintained" and that remote services end after 30 days, leaving a fully local architecture. Source: https://www.vibekanban.com/blog/shutdown (fetched 2026-09-27).
- Fit for us: it is a standalone UI, not something Claude Code drives. Wrong layer for us, but it validates the worktree-per-run pattern.

**claude-squad** (smtg-ai) — terminal manager for parallel agents.

- What it does: "Manage multiple AI terminal agents like Claude Code, Codex, OpenCode, and Amp" in tmux sessions with git worktrees. Source: repo description, GitHub API `api.github.com/repos/smtg-ai/claude-squad` (fetched 2026-09-27).
- Activity: 8,536 stars, created 2025-03-09, last push 2026-08-20. Source: GitHub API (above).
- License: **AGPL-3.0**. Source: GitHub API (above). **[fact + judgment]** Copyleft. We can use it as a tool, but we should not copy its code into our project.

**Conductor** (Melty Labs, conductor.build) — closed macOS app.

- What it does: runs parallel Claude Code (and per third-party pages Codex, Cursor, and OpenCode) sessions in isolated git worktrees, with setup scripts, diff review, and a PR flow. Sources: vendor docs https://www.conductor.build/docs/guides/git-worktrees/run-claude-code-with-git-worktrees and https://www.conductor.build/docs/guides/parallel-agents/run-multiple-claude-code-sessions; third-party description https://continuumcode.ai/guides/what-is-conductor/ (all found via search, fetched 2026-09-27).
- License: proprietary. **[fact]** It is a Mac app, not open source, and it orchestrates from a GUI, not from Claude Code. Not reusable.

### 1.4 Verdict on prior art

**[fact]** Nothing found does exactly what this project wants: Claude Code as orchestrator, cheap GLM subagents via opencode, the user watching live, and a skill that makes the setup reusable in other projects.

**[judgment]** The closest matches and what to take from each:

- `opencode-mcp` (MCP): proves the HTTP API is sufficient; proves poll-based job control works. Too much MCP surface for us, and we do not control it.
- `delegate-to-agents` (plugin of skills): the right knowledge structure (router + driver + review lane), zero runtime dependencies.
- `invoke-opencode-acp` (skill + script): proves "skill invokes a script that drives opencode" works, and documents the timeout realities.
- `shinpr/sub-agents-skills`: shows a router skill that targets many backends, including OpenCode and GLM.
- Worktree orchestrators: use the pattern (isolate risky runs) but not the products.

## 2. The opencode programmatic interface

### 2.1 Home, license, and versions (facts)

- The repository moved: `github.com/sst/opencode` now resolves to **`anomalyco/opencode`** ("The open source coding agent", homepage opencode.ai, TypeScript, MIT). 210,260 stars, default branch `dev`, last push 2026-09-27. Source: GitHub API `api.github.com/repos/sst/opencode` (fetched 2026-09-27; the API returns `full_name: anomalyco/opencode`).
- Latest stable release: **v1.18.32**, published 2026-09-21. Source: GitHub API releases list `api.github.com/repos/anomalyco/opencode/releases?per_page=5` (fetched 2026-09-27).
- npm `opencode-ai` dist-tag `latest` = **1.18.32**. Source: `registry.npmjs.org/-/package/opencode-ai/dist-tags` (fetched 2026-09-27).
- Our `mise.toml` pins `opencode = "1.18.25"` (file `mise.toml`, line 2). That is six patch versions behind 1.18.32 and predates 2026-09-21.
- A **v2** is announced but not stable: the docs site shows a banner "New OpenCode v2 is now available", `opencode.ai/v2` redirects to `/v2/docs`, npm carries `beta` and `next` snapshot tags (dated Aug 2026 in the tag names), and no 2.x release exists on GitHub as of 2026-09-27. Sources: docs pages fetched 2026-09-27 (banner on every page), `registry.npmjs.org/-/package/opencode-ai/dist-tags`, GitHub releases list.
- The v2 docs describe a different architecture: "By default, OpenCode discovers or starts one shared background server for your user account", with `--standalone` for a private server and `--server URL` to connect; it adds `opencode mini` and `opencode debug paths`. Source: https://opencode.ai/v2/docs/cli (fetched 2026-09-27). **[judgment]** Plan the tool against 1.18.x now and budget a migration to v2 when it ships.

### 2.2 `opencode run` (facts, from CLI docs)

Source for all flags: https://opencode.ai/docs/cli/ (page states "Last updated: Sep 26, 2026"; fetched 2026-09-27).

- `opencode run [message..]` runs non-interactively.
- `--agent` (agent to use), `--model/-m provider/model`, `--variant` ("Model variant (provider-specific reasoning effort)").
- `--session/-s <id>`, `--continue/-c`, `--fork` to continue or fork a session.
- `--file/-f` attach files, `--title`, `--share` (share the session), `--format default|json` ("json (raw JSON events)"), `--thinking` (show thinking blocks), `--auto` (auto-approve permissions not explicitly denied).
- `--attach <url>`: attach to an already-running server ("to avoid MCP server cold boot times on every run"), with `--password/-p` (defaults to `OPENCODE_SERVER_PASSWORD`) and `--username/-u` (defaults to `OPENCODE_SERVER_USERNAME` or `opencode`). `--dir` sets the working directory (or remote path when attaching).
- Related CLI: `opencode serve`, `opencode web`, `opencode attach <url>`, `opencode session list|delete`, `opencode stats` ("Show token usage and cost statistics for your OpenCode sessions"), `opencode export [sessionID]` ("Export session data as JSON", `--sanitize` redacts), `opencode agent list|create`.

### 2.3 `opencode serve` and the HTTP API (facts)

Source: https://opencode.ai/docs/server/ (updated 2026-09-26; fetched 2026-09-27).

- `opencode serve [--port] [--hostname] [--cors origin]...` starts a headless server. Defaults: port 4096, hostname 127.0.0.1.
- Architecture: "When you run `opencode` it starts a TUI and a server. Where the TUI is the client that talks to the server." The server exposes an OpenAPI 3.1 spec, used to generate the SDK.
- Spec endpoint: `GET /doc` (OpenAPI 3.1).
- Authentication: set `OPENCODE_SERVER_PASSWORD` for HTTP basic auth on `serve` and `web`; username defaults to `opencode`, overridable with `OPENCODE_SERVER_USERNAME`. Source: server docs and CLI docs (env var table).
- Session endpoints (selection relevant to us):
  - `POST /session` — create a session, body `{ parentID?, title? }`.
  - `GET /session` — list; `GET /session/:id` — details; `DELETE /session/:id` — delete.
  - `GET /session/status` — status for all sessions, `{ [sessionID]: SessionStatus }`.
  - `GET /session/:id/children` — child sessions (subagent runs).
  - `POST /session/:id/message` — "Send a message and wait for response", body `{ messageID?, model?, agent?, noReply?, system?, tools?, parts }`.
  - `POST /session/:id/prompt_async` — "Send a message asynchronously (no wait)", returns 204.
  - `POST /session/:id/command` — run a slash command; `POST /session/:id/shell` — run a shell command.
  - `POST /session/:id/abort` — "Abort a running session".
  - `GET /session/:id/message` — list messages (`limit?`), returns `{ info: Message, parts: Part[] }[]`.
  - `POST /session/:id/permissions/:permissionID` — answer a permission request, body `{ response, remember? }`.
  - `GET /session/:id/diff` — file diff for the session (`messageID?` query).
  - `POST /session/:id/summarize`, `POST /session/:id/fork`, `POST /session/:id/revert`, `POST /session/:id/unrevert`, share/unshare.
- Other useful endpoints: `GET /global/health` → `{ healthy, version }`; `GET /agent` — list agents; `GET /config/providers`; `GET /find?pattern=`, `GET /file/content?path=`; TUI control endpoints under `/tui/*` (used by the IDE plugins to drive a TUI through the server).
- Events: `GET /event` is a server-sent events stream; "First event is `server.connected`, then bus events". `GET /global/event` is a global SSE stream. Source: server docs (above).

### 2.4 Follow-up, abort, status, cost, tokens

- Follow-up message to a running session: `POST /session/:id/message` (blocking) or `POST /session/:id/prompt_async` (non-blocking). Source: server docs (above).
- Abort: `POST /session/:id/abort`. SDK method `session.abort({ path })`. Source: server docs and SDK docs.
- Session status: `GET /session/status` returns a map of per-session status objects. Source: server docs (above). **[guess]** The exact `SessionStatus` fields (for example running/idle) are defined in the generated types at `packages/sdk/js/src/gen/types.gen.ts` in the repo; verify them against `/doc` on a live server during implementation.
- Cost and tokens:
  - Fact: `opencode stats` shows "token usage and cost statistics for your OpenCode sessions" (flags `--days`, `--tools`, `--models`, `--project`). Source: CLI docs.
  - Fact: `opencode export [sessionID]` dumps the session as JSON (with `--sanitize`). Source: CLI docs.
  - Fact: the API returns message info objects (`{ info: Message, parts }`); the `Message` type carries cost and token accounting in the generated SDK types. Source: server docs response shape plus the types file path `packages/sdk/js/src/gen/types.gen.ts` (repo link in server docs). **[guess]** I could not confirm the exact field names (`cost`, `tokens.input/output/cacheRead/cacheWrite`) from the docs alone; check them on a live server via `GET /session/:id/message`.

### 2.5 Official SDKs

- **TypeScript/JavaScript, official and current**: `@opencode-ai/sdk` on npm, `npm install @opencode-ai/sdk`. `createOpencode()` starts a server plus a client; `createOpencodeClient({ baseUrl })` is client-only for an existing server. All types are generated from the server's OpenAPI spec. `client.event.subscribe()` returns an async-iterable SSE stream. Structured output via `session.prompt` with a `format` JSON schema, result at `result.data.info.structured_output`. Sources: https://opencode.ai/docs/sdk/ (fetched 2026-09-27). Version: npm dist-tag `latest` = **1.18.32**, matching the CLI release for version. Source: `registry.npmjs.org/-/package/@opencode-ai/sdk/dist-tags` (fetched 2026-09-27).
- **Python, official but stale**: `opencode-ai` on PyPI, "0.1.0a36", a pre-release, released 2025-08-27. Repo `anomalyco/opencode-sdk-python` (formerly `sst/opencode-sdk-python`), MIT, 284 stars, last push 2026-01-30. It is Stainless-generated, sync and async over httpx, Python 3.8+. Sources: https://pypi.org/project/opencode-ai/ and GitHub API `api.github.com/repos/sst/opencode-sdk-python` (both fetched 2026-09-27). Its `api.md` still documents the old API surface (`/app`, `/mode`, `POST /session/{id}/message` returning `AssistantMessage`, no `/session/status`, no `prompt_async`, no `/agent`). Source: https://raw.githubusercontent.com/anomalyco/opencode-sdk-python/main/api.md (fetched 2026-09-27). **[fact + judgment]** The Python SDK lags the current server API by many months.

### 2.6 Watching a run live (facts)

Source unless noted: CLI docs and web docs (both updated 2026-09-26; fetched 2026-09-27).

- `opencode attach [url]` — "Attach a terminal to an already running OpenCode backend server started via `serve` or `web` commands." It runs the full TUI against that server, with `--continue`, `--session`, `--fork`, `--dir`, and basic-auth flags. Example in the docs: `opencode web --port 4096 --hostname 0.0.0.0`, then `opencode attach http://10.20.30.40:4096`.
- `opencode web` — headless server plus a browser UI ("View and manage your sessions from the homepage. You can see active sessions and start new ones", plus a "See Servers" status view). `opencode attach` then adds a TUI on the same server, "sharing the same sessions and state". Source: https://opencode.ai/docs/web/
- Session sharing: `opencode run --share` (or `/share`) publishes the session; `opencode import <url>` accepts `https://opncd.ai/s/...` share URLs. Source: CLI docs. **[fact]** Shared sessions are viewable in a browser at the share URL. **[guess]** I did not verify what the share page shows while a run is in progress.
- Programmatic watching: subscribe to `GET /event` (SSE) or use the SDK's `event.subscribe()`. Source: server and SDK docs.
- TUI control: the server exposes `/tui/append-prompt`, `/tui/submit-prompt`, and related endpoints "used by the OpenCode IDE plugins". Source: server docs.

**[judgment]** For our user, the practical watch paths are: (a) `opencode web` in a browser, (b) `opencode attach http://localhost:4096` in a terminal, and (c) our tool's `watch` command printing the SSE stream. All three work against one `opencode serve` instance.

## 3. Agent definitions in opencode

Source for this section: https://opencode.ai/docs/agents/ and https://opencode.ai/docs/permissions/ (both updated 2026-09-26; fetched 2026-09-27), and the provider/model docs https://opencode.ai/docs/providers/ and https://opencode.ai/docs/models/ (fetched 2026-09-27).

### 3.1 File format

- Markdown agent files live at global `~/.config/opencode/agents/` or per-project `.opencode/agents/`. "The markdown file name becomes the agent name." Our repo already has `.opencode/agents/researcher.md` (file exists in this repo).
- The same config can live in `opencode.json` under the `agent` key.
- Frontmatter fields: `description` (required), `mode` (`primary` | `subagent` | `all`, default `all`), `model` (`provider/model-id`), `temperature`, `top_p`, `steps` (max agentic iterations; legacy `maxSteps` deprecated), `prompt` (system prompt, supports `{file:./path.txt}`), `permission`, `tools` (deprecated, merged into `permission` since v1.1.1), `disable`, `hidden` (hide from `@` menu, subagents only), `color`, and task permissions via `permission.task` with glob patterns (last matching rule wins).
- Body below the frontmatter is the agent's system prompt content.

### 3.2 Permissions

- Each permission key resolves to `"allow"`, `"ask"`, or `"deny"`.
- Keys: `read`, `edit` (covers `edit`, `write`, `patch`), `glob`, `grep`, `list`, `bash`, `task` (launching subagents), `skill`, `lsp`, `question`, `webfetch`, `websearch`, `external_directory`, `todowrite`, and `doom_loop` (repeated identical tool calls).
- `read`, `edit`, `glob`, `grep`, `list`, `bash`, `task`, `external_directory`, `lsp`, and `skill` accept either a shorthand action or an object of glob/pattern → action. The rest take the shorthand only.
- Pattern matching: simple wildcards. `*` matches zero or more characters, `?` matches exactly one. **"Last matching rule wins"** — put the catch-all `"*"` first, specific rules after. Source: permissions docs, "Granular Rules" section.
- `edit` patterns match file paths. Example from the docs: `"*": "deny"` then `"packages/web/src/content/docs/*.mdx": "allow"`. Our own agent file uses the same shape: `edit: {"*": "deny", "docs/research/*": "allow"}` (`.opencode/agents/researcher.md`, lines 10-12).
- `bash` patterns match parsed commands (the docs show `"git status *": "allow"`); `"grep *"` allows `grep pattern file.txt` while bare `"grep"` would not.
- `external_directory`: use `~` or `$HOME` expansion in patterns; any tool that touches paths outside the project worktree triggers it; allowed directories inherit workspace defaults.
- Defaults: most permissions `allow`; `doom_loop` and `external_directory` default to `ask`; reading `.env` files is denied by default (`read: {"*": "allow", "*.env": "deny", "*.env.*": "deny"}`).
- `--auto` (CLI/TUI) approves everything not explicitly denied.

### 3.3 Model and provider options per agent

- `model: openrouter/z-ai/glm-5.3-flash` style IDs work per agent (our agent file, line 4).
- Pass-through: "Any other options you specify in your agent configuration will be **passed through directly** to the provider as model options." The docs example uses `reasoningEffort: "high"` and `textVerbosity: "low"` for `openai/gpt-5`. Source: agents docs, "Additional" section.
- Variants: many models support variants selected with `--variant` on `opencode run` ("provider-specific reasoning effort"). Built-in variants exist for popular providers (Anthropic `high`/`max`, OpenAI `none`…`xhigh`, Google `low`/`high`). Custom variants are defined in config under `provider.<id>.models.<model>.variants.<name>`. Source: models docs, "Variants".
- Global model options: `provider.<id>.models.<model>.options` (example: `reasoningEffort`, `thinking` budget for Anthropic). Agent config overrides global options. Source: models docs, "Configure models".
- **OpenRouter provider routing**: provider routing options pass through as model options. The docs example:
  ```json
  { "provider": { "openrouter": { "models": { "moonshotai/kimi-k2": {
      "options": { "provider": { "order": ["baseten"], "allow_fallbacks": false } } } } } } }
  ```
  Source: providers docs, OpenRouter section (lines ~1799-1807 of the fetched page).
- **[guess]** For GLM 5.3 Flash specifically, the reasoning-effort control (whether a `variant` exists, and which option name OpenRouter expects, for example `reasoning_effort`) is not documented on the opencode pages I fetched. Verify with `opencode models openrouter --verbose` and a test run with `--variant`.

## 4. Claude Code skills

Source for this section: https://code.claude.com/docs/en/skills (fetched 2026-09-27) and https://code.claude.com/docs/en/plugins (fetched 2026-09-27). The skills page references Claude Code releases up to v2.1.281, which dates the content to late September 2026.

### 4.1 Format

- A skill is a directory with a `SKILL.md`: YAML frontmatter between `---` markers, then a markdown body with the instructions. The directory name (or frontmatter `name`) becomes the `/command`. Skills follow the Agent Skills open standard (agentskills.io); Claude Code adds extensions on top.
- Claude Code's old `.claude/commands/*.md` files are merged into skills and still work.
- Frontmatter fields (Claude Code, all optional): `name`, `description` (recommended; drives automatic invocation; the listing text is truncated at 1,536 characters including `when_to_use`), `when_to_use`, `argument-hint`, `arguments`, `disable-model-invocation`, `user-invocable`, `allowed-tools`, `disallowed-tools`, `model`, `effort`, `context` (`fork` runs the skill in a subagent), `agent` (which subagent type for `context: fork`), `background`, `paths`, `shell`, `metadata`, `license`, `compatibility`. Only the six Agent Skills spec fields (`name`, `description`, `license`, `compatibility`, `metadata`, `allowed-tools`) survive upload to claude.ai or packaging.
- Dynamic context injection: a line like `` !`git diff HEAD` `` runs before Claude sees the content. Supporting files: extra files in the skill directory (reference docs, scripts). Scripts are executed, not loaded. Tip from the docs: "Keep `SKILL.md` under 500 lines."
- Substitutions: `$ARGUMENTS`, `$ARGUMENTS[N]`/`$N`, named `$name`, `${CLAUDE_SESSION_ID}`, `${CLAUDE_EFFORT}`, `${CLAUDE_SKILL_DIR}`, `${CLAUDE_PROJECT_DIR}`, `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`. `${CLAUDE_SKILL_DIR}` works in both the body and `allowed-tools`, which lets a skill pre-approve its own bundled script: `allowed-tools: Bash(${CLAUDE_SKILL_DIR}/scripts/render.sh *)`.
- Invocation control: `disable-model-invocation: true` (only the user can run it; removes it from Claude's context), `user-invocable: false` (only Claude).
- Lifecycle: descriptions sit in context every turn; the body loads on invocation and stays in context across turns ("every line is a recurring token cost"). After compaction, up to 5,000 tokens per skill and 25,000 tokens combined are re-attached.
- `allowed-tools` grants permission for the invoking turn only; it clears on your next message.
- `context: fork` runs the skill in a background subagent of type `agent` (default `general-purpose`; can be `Explore`, `Plan`, or a custom agent from `.claude/agents/`); `background: false` waits for the result.

### 4.2 Locations

| Location | Path | Loads in |
|---|---|---|
| Personal | `~/.claude/skills/<name>/SKILL.md` | All projects on this machine |
| Project | `.claude/skills/<name>/SKILL.md` | This repository (commit it) |
| Nested | `<subdir>/.claude/skills/<name>/SKILL.md` | Sessions in or below that subdir |
| Additional dir | via `--add-dir` / `/add-dir` | That session |
| Plugin | `<plugin>/skills/<name>/SKILL.md` | Where the plugin is enabled, as `/plugin:skill` |
| Enterprise | managed settings dir | All users on deployed machines |
| claude.ai sync | `~/.claude/skills/synced/` (reserved name) | Sessions signed in with that account |

Name conflicts resolve enterprise > personal > project; plugin skills are namespaced and coexist.

### 4.3 Plugins and marketplaces

- A plugin is a directory with a manifest at `.claude-plugin/plugin.json`; it bundles skills, agents (subagent definitions), hooks, and MCP servers, installed as one unit. Skills run as `/plugin-name:skill-name`.
- A marketplace is a repository or directory with `.claude-plugin/marketplace.json` that lists plugins and where to fetch them. Anthropic's official marketplace is added automatically on first interactive start. Install with `/plugin`, or `/plugin marketplace add <owner>/<repo>` then install by name.
- Scopes: user (this machine), project (committed `.claude/settings.json`), local (this repo, this user). While developing, `--plugin-dir` loads a folder without a marketplace.
- Cost warning from the docs: every model-invocable skill's name and description are in context on every turn, even when unused.

### 4.4 Documented best practices

From the same skills page **[facts, quotes or close paraphrases]**:

- Put the use case first in `description`; it decides automatic invocation.
- Keep the body concise; loaded content persists across turns and costs tokens each turn.
- Keep `SKILL.md` under 500 lines; move reference material to supporting files.
- Prefer skills over `.claude/commands/` for new work.
- Use `disable-model-invocation: true` for side-effectful workflows the user must control.
- Use scripts for computation (executed, not loaded) and reference files for detail.
- Use `context: fork` for isolated long tasks; write instructions that stand alone, because the forked subagent does not see the conversation.
- Use hooks if behavior must be deterministic rather than advisory.
- Review `allowed-tools` in skills you check into a repository; a skill can grant itself tool access.

## 5. Language and runtime for the small tool

Facts first:

- `mise.toml` in this repo pins only `opencode = "1.18.25"` today (file line 2).
- mise installs the relevant runtimes: `python` and `node` and `bun` are core tools; `uv` (aqua backend) and `jq` (aqua backend) are registry shorthands. Source: mise registry https://mise.jdx.dev/registry.html (fetched 2026-09-27; rows for bun, node, python, uv, jq).
- The official opencode SDK exists for TypeScript (`@opencode-ai/sdk`, versioned with the CLI, 1.18.32) but not for Python in a current form (Python SDK is 0.1.0a36 from 2025-08-27). Sources in Section 2.5.

Options and tradeoffs **[facts plus judgment]**:

1. **TypeScript + bun + `@opencode-ai/sdk`** (recommended). Pros: the only official, current SDK; generated types for sessions, messages, events, and status; built-in SSE subscription via `event.subscribe()`; versioned in lockstep with the CLI, so API drift is visible in the version number; `bun` is a mise core tool; the whole opencode ecosystem is TypeScript, so examples map over. Cons: adds a JS runtime to every project that adopts the tool; the SDK regenerates with every CLI release, so pin versions deliberately; type churn across minor versions is possible **[guess]**.
2. **Python 3 + uv + httpx (hand-written against the HTTP API)**. Pros: the user already works in Python contexts; `python` is a mise core tool and `uv` is one registry line; uv can inline dependencies in a single script (`uv run` with PEP 723 metadata), so deployment is one file; httpx handles basic auth and streaming. Cons: no official SDK support today, so we own the API surface (endpoint shapes, SSE parsing with something like `httpx-sse`); the stale `opencode-ai` PyPI package must not be used for the current API.
3. **Plain bash + curl + jq**. Pros: zero build, trivially auditable, jq is in the mise registry. Cons: SSE streams and JSON munging in bash are brittle; no sane way to test; error handling is poor. Acceptable only for a throwaway prototype.

**[judgment, recommendation]** Build the tool in TypeScript with bun and `@opencode-ai/sdk`, because the official SDK removes the main risk (API drift) and gives SSE for free. Keep the tool small and single-purpose. If the team prefers to stay in Python, the fallback is uv + httpx with the OpenAPI spec from `GET /doc` as the contract; budget a day for SSE parsing and response typing.

## 6. Recommendation and sketch

### 6.1 Reuse, adapt, or build

**[judgment, based on Section 1]**

- **Reuse**: opencode itself (HTTP API, SSE, agents, `web`/`attach` for watching). That is the platform and it is MIT.
- **Adapt (copy patterns, not code)**: the router/driver/review-lane skill structure from `delegate-to-agents`; the timeout and failure guidance from `invoke-opencode-acp`; the job states (`accepted`, `running`, `input_required`, `completed`, `failed`, `cancelled`) from `opencode-mcp`; the worktree isolation pattern from the orchestrators for parallel coding runs.
- **Build**: our small tool and our skill. Reasons: nothing existing gives the user live watching wired to Claude Code, encodes our agent files and review conventions, or stays small enough to drop into other projects. An MCP server would spend context on tool descriptions every turn; a GUI orchestrator is the wrong layer; the pure-skill approaches drive CLIs without the server API and cannot do follow-ups, aborts, or cost reporting cleanly.
- Do not depend on: `claude-squad` (AGPL), `oh-my-openagent` (license unclear), Conductor (proprietary). `vibe-kanban` is community-maintained after its company shut down in April 2026, so it is a shaky foundation **[judgment]**.

### 6.2 Minimal tool sketch (`oc-sub`, name open)

One command, subcommands, thin client over the opencode server. Config via env (`OPENCODE_SERVER_URL` or spawn/ensure a local `opencode serve`; `OPENCODE_SERVER_PASSWORD`/`OPENCODE_SERVER_USERNAME` for basic auth, never printed). **[guess]** for anything not sourced above.

- `oc-sub up` — ensure a server is running: health-check `GET /global/health` (gives version); if absent, spawn `opencode serve --port <port>` and wait for health. Print the URL.
- `oc-sub agents` — `GET /agent`; list available agent names (researcher, coder, ...).
- `oc-sub run <agent> "<task>" [--dir DIR] [--variant V] [--title T]` — `POST /session` (title), then `POST /session/:id/prompt_async` with `agent`, `parts: [{type: "text", text}]`, and optional model/variant. Print the session ID and write a small run record (JSON: session ID, task, agent, timestamps) under `.opencode/runs/` or `/tmp` so other commands can resolve "the last run". **[guess]** whether `model`/`variant` belong in the prompt body or must be agent-level; the body accepts `model`, and `--variant` exists on the CLI; verify the body field for variant.
- `oc-sub status [--all]` — `GET /session/status`; one line per session (id, state, title).
- `oc-sub watch [id] [--json]` — subscribe to `GET /event`, filter events by session ID, print assistant text parts and tool activity as they arrive; exit when the session goes idle or the user presses Ctrl-C. This is the "watch a run live" surface for both the user and, in the background, Claude Code.
- `oc-sub reply <id> "<message>"` — follow-up: `POST /session/:id/message` (or `prompt_async` with `--no-wait`).
- `oc-sub answer <id> --permission <pid> allow|deny` — respond to a permission request via `POST /session/:id/permissions/:permissionID`. **[guess]** Only needed if we let subagents ask; our current agents deny instead of asking.
- `oc-sub abort <id>` — `POST /session/:id/abort`.
- `oc-sub log <id> [--limit N]` — `GET /session/:id/message`; print the transcript plus per-message cost and tokens from the message info objects **[guess on exact fields; verify against `/doc`]**.
- `oc-sub review <id>` — for the orchestrator: print `GET /session/:id/diff` (file changes) and the final assistant message; exit code 0 when the report file exists. For research runs the report path is `docs/research/*` by convention.
- `oc-sub export <id> [--sanitize]` — `opencode export <id>` passthrough for archival.

Non-goals for v1: multiple servers, remote auth beyond basic auth, worktree management (Claude Code's own worktree support covers parallelism if we need it).

### 6.3 Skill sketch (`.claude/skills/oc-sub/SKILL.md` plus supporting files)

- Frontmatter: `description` names the trigger ("delegate a research or coding task to a cheap opencode subagent, start/monitor/abort runs, review results"), `disable-model-invocation: false` (Claude should use it when the user asks for delegation), optional `argument-hint`.
- Body (short): when to delegate (bulk research, mechanical edits, anything a cheap model handles); the two or three `oc-sub` commands with a fixed workflow (`up` → `run` → `watch` in background → `review`); where the run records live; timeout guidance (GLM-class models are fast for research, slow for big edits; cite the invoke-opencode-acp ranges as starting points **[fact from that repo, judgment for our models]**); how to review (read the report or diff, check cost with `log`, accept or `abort`); fallback when the server is down (run `oc-sub up`); never print secrets.
- Supporting files: `reference.md` with the full command reference and the endpoint table (Sections 2.3-2.4); `agents.md` snippet explaining our `.opencode/agents/*.md` format and how to add a new agent (Section 3); possibly a small script wrapper if we need pre-approved invocation via `allowed-tools: Bash(${CLAUDE_SKILL_DIR}/scripts/... )`.
- Packaging: for reuse in other projects, ship it as a project skill (`.claude/skills/oc-sub/`) committed with the tool, and optionally as a plugin with `.claude-plugin/plugin.json` so one marketplace add installs tool + skill. The plugin path also carries the agent files **[judgment]**.

## 7. What I could not find out

- The exact JSON shape of message `info` fields for cost and tokens in 1.18.32 (needs a live `GET /doc` or one API call).
- Which reasoning-effort knob applies to `z-ai/glm-5.3-flash` through OpenRouter (variant name or pass-through option).
- Whether `opencode attach` can open a session that was created through the HTTP API without an existing TUI session (it attaches to the server; session picking inside the TUI was not documented in what I read).
- The opencode docs do not state a minimum Claude Code or Node version for our use; nothing found constrains it.
- The v2 release date and its final API surface (the `/v2/docs` pages exist but no stable 2.x release is published yet).

## 8. Sources (index)

- opencode docs (all pages state "Last updated: Sep 26, 2026", fetched 2026-09-27): https://opencode.ai/docs/cli/ , /docs/server/ , /docs/sdk/ , /docs/agents/ , /docs/permissions/ , /docs/models/ , /docs/providers/ , /docs/web/ , /docs/ecosystem/ , /v2/docs/cli
- GitHub API (fetched 2026-09-27): `repos/sst/opencode` (= anomalyco/opencode), `repos/anomalyco/opencode/releases?per_page=5`, `repos/josephyaduvanshi/delegate-to-agents`, `repos/phonowell/invoke-opencode-acp`, `repos/AlaeddineMessadi/opencode-mcp`, `repos/alejandro-technology/opencode-mcp`, `repos/BloopAI/vibe-kanban`, `repos/smtg-ai/claude-squad`, `repos/shinpr/sub-agents-skills`, `repos/code-yeongyu/oh-my-openagent`, `repos/sst/opencode-sdk-python` (= anomalyco/opencode-sdk-python)
- npm/PyPI registries (fetched 2026-09-27): `registry.npmjs.org/-/package/opencode-ai/dist-tags`, `registry.npmjs.org/-/package/@opencode-ai/sdk/dist-tags`, `pypi.org/project/opencode-ai/`, and `raw.githubusercontent.com/anomalyco/opencode-sdk-python/main/api.md`
- Project READMEs (fetched 2026-09-27): AlaeddineMessadi/opencode-mcp, phonowell/invoke-opencode-acp, josephyaduvanshi/delegate-to-agents, BloopAI/vibe-kanban
- Claude Code docs (fetched 2026-09-27): https://code.claude.com/docs/en/skills , https://code.claude.com/docs/en/plugins
- Other: https://www.vibekanban.com/blog/shutdown (fetched 2026-09-27), https://www.conductor.build/docs/... (via search), https://mise.jdx.dev/registry.html (fetched 2026-09-27), DuckDuckGo search result pages (2026-09-27) for discovery, dev.to shinpr article (via snippet)
- Local: `mise.toml` (line 2), `.opencode/agents/researcher.md` (lines 1-32)
