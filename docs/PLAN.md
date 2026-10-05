# Plan

This file holds only the open work. Finished steps, their root causes, and their details are in [HISTORY.md](HISTORY.md), under the same step numbers. Measured runs and costs are in [EXPERIENCE.md](EXPERIENCE.md). How to use the tool is in [GUIDE.md](GUIDE.md).

## Goal

If four things hold, oc-sub is stable and useful. First, a plugin change reaches every running server without manual steps. Second, a sandbox starts after a reboot. Third, every project runs the same tested setup. Fourth, a coder can install the tools that it needs. Everything else is comfort.

## Direction since 2026-10-04 evening

The user decided on 2026-10-04 evening (meta 384ff44, global rules): our agents cooperate. A check catches mistakes, not attacks of our own agents. No protection work happens without a feature goal, and the goal is that the projects get finished. Secrets and keys stay protected. So idfix is no longer the isolation layer of the GitHub runner. The runner keeps running as fix 50 set it up. New work serves the user directly: Claude Code sessions in `top`, then the Telegram broker for approvals, without extra hardening. The GLM features still rest while the user has the Claude Max plan. A step that serves neither is marked "Paused" or "Dropped".

## Notes from meta, 2026-10-04

- Git: the user changed the Git rules (meta `agents/AGENTS.md`, section Git, and the report `~/dv/meta/docs/research/branching-model.md`). `alpha` goes away, agent PRs auto-merge into `main`, release-please keeps one release PR, and CI moves the tag `stable`. This project migrates third in meta plan step 16c, after grata and markgraf. Do not start before the supervisor says so. Until then the `alpha` flow stays, but a merge into `main` no longer needs the approval of the user. After the move, the `~/.local/bin` links and the marketplace use `ref: stable`.
- User scripts end with `notify-session <session-id> <text>` (report `~/dv/meta/docs/research/script-notifies-session.md`, template `~/dv/meta/dv/bin/user-step-template.sh`). After the session writes such a script, it ends its turn.
- Not built: the Telegram broker for Claude Code sessions (meta step 12, R3). meta-f2 and the supervisor decided on 2026-10-04 evening, after the new direction, that the phone channel goes back to tlive (R2), an existing tool. meta-f2 owns its setup. On 2026-10-05 the user stopped every Telegram part (tlive R2 and the broker R3). The replacement is a user-step inbox (meta plan step 12, commit e652d19, report `~/dv/meta/docs/research/user-step-inbox.md`). Its place, idfix or its own project, is still open. Step 25g (Claude sessions in `top`) goes on without it and reads the Claude Code files by polling.
- Task from meta-f2, after the broker plan: the journal `~/dv/gemini-journal` found four Deep Research reports of the user on a control layer that drives Claude Code autonomously. Merge them into `docs/design/driver-layer.md` or its research report if they cover the question, else into one new report, with a recheck head (skill `gemini-research`). Cite the Gemini chat ids, because no share links exist. Note what changes for idfix. The ids are `78cb4cb3b06a0b87`, `8132f53fd96bfd51`, `cac95a48f5594da9`, and `e01c776569945668`. The texts are private, in `~/.cache/gemini-journal/text/<id>.md`, and never go into a commit. Summaries are in `~/dv/gemini-journal/entries/<id>.md`.
- Spike 32c is dropped (see Direction).

## State on 2026-10-02

`alpha` holds the branch `worktree-complete-plan` up to step 19, and the main checkout is on it, so `~/.local/bin/oc-sub` runs the new code. `oc-sub doctor --fix` ran: the plugin and the idle server use the new plugin. Steps 2b, 3, 4, 5 (11d), 8h, 15e, 16d, 17b, 17c, 18a, 18b, and 19 are done in code. The suite passes on the host: 978 tests. The research reports of steps 15e, 16, 17a, 18, 2b, and the KVM task are written. Details are in [HISTORY.md](HISTORY.md).

On 2026-10-02 `oc-sub doctor --fix --force` passed `sandbox-mounts` in this project, grata, and meta: each sandbox is in clone mode with all mounts. arch-helper has no sandbox, and `oc-sub up` creates it in the current standard. The workflow in this project is unchanged (clone mode):

1. `oc-sub worktree STEP` creates the run worktree inside the sandbox clone, runs `mise install` with the sandbox mise, and runs the `setup` command of `.opencode/oc-sub.json`.
2. `oc-sub run --agent coder --dir <root>/.worktrees/STEP --brief <file>` starts the run, and `oc-sub watch` waits.
3. `oc-sub fetch` on the host, review with `git diff alpha...sandbox-oc-sub-opencode-subagents/feature/STEP`, run `mise exec -- bun test` and `mise exec -- bun run typecheck` on the host, and squash-merge into `alpha`.
4. `oc-sub worktree rm STEP` removes the worktree inside the clone.

## Next steps, in this order

### 1. Bring the branch onto `alpha`, then the live tests

Since 2026-10-04 the live test 2b rests, because it tests a GLM feature. The other tests stay.

`origin/alpha` is moved, and `oc-sub doctor --fix` ran. Open: the user fast-forwards the main checkout with `git merge --ff-only origin/alpha`, so that the `oc-sub` command runs the new code. Then the live tests:

- 2b: a research run with `--model deepinfra/zai-org/GLM-5.3-Flash`. The proxy log must show the `reader` requests at DeepInfra, not at OpenRouter.
- 3: passed on 2026-10-02. `oc-sub worktree X` printed `setup: bun install --frozen-lockfile`, and the sandbox mise printed no self-update warning.
- 16d: after `oc-sub restart`, the server log starts with a `--- oc-sub up ... ---` marker and keeps the older lines.
- 5 (11d): `watch` stays quiet during a long model request, and `oc-sub down` leaves no orphan proxy restart loop.
- 17c: passed on 2026-10-02 with `./bin/oc-sub doctor` of the branch. It lists the six trigger heads under `research-due`.
- 19: `oc-sub worktree X` in meta (only `main`) prints `base: main (no alpha branch)`. This needs the meta sandbox in clone mode first.

### 2. Step 16: DeepInfra, a decision of the user

Paused on 2026-10-04: it does not serve the runner goal (see Direction).

[deepinfra-logprob.md](research/deepinfra-logprob.md) answers the root cause question. DeepInfra has no public report of the error. The client never asks for log probabilities, so no request option avoids it. opencode 1.18.32 does not retry the error (opencode issue #21893). The options are in its table. A proxy retry before the first content chunk (option D) is safe. The retry works in one case only: the bad chunk comes before any content. The append-mode logs of step 16d now keep the data that answers this. The user decides whether DeepInfra comes back and whether to report the bug to DeepInfra (option B needs the DeepInfra account). The draft of the report is [deepinfra-logprob-null.md](reports/deepinfra-logprob-null.md). Open gaps: the opencode estimate shows twice the real DeepInfra cost. An existing sandbox gets the network allow rule for `api.deepinfra.com` only with the first secret set.

### 3. Step 17: recurring research, the rest

Paused on 2026-10-04: it does not serve the runner goal (see Direction).

- 17d, after a decision of the user: whether unattended paid rechecks are allowed, and the cap per month. [recurring-research.md](research/recurring-research.md) found that only the Windows Task Scheduler can start a stopped WSL2, and only while the user is logged in. Until then, `research-due` only warns.

### 4. Step 18: the trace pipeline, stage three and quality

Paused on 2026-10-04: it does not serve the runner goal (see Direction).

Stage one (`oc-sub trace`) and stage two (`oc-sub trace --tag`, Jev through the OpenRouter decisions endpoint, about $0.00003 per step) work. Open:

1. Question version 2: give each step the result of the previous tool call as evidence. When its evidence sits in the step before, a per-step judge calls a claim ungrounded (live test of 18b).
2. Quality measurement: hand labels for 3 to 5 known runs, then precision and recall per tag ([trace-analysis.md](research/trace-analysis.md), "Quality measurement").
3. Stage three: a GLM agent groups the tags over many runs and names changes to briefs, prompts, and tools.
4. Small gaps: a `fetch` that throws ends the whole tagging. A chunked `read` of one file counts as a reread.

### 5. Step 15e follow-ups

Paused on 2026-10-04: it does not serve the runner goal (see Direction).

`doctor --renovate` exists. Not yet covered: a project that still runs a host-mode server, and old setups that no check detects yet. Each new best practice becomes a check with a fix.

### 6. Step 20: research runs must read their sources

Paused on 2026-10-04: it does not serve the runner goal (see Direction).

On 2026-10-02 three researcher runs (openhands, langgraph, driver-layer) called `reader` zero times and still marked every source "fetched". The researcher prompt now says that only read pages count as sources, and that every software question searches skills.sh. Still open: `oc-sub watch` and `oc-sub log` must warn in one case. That case is a `researcher` run that ends without a `reader` call. The three reports get a note that their sources are search excerpts.

### 7. Step 21 moved to meta

On 2026-10-02 the user moved step 21 (deep research tools for expensive decisions) to meta, with its reports. It is now step 4 of `~/dv/meta/docs/PLAN.md`. The reports are in `~/dv/meta/docs/research/`: `deep-research-tools.md`, `oss-deep-research.md`, and `deep-research-eval/`. `api-browsers.md` stays here, because part 1 serves step 22. The meta step links its part 2.

### 8. Step 22: an agent browser for the reader

Paused on 2026-10-04: it does not serve the runner goal (see Direction).

[api-browsers.md](research/api-browsers.md) found `vercel-labs/agent-browser` (Apache-2.0, 43k stars, 934k installs on skills.sh): a CLI and MCP server with persistent profiles, cookie import, and `read <url>` without Chrome. Test it in the sandbox as a fetch path of the `reader` for pages that webfetch cannot read (JavaScript, login, x.com). Fallback: `microsoft/playwright-mcp`.

Research question from meta (2026-10-03, the user approved it): the user often shares x.com and t.co links, and agents must read them. Is there an established extractor that reads an x.com post or thread from its URL without a login? Candidates are an embed or syndication endpoint, an API like fxtwitter, a skill on skills.sh, or a library. Compare it with `agent-browser` with cookie import, which stays the fallback. A t.co link resolves with a plain HEAD request (the `Location` header), so only the x.com page needs a special path. The report goes into `docs/research/`.

### 9. Step 23: Claude Code as a subagent in the sandbox (starts when the user has Claude Max)

Paused on 2026-10-04 evening: the sandbox protects against our own agents and has no feature goal (see Direction). Claude subagents run on the host in worktrees. The read side of sub-step 4 and 5 (`status`, `top`) moves to step 25g.

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

Since 2026-10-04 only the Claude drivers go on. The opencode and `claude-glm` parts rest with the GLM features.

Requested by the session of step 7c on 2026-10-03. The project gets one driver layer for three drivers: opencode on GLM, Claude Code on GLM, and Claude Code on Claude (step 23). Claude Code on GLM starts through `~/dv/meta/dv/bin/claude-glm`. The report about it is in meta, `docs/research/claude-code-with-glm.md`.

The design gives the three drivers one shape. It covers: one run record, one cost path through the proxy, and one `top`. It also covers the shared commands `run`, `say`, `watch`, `log`, and `abort`. The cost path includes the Anthropic path `/v1/messages` and the attribution of requests to a Claude Code session. The design also decides where the proxy runs for host sessions and how the proxy keeps the keys out of its logs.

Inputs: a new driver-layer research report and [claude-in-sandbox.md](research/claude-in-sandbox.md). Because the decision is hard to reverse, the design gets deep research (step 4 of the meta plan). Order: interview of the user, then research, then the design.

Decisions of the user, 2026-10-03:

- The driver interface stays open for a fourth CLI, for example Codex.
- All host sessions go through the proxy and show in `top`: the supervisor and the interactive sessions too, not only the subagent runs.
- The research uses the deep-research tool of meta step 4. Its evaluation is not finished (4b and 4c are open), and its step 4d names the driver-layer question itself. So the research report waits for that evaluation, or the driver-layer question runs first in it.
- The design comes first, before the rename in step 24. The design text already writes `idfx`.

State: the design is written, as [driver-layer.md](design/driver-layer.md) (step 25, 2026-10-03). It extends the in-house proxy, gives each driver one cost source, and runs the host proxy as a systemd user unit. Section 3 asks the user one question. Until the answer, the design follows its recommendation: `claude-glm` sessions go through the proxy, and sessions with a claude.ai login show in `top` from `claude agents --json` and the transcript.

Next, one session each (details in section 4 of the design):

1. 25b: spike by hand. Record which session headers and which `metadata.user_id` Claude Code 2.1.285 sends through the proxy.
2. 25c: an Anthropic SSE tap, session attribution, and the key hygiene test in the proxy.
3. 25d: the host proxy as a systemd user unit, with a `doctor` check and fix.
4. 25e: an outbox task, so that `claude-glm` points at the host proxy.
5. 25f: the driver interface, with the `opencode` driver around the existing code.
6. 25g: the read side of the Claude drivers, so that `top` shows Claude sessions.

### 12. Step 27: the researcher loads the skill simple-english

Paused on 2026-10-04: it does not serve the runner goal (see Direction).

Task from the supervisor, 2026-10-03 (meta plan, step 9). A new global rule (meta df5ba4a) says that a research report follows ASD-STE100, with the skill `simple-english` in strict mode. That skill is a Claude Code plugin in `~/.claude/plugins/cache/simple-english/simple-english/<version>/`, and the folder changes with each plugin version (2.1.0 and 2.1.1 exist now). opencode in the sandbox loads skills only from `OC_SUB_SHARED_DIR` (`meta/agents/skills/`). Find a fix that survives plugin updates, for example a copy of the newest version at `oc-sub up` or a stable path. Research first: how others give opencode a skill of a Claude Code plugin.

### 13. Step 28: moved to meta step 19

On 2026-10-04 the user widened the graph view of the plans into a generic graph viewer in its own new project (meta plan step 19, name still open). Nothing is built here. The research reports stay here, because step 19 links to them: [plan-graph-tools.md](research/plan-graph-tools.md) and [plan-graph-view.md](research/plan-graph-view.md). The design [plan-graph.md](design/plan-graph.md) also stays.

### 14. Step 29: idle servers stop by themselves, and `top` stops its leak

On 2026-10-04 five sandbox servers ran for up to 1.8 days with no session. `oc-sub top --all` used 7 GB RSS after 2 days in a tmux pane. Root cause of the servers: `up` starts a detached holder that runs until `down`, and `run` never starts a server, so nobody stops one. The user agreed on 2026-10-04 to this fix. It starts after the `down --all` work of the other session is on `alpha`.

1. 29a, research (a Claude research agent, because GLM rests): does `opencode serve` or `sbx` 0.45.1 have an idle timeout that oc-sub can use?
2. 29b: an idle watchdog. If `GET /session/status` shows no busy session for 30 minutes, the server stops through the `down` path.
3. 29c: if the sandbox server of the project is down, `run` starts it.
4. 29d: find the leak of `top --all` with a heap snapshot, fix it, and add a test that memory stays flat over many refreshes.

### 15. Step 30 follow-up: the integration tests leak cost-proxy loops

Step 30 is done (see HISTORY). Its dry run on 2026-10-04 found 3 `sh -c "while :; do bun .../cost-proxy.js ...; done"` loops in deleted `/tmp/oc-sub-it-*` folders, with their parent `/init`. The teardown of `test/integration.test.ts` stops the server, but not the restart loop of the cost proxy. Find the start of the loop, stop its process group in the teardown, and add a test that no process of the test outlives it.

### 16. Step 31: label long-lived processes with systemd user units

Research: [process-labels.md](research/process-labels.md), with the review of the main thread. The user asked on 2026-10-04 that each process knows the reason it runs, so that a forgotten process is easy to find.

1. 31a: a small module starts a command as `systemd-run --user --unit=ocsub-<kind>-<name> --description="owner=<project or session> reason=<why>" --slice=ocsub.slice --collect`. Without a user manager it falls back to the current spawn and sets `OCSUB_OWNER` and `OCSUB_REASON` in the environment.
2. 31b: `up` starts the host server, the cost proxy (with `Restart=on-failure` instead of the `sh` loop), and the holder through it. `down` stops the unit, so the whole tree stops.
3. 31c: the integration tests use the same path with a test owner, and the teardown stops their units (this also closes the follow-up of step 30).
4. 31d: `doctor` lists the `ocsub-*` units with owner and reason, and warns for a unit whose owner is gone. `--fix --force` stops it.

### 17. Step 32: a sandbox for each runner job

Dropped on 2026-10-04 evening (see Direction). The runner keeps running as fix 50 set it up. Spike 32c does not go to the user, and `scripts/spike-32c-root-v2.sh` is not run. 32a and 32b stay as records. The text below is history.

Result of meta step 12f, from the supervisor on 2026-10-04 (arch-helper `alpha` 85e3ffd: `fixes/50-gh-runner.sh`, `lib/gh-runner/`, `docs/gh-runner.md`, `docs/research/self-hosted-runner.md`). The runner uses option (a) now: the Linux user `gh-runner`, rootless Docker, and a just-in-time runner for each job. A root-only token in `/etc/credstore/gh-runner.pat` mints the runners. The global rules come read-only from `/srv/meta-agents`. Option (c) is an idfix sbx sandbox for each job, and it is this step. It waits for a headless sbx login of the user `gh-runner`. Option (c) can close two gaps of (a): Docker images stay between jobs, and jobs have full network access. Fix 50 did not run on the real system yet. arch-helper belongs to the supervisor, so idfix sends it the changes that fix 50 needs.

1. 32a, research (a Claude research agent): a headless sbx login for a second Linux user, the lifecycle of one sandbox for each job, the network policy of sbx, and how the sandbox gets the one Claude Max token for exactly one job and loses it afterwards. User decision 17 (meta plan step 12): the token lives in `/etc/credstore/claude-oauth.token` of the runner and reaches each job as `CLAUDE_CODE_OAUTH_TOKEN`. Done on 2026-10-04: [runner-job-sandbox.md](research/runner-job-sandbox.md). The whole runner process of a job operates in a fresh sbx VM, and `sbx rm --force` removes it. The user `gh-runner` logs in with a Docker PAT through `sbx login --password-stdin`, fed by `LoadCredential=`. The Claude token goes in as `sbx exec -e CLAUDE_CODE_OAUTH_TOKEN`, because the secret proxy of sbx 0.45.1 cannot inject it (issue #601). An injected prompt can still copy the token. Defaults that follow from the goal of a sandbox: the daemon of `gh-runner` starts with `--policy deny-all` and an allow list for each project, the token moves to the proxy when sbx supports it, and no global Anthropic secret or `/login` exists in the store of `gh-runner`. Default until a measurement: one job at a time. The user decided on 2026-10-04 (meta plan 760d063): the existing Docker account of the user owns the PAT.
2. 32b, done on 2026-10-04: [runner-job-sandbox.md](design/runner-job-sandbox.md). idfix gets `idfx job run` and `idfx job prune`. arch-helper keeps the users, units, and credentials. No choice was open for the user.
3. Next: 32c to 32f, as in section 5 of the design. 32c is a spike by hand as the user `gh-runner`. Fix 50 is not applied here, so `scripts/spike-32c-root-v2.sh` (apply, check, undo) adds an sbx daemon for `gh-runner` next to the live runner of fix 50 and logs to `~/.local/state/user-steps/spike-32c.log`. Do not run v1: its undo deletes the user and the files of fix 50. The user runs it with sudo after a review. The script is not tested yet, because the permission check of the session blocked a dry run. After `check`, read `~/.local/state/user-steps/spike-32c.log`, fix the design, and send the final change list for fix 50 to the supervisor.

### 18. Step 33: every research brief ends with the critical-research footer

Task from the supervisor, 2026-10-04. A new global rule and the skill `critical-research` (`meta/agents/skills/critical-research/SKILL.md`) say that every research question ends with a fixed footer, and every report has a section "Critical analysis" with four points. `oc-sub run --agent researcher` appends the footer, read from the skill file in `OC_SUB_SHARED_DIR`, after a line `---`. A brief that already ends with it stays unchanged. A missing skill file stops the run with an error. The researcher prompt asks for the section. A test compares the appended footer with the skill file. Done on 2026-10-04 in 20a6bb3: `src/critical-footer.ts`, 1048 tests pass in the main checkout. Known gap: in a worktree under `.claude/worktrees/`, 9 Ink tests of `top` fail with "Invalid hook call" (two copies of React), and they pass in the main checkout.

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
- Decide from [driver-layer.md](design/driver-layer.md) section 3: whether sessions with a claude.ai login go through the proxy (Remote Control off, terms gray zone) or show in `top` from their transcript (recommended).
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
