# Plan

This file holds only the open work. Finished steps, their root causes, and their details are in [HISTORY.md](HISTORY.md), under the same step numbers. Measured runs and costs are in [EXPERIENCE.md](EXPERIENCE.md). How to use the tool is in [GUIDE.md](GUIDE.md).

## Goal

oc-sub is stable and useful if four things hold. First, a plugin change reaches every running server without manual steps. Second, a sandbox starts after a reboot. Third, every project runs the same tested setup. Fourth, a coder can install the tools that it needs. Everything else is comfort.

## State on 2026-10-01

Everything is on `alpha` and pushed. The `doctor` checks `opencode-version` and `opencode-release` are done, and the global mise configuration pins opencode 1.18.32. The sync writes the `.gitignore` that a read-only sandbox server needs. Step 16c is done: `watch` and `log` read the real cost from the proxy log. Step 15d is done in code: `oc-sub doctor --fix --force` recreates a sandbox that lacks a mount, has no clone, or is not in clone mode. A busy session and work that the host would lose block it, also with `--force`. 823 tests pass. The live test is open, because the permission check of Claude Code blocked the main thread from running the recreate (see the open tasks of the user). Every sandbox created before 15c still lacks the synced plugin mount, so `oc-sub up` fails in it until a recreate.

Sandbox mode in clone mode works, with one run worktree per step inside the clone and the review fetch on the host. A cost proxy runs next to each server. GLM goes to Z.AI, with Parasail and Together as fallbacks. The live view `oc-sub top` works, and `oc-sub doctor --fix` repairs the plugin and the global rule links.

The workflow in this project (clone mode):

1. `oc-sub worktree STEP` creates the run worktree inside the sandbox clone and runs the `setup` command of `.opencode/oc-sub.json`.
2. `oc-sub run --agent coder --dir <root>/.worktrees/STEP --brief <file>` starts the run, and `oc-sub watch` waits.
3. `oc-sub fetch` on the host, review with `git diff alpha...sandbox-oc-sub-opencode-subagents/feature/STEP`, run `mise exec -- bun test` on the host, and squash-merge into `alpha`.
4. `oc-sub worktree rm STEP` removes the worktree inside the clone.

## Next steps, in this order

### 1. Bugs found on 2026-10-01

- Live test of the `.gitignore` fix (commit e2714c5): the synced folder of this project already holds a copied `.gitignore`, so only the tests prove the fix. The recreate of the other sandboxes (open task of the user) is the live test.

### 2. Step 16: DeepInfra as a direct provider, a known difficulty

Step 16 is on `alpha` ([GUIDE.md](GUIDE.md), [DEEPINFRA_KEY_PATH.md](research/DEEPINFRA_KEY_PATH.md)). The user decided on 2026-10-01 to use DeepInfra until a difficulty shows. Two runs on 2026-10-01 stopped on the same DeepInfra error (see [EXPERIENCE.md](EXPERIENCE.md)), so runs went back to OpenRouter. Open:

1. Root cause of the stream error `OpenAIChatCompletionStreamOut ... logprob ... Input should be a valid number`: DeepInfra sends a `null` log probability, its own validation rejects it, and opencode does not retry the error. Find out whether a request option avoids it, whether the cost proxy can retry a request that fails before the first content chunk, and whether DeepInfra knows the bug. Then the user decides whether DeepInfra comes back.
2. The opencode estimate uses the undiscounted models.dev price, so it shows twice the real cost.
3. An existing sandbox gets the network allow rule for `api.deepinfra.com` only together with the first secret set.

### 2b. `oc-sub say` keeps the model of the run (in progress)

Root cause: `run --model` sets the model only on the first message, and `say` sends no model, so a follow-up falls back to the model of the agent file. The fix (worktree `say-model`) reuses the model of the last user message and adds `say --model`. Known gap: a subagent such as `reader` always uses the model of its agent file, so `--model` never reaches it.

### 3. Step 12: a working mise inside the sandbox (in progress)

The coder run is in the worktree `12-sandbox-mise`. Change of the design: `up` installs the version of the host mise (`mise install mise@<host version>`) into the shared installs folder, instead of a `mise` entry in every project `mise.toml`. Follow-up: `oc-sub worktree` runs `mise install` inside the sandbox after the setup, so the tools of the worktree `mise.toml` exist before the agent starts.

Root cause: the sandbox gets the tool folders of the host read-only, but no `mise` binary, so an agent cannot add a tool. On 2026-09-30, a coder in arch-helper needed `pwsh` and tried workarounds for a long time. The research is in [SANDBOX_MISE.md](research/SANDBOX_MISE.md).

1. `mise.toml` lists `mise` itself as a tool, so the binary lands in the mounted installs folder.
2. `up` passes `MISE_SHARED_INSTALL_DIRS=<installs mount>` into the server.
3. `up` writes `trusted_config_paths` for the project root only into the mise configuration of the sandbox.
4. Open: the feature is experimental upstream. Make sure that it works without `MISE_EXPERIMENTAL=1`, or set it. Find out why `/home/toka/.local/share` belongs to root inside the sandbox, and whether `HOME` is `/home/toka` there.
5. Tests for the server environment, and one bullet each in `docs/GUIDE.md` and `skills/oc-sub/reference.md`.

### 4. `oc-sub say` warns on a pending question

If a session waits for an answer to a `question`, `say` only queues its message. The agent sees the message after the question gets an answer. `say` warns and names `oc-sub answer`.

### 5. Step 11d: the cost proxy in `watch` and `log`

The live test of the proxy (log lines, no orphan restart loop after `down`). Step 16c already reads the real cost from the proxy log. Open: `watch` reads the open requests from the proxy log. This also fixes the false stall of step 6 while a model request is open.

### 6. Step 15e: bring every project to the standard

15e: `doctor --renovate` lifts a project to the current standard. Every best practice is a check, and an old setup gets the status `outdated`. `--renovate` includes `--fix` and applies every fix without `--force`, but a busy session or unfetched work still blocks it. First candidates: a host-mode server, a sandbox in direct-mount mode, a project `mise.toml` that pins its own `opencode`, and old agent copies. A missing project key is only reported, because oc-sub never creates OpenRouter keys (decided with the user on 2026-09-30). Research first: how `ng update`, Renovate, and similar tools define a standard, detect drift, and apply migrations.

### 7. Step 17: recurring research

Root cause: a research report records facts with a date, but nothing says when a fact goes stale or which decision rests on it. So a decision stays in force after its facts change, and nobody notices. Only opencode releases have a re-check today: the `doctor` check `opencode-release` and the review record `opencode-review.json`. The other 26 reports in `docs/research/` have no recheck date.

Facts that go stale in this project, with a first guess for the interval:

| Topic | Reports | Decision that rests on it | Trigger or interval |
| --- | --- | --- | --- |
| opencode releases, 2.0 status, the upstream bugs that we work around (SDK SSE abort, issue 28658, the stale v1 SDK gen) | OPENCODE_ROADMAP, SSE_CLIENT, SUBAGENT_QUESTIONS | stay on 1.18.32, the handler in `src/top/app.tsx` | each new release (the existing check), and monthly for 2.0 |
| GLM providers: price, quantization, uptime | OPENROUTER_ROUTING, DEEPINFRA, PROVIDER_PROBE | the provider order, DeepInfra as the default | every two weeks |
| A cheaper or better model than GLM for `researcher` and `coder` | none yet | GLM as the default subagent model | monthly |
| `sbx` releases, and the experimental shared installs of mise | SANDBOX, SANDBOX_MISE | step 12, the clone mode | each new `sbx` release |
| Plugin updates in Claude Code | PLUGIN_UPDATES | the synced plugin folder of 15c | each new Claude Code release |
| Prior art, the lag of the Exa index | PRIOR_ART, WEBSEARCH | build oc-sub instead of an existing tool | quarterly |

Substeps:

1. 17a research, with a GLM researcher, report `docs/research/RECURRING_RESEARCH.md`. How do others keep decisions fresh: review dates in ADRs (architecture decision records), the schedules of Renovate and Dependabot, the refresh of a tech radar, the freshness checks of documentation tools. How does a scheduled job run on this machine when the user is away: a systemd user timer under WSL, cron, a Claude Code routine (`/schedule`, which runs in the cloud and cannot reach this machine), or a reminder only. Criteria: cost per month, no repeated work (lesson: cache expensive work), the result reaches `PLAN.md`, and it works across all projects in `~/dv`. The brief names the criteria and no preferred option (lesson `leading-brief-skews-research.md`).
2. 17b the convention: each report gets a short head with `recheck` (a date, an interval, or a trigger such as a new release) and `decisions` (the plan items that rest on it). The convention is general, so it goes into meta: the global rules and `bin/research-index.py`, which then lists the due reports. The six topics above get their heads first.
3. 17c a `doctor` check `research-due` that warns on an overdue report of the project, the same shape as `opencode-release`. A recheck that finds no change records the date, like `opencode-review.json`.
4. 17d the scheduled runner: it starts one researcher run per due report, appends a section "Recheck <date>" with only the changes, and adds a line to the open tasks of the user if a decision is affected. Only after 17a and a decision of the user.

Cost estimate: one research run cost 0.058 USD ([EXPERIENCE.md](EXPERIENCE.md)). Ten rechecks a month cost about 0.60 USD, with a cap per run.

Decision of the user before 17d: whether unattended paid runs are allowed, and the cap per month. Until then, 17c only warns, and the main thread starts the recheck.

### 8. Step 18: learn from the traces of cheap agents

The user decided on 2026-10-01 to build a pipeline over the stored opencode sessions and to use Jev for it. The research is in [TRACE_ANALYSIS.md](research/TRACE_ANALYSIS.md). Stage one is a script without a model: it cuts a session into steps and marks cheap signals. Stage two is Jev: it tags each step from a fixed list with typed questions. Stage three is a cheap GLM agent: it groups the tags over many runs and names changes to briefs, prompts, and tools. Open first: a probe of one or two requests through OpenRouter, to find out whether `~typesafe/jev-latest` accepts requests and keeps the typed question format (the public list shows only `typesafe/jev-router`). The direct Jev API costs $0.042 per million input tokens, but it needs its own key, and a limit per project is not documented.

### Later

- Known gap of 15d: the fix text of `sandbox-mounts` still names `sbx rm --force NAME` and `oc-sub up` by hand instead of `oc-sub doctor --fix --force`.

- Step 11, rest: the detectors of step 6 give the provider of a flagged run a strike. After two or three strikes, the provider goes onto the OpenRouter `ignore` list for some days.
- Step 8h: `oc-sub status --json`.
- Step 8g gaps. A new worktree shows in the live view only after `a` twice. The footer lacks the day totals and the key usage per project. The `o` command finds only runs of `oc-sub run`. Below about 110 columns, the title is cut.
- Step 7: agent files without a body, so GLM keeps the default system prompt of opencode. A first A/B test found no difference. Details in [HISTORY.md](HISTORY.md#step-7-agent-files-keep-the-default-system-prompt).
- Step 10 follow-up: put a faster provider (Parasail or Together) first. This is a decision of the user.
- Known gap of 10c: meaningless plain ASCII text under 20,000 characters passes the probe evaluator.
- The Exa index lags behind. The researcher must make sure that a version is current with `reader` on the source page.

## Open tasks of the user

- Make the access to `/dev/kvm` permanent. Today it has mode 0666 only because of `oc-sub doctor --fix-as-root` (`sudo chmod 0666 /dev/kvm`). On 2026-09-30 the device was recreated with mode 660 and the unknown group ID 109, and every sandbox start failed. After the next WSL restart this can happen again. The structural fix is a udev rule or a boot step that sets the group `kvm` and the mode. The main thread can research the right way under WSL first.
- Recreate every sandbox once with step 15d, because since step 15c each needs the synced plugin mount. In each project, run `oc-sub doctor --fix --force`. This ends the sessions of that sandbox, and it refuses while a session is busy or while the clone holds work that the host would lose. Start with this project: it is the live test of 15d, and it also restarts the old sandbox server. Then arch-helper, grata, and meta. Until then, an agent in the old sandboxes of arch-helper, grata, and meta reaches the whole repository and its `.git`, because they are not in clone mode. The main thread cannot run the recreate itself: the auto mode classifier of Claude Code denied it as interference with workloads. To let the main thread do it, allow `oc-sub doctor --fix --force` in the permission rules.
- Decide from [DEPLOY_ACCESS.md](research/DEPLOY_ACCESS.md) section 8: whether Tailscale runs on the servers, and how long a debugging window lasts.
- Optional: report the unhandled `AbortError` of the SSE client of `@opencode-ai/sdk` 1.18.32 upstream (lesson `opencode-sdk-sse-abort-unhandled.md` in meta). Then the handler in `src/top/app.tsx` can go.

## Default decisions, open for a change by the user

- The update command is a flag of `doctor` and not a new `update` command, because the fixes belong to the checks.
- Every fix that can end a session or lose a local change needs `--force`. Only `--renovate` applies them without it.
- oc-sub stays on opencode 1.18.32. The latest release 1.18.33 fixes none of our issues, and 2.0 is a beta with a new server API ([OPENCODE_ROADMAP.md](research/OPENCODE_ROADMAP.md)).
