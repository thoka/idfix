# Plan

This file holds only the open work. Finished steps, their root causes, and their details are in [HISTORY.md](HISTORY.md), under the same step numbers. Measured runs and costs are in [EXPERIENCE.md](EXPERIENCE.md). How to use the tool is in [GUIDE.md](GUIDE.md).

## Goal

oc-sub is stable and useful if four things hold. First, a plugin change reaches every running server without manual steps. Second, a sandbox starts after a reboot. Third, every project runs the same tested setup. Fourth, a coder can install the tools that it needs. Everything else is comfort.

## State on 2026-10-01

Everything is on `alpha` and pushed. The `doctor` checks `opencode-version` and `opencode-release` are done, and the global mise configuration pins opencode 1.18.32. The sync writes the `.gitignore` that a read-only sandbox server needs. A DeepInfra probe is running (step 2). Step 15d is done in code: `oc-sub doctor --fix --force` recreates a sandbox that lacks a mount, has no clone, or is not in clone mode. A busy session and work that the host would lose block it, also with `--force`. 753 tests pass. The live test is open, because the permission check of Claude Code blocked the main thread from running the recreate (see the open tasks of the user). Every sandbox created before 15c still lacks the synced plugin mount, so `oc-sub up` fails in it until a recreate.

Sandbox mode in clone mode works, with one run worktree per step inside the clone and the review fetch on the host. A cost proxy runs next to each server. GLM goes to Z.AI, with Parasail and Together as fallbacks. The live view `oc-sub top` works, and `oc-sub doctor --fix` repairs the plugin and the global rule links.

The workflow in this project (clone mode):

1. `oc-sub worktree STEP` creates the run worktree inside the sandbox clone and runs the `setup` command of `.opencode/oc-sub.json`.
2. `oc-sub run --agent coder --dir <root>/.worktrees/STEP --brief <file>` starts the run, and `oc-sub watch` waits.
3. `oc-sub fetch` on the host, review with `git diff alpha...sandbox-oc-sub-opencode-subagents/feature/STEP`, run `mise exec -- bun test` on the host, and squash-merge into `alpha`.
4. `oc-sub worktree rm STEP` removes the worktree inside the clone.

## Next steps, in this order

### 1. Bugs found on 2026-10-01

- Live test of the `.gitignore` fix (commit e2714c5): the synced folder of this project already holds a copied `.gitignore`, so only the tests prove the fix. The recreate of the other sandboxes (open task of the user) is the live test.

### 2. Step 16: DeepInfra as a direct provider, live test

Step 16 is on `alpha`: `up` registers the key from `~/.config/<project>/deepinfra.key` as an `sbx` custom secret for `api.deepinfra.com`, the sandbox sees only a placeholder, and the cost proxy logs `usage.estimated_cost` with `"upstream":"deepinfra"` ([GUIDE.md](GUIDE.md), [DEEPINFRA_KEY_PATH.md](research/DEEPINFRA_KEY_PATH.md)). The first live coder run passed review (see [EXPERIENCE.md](EXPERIENCE.md)). Open:

1. One or two longer coder runs on DeepInfra, because the fp4 incident happened in long runs. Then the user decides whether DeepInfra becomes the default.
2. `watch` and `log` show a real cost of $0 for a DeepInfra run, because they read the OpenRouter key usage. They must sum the proxy log instead (this joins step 11d).
3. The opencode estimate uses the undiscounted models.dev price, so it shows twice the real cost.
4. An existing sandbox gets the network allow rule for `api.deepinfra.com` only together with the first secret set.

### 3. Step 12: a working mise inside the sandbox

Root cause: the sandbox gets the tool folders of the host read-only, but no `mise` binary, so an agent cannot add a tool. On 2026-09-30, a coder in arch-helper needed `pwsh` and tried workarounds for a long time. The research is in [SANDBOX_MISE.md](research/SANDBOX_MISE.md).

1. `mise.toml` lists `mise` itself as a tool, so the binary lands in the mounted installs folder.
2. `up` passes `MISE_SHARED_INSTALL_DIRS=<installs mount>` into the server.
3. `up` writes `trusted_config_paths` for the project root only into the mise configuration of the sandbox.
4. Open: the feature is experimental upstream. Make sure that it works without `MISE_EXPERIMENTAL=1`, or set it. Find out why `/home/toka/.local/share` belongs to root inside the sandbox, and whether `HOME` is `/home/toka` there.
5. Tests for the server environment, and one bullet each in `docs/GUIDE.md` and `skills/oc-sub/reference.md`.

### 4. `oc-sub say` warns on a pending question

If a session waits for an answer to a `question`, `say` only queues its message. The agent sees the message after the question gets an answer. `say` warns and names `oc-sub answer`.

### 5. Step 11d: the cost proxy in `watch` and `log`

The live test of the proxy (log lines, no orphan restart loop after `down`). Then `watch` and `log` read the real cost and the open requests from the proxy log. This also fixes the false stall of step 6 while a model request is open.

### 6. Step 15e: bring every project to the standard

15e: `doctor --renovate` lifts a project to the current standard. Every best practice is a check, and an old setup gets the status `outdated`. `--renovate` includes `--fix` and applies every fix without `--force`, but a busy session or unfetched work still blocks it. First candidates: a host-mode server, a sandbox in direct-mount mode, a project `mise.toml` that pins its own `opencode`, and old agent copies. A missing project key is only reported, because oc-sub never creates OpenRouter keys (decided with the user on 2026-09-30). Research first: how `ng update`, Renovate, and similar tools define a standard, detect drift, and apply migrations.

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
