---
checked: 2026-10-02
recheck: 3m
decisions:
  - "keep oc-sub vs. adopt OpenHands components (plan review)"
---

# OpenHands and oc-sub: comparison and overlap

Research date: 2026-10-02. Question: how does oc-sub (plus its Claude Code skill) compare to OpenHands and similar agent platforms, and which parts of our work duplicate what OpenHands already delivers?

Facts carry a source (URL or file with line number). Statements marked **[guess]** are my judgment. Where I could not find something, I say so.

## 0. Short answers

1. OpenHands is a large, very active MIT project (main repo ~89,800 stars, SDK pushed today). It now ships a "Software Agent SDK" (Python, four packages) with a REST/WebSocket agent server, Docker sandbox workspaces, confirmation/pause flows, MCP support, LiteLLM for models, and a skill system that loads `AGENTS.md` and `SKILL.md`. (Sections 1–2)
2. OpenHands overlaps with oc-sub on: headless agent runs behind an HTTP API, a Docker sandbox, confirmation/permission answering, follow-up messages, cost tracking, and skills/rules. It does not overlap on: Claude Code as the orchestrating main thread, git worktree per run, per-project real cost from OpenRouter, the live user view wired to Claude Code, and the guards (loop/stall/reasoning). (Section 3)
3. The parts of oc-sub that duplicate OpenHands are conceptually the run lifecycle (up/run/watch/answer/say/abort) and the sandbox. But OpenHands has no "Claude Code drives cheap subagents" story, no project-key real-cost accounting, and its Docker sandbox does not keep the API key out of the agent's reach. (Sections 3–4)

## 1. State of OpenHands (facts with dates)

### 1.1 Repos, license, activity, releases

- Main app repo `OpenHands/OpenHands`: MIT, 89,807 stars, created 2024-03-13, last push 2026-10-02, 857 open issues. Source: GitHub API `repos/OpenHands/OpenHands` (fetched 2026-10-02).
- SDK repo `OpenHands/software-agent-sdk`: MIT, 1,192 stars, created 2025-08-23, last push 2026-10-02, 517 open issues. Contains `openhands-sdk`, `openhands-tools`, `openhands-workspace`, `openhands-agent-server`, `clients`. Source: GitHub API `repos/OpenHands/software-agent-sdk` and contents listing (fetched 2026-10-02).
- CLI repo `OpenHands/OpenHands-CLI`: MIT, 261 stars, last push 2026-09-28. Its README carries the warning "This project is no longer actively maintained." Source: GitHub API and README (fetched 2026-10-02). Where the CLI work continues is not clear from the repo listing (see Section 6).
- Release cadence is very fast. SDK releases: v1.49.1 (2026-09-17) to v1.50.1 (2026-09-30) — six releases in two weeks. App releases: v1.20.0 (2026-09-17) to v1.24.0 (2026-09-25). Sources: GitHub API releases lists for both repos (fetched 2026-10-02).
- **[judgment]** This cadence means any code we write against OpenHands internals or APIs needs frequent re-pinning, the same problem `oc-sub doctor` already manages for opencode (GUIDE.md, check `opencode-version`), but with a much faster target.

### 1.2 The SDK and the agent server

- The SDK is Python. Four packages: `openhands-sdk` (agent, LLM, conversation, skills, security), `openhands-tools` (bash, file editor, browser, task tracker), `openhands-workspace` (Docker and remote workspaces), `openhands-agent-server` (FastAPI HTTP/WebSocket server). Install via PyPI, versions move together (`openhands-sdk==1.22.1` style pinning is documented). Sources: https://docs.openhands.dev/sdk/getting-started and https://docs.openhands.dev/sdk/arch/overview (fetched 2026-10-02).
- The agent server runs behind HTTP and WebSocket: `python -m openhands.agent_server --host 127.0.0.1 --port 8000`. Auth via session API keys (`OH_SESSION_API_KEYS_0`, header `X-Session-API-Key`); by default it starts **without** authentication. Endpoints: `/health`, `/ready`, `/server_info`, `/docs` (OpenAPI), `/api/*` for conversations, workspace, files, commands. It also exposes an OpenAI-compatible `/v1/chat/completions` endpoint. Sources: https://docs.openhands.dev/sdk/arch/agent-server and https://docs.openhands.dev/sdk/arch/overview (fetched 2026-10-02).
- Headless mode of the CLI: `openhands --headless -t "task"` with `--json` for JSONL event output. The docs state: "Headless mode always runs in `always-approve` mode. The agent will execute all actions without any confirmation. This cannot be changed." Source: https://docs.openhands.dev/openhands/usage/cli/headless (fetched 2026-10-02).
- An RFC (issue OpenHands-CLI #574, 2026-03-06) plans to make the CLI always launch a local `openhands-agent-server` per session and talk to it as a client, plus a cloud "bridge"; parts were still open work items when written. Source: https://github.com/OpenHands/OpenHands-CLI/issues/574.

### 1.3 Sandbox runtimes

- Three workspace types with one API: local folder, `DockerWorkspace` (a Docker container running the pre-built `ghcr.io/openhands/agent-server` image), and `APIRemoteWorkspace` (hosted runtime). "Switching from local to remote is just a matter of swapping the workspace class—no code rewrites needed." Sources: https://docs.openhands.dev/sdk/guides/agent-server/overview and https://docs.openhands.dev/sdk/guides/agent-server/docker-sandbox (fetched 2026-10-02).
- `DockerWorkspace` mounts host paths via a `volumes` list (bind mounts), auto-picks a free host port, waits for container health, and forwards selected env vars (`forward_env` defaults to `DEBUG`, `SESSION_API_KEY`, `OH_SESSION_API_KEYS_0`). Sources: docs page above and `openhands-workspace/openhands/workspace/docker/workspace.py` in the repo (fetched 2026-10-02).
- The old V1 app runtime (Docker runtime with `SANDBOX_VOLUMES`, plugin system, VS Code/Jupyter plugins) is documented separately and remains the app's default. Source: https://docs.openhands.dev/openhands/usage/architecture/runtime (fetched 2026-10-02).
- **Not found:** a documented deny-by-default network egress policy for the SDK `DockerWorkspace`, and any credential proxy that keeps the LLM API key out of the container. The agent-server doc instead says `OH_SECRET_KEY` "encrypts sensitive values stored with conversations, including LLM API keys" — meaning LLM API keys are stored with the server, which runs inside the sandbox container. Source: https://docs.openhands.dev/sdk/arch/agent-server (fetched 2026-10-02). This is the opposite of the Docker Sandboxes (`sbx`) model we use, where "the raw credential values never enter the VM" (sandbox.md, line 64).

### 1.4 Models via LiteLLM

- Model names follow the LiteLLM convention `provider/model_name`; LiteLLM gives "a unified interface to OpenAI, Anthropic, Google, and 100+ providers". The provider docs table includes a dedicated OpenRouter page. Cost tracking: "Telemetry & Cost — Track usage, latency, and costs across providers"; an example prints `conversation.conversation_stats.get_combined_metrics().accumulated_cost`. Sources: https://docs.openhands.dev/sdk/arch/llm and the docker-sandbox example in the repo (fetched 2026-10-02).
- **[judgment]** LiteLLM's cost is computed from its own price map, so it is an estimate like opencode's models.dev cost, not the real charge at OpenRouter. I did not find any OpenRouter key-usage feature in OpenHands (see Section 6).

### 1.5 MCP, skills, and rules

- MCP: `Agent(mcp_config={"mcpServers": {...}})` in FastMCP format, with tool filtering by regex and OAuth support (OAuth is documented as unsuitable for headless). Sources: https://docs.openhands.dev/sdk/guides/mcp and https://docs.openhands.dev/sdk/arch/mcp (fetched 2026-10-02).
- Skills: OpenHands supports the AgentSkills standard (`SKILL.md`) plus its own extensions (keyword, task, and path triggers; path-triggered "rules" inject on file touch with zero baseline cost). Repo rules: "`AGENTS.md` at your repo root - it's loaded automatically"; loaders also find `CLAUDE.md`, `GEMINI.md`, `.cursorrules`. Sources: https://docs.openhands.dev/sdk/guides/skill and https://docs.openhands.dev/sdk/arch/skill (fetched 2026-10-02).
- The agent server has a skills endpoint with precedence: sandbox < public (GitHub `OpenHands/skills`) < user (`~/.openhands/skills/`) < organization < project (`.openhands/skills/` in the workspace). Source: https://docs.openhands.dev/sdk/guides/agent-server/api-reference/skills/get-skills (fetched 2026-10-02).
- Enterprise docs also document `.agents/skills/` per repository and plugin marketplaces with auto-load. Source: https://docs.openhands.dev/enterprise/skills-and-plugins (fetched 2026-10-02).

### 1.6 Pause, confirmation, abort

- The SDK has a full confirmation flow: `AlwaysConfirm()`, `NeverConfirm()`, `ConfirmRisky(threshold)` with a security analyzer; the conversation state exposes `WAITING_FOR_CONFIRMATION`, `get_unmatched_actions()` lists pending actions, and `reject_pending_actions("reason")` rejects with feedback. Over the server API: `POST /api/conversations/{id}/events/respond_to_confirmation` with `{accept, reason}`. `conversation.pause()` stops the agent between steps and `run()` resumes; sending a message while paused is shown in the docs. Sources: https://docs.openhands.dev/sdk/guides/security, https://docs.openhands.dev/sdk/api-reference/openhands.sdk.conversation, https://docs.openhands.dev/sdk/guides/convo-pause-and-resume (all fetched 2026-10-02).

## 2. Requirement-by-requirement comparison

Criteria (from the brief): (1) Claude Code stays the main thread and delegates to cheap models; (2) live watching plus follow-up, permission answers, abort; (3) own git worktree per run, sandbox, no key access; (4) real cost per run and per project key; (5) shared rules and skills reach the subagent; (6) low maintenance for one user on WSL2 with Docker Sandboxes.

| Criterion | oc-sub (repo files) | OpenHands |
|---|---|---|
| 1. Claude Code main thread, cheap models | Meets. The plugin serves `coder`/`researcher`/`reader` agents; the skill tells Claude when to delegate (README.md lines 5, 31–36; GUIDE.md lines 126–133). GLM via OpenRouter and DeepInfra is configured per project (README.md lines 83, 118). | Not met as such. OpenHands has no Claude Code integration; the orchestrator would be our own script or the OpenHands app. OpenHands can run *as* an agent (ACP mode `openhands acp` for IDEs, headless `--json` for scripts; command-reference docs, fetched 2026-10-02). Cheap GLM works through LiteLLM's OpenRouter support **[guess on GLM specifically — not verified]**. |
| 2. Watch live, follow up, answer, abort | Meets. `watch` follows the SSE stream, `top` is an htop-like live view, `say`/`answer`/`abort` cover follow-up, questions and permissions, abort (README.md lines 155–258; GUIDE.md lines 138–194). | Partly. The SDK streams events via WebSocket and callbacks; pause/resume, confirmation accept/reject, and message sending are documented (Section 1.6). But there is no ready-made live CLI view for a headless run; the user view is the OpenHands app/CLI TUI, and the CLI repo says it is unmaintained. Driving it from Claude Code would need new glue. |
| 3. Worktree per run, sandbox, no keys | Meets. Sandbox clone mode gives a private in-container clone, worktrees at `.worktrees/<step>` inside the clone, host repo read-only, `sbx` credential proxy keeps the key out of the VM, network deny rules, no SSH agent (GUIDE.md lines 224–287; sandbox.md). | Partly. `DockerWorkspace` gives container isolation and bind mounts, but there is no git worktree management, no documented network egress policy, and the LLM API key is stored with the agent server inside the container (Section 1.3). |
| 4. Real cost per run and per project key | Meets. Project key files, shared-key refusal, key-usage delta from `GET /api/v1/key`, cost proxy with per-request `usage.cost` (README.md lines 118–129, 240–250; real-cost.md). | Not met. LiteLLM/`conversation_stats` give an accumulated cost estimate per conversation (Section 1.4). No per-project-key accounting or OpenRouter key-usage feature found. |
| 5. Shared rules and skills reach the subagent | Meets. `up` passes the shared `AGENTS.md` as `instructions` and the skills folder as `skills.paths`, mounts the shared folder read-only into the sandbox, and `ping --rules` verifies the agent really sees the rules (README.md lines 81, 254; GUIDE.md line 261). | Meets, differently. `AGENTS.md` auto-loads, `SKILL.md` with triggers, user/org/project precedence (Section 1.5). But the sources are OpenHands's own paths (`~/.openhands/skills/`, `.openhands/skills/`), not our `~/dv/meta/agents` layout; pointing it at our shared folder would need glue **[guess]**. No equivalent of `ping --rules` was found. |
| 6. Low maintenance, one user, WSL2, Docker Sandboxes | Meets, with known cost: opencode version pinning, `doctor`, sandbox recreate checks (GUIDE.md lines 85–97). | Partly. OpenHands is MIT and extremely active, but the SDK releases every few days, the CLI repo declares itself unmaintained, and a migration from the V1 app to the SDK is in progress (issue #574). Running `DockerWorkspace` on WSL2 works where Docker works **[guess — not verified on WSL2]**; it uses plain Docker, not Docker Sandboxes. |

## 3. What oc-sub duplicates

**[judgment, based on Section 2]**

- **Run lifecycle over an HTTP API** (`up/run/watch/say/answer/abort/log`): OpenHands agent server delivers the server side (conversations, events over WebSocket, confirmation endpoint, OpenAI-compatible endpoint). Our client logic is thinner than what OpenHands ships, but our client is the part that knows Claude Code and the user.
- **Sandbox**: OpenHands `DockerWorkspace` duplicates the "container per project" idea. It does not duplicate our key model (credential proxy), network rules, clone mode, or worktree-in-clone.
- **Skills and rules**: OpenHands reads `AGENTS.md` and `SKILL.md` natively. Our `OPENCODE_CONFIG_CONTENT` plumbing exists because opencode drops the global rules file (opencode-rules.md); OpenHands has no such bug to work around, but also no path to our shared meta folder.
- **Cost**: OpenHands tracks accumulated cost per conversation, which duplicates the estimate half of our `log`; it has nothing like the real-cost line.
- **What OpenHands has that we lack entirely**: browser tools with VNC, a hosted runtime option, an OpenAI-compatible endpoint, security risk analyzers, path-triggered rules, condensers, and a huge community.

## 4. Other tools of the same class that prior-art.md misses

Kept short, per the brief:

- **OpenHands** itself — now covered by this report. The agent server's OpenAI-compatible endpoint means *any* OpenAI-compatible orchestrator could drive it as a "model", a pattern prior-art.md did not consider (https://docs.openhands.dev/sdk/arch/overview).
- **ACP agents as delegable backends** — sandbox.md section 4 already covers the Agent Client Protocol; what it does not say is that this makes roughly 40 agent CLIs (Gemini CLI, Codex CLI, Goose, …) potentially drivable from Claude Code through one protocol (https://agentclientprotocol.com/overview/agents, cited in sandbox.md line 89). [guess] No ACP client skill for Claude Code was verified.
- No other new platform was found in this pass beyond what prior-art.md sections 1.1–1.3 lists; I searched mainly for OpenHands, not for a full re-survey. See Section 6.

## 5. Options

**Option A: keep oc-sub as is.**
- Cost of switching: none.
- Gain: nothing new; the maintenance burden (opencode pinning, sandbox checks) stays.
- Lose: browser tools, security analyzers, the OpenHands ecosystem. None is on our plan (PLAN.md) today.

**Option B: replace parts of oc-sub with OpenHands components.**
- Candidates, named: (a) the run server — replace `opencode serve` with `openhands-agent-server`; (b) the sandbox — replace `sbx` with `DockerWorkspace`; (c) cost estimation — drop our models.dev-dependent estimate and use `conversation_stats`.
- Cost of switching: high. Every command of `oc-sub` (about 15 subcommands, 978 tests) targets the opencode HTTP API; opencode agents, permissions, `attach`/`web` live views, and child-session cost accounting have no OpenHands equivalent. The skill, the run records, the real-cost line, and the guards would need rewrites. The CLI (the only packaged user-facing client) declares itself unmaintained, so we would have to build our own client on the Python SDK — a new runtime (Python/uv) next to bun.
- Gain: a faster-moving server with MCP, browser tools, and built-in confirmation; escape from opencode's v2 migration risk (prior-art.md section 2.1).
- Lose: `opencode attach`/`web` live views, per-agent permission rules, child-session cost trees, the `sbx` credential proxy (the key would enter the container), and our tested tooling.

**Option C: replace oc-sub fully with OpenHands.**
- Cost of switching: highest. OpenHands has no Claude Code orchestrator role, no worktree-per-run, no project-key real cost, and its user-facing CLI is unmaintained; we would rebuild most of oc-sub as an OpenHands client anyway, plus migrate the whole workflow (GUIDE.md) and all projects.
- Gain: one platform instead of opencode + oc-sub, in theory.
- Lose: everything in Option B, plus the working sandbox/key model, for a platform whose fit for criterion 1 is unproven.

## 6. What I could not find out

- Whether GLM (z-ai) models work in OpenHands via LiteLLM/OpenRouter in practice — the provider docs list OpenRouter, but no GLM-specific page was checked.
- Whether the SDK `DockerWorkspace` has any network egress control at all (nothing documented; only the V1 app runtime pages mention volumes and ports, not egress policy).
- Where OpenHands CLI development continues after the "no longer actively maintained" notice (the `clients/` folder in the SDK repo was not examined in depth).
- Whether LiteLLM cost tracking can be fed real provider-reported costs (OpenRouter `usage.cost`) rather than its price map.
- Whether the local agent server keeps the LLM key only in its process env or persists it encrypted with `OH_SECRET_KEY` by default, and what that means for a container escape.
- A full re-survey of "agent platforms that Claude Code can drive as subagents" was out of scope; prior-art.md (2026-09-27) is three days old and its list was not re-checked except for OpenHands.

## 7. Sources

- GitHub API (fetched 2026-10-02): `repos/OpenHands/OpenHands`, `repos/OpenHands/software-agent-sdk`, `repos/OpenHands/OpenHands-CLI`, releases lists of all three, contents listing of `software-agent-sdk`.
- OpenHands docs (fetched 2026-10-02): https://docs.openhands.dev/sdk , /sdk/getting-started , /sdk/arch/overview , /sdk/arch/agent-server , /sdk/arch/llm , /sdk/arch/mcp , /sdk/arch/skill , /sdk/arch/security , /sdk/guides/mcp , /sdk/guides/skill , /sdk/guides/security , /sdk/guides/convo-pause-and-resume , /sdk/guides/agent-server/overview , /sdk/guides/agent-server/docker-sandbox , /sdk/guides/agent-server/api-reference/skills/get-skills , /sdk/guides/agent-server/api-reference/events/respond-to-confirmation , /sdk/api-reference/openhands.sdk.conversation , /sdk/api-reference/openhands.sdk.agent , /openhands/usage/cli/headless , /openhands/usage/cli/command-reference , /openhands/usage/architecture/runtime , /enterprise/skills-and-plugins
- GitHub (fetched 2026-10-02): OpenHands/OpenHands-CLI issue #574; `openhands-workspace/openhands/workspace/docker/workspace.py`; examples `02_convo_with_docker_sandboxed_server.py`, `03_browser_use_with_docker_sandboxed_server.py`, `04_confirmation_mode_example.py`.
- Repo files: README.md, docs/GUIDE.md, docs/PLAN.md, docs/research/prior-art.md, docs/research/sandbox.md, docs/research/real-cost.md.
