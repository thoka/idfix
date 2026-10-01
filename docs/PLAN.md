# Plan

This file holds only the open work. Finished steps, their root causes, and their details are in [HISTORY.md](HISTORY.md), under the same step numbers. Measured runs and costs are in [EXPERIENCE.md](EXPERIENCE.md). How to use the tool is in [GUIDE.md](GUIDE.md).

## Goal

oc-sub is stable and useful if four things hold. First, a plugin change reaches every running server without manual steps. Second, a sandbox starts after a reboot. Third, every project runs the same tested setup. Fourth, a coder can install the tools that it needs. Everything else is comfort.

## State on 2026-10-01, evening

The work of this session is on the branch `worktree-complete-plan`, pushed to GitHub, but not yet on `alpha`. The Claude Code guard of the session blocked every git command in the main checkout, where `alpha` is checked out, so the main thread could not move `alpha`. Steps 2b, 3, 4, 5 (11d), 8h, 15e, 16d, 17b (project part), 17c, 18a, and 18b are done in code, with tests (974 pass on the host). The research reports of steps 15e, 16, 17a, 18, 2b, and the KVM task are written. Details are in [HISTORY.md](HISTORY.md).

The sandbox of this project is in clone mode with all mounts, so its 15d recreate is done. The workflow in this project is unchanged (clone mode):

1. `oc-sub worktree STEP` creates the run worktree inside the sandbox clone, runs `mise install` with the sandbox mise, and runs the `setup` command of `.opencode/oc-sub.json`.
2. `oc-sub run --agent coder --dir <root>/.worktrees/STEP --brief <file>` starts the run, and `oc-sub watch` waits.
3. `oc-sub fetch` on the host, review with `git diff alpha...sandbox-oc-sub-opencode-subagents/feature/STEP`, run `mise exec -- bun test` and `mise exec -- bun run typecheck` on the host, and squash-merge into `alpha`.
4. `oc-sub worktree rm STEP` removes the worktree inside the clone.

## Next steps, in this order

### 1. Bring the branch onto `alpha`, then the live tests

First the user (or a session without the guard) moves `alpha`: in the main checkout, `git merge --ff-only worktree-complete-plan`, then `git push`. Then `oc-sub doctor --fix` updates the plugin and restarts the idle server. Then the live tests:

- 2b: a research run with `--model deepinfra/zai-org/GLM-5.3-Flash`. The proxy log must show the `reader` requests at DeepInfra, not at OpenRouter.
- 3: `oc-sub worktree X` prints `setup: bun install ...` after a `mise install`, and the sandbox mise prints no self-update warning.
- 16d: after `oc-sub restart`, the server log starts with a `--- oc-sub up ... ---` marker and keeps the older lines.
- 5 (11d): `watch` stays quiet during a long model request, and `oc-sub down` leaves no orphan proxy restart loop.
- 17c: `oc-sub doctor` in the main checkout lists the six trigger heads under `research-due`.

### 2. Step 16: DeepInfra, a decision of the user

[DEEPINFRA_LOGPROB.md](research/DEEPINFRA_LOGPROB.md) answers the root cause question. DeepInfra has no public report of the error. The client never asks for log probabilities, so no request option avoids it. opencode 1.18.32 does not retry the error (opencode issue #21893). The options are in its table. A proxy retry before the first content chunk (option D) is safe, but only if the bad chunk comes before any content. The append-mode logs of step 16d now keep the data that answers this. The user decides whether DeepInfra comes back and whether to report the bug to DeepInfra (option B needs the DeepInfra account). Open gaps: the opencode estimate shows twice the real DeepInfra cost, and an existing sandbox gets the network allow rule for `api.deepinfra.com` only with the first secret set.

### 3. Step 17: recurring research, the rest

- 17b in meta: the convention (front matter `checked`, `recheck`, `decisions`, see the GUIDE section "Recheck heads of research reports") goes into the global rules, and `bin/research-index.py` must skip the front matter (today it shows it as the summary) and list the due reports. This needs a session in meta, because the guard of this session blocks git there.
- 17d, after a decision of the user: whether unattended paid rechecks are allowed, and the cap per month. [RECURRING_RESEARCH.md](research/RECURRING_RESEARCH.md) found that only the Windows Task Scheduler can start a stopped WSL2, and only while the user is logged in. Until then, `research-due` only warns.

### 4. Step 18: the trace pipeline, stage three and quality

Stage one (`oc-sub trace`) and stage two (`oc-sub trace --tag`, Jev through the OpenRouter decisions endpoint, about $0.00003 per step) work. Open:

1. Question version 2: give each step the result of the previous tool call as evidence, because a per-step judge calls a claim ungrounded when its evidence is in the step before (live test of 18b).
2. Quality measurement: hand labels for 3 to 5 known runs, then precision and recall per tag ([TRACE_ANALYSIS.md](research/TRACE_ANALYSIS.md), "Quality measurement").
3. Stage three: a GLM agent groups the tags over many runs and names changes to briefs, prompts, and tools.
4. Small gaps: a `fetch` that throws ends the whole tagging; a chunked `read` of one file counts as a reread.

### 5. Step 15e follow-ups

`doctor --renovate` exists. Not yet covered: a project that still runs a host-mode server, and old setups that no check detects yet. Each new best practice becomes a check with a fix.

### Later

- Log rotation: the server and proxy logs grow without limit since step 16d.
- `oc-sub say --file FILE`: a message from a file. The guard of Claude Code refuses a `say` text that names git commands.
- `printLogTail` exists twice, in `src/up.ts` and `src/sandbox.ts`.
- Step 11, rest: the detectors of step 6 give the provider of a flagged run a strike. After two or three strikes, the provider goes onto the OpenRouter `ignore` list for some days.
- Step 8g gaps. A new worktree shows in the live view only after `a` twice. The footer lacks the day totals and the key usage per project. The `o` command finds only runs of `oc-sub run`. Below about 110 columns, the title is cut.
- Step 7: agent files without a body, so GLM keeps the default system prompt of opencode. A first A/B test found no difference. Details in [HISTORY.md](HISTORY.md#step-7-agent-files-keep-the-default-system-prompt).
- Step 10 follow-up: put a faster provider (Parasail or Together) first. This is a decision of the user.
- Known gap of 10c: meaningless plain ASCII text under 20,000 characters passes the probe evaluator.
- The Exa index lags behind. The researcher must make sure that a version is current with `reader` on the source page.

## Open tasks of the user

- Move `alpha` to the branch `worktree-complete-plan` (see step 1), and commit and push meta: four new lessons are in `~/dv/meta/agents/lessons/` (`bun-test-skips-type-check.md`, `log-read-for-accounting-must-append.md`, `clean-tree-check-per-target-file.md`, `per-step-judge-misses-earlier-evidence.md`). Then run `mise run index` in meta.
- Make the access to `/dev/kvm` permanent. [WSL_KVM_ACCESS.md](research/WSL_KVM_ACCESS.md), section 7: the `kvm` group exists here with gid 990, and the udev rule of this distro already sets mode 0666. So the state of 2026-09-30 (gid 109, mode 0660) likely came from another WSL distro that shares the device node. Run `wsl.exe -l -v` on Windows and name the distros that run. The guard of this session blocked that command.
- Recreate the sandboxes of arch-helper, grata, and meta with `oc-sub doctor --fix --force` in each project (this project is done). Until then, an agent in those old sandboxes reaches the whole repository and its `.git`.
- Decide on DeepInfra (step 2) and on unattended rechecks (step 3, 17d).
- Decide from [DEPLOY_ACCESS.md](research/DEPLOY_ACCESS.md) section 8: whether Tailscale runs on the servers, and how long a debugging window lasts.
- Optional: report the unhandled `AbortError` of the SSE client of `@opencode-ai/sdk` 1.18.32 upstream (lesson `opencode-sdk-sse-abort-unhandled.md` in meta). Then the handler in `src/top/app.tsx` can go.

## Default decisions, open for a change by the user

- The update command is a flag of `doctor` and not a new `update` command, because the fixes belong to the checks.
- Every fix that can end a session or lose a local change needs `--force`. Only `--renovate` applies them without it.
- `doctor --renovate` and `--fix` change a project file only when git tracks it and it has no local change. A pin in the global mise configuration of the user stays a manual step.
- The `reader` subagent has no model of its own, so it uses the model of the run.
- Stage two of the trace pipeline pins `typesafe/jev-1.13` and uses the project OpenRouter key, with a cap of 200 steps per call.
- oc-sub stays on opencode 1.18.32. The latest release 1.18.33 fixes none of our issues, and 2.0 is a beta with a new server API ([OPENCODE_ROADMAP.md](research/OPENCODE_ROADMAP.md)).
