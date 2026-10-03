# Plan

This file holds only the open work. Finished steps, their root causes, and their details are in [HISTORY.md](HISTORY.md), under the same step numbers. Measured runs and costs are in [EXPERIENCE.md](EXPERIENCE.md). How to use the tool is in [GUIDE.md](GUIDE.md).

## Goal

If four things hold, oc-sub is stable and useful. First, a plugin change reaches every running server without manual steps. Second, a sandbox starts after a reboot. Third, every project runs the same tested setup. Fourth, a coder can install the tools that it needs. Everything else is comfort.

## State on 2026-10-02

`alpha` holds the branch `worktree-complete-plan` up to step 19, and the main checkout is on it, so `~/.local/bin/oc-sub` runs the new code. `oc-sub doctor --fix` ran: the plugin and the idle server use the new plugin. Steps 2b, 3, 4, 5 (11d), 8h, 15e, 16d, 17b, 17c, 18a, 18b, and 19 are done in code. The suite passes on the host: 978 tests. The research reports of steps 15e, 16, 17a, 18, 2b, and the KVM task are written. Details are in [HISTORY.md](HISTORY.md).

On 2026-10-02 `oc-sub doctor --fix --force` passed `sandbox-mounts` in this project, grata, and meta: each sandbox is in clone mode with all mounts. arch-helper has no sandbox, and `oc-sub up` creates it in the current standard. The workflow in this project is unchanged (clone mode):

1. `oc-sub worktree STEP` creates the run worktree inside the sandbox clone, runs `mise install` with the sandbox mise, and runs the `setup` command of `.opencode/oc-sub.json`.
2. `oc-sub run --agent coder --dir <root>/.worktrees/STEP --brief <file>` starts the run, and `oc-sub watch` waits.
3. `oc-sub fetch` on the host, review with `git diff alpha...sandbox-oc-sub-opencode-subagents/feature/STEP`, run `mise exec -- bun test` and `mise exec -- bun run typecheck` on the host, and squash-merge into `alpha`.
4. `oc-sub worktree rm STEP` removes the worktree inside the clone.

## Next steps, in this order

### 1. Bring the branch onto `alpha`, then the live tests

`origin/alpha` is moved, and `oc-sub doctor --fix` ran. Open: the user fast-forwards the main checkout with `git merge --ff-only origin/alpha`, so that the `oc-sub` command runs the new code. Then the live tests:

- 2b: a research run with `--model deepinfra/zai-org/GLM-5.3-Flash`. The proxy log must show the `reader` requests at DeepInfra, not at OpenRouter.
- 3: passed on 2026-10-02. `oc-sub worktree X` printed `setup: bun install --frozen-lockfile`, and the sandbox mise printed no self-update warning.
- 16d: after `oc-sub restart`, the server log starts with a `--- oc-sub up ... ---` marker and keeps the older lines.
- 5 (11d): `watch` stays quiet during a long model request, and `oc-sub down` leaves no orphan proxy restart loop.
- 17c: passed on 2026-10-02 with `./bin/oc-sub doctor` of the branch. It lists the six trigger heads under `research-due`.
- 19: `oc-sub worktree X` in meta (only `main`) prints `base: main (no alpha branch)`. This needs the meta sandbox in clone mode first.

### 2. Step 16: DeepInfra, a decision of the user

[deepinfra-logprob.md](research/deepinfra-logprob.md) answers the root cause question. DeepInfra has no public report of the error. The client never asks for log probabilities, so no request option avoids it. opencode 1.18.32 does not retry the error (opencode issue #21893). The options are in its table. A proxy retry before the first content chunk (option D) is safe. The retry works in one case only: the bad chunk comes before any content. The append-mode logs of step 16d now keep the data that answers this. The user decides whether DeepInfra comes back and whether to report the bug to DeepInfra (option B needs the DeepInfra account). The draft of the report is [deepinfra-logprob-null.md](reports/deepinfra-logprob-null.md). Open gaps: the opencode estimate shows twice the real DeepInfra cost. An existing sandbox gets the network allow rule for `api.deepinfra.com` only with the first secret set.

### 3. Step 17: recurring research, the rest

- 17d, after a decision of the user: whether unattended paid rechecks are allowed, and the cap per month. [recurring-research.md](research/recurring-research.md) found that only the Windows Task Scheduler can start a stopped WSL2, and only while the user is logged in. Until then, `research-due` only warns.

### 4. Step 18: the trace pipeline, stage three and quality

Stage one (`oc-sub trace`) and stage two (`oc-sub trace --tag`, Jev through the OpenRouter decisions endpoint, about $0.00003 per step) work. Open:

1. Question version 2: give each step the result of the previous tool call as evidence. When its evidence sits in the step before, a per-step judge calls a claim ungrounded (live test of 18b).
2. Quality measurement: hand labels for 3 to 5 known runs, then precision and recall per tag ([trace-analysis.md](research/trace-analysis.md), "Quality measurement").
3. Stage three: a GLM agent groups the tags over many runs and names changes to briefs, prompts, and tools.
4. Small gaps: a `fetch` that throws ends the whole tagging. A chunked `read` of one file counts as a reread.

### 5. Step 15e follow-ups

`doctor --renovate` exists. Not yet covered: a project that still runs a host-mode server, and old setups that no check detects yet. Each new best practice becomes a check with a fix.

### 6. Step 20: research runs must read their sources

On 2026-10-02 three researcher runs (openhands, langgraph, driver-layer) called `reader` zero times and still marked every source "fetched". The researcher prompt now says that only read pages count as sources, and that every software question searches skills.sh. Still open: `oc-sub watch` and `oc-sub log` must warn in one case. That case is a `researcher` run that ends without a `reader` call. The three reports get a note that their sources are search excerpts.

### 7. Step 21 moved to meta

On 2026-10-02 the user moved step 21 (deep research tools for expensive decisions) to meta, with its reports. It is now step 4 of `~/dv/meta/docs/PLAN.md`. The reports are in `~/dv/meta/docs/research/`: `deep-research-tools.md`, `oss-deep-research.md`, and `deep-research-eval/`. `api-browsers.md` stays here, because part 1 serves step 22. The meta step links its part 2.

### 8. Step 22: an agent browser for the reader

[api-browsers.md](research/api-browsers.md) found `vercel-labs/agent-browser` (Apache-2.0, 43k stars, 934k installs on skills.sh): a CLI and MCP server with persistent profiles, cookie import, and `read <url>` without Chrome. Test it in the sandbox as a fetch path of the `reader` for pages that webfetch cannot read (JavaScript, login, x.com). Fallback: `microsoft/playwright-mcp`.

### 9. Step 23: Claude Code as a subagent in the sandbox (starts when the user has Claude Max)

The user decided on 2026-10-02: subagents that need Opus or Sonnet run as Claude Code, not as opencode, and inside the sbx sandbox. The work starts after the upgrade to Claude Max. Until then, Claude subagents stay on the host in worktrees. Research: [claude-in-sandbox.md](research/claude-in-sandbox.md), option A.

Each sub-step is one session, with tests and documentation:

1. Spike, by hand: `sbx run --clone claude .` in this project, `/login` once, and check that the token stays out of the VM. Check the onboarding (issue #8938), and run `claude -p --output-format json` inside the sandbox through `sbx exec`. Hit a usage limit on purpose with a small run and record what a run does then. Write the findings into the research report.
2. Configuration: decide how skills, configuration, plugins, and the shared rules reach the sandboxed Claude Code. The options are a mount of the needed parts of `~/.claude`, or an sbx kit. Set `CLAUDE_CONFIG_DIR` to a gitignored folder in the workspace, so that `ccusage` on the host sees the transcripts.
3. `oc-sub run --agent claude`: start a one-shot `claude -p` run in the sandbox, in a worktree of `oc-sub worktree`. Write a run record with the session ID, usage, and estimated cost from the result JSON.
4. `oc-sub say` (as `--resume`), `oc-sub abort`, `oc-sub status`, and `oc-sub log` for Claude runs, through `claude agents --json`, the transcript, and signals.
5. Guards and the live view: loop and stall detection on the transcript, and Claude runs in `oc-sub top`.
6. Skill: `skills/oc-sub/SKILL.md` names the routing. A step goes to GLM through opencode, or to Claude. It also names how to fill the Max plan without a stop in the middle of a step.

Known gaps from the research: permission requests have no documented two-way channel. Runs therefore use pre-allowed tools and treat a denial as a failure. The remaining quota has no API. "Ordinary, individual usage" is undefined. Keep the number of parallel runs small at first.

### 10. Step 24: rename the project to idfix

The user decided on 2026-10-03: the project becomes idfix 🐕 (the dog Idefix in Asterix), because it will support clients other than opencode. The CLI becomes `idfx`. Done: `bin/idfx` runs the same CLI as `oc-sub`, and `~/.local/bin/idfx` links to it. Both names work for now, so that the user gets used to the new one. Open, in small steps:

1. Help text, messages, and docs say `idfx`. `oc-sub` stays as an alias.
2. The plugin, the marketplace, and the skill `oc-sub` get the new name. Claude Code needs a reinstall of the plugin.
3. State folders (`$XDG_STATE_HOME/oc-sub`), environment variables (`OC_SUB_*`), sandbox names, and `.opencode/oc-sub.json` move with a fallback to the old names. `doctor --fix` migrates them.
4. The repository folder and the GitHub repository get the new name. meta and arch-helper (links, rules, skills) change through the outbox.
5. `oc-sub` goes away after the user agrees.

### 11. Step 25: one driver layer for opencode and Claude Code (design)

Requested by the session of step 7c on 2026-10-03. The project gets one driver layer for three drivers: opencode on GLM, Claude Code on GLM, and Claude Code on Claude (step 23). Claude Code on GLM starts through `~/dv/meta/dv/bin/claude-glm`. The report about it is in meta, `docs/research/claude-code-with-glm.md`.

The design gives the three drivers one shape. It covers: one run record, one cost path through the proxy, and one `top`. It also covers the shared commands `run`, `say`, `watch`, `log`, and `abort`. The cost path includes the Anthropic path `/v1/messages` and the attribution of requests to a Claude Code session. The design also decides where the proxy runs for host sessions and how the proxy keeps the keys out of its logs.

Inputs: a new driver-layer research report and [claude-in-sandbox.md](research/claude-in-sandbox.md). Because the decision is hard to reverse, the design gets deep research (step 4 of the meta plan). Order: interview of the user, then research, then the design.

Decisions of the user, 2026-10-03:

- The driver interface stays open for a fourth CLI, for example Codex.
- All host sessions go through the proxy and show in `top`: the supervisor and the interactive sessions too, not only the subagent runs.
- The research uses the deep-research tool of meta step 4. Its evaluation is not finished (4b and 4c are open), and its step 4d names the driver-layer question itself. So the research report waits for that evaluation, or the driver-layer question runs first in it.
- The design comes first, before the rename in step 24. The design text already writes `idfx`.

State: the Gemini report is back, as [driver-interface.md](research/driver-interface.md). It recommends to extend the in-house proxy and to attribute sessions with a header from `ANTHROPIC_CUSTOM_HEADERS`. The paste lost its source links, and step 25a checked the claims that the design depends on, in section 6 of the report. Next: the design session reads the report with its check, next to [claude-in-sandbox.md](research/claude-in-sandbox.md).

### Later

- Log rotation: the server and proxy logs grow without limit since step 16d.
- `oc-sub say --file FILE`: a message from a file. The guard of Claude Code refuses a `say` text that names git commands.
- `oc-sub fetch` prints `+N over alpha` and `git diff alpha...` also in a repository without `alpha`. It needs the same base fallback as `oc-sub worktree` (step 19).
- `printLogTail` exists twice, in `src/up.ts` and `src/sandbox.ts`.
- Step 11, rest: the detectors of step 6 give the provider of a flagged run a strike. After two or three strikes, the provider goes onto the OpenRouter `ignore` list for some days.
- Step 8g gaps. A new worktree shows in the live view only after `a` twice. The footer lacks the day totals and the key usage per project. The `o` command finds only runs of `oc-sub run`. Below about 110 columns, the title is cut.
- Step 7: agent files without a body, so GLM keeps the default system prompt of opencode. A first A/B test found no difference. Details in [HISTORY.md](HISTORY.md#step-7-agent-files-keep-the-default-system-prompt).
- Step 10 follow-up: put a faster provider (Parasail or Together) first. This is a decision of the user.
- Known gap of 10c: meaningless plain ASCII text under 20,000 characters passes the probe evaluator.
- The Exa index lags behind. The researcher must make sure that a version is current with `reader` on the source page.

## Open tasks of the user

- Decide on the upgrade to Claude Max 5x. Step 23 starts after it. The current plan is Pro. September used about $804 at API prices.
- Run the `!` command for the OpenRouter usage per project, for [claude-max-vs-openrouter.md](research/claude-max-vs-openrouter.md).
- Make the access to `/dev/kvm` permanent. [wsl-kvm-access.md](research/wsl-kvm-access.md), section 7: the `kvm` group exists here with gid 990, and the udev rule of this distro already sets mode 0666. So the state of 2026-09-30 (gid 109, mode 0660) likely came from another WSL distro that shares the device node. Run `wsl.exe -l -v` on Windows and name the distros that run. The guard of this session blocked that command.
- Decide on DeepInfra (step 2) and on unattended rechecks (step 3, 17d).
- Decide from [deploy-access.md](research/deploy-access.md) section 8: whether Tailscale runs on the servers, and how long a debugging window lasts.
- Optional: report the unhandled `AbortError` of the SSE client of `@opencode-ai/sdk` 1.18.32 upstream (lesson `opencode-sdk-sse-abort-unhandled.md` in meta). Then the handler in `src/top/app.tsx` can go.

## Channels

- Work for meta (a lesson, a general rule, a research link, or a task) goes into `docs/outbox/` with the global skill `meta-outbox`. The meta supervisor imports it, so a session here needs no git access in meta.

## Default decisions, open for a change by the user

- The update command is a flag of `doctor` and not a new `update` command, because the fixes belong to the checks.
- Every fix that can end a session or lose a local change needs `--force`. Only `--renovate` applies them without it.
- `doctor --renovate` and `--fix` change a project file in one case only: git tracks it, and it has no local change. A pin in the global mise configuration of the user stays a manual step.
- The `reader` subagent has no model of its own, so it uses the model of the run.
- Stage two of the trace pipeline pins `typesafe/jev-1.13` and uses the project OpenRouter key, with a cap of 200 steps per call.
- oc-sub stays on opencode 1.18.32. The latest release 1.18.33 fixes none of our issues, and 2.0 is a beta with a new server API ([opencode-roadmap.md](research/opencode-roadmap.md)).
