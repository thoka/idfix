---
checked: 2026-10-02
recheck: 1m
decisions:
  - "backend for the Opus/Sonnet subagents: Claude Code in the sbx sandbox vs Claude Code on the host in worktrees"
  - "upgrade to Max 5x and how the subscription carries the subagents"
---

# Running Claude Code itself as a subagent in the Docker sandbox

Date: 2026-10-02. Research only, no code changes.

User context: the user is on Claude Pro ($20/month) and hits its limits; ccusage measured about $804 API-equivalent Claude Code use in September 2026 (docs/research/claude-max-vs-openrouter.md, section 6). A move to Max 5x ($100/month) is under consideration, and the subscription should then also carry the Opus/Sonnet subagents. The user decided on 2026-10-02 that subagents needing Opus or Sonnet run as Claude Code, not as opencode; opencode with GLM stays for cheap steps. Today Claude subagents run on the host in a git worktree, driven by Claude Code's own Agent tool or `claude --bg`.

## Criteria

- Compliance: the subscription OAuth may only drive the unmodified Claude Code binary (see section 2).
- Safety: blast radius of a subagent run; where the OAuth token and any keys sit.
- Effort: what oc-sub and the sandbox need to change for a production-quality version.
- Watching: can the user see a run live, follow up, and abort it.
- Cost and limits: can we measure per-run usage, and how the subagents share the 5-hour and weekly limits.
- Maturity of prior art.

## 0. Short answers

1. Yes — `sbx` ships Claude Code as a built-in agent (`sbx run claude`), in clone mode and with background sessions (`sbx run --clone claude . -- agents`). (Section 1)
2. The sbx credential proxy handles Claude OAuth: the flow runs on the host, the token never enters the sandbox, and the proxy refreshes it. No `CLAUDE_CODE_OAUTH_TOKEN` needs to enter the VM when the built-in agent kit is used. Anthropic also documents `claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN` for containers, and an official devcontainer. (Section 1)
3. Compliance: a headless Claude Code run inside a sandbox, started by our script, is Claude Code itself and looks allowed; Anthropic explicitly permits a platform hosting Claude Code for an end user's own sign-in. But "ordinary, individual usage" is undefined, the Consumer Terms forbid automated access except via Anthropic API key or explicit permission, and how heavily one may script `claude -p` on a subscription is a gray zone. (Section 2)
4. Driving: `claude -p` with `--output-format stream-json` covers one-shot runs and `--resume` covers follow-ups; `claude --bg` / `claude agents` / `claude attach` / `claude logs` cover background sessions the user can watch and abort. A bidirectional permission channel exists but is only fully documented for the Agent SDK, which the subscription may not drive. (Section 3)
5. Limits: all Claude Code activity, including parallel sessions and subagents, draws from the same account pool; ccusage reads the local JSONL transcripts for API-equivalent cost. A limit hit mid-run shows a "limit reached, resets at time" message; the documented fallbacks are usage credits (explicit consent), a higher plan, or waiting. (Section 4)
6. Prior art: the official devcontainer with an egress firewall, Docker Sandboxes' built-in Claude agent, and a few community wrappers; Docker's is by far the most mature. (Section 5)

Recommendation: option A, a `--agent claude` backend in oc-sub that runs Claude Code headless inside the same sbx sandbox, with `claude --bg` sessions in clone mode. Deciding criteria: compliance (Claude binary only), safety (sbx credential proxy keeps the OAuth token out of the VM), and cost (Max 5x carries $100+ per month of API-equivalent use, which $804/month of measured use clears). Option B (host worktrees, today's state) stays the default until A is built, because its only weakness is blast radius. (Section 6)

## Search log

Queries and relevant hits (a hit counts when it names a way to run Claude Code in a sandbox/container):

- `sbx --help`, `sbx run --help`, `sbx secret --help`, `sbx create --help`, `claude --help`, `claude agents --help`, `claude attach --help`, `claude setup-token --help`, `claude logs --help` (local, 2026-10-02): built-in agents `claude, codex, copilot, cursor, devin, docker-agent, droid, gemini, kiro, opencode, shell`; background commands; setup-token.
- websearch: Claude Code devcontainer and `CLAUDE_CODE_OAUTH_TOKEN` (5 relevant pages: devcontainer doc, authentication doc, env-vars doc, GitHub issue #8938, trailofbits repo); headless/background docs (6 relevant); sbx credentials (5 relevant); usage limits (6 relevant); stream-json control protocol (5 relevant: docs issue #24594, two community protocol write-ups).
- Reader (9 pages read in full): sbx claude-code agent page, sbx credentials page, sbx architecture page; Claude Code legal-and-compliance, authentication, headless, sessions, agent-sdk/streaming-input, devcontainer; support.claude.com Pro/Max plan article and models-usage article.
- skills.sh API, `claude code sandbox` and `claude code docker`: no skill about running Claude Code itself in a sandbox. Hits are unrelated (sandbox SDKs for app code, a 28-install `claude-code-web-docker`). 0 relevant hits.
- GitHub search, "claude code docker headless" and "claude code sandbox": 15+ repos, largest `textcortex/claude-code-sandbox` (322 stars, archived 2026-02), `trailofbits/claude-code-devcontainer` (949 stars, pushed 2026-08-28, gh api).

## 1. Docker Sandboxes and Claude Code

### 1.1 Does sbx support Claude Code as an agent?

Yes, as a built-in agent. From `sbx run --help` (run 2026-10-02): "Available agents: claude, codex, copilot, cursor, devin, docker-agent, droid, gemini, kiro, opencode, shell". From the sbx Claude Code page (https://docs.docker.com/ai/sandboxes/agents/claude-code/, read 2026-10-02 through the reader):

- Default startup: "Without extra args, the sandbox runs: `claude --dangerously-skip-permissions`".
- Background sessions are supported: "Claude Code's agents view starts background sessions that run tasks in parallel. Pair it with clone mode to keep their changes inside the sandbox: `$ sbx run --clone claude . -- agents`". Overriding the startup drops the skip-permissions default: "either use Claude Code's auto mode or pass the flag explicitly: `$ sbx run --clone claude . -- --dangerously-skip-permissions agents`".
- Isolation: "Claude Code creates any branches and worktrees inside the sandbox, not in your host checkout" — review via `git fetch sandbox-<sandbox-name>`, the same flow our clone mode already uses.
- Configuration gap: "Sandboxes don't pick up user-level configuration from your host, such as `~/.claude`. Only project-level configuration in the working directory is available inside the sandbox." Skills, settings, and plugins from `~/.claude` would need a mount (like the mounts we already set up for opencode) or a custom kit (`sbx create claude --kit ./my-mixin/`, from `sbx create --help`).

### 1.2 How does subscription OAuth work inside the sandbox?

The credential proxy handles it. From the sbx credentials page (https://docs.docker.com/ai/sandboxes/security/credentials, read 2026-10-02 through the reader):

- "An HTTP/HTTPS proxy on your host intercepts outbound requests from the sandbox, looks up the matching credential on the host, and overwrites the auth header before forwarding. The real credential stays on the host when proxy management is active; the sandbox sees only a sentinel value."
- "OAuth | A host-side sign-in flow; the token never enters the sandbox | The agent supports it, such as Claude Code, Codex, Cursor, or Droid."
- "Several agents support OAuth as another secure option: the flow runs on the host, so the token is never exposed inside the sandbox. ... Claude Code, Cursor, and Droid prompt interactively inside the sandbox. ... use `/login` inside Claude Code."
- The proxy also does "token refresh and routing" (credential bindings section). Anthropic's built-in service domains: `api.anthropic.com`, `console.anthropic.com`, `claude.ai`, `mcp-proxy.anthropic.com`.
- Escape hatch (not the default): "A kit can set OAuth `passthrough: true` to opt out of sentinel masking. This sends the real token response into the sandbox and reduces credential isolation."

So with the built-in claude agent kit, the token never has to enter the VM. One-time setup is interactive: the user runs `/login` inside the sandboxed Claude Code once, and the proxy stores and refreshes the token host-side. [guess] The exact split of what the kit stores host-side (a refresh token? a full credentials file?) is not spelled out on the page; the security claim is only that the real credential never enters the sandbox.

Two facts from Anthropic's own docs about tokens in containers:

- `claude setup-token` (read 2026-10-02 through the reader, https://code.claude.com/docs/en/authentication/): "For CI pipelines, scripts, or other environments where interactive browser login isn't available, generate a one-year OAuth token with `claude setup-token`"; "This token authenticates with your Claude subscription and requires a Pro, Max, Team, or Enterprise plan. It can only make model requests"; set it as `CLAUDE_CODE_OAUTH_TOKEN`. "Bare mode does not read `CLAUDE_CODE_OAUTH_TOKEN`" — avoid `--bare` for subscription runs.
- The env-vars doc adds `CLAUDE_CODE_OAUTH_REFRESH_TOKEN` with `CLAUDE_CODE_OAUTH_SCOPES` for provisioning auth in automated environments (search excerpt, not read through the reader).

Path to `setup-token` for sbx would need a custom kit or `sbx secret set-custom` (the built-in kit's OAuth path needs no token env var at all) — only relevant if the interactive first `/login` is not acceptable.

### 1.3 What Anthropic documents about Claude Code in containers

From the official devcontainer docs (https://code.claude.com/docs/en/devcontainer, read 2026-10-02 through the reader):

- A devcontainer feature `ghcr.io/anthropics/devcontainer-features/claude-code:1.0` installs the CLI; the `anthropics/claude-code` repository ships "an example dev container that combines the CLI, the egress firewall, persistent volumes, and a Zsh-based shell ... provided as a working example rather than a maintained base image", with `init-firewall.sh` limiting outbound traffic.
- Auth: sign in through the browser with a volume mounted at `~/.claude` and `CLAUDE_CONFIG_DIR` pointing there; or "store `ANTHROPIC_API_KEY` or a `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` as a Codespaces secret".
- Unattended: "Because the container runs Claude Code as a non-root user and confines command execution to the container, you can pass `--dangerously-skip-permissions` for unattended operation. The CLI rejects this flag when launched as root."
- Known caveat, same page: "When executed with `--dangerously-skip-permissions`, dev containers do not prevent a malicious project from exfiltrating anything accessible inside the container, including the Claude Code credentials stored in `~/.claude`. Only use dev containers when developing with trusted repositories." This is exactly the weakness that sbx's host-side credential proxy removes.

## 2. Compliance

### 2.1 What the pages say

From https://code.claude.com/docs/en/legal-and-compliance (read 2026-10-02 through the reader):

- "OAuth authentication is intended exclusively for purchasers of Claude Free, Pro, Max, Team, and Enterprise subscription plans and is designed to support ordinary use of Claude Code and other native Anthropic applications."
- "Developers building products or services that interact with Claude's capabilities, including those using the Agent SDK, should use API key authentication through Claude Console or a supported cloud provider. Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users."
- "Advertised usage limits for Pro and Max plans assume ordinary, individual usage of Claude Code and the Agent SDK."
- On hosted Claude Code: "Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription, including where a platform hosts Claude Code as described under *Can customers offer Claude Code in their products?* above." [note] I read only this cross-reference sentence, not the full hosting section; the body of that section could add conditions.
- "Anthropic reserves the right to take measures to enforce these restrictions and may do so without prior notice."

From the Consumer Terms (https://www.anthropic.com/legal/consumer-terms, effective 2025-10-08, read 2026-10-02 through the reader), § 3 item 7:

- "Except when you are accessing our Services via an Anthropic API Key or where we otherwise explicitly permit it, to access the Services through automated or non-human means, whether through a bot, script, or otherwise."

This clause is the reason third-party harnesses are forbidden: they access via their own means, not via an Anthropic API key. But headless Claude Code on a subscription is a script accessing the service *without* an API key — its permission rests on "where we otherwise explicitly permit it". Anthropic permits it in practice: the legal page endorses headless/CI usage (`setup-token` "for CI pipelines, scripts", the whole headless mode) and limits "assume ordinary, individual usage of Claude Code and the Agent SDK", which includes the Agent SDK in the ordinary-use assumption.

### 2.2 Is our setup "ordinary, individual usage"?

The setup: the user's own subscription, the unmodified `claude` binary, started by oc-sub (their own script, not a product for others), inside a sandbox on their own machine, in their own repository.

- Clearly allowed: the unmodified Claude Code binary with the user's own subscription, headless (`claude -p`), in background (`--bg`), in containers/devcontainers, with `setup-token` for scripts, and a platform hosting Claude Code for an end user's own sign-in (legal page, reader).
- Clearly forbidden: driving opencode or the Agent SDK with subscription OAuth; any third-party tool routing subscription credentials; collecting or intermediating the user's credentials (legal page, reader). This kills any "opencode with subscription" path and confirms the 2026-10-02 decision.
- Unclear: how much script-driven parallel orchestration stays within "ordinary, individual usage". The phrase is undefined. One user running a few headless subagent runs alongside their interactive work fits the letter ("usage of Claude Code"); running a farm of parallel headless agents may deviate. [guess] Whether oc-sub — which is not Anthropic's product and is not offered to other users, just a personal launcher of the official binary — counts as a "third-party developer" scenario is the sharpest open question; the hosting exception suggests the intent is to punish products serving *other* users, not personal scripting.

### 2.3 Enforcement in 2026

From docs/research/claude-max-vs-openrouter.md (written 2026-10-02 in this repository, whose sources were read through the reader then):

- January 2026: Anthropic deployed technical safeguards against tools spoofing the Claude Code client; "some user accounts were automatically banned for triggering abuse filters". Claude Code engineer: "Third-party harnesses using Claude subscriptions create problems for users and are prohibited by our Terms of Service."
- February 2026: opencode removed Claude subscription auth after "anthropic legal requests".
- GitHub issues report false-positive bans of Max subscribers who used only official Claude Code. So ban risk exists even for compliant use, and the enforcement is automated and opaque.

I found no 2026 enforcement report that names headless or containerized *official* Claude Code on a subscription as a ban reason. The named targets were third-party harnesses. [guess] Containerized official Claude Code is mainstream (official devcontainer, Docker's built-in agent) and is not a plausible ban trigger by itself; heavy parallel headless volume is the risk factor to watch.

## 3. Driving Claude Code from a script

All facts in this section from `claude --help`, `claude agents --help`, `claude attach --help`, `claude setup-token --help`, and `claude logs --help` (run 2026-10-02), or from the headless, sessions, and streaming-input docs (read 2026-10-02 through the reader).

### 3.1 One-shot and follow-up: `claude -p`

- `claude -p PROMPT` runs non-interactive; "Claude Code exits with code 0 on success and a non-zero code when the run fails, so your scripts can branch on the exit status."
- `--output-format text|json|stream-json`. "With `--output-format json`, the response payload includes `total_cost_usd` and a per-model cost breakdown" — "Both figures are client-side estimates". The last stream line is "a `result` message with the final response text, cost, and session metadata"; `system/init` reports model, tools, MCP servers, plugins. So a run record can capture session ID, usage, and estimated cost — the same data oc-sub now gets from opencode.
- `--resume <id>` continues a specific session; `claude -p "Continue that review" --resume "$session_id"` is the documented follow-up. `--resume` also accepts an absolute path to a transcript `.jsonl` file.
- `claude -p` conflicts with `--bg` ("Claude Code rejects `--bg`"), and `--max-turns` caps the turns; queued messages with `--input-format stream-json` get their own turn.
- `--fallback-model`, `--model fable|opus|sonnet|...` (from `claude --help`) select the model per run.

### 3.2 Bidirectional streaming: `--input-format stream-json`

- The CLI flag exists (`claude --help`: "Input format (only works with `--print`)"), and the Agent SDK docs describe the mode: streaming mode "allows the agent to operate as a long lived process that takes in user input, handles interruptions, surfaces permission requests, and handles session management".
- Permission requests surface to a host: in the SDK as the `canUseTool` callback ("Both trigger your `canUseTool` callback, which pauses execution until you return a response... The callback can stay pending indefinitely"); with the raw CLI via `--permission-prompt-tool` (an MCP tool) — the full CLI wire format (`control_request`/`control_response`) is not officially documented; community write-ups (docs issue #24594, protocol gists — search excerpts, not read through the reader) reverse-engineer it.
- Interrupt/abort in streaming mode: SDK `interrupt()`, or "To end the turn instead, send SIGINT ... Claude Code exits with code 143 [on SIGTERM] ... leaves the turn that was in progress unfinished" (headless doc).
- The Agent SDK route is legally closed for us (section 2). The raw CLI route with `--input-format stream-json` + `--permission-prompt-tool` exists but rests on an undocumented wire format. [guess] For oc-sub, the safer design avoids the bidirectional channel: run one-shot `claude -p` runs with `--permission-prompts none` or pre-allowed tools, and treat a denied permission as a normal failure that the orchestrator follows up on with `--resume`.

### 3.3 Background sessions: `--bg`, `agents`, `attach`, `logs`

From `claude --help` and the agent-view docs:

- `claude --bg "prompt"`: "Start the session in the background and return immediately. Prints the id that `claude attach`, `logs`, `stop` and `rm` take; `claude agents` lists them." Also "Combine with `--exec` to run a shell command as a background job ... or with `--agent` to run a specific subagent".
- `claude agents --json`: "print active sessions as a JSON array for scripting (`--json --all` also includes completed background sessions)". This is the polling surface oc-sub would use for status.
- `claude attach <id>`: "Open the background session in this terminal. ← returns to agent view, Ctrl+Z drops back to your shell. The session keeps running either way." — the user's live view.
- `claude logs <id>`: "Print a background session's recent terminal output."
- `claude --bg --resume <session-id>`: "continues that session in the background under the same ID" (from `claude --help`). This is the follow-up command for a background run.

### 3.4 Permission modes

From `claude --help` and the headless doc: `--permission-mode` choices include `acceptEdits`, `auto` ("a classifier review most actions instead of you"), `bypassPermissions`, `manual`, and `dontAsk` ("Claude Code denies every call that would otherwise prompt, which is useful for locked-down CI runs"). `--permission-prompts none` denies anything that would prompt; denials appear as `permission_denied` system messages and in `permission_denials` of the result. `--allowedTools "Bash(git diff *)"` etc. set prefix rules.

### 3.5 Can the user watch a run live?

Yes, three ways: `claude attach <id>` (full terminal, session keeps running), the `claude agents` view (list of parallel sessions with state), and `claude logs <id>` (recent output). For `claude -p` runs there is no attach — the run prints to the caller's stdout, and the transcript JSONL is written to `~/.claude/projects/<project>/<session-id>.jsonl` (sessions doc; "the entry format is internal to Claude Code and changes between versions"). Compared with oc-sub today: no `top` view, no per-child cost breakdown, no event stream with loop/stall guards — those we would rebuild on `claude agents --json` polling and the transcript files. [guess]

## 4. Limits and cost

### 4.1 What Max 5x gives over Pro (user context)

From docs/research/claude-max-vs-openrouter.md (its pricing and support pages were read through the reader on 2026-10-02): Max 5x is $100/month, "5x more usage than Pro" — and the multiplier applies per 5-hour session, not per week: "Max gives you 5x or 20x more usage per 5-hour session than Pro". Weekly limits sit on top and "reset at a fixed time each week that is assigned to your account". Anthropic doubled the 5-hour Claude Code limits on 2026-05-06 (anthropic.com/news/higher-limits-spacex — search excerpt, not read through the reader). Community estimates (archive.ph of the help center — search excerpt, not read): Pro ≈ 10–40 prompts per 5 hours, Max 5x ≈ 50–200, Max 20x ≈ 200–800; "Users running multiple Claude Code instances in parallel will hit their limits sooner". Opus reaches limits roughly five times faster than Sonnet, and Max auto-switches Opus→Sonnet at usage thresholds (same source). Exact allowances are unpublished; treat all numbers as estimates.

Given the measured $804 API-equivalent use in September on Pro, Max 5x pays off by a wide margin: the break-even in the prior report was "API-equivalent usage exceeds $100/mo". At $804, Max 5x delivers at least the same token volume for $100 that would cost $804 at API prices — about 8x the spend — and 5x the per-session headroom of Pro removes the limit stops the user currently hits. [guess] Whether $804 of measured use fits into a Max 5x *allowance* is a different question than pay-off: the allowance is measured in prompts/turns, not dollars, and parallel subagents consume it faster than solo interactive work. The prior report's class-action note claims real Max delivery is far below the label. Only live measurement after the upgrade settles this.

### 4.2 How subagents share the pool

"All Claude Code activity ... counts against the same usage limits": the Pro/Max help article says "usage limits that are shared across Claude and Claude Code, meaning all activity in both tools counts against the same usage limits" (read 2026-10-02 through the reader). Neither page names subagents; since a subagent is the same account making the same kind of request, they draw from the same pool. [guess, from the quotes above] A 5-hour window is per account, not per process — parallel oc-sub-driven runs and the user's interactive session all spend the same allowance.

### 4.3 Reading the remaining quota and avoiding a mid-step stop

- In-session: "Monitor your remaining allocation using the /status command" (Pro/Max article, reader). `/cost` is API-billing only.
- Proactive: "you will see warning messages about remaining capacity" — the CLI warns before the stop.
- Outside a session: no official quota API. [guess] The JSONL transcripts record the usage per request, so a local counter (like ccusage's `blocks` mode, which models the 5-hour windows) can estimate remaining capacity, but it can only estimate — Anthropic does not expose the true remaining allowance.
- Practical scheduling to use the plan to its limit without a mid-step stop [guess, built from the documented pieces]: start subagent runs early in a 5-hour window; before a run, check `/status` in any open Claude session (or read a local usage estimate); keep Opus for the steps that need it and Sonnet for the rest ("Opus ... uses meaningfully more of your quota" — models-usage article); accept the auto Opus→Sonnet switch rather than fighting it; and keep usage credits configured as the fallback, which Anthropic gates to explicit consent: "All transitions to API credit usage require explicit user consent."
- What happens when the limit hits mid-run: the docs describe a "limit reached, resets at time" message (models-usage article, reader) and the options (usage credits, higher plan, wait). They do not describe whether the in-flight request fails or the run pauses. [guess] A `claude -p` run that hits the limit mid-turn fails and exits non-zero with the limit message; the orchestrator then either waits for the window or follows up with `--resume` after the reset. This is testable only after the upgrade, and it is a known unknown for the design (a mid-run limit hit is the failure mode oc-sub's abort/follow-up commands must absorb).

### 4.4 Measuring usage per run

- Per-run: the `result` JSON of `claude -p --output-format json` carries `total_cost_usd` (a client-side estimate) and usage; `system/init` carries the session ID. A run record like today's `.opencode/runs/<id>.json` can store these.
- Per-day/per-project aggregate: ccusage (18,840 stars, pushed 2026-10-02, gh api) reads the local JSONL transcripts at `~/.claude/projects/` and estimates API-equivalent cost; `bunx ccusage blocks` models the 5-hour windows; it also reads opencode logs (`ccusage opencode daily`). Source: docs/research/claude-max-vs-openrouter.md section 6.
- Caveat for sandboxes: transcripts land in the sandbox's `~/.claude`, which host ccusage does not see (the sandbox home is not the host home). [guess] Fix: set `CLAUDE_CONFIG_DIR` (sessions doc: "Move storage off `~/.claude` — `CLAUDE_CONFIG_DIR`") to a path inside the mounted workspace, for example `<project>/.opencode/claude/`, so the JSONL lands on the host filesystem and ccusage reads it. That folder must be gitignored and it does expose transcripts to the workspace mount — they leave the sandbox through a channel the user owns, not through the agent's actions.
- There is no OpenRouter-style real-cost line for a subscription: no per-request metered charge exists. ccusage's API-equivalent estimate is the closest number, and it is an estimate. [fact from prior report]

## 5. Existing tools

| Tool | What it does | Maturity | Fit |
| --- | --- | --- | --- |
| Docker Sandboxes built-in `claude` agent (docs.docker.com/ai/sandboxes/agents/claude-code/) | Runs Claude Code in the microVM, proxy-managed OAuth, clone mode, agents view supported | Docker product, current docs, read 2026-10-02 | Best fit; the piece oc-sub must add is headless invocation and orchestration |
| Official devcontainer (code.claude.com/docs/en/devcontainer; anthropics/claude-code reference container) | Devcontainer feature + example container with egress firewall, persistent `~/.claude`, `--dangerously-skip-permissions` for unattended use | Official, but "a working example rather than a maintained base image" | Container lives on our own Docker, no credential proxy; token or credentials file sits inside the container (exfiltration warning applies) |
| trailofbits/claude-code-devcontainer (949 stars, pushed 2026-08-28, gh api) | Devcontainer with `setup-token` headless auth and a one-shot auth handshake working around the onboarding issue (#8938) | Active, popular | Same container model; useful reference for the onboarding fix, not a runtime we adopt |
| textcortex/claude-code-sandbox (322 stars, archived 2026-02, gh api) | Docker wrapper with auto-allowed permissions | Archived | Dead end |
| ccusage (18,840 stars, active) | Cost/usage reporting from JSONL logs, incl. 5-hour blocks and opencode logs | Mature, active | Use for measurement |
| skills.sh (`claude code sandbox`, `claude code docker`) | No skill about sandboxing Claude Code itself; nearest is `trevors/dot-claude/claude-code-web-docker` with 28 installs | — | Nothing to adopt |

The onboarding problem in fresh containers (theme picker/trust dialog despite a valid token) is documented in GitHub issue #8938 (search excerpt, not read through the reader): workarounds are `hasCompletedOnboarding: true` in `~/.claude.json` or `IS_DEMO=true`. [guess] The sbx built-in kit presumably handles this; if a fresh sandbox stalls on onboarding, the fix is one interactive `/login` or a prepared `.claude.json`.

## 6. Options for oc-sub

### A. A `--agent claude` backend that runs Claude Code in the sbx sandbox

oc-sub gains a claude mode: the sandbox for a project is created with the `claude` agent kit (a second sandbox per project, or a custom kit combining both agents), oc-sub starts runs as `claude -p --output-format json` (or `--bg` for long runs) inside the sandbox via `sbx exec`, watches via `claude agents --json` polling and transcript JSONL, follows up via `--resume`, aborts via `claude stop <id>` or SIGTERM, and records the estimated cost from the result JSON. The credential proxy of sbx handles subscription OAuth; no token enters the VM.

- Gains: full sandbox isolation with the best credential model of any option (token never in the VM); clone mode gives per-run worktrees inside the sandbox; compliance is the cleanest (unmodified binary, own subscription, personal script); reuses the sbx infrastructure and state files we already run.
- Costs: new backend code (a second driver next to the opencode one: different status, event, and cost surfaces); the user-level `~/.claude` config (skills, settings, plugins) is not picked up in the sandbox and needs mounts or a kit; the oc-sub top/watch/guard features (loop and stall detection, pending requests, per-child cost) must be rebuilt on cruder surfaces (`agents --json`, JSONL transcripts); ccusage needs the `CLAUDE_CONFIG_DIR` trick to see sandbox transcripts; no real-cost line, only estimates.
- Risks: the undocumented CLI wire format if we later want the bidirectional channel (mitigated: avoid it); "ordinary, individual usage" gray zone for heavy parallel headless use; automated false-positive bans exist even for compliant users; `claude --bg` inside the sandbox depends on the sbx holder process keeping the VM alive (the auto-stop problem we already solved for opencode).

### B. Claude subagents on the host in git worktrees (today's state, formalized)

oc-sub (or Claude itself) starts `claude -p` / `claude --bg` on the host, one run per git worktree under `<repo>/.worktrees/`, as today.

- Gains: least effort — nothing new to build beyond maybe a thin status/abort wrapper around `claude agents --json`; full `claude` functionality (skills, plugins, settings, attach) works with no mount work; transcripts land in the host `~/.claude`, so ccusage sees them directly; no onboarding or config gaps.
- Costs: blast radius is the host. Permission rules are "not a sandbox" (our own GUIDE.md security note); a run with `--permission-mode bypassPermissions` (needed for unattended operation) can touch the host filesystem and network within Claude Code's own sandboxing limits (bubblewrap on Linux, docs/research/sandbox.md section 1.2); the OAuth token sits in `~/.claude` on the host, reachable by any process the agent runs.
- Compliance: identical to option A — same binary, same subscription, same script. [fact] The only difference between A and B is safety, not compliance.
- Judged against A: A wins on safety (microVM, credential proxy, clone mode). B wins on effort (near zero), on watching (attach/agents view work at full quality), and on cost accounting (host transcripts). Risk of B: an unattended headless run with bypassed permissions on the host is exactly the failure mode the user built the sbx sandbox to avoid.

### C. A separate tool (no oc-sub integration)

Keep Claude subagents outside oc-sub: the user drives them with `claude --bg`, the agents view, and `claude attach`, or via Claude Code's own Agent tool in the main session, optionally in the sbx sandbox manually.

- Gains: zero new code; Claude Code's own orchestration (subagents, agent view) is maintained by Anthropic and already integrates with the main session; no gray zone about our harness beyond the same headless usage.
- Costs: no guards, no run records, no cost lines, no per-project attribution; the main session's own context pays for orchestration; the user must check `claude agents` by hand.
- Compliance: same as A/B.

### D. opencode or the Agent SDK with the subscription — excluded

Not an option: the legal page forbids routing subscription credentials through other tools and forbids OAuth in the Agent SDK (section 2), and opencode removed subscription auth after Anthropic's legal request (prior report). Listed only to record why it is out.

## 7. Recommendation

Option A — a `--agent claude` backend in oc-sub that runs Claude Code headless inside the sbx sandbox — as the target for the Opus/Sonnet steps, with option B (host worktrees, today's state) as the working default until A is built, and option C (Claude Code's own agent view) acceptable for single ad-hoc runs. The criteria that decide it:

1. Compliance: A, B, and C are equal; all three use the unmodified binary with the user's own subscription. D is out.
2. Safety: A wins clearly (microVM blast radius, credential proxy keeps the OAuth token out of the VM, clone mode contains worktrees). B puts an unattended bypass-permissions agent on the host.
3. Cost accounting: B wins slightly (host transcripts for ccusage), but A reaches parity with the `CLAUDE_CONFIG_DIR`-in-workspace trick [guess].
4. Effort: B is near zero; A is a real backend (status, watch, records, config mounts). The user's intent — Max 5x used to the max for subagent volume — makes the recurring safety benefit of A worth the one-time effort, because higher volume means more unattended runs and therefore a larger blast radius if B stays the default.

Sequence: keep B now, build A incrementally (first: one-shot `claude -p` runs inside the sandbox with result-JSON run records; then: status/abort via `claude agents --json`; then: guards and the top view), and revisit the compliance gray zone if parallel volume grows past a handful of concurrent runs. Before any of it: confirm the Max 5x upgrade decision with the user and measure whether the allowance actually absorbs $804/month of API-equivalent work.

## 8. What I could not find out

- Any published token, prompt, or dollar allowance for Pro/Max 5-hour and weekly windows (Anthropic publishes none; community numbers are estimates).
- What exactly happens mid-run when a subscription limit hits (does the in-flight request fail, pause, or downgrade?) — no doc describes it; needs a live test after the upgrade.
- The full body of the legal page's "Can customers offer Claude Code in their products?" section — I read only the cross-reference sentence, not the hosting section's conditions.
- The official wire format of `--input-format stream-json` / `control_request` (docs issue #24594 confirms it is undocumented; community write-ups reverse-engineer it).
- Whether sbx's built-in claude kit fully handles the container onboarding issue (#8938) without an interactive first `/login`.
- The actual token storage the sbx OAuth proxy keeps host-side (refresh token vs credentials file) — the page only claims the credential never enters the sandbox.
- Whether Anthropic's enforcement in 2026 has specifically flagged scripted headless volume on a subscription — no report found; the named targets were third-party harnesses.
