# Plan

This file holds only the open work. Finished steps, their root causes, and their details are in [HISTORY.md](HISTORY.md), under the same step numbers. Measured runs and costs are in [EXPERIENCE.md](EXPERIENCE.md). How to use the tool is in [GUIDE.md](GUIDE.md).

## Goal

oc-sub is stable and useful if four things hold. First, a plugin change reaches every running server without manual steps. Second, a sandbox starts after a reboot. Third, every project runs the same tested setup. Fourth, a coder can install the tools that it needs. Everything else is comfort.

## State on 2026-10-01

Everything is on `alpha` and pushed. No run is active. `oc-sub doctor` passes all 9 checks in this project, after `oc-sub doctor --fix` updated the installed plugin to `7661ae0`.

Sandbox mode in clone mode works, with one run worktree per step inside the clone and the review fetch on the host. A cost proxy runs next to each server. GLM goes to Z.AI, with Parasail and Together as fallbacks. The live view `oc-sub top` works, and `oc-sub doctor --fix` repairs the plugin and the global rule links.

The workflow in this project (clone mode):

1. `oc-sub worktree STEP` creates the run worktree inside the sandbox clone and runs the `setup` command of `.opencode/oc-sub.json`.
2. `oc-sub run --agent coder --dir <root>/.worktrees/STEP --brief <file>` starts the run, and `oc-sub watch` waits.
3. `oc-sub fetch` on the host, review with `git diff alpha...sandbox-oc-sub-opencode-subagents/feature/STEP`, run `mise exec -- bun test` on the host, and squash-merge into `alpha`.
4. `oc-sub worktree rm STEP` removes the worktree inside the clone.

## Next steps, in this order

### 1. Step 15c: plugin changes reach the servers

Root cause: a server takes its plugin folder from the `oc-sub` that started it. If that folder is out of date, nothing notices. In this project it is worse, because clone mode leaves the plugin mount out. The sandbox then runs the committed copy of `opencode/` in its clone. So a plugin change needs a fast-forward of the clone `alpha` before the restart.

- `up` and `doctor --fix` sync the `opencode/` folder of the current plugin into one fixed real folder, for example `~/.local/share/oc-sub/opencode/`. The sync removes files that the plugin dropped. It replaces content in place and never renames the folder away, because the mount holds the folder itself. `rsync` is not installed, so use `node:fs` (`cpSync` plus a removal of stale entries) or an established npm library.
- The server and the sandbox mount use that folder. A test with `sbx` 0.45.1 on 2026-09-30 showed that new content in a real folder appears inside at once, also after `sbx stop`. A symlink as a mount source is resolved only once, at create time.
- The state files record the plugin folder of each server. A new check reports a stale server. If the server is idle, the fix restarts it.
- The plan for the review is in the review section of [DOCTOR_FIX.md](research/DOCTOR_FIX.md).

### 2. A check for the opencode version of each project

Nine projects in `~/dv` pin `opencode = "latest"` in their `mise.toml`. Their sandbox server thus runs another opencode than the tested 1.18.32, and no check reports it. A new `doctor` check warns. Its fix comes with 15e.

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

### 6. Steps 15d and 15e: bring every project to the standard

- 15d: `doctor --fix --force` recreates a sandbox that is not in clone mode or lacks a mount. A busy session or unfetched `feature/*` commits in the clone always block it. It runs `sbx rm --force NAME` and `oc-sub up`.
- 15e: `doctor --renovate` lifts a project to the current standard. Every best practice is a check, and an old setup gets the status `outdated`. `--renovate` includes `--fix` and applies every fix without `--force`, but a busy session or unfetched work still blocks it. First candidates: a host-mode server, a sandbox in direct-mount mode, a project `mise.toml` that pins its own `opencode`, and old agent copies. A missing project key is only reported, because oc-sub never creates OpenRouter keys (decided with the user on 2026-09-30). Research first: how `ng update`, Renovate, and similar tools define a standard, detect drift, and apply migrations.

### Later

- Step 11, rest: the detectors of step 6 give the provider of a flagged run a strike. After two or three strikes, the provider goes onto the OpenRouter `ignore` list for some days.
- Step 8h: `oc-sub status --json`.
- Step 8g gaps. A new worktree shows in the live view only after `a` twice. The footer lacks the day totals and the key usage per project. The `o` command finds only runs of `oc-sub run`. Below about 110 columns, the title is cut.
- Step 7: agent files without a body, so GLM keeps the default system prompt of opencode. A first A/B test found no difference. Details in [HISTORY.md](HISTORY.md#step-7-agent-files-keep-the-default-system-prompt).
- Step 10 follow-up: put a faster provider (Parasail or Together) first. This is a decision of the user.
- Known gap of 10c: meaningless plain ASCII text under 20,000 characters passes the probe evaluator.
- The Exa index lags behind. The researcher must make sure that a version is current with `reader` on the source page.

## Open tasks of the user

- Make the access to `/dev/kvm` permanent. Today it has mode 0666 only because of `oc-sub doctor --fix-as-root` (`sudo chmod 0666 /dev/kvm`). On 2026-09-30 the device was recreated with mode 660 and the unknown group ID 109, and every sandbox start failed. After the next WSL restart this can happen again. The structural fix is a udev rule or a boot step that sets the group `kvm` and the mode. The main thread can research the right way under WSL first.
- If no session runs in arch-helper, grata, or meta, recreate its sandbox in clone mode: `sbx rm --force oc-sub-<project>`, then `oc-sub up` in the project. This ends their sessions. Until then, an agent in those sandboxes reaches the whole repository and its `.git`.
- Decide from [DEPLOY_ACCESS.md](research/DEPLOY_ACCESS.md) section 8: whether Tailscale runs on the servers, and how long a debugging window lasts.
- Optional: report the unhandled `AbortError` of the SSE client of `@opencode-ai/sdk` 1.18.32 upstream (lesson `opencode-sdk-sse-abort-unhandled.md` in meta). Then the handler in `src/top/app.tsx` can go.

## Default decisions, open for a change by the user

- The update command is a flag of `doctor` and not a new `update` command, because the fixes belong to the checks.
- Every fix that can end a session or lose a local change needs `--force`. Only `--renovate` applies them without it.
- oc-sub stays on opencode 1.18.32. The latest release 1.18.33 fixes none of our issues, and 2.0 is a beta with a new server API ([OPENCODE_ROADMAP.md](research/OPENCODE_ROADMAP.md)).
