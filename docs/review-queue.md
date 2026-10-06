# Review queue

Decisions that a session made from the canon of values. Newest entry first.

## 2026-10-06: step 29d, where `top` sets NODE_ENV

- Decision: `top` sets `NODE_ENV=production` in code, in `loadView` directly before the dynamic import of the view, and not in the start scripts in `bin/`. A value that the user set stays. So every way to start `top` (the start script, `bun src/cli.ts`, a test) gets the production build of React, and the `--once` path still loads no React.
- Values: fix the structure (the root cause is the build choice of React, measured). Deliver first (one function, no new dependency).
- Conditions: React picks its build from `process.env.NODE_ENV` at its first import, and bun 1.4.2 does not inline the value at run time. If a bundled or compiled `idfx` binary comes, the bundler must set `NODE_ENV` instead.

## 2026-10-06: step 36, the check of the naming rule

- Decision: idfix starts no Claude worker itself, so step 36 checks the rule instead of a start path. `SessionUnnamed` turns True with reason `NameOffRule` for a live session whose name is neither its project (`projectNameOfRun` of its folder) nor `<project>-<step>`. The name `supervisor` is valid in every folder. The message names the expected form. A True condition that changes its reason from `NoName` to `NameOffRule` gives no new event, the same as every condition that stays True. The event stays in the log and gives no notice. The fixture session `bg-worker` in folder `w2` now shows the condition in `status --json`.
- Values: a rule needs a check (meta plan step 26 names this report as its check). Deliver first (one pure function, no new condition type).
- Conditions: the naming rule of meta plan step 26 and the session name `supervisor` of `~/dv/AGENTS.md`. If the rule allows other forms, for example a `glm-` prefix, this is open again.

## 2026-10-06: step 38, the condition `SessionHandedOff`

- Decision: `SessionHandedOff` is a one-shot condition. Each new commit of `docs/PLAN.md` after a clean `handover check` at an edge from `busy` or `waiting` to `idle` or `ended` gives one True event (INFO 9, `dv.idfx.session.handed-off`, reason `HandoverCheckPassed`, `data.planCommit`). It never gives a False event, also not when the session leaves the source, because the fact "this commit was handed off" does not end; a False event at the next turn would only add noise for Severin. The record stays in the state as the memory of the last commit, also for a gone session, and the restore reads `data.planCommit` from the log. It is not an open condition: the heartbeat `open` count and `status --json` leave it out. Exit code 1 at an `idle` edge writes no `HandoverFailed`, because a session at its prompt in the middle of a step is normal; `HandoverFailed` keeps its edge to `ended`. One `handover check` per session and poll serves both conditions. A session seen first after a start has the edge when it rests and was active after the watermark, the same rule as `HandoverFailed`. The `git log` call runs without the variables of `git rev-parse --local-env-vars`.
- Values: one state in one place (the memory lives in the event log). Deliver first (no new state file). Fix the structure (a computed signal, not a guess).
- Conditions: Severin reads True events by `sequence` and needs no False event. If Severin needs "the session is at a clean hand-off now" as a state, the False edge at the next `busy` is open again.

## 2026-10-06: step 37, the reasons of `SessionWaitsForUser` follow protocol v0

- Decision: `SessionWaitsForUser` has the reason `auth_required` when its waiting text asks for a login or a key, and else `input_required`. No `waitingFor` value of Claude Code 2.1.285 means a login (research `claude-session-sources.md`, section 2), so the watcher matches phrases (`401`, `/login`, `not logged in`, `login required`, `authentication failed`, an invalid or expired key or token). A bare word `login` does not count, so a dialog for `src/login.ts` stays `input_required`. The kind of wait goes into `message` (`<kind>, waits for the user since <n> min`), and the wake-up notice shows the kind. The event type of the condition changes from `dv.idfx.session.waits-for-user` to `dv.idfx.session.waiting`, the type of the protocol report; the restore reads `data.condition`, so old logs still restore. The reasons of `ApiError` stay, because the protocol report names no values for them. The test schema of `status --json` now also allows a snake_case reason.
- Values: use the standard (MCP tasks and A2A words). Deliver first (text match instead of a new source).
- Conditions: protocol v0 and the `waitingFor` values of Claude Code 2.1.285. If Claude Code gets a fixed text for a login, or protocol v1 changes the reasons or the type, this is open again.

## 2026-10-06: open points of W3

- Decision: a doctor check with `error` counts as `warn` at the top level, as the health-check draft defines `warn`. A doctor that cannot run exits with 2 and prints nothing on stdout. The version is the short git sha until `package.json` gets a version from release-please (meta plan step 16c).
- Values: use the standard (the health-check draft). Deliver first.
- Conditions: protocol version 0. If the Gemini check or the meta conformance test asks for a JSON object on exit 2, this is open again.

## 2026-10-06: technical choices of W2 of `idfx watch --all`

- Decision: the watcher calls `notify-session --name supervisor -- none "<text>"`, because `notify-session` needs a session ID first, and `none` matches no session, so the name decides. A failed notice is dropped after a warning, because the log holds its events and a retry would pile up while no supervisor runs. The notice ends with the path of the log. The unit file sets `PATH` (`~/.local/bin`, `~/dv/meta/dv/bin`, the mise shims, `/usr/local/bin`, `/usr/bin`), because a user service gets only `/usr/local/bin:/usr/bin` and would find neither `notify-session` nor `handover`. A `waitingFor` text outside the four fixed texts counts as the title of a permission dialog (`PermissionDialog`), because the research names no other values. Note 2026-10-06 (step 37): the reasons `PermissionDialog`, `InputNeeded`, `DialogOpen`, `SandboxRequest`, `WorkerRequest`, `JobBlocked`, and `Other` are gone. The reason is now `input_required` or `auth_required` (tool protocol v0), and the kind of wait moved into `message`. The `watch-running` check is a slow check (only `doctor` runs it).
- Values: one state in one place (the log is the record, the notice only wakes). Use the platform (systemd). Deliver first.
- Conditions: the CLI of `notify-session` in meta, and the `waitingFor` values of Claude Code 2.1.285. If `notify-session` gets a name-only form, or Claude Code adds a new fixed text, the choice is open again.

## 2026-10-06: technical choices of W1 of `idfx watch --all`

- Decision: the lock is a file `events.lock`, created with `O_EXCL`, that holds the PID and the process start time (field 22 of `/proc/<pid>/stat`). A lock whose process is gone, or whose PID now belongs to another process, is stale, and the next watcher removes it. This replaces the `flock` of the design. Bun has no `flock` call without FFI, and `proper-lockfile` decides staleness by an age of the file, so it needs a refresh timer and a guess of the age. The start-time check is the same check that idfix already uses for the session files of Claude Code. The state of the conditions is keyed by condition and full session ID, not by subject, so two sessions with the same name stay apart. A new API error line counts by the line count between two polls. At the first sight of a session (after a start or a restart), an error line counts only when it is newer than the last event in the log. The same rule finds a session that ended while the watcher was down, so `handover check` runs for it. Without a log, the first poll only takes a baseline for these two conditions.
- Values: use established tools, but do not add a dependency for 60 lines. One state in one place (the log). Deliver first.
- Conditions: Linux `/proc`. On another system, or if Bun gets `flock`, the lock choice is open again.

## 2026-10-06: technical defaults of the design of `idfx watch --all`

- Decision: the watcher polls every 15 seconds and watches Claude sessions only. `idfx watch SESSION` keeps its old meaning, and `--all` starts the watcher. The event file is the only state of the watcher. It wakes the supervisor at most once per 60 seconds. `status --json` and `doctor --json` change to the object form of the protocol, because no code outside idfix reads the old arrays. idfix ships the systemd unit file, and arch-helper installs it. A sixth condition `SessionUnnamed` reports a session without a name. The design is [idfx-watch.md](design/idfx-watch.md).
- Values: one state in one place. Use the platform (systemd, CloudEvents). Deliver first. A rule needs a check (the user decision on worker names).
- Conditions: the protocol version 0 of `~/dv/meta/docs/research/tool-protocol.md`. If the Gemini check changes it, the envelope changes.

## 2026-10-06: open points of step 25g.1

- Decision: `waitingFor` keeps the full `needs` text, also a URL of a key management page. It holds no key, and it is the text that Claude Code shows the user. `claude-glm` sessions stay without a price until the GLM features come back, then an `openrouter/` prefix lookup in LiteLLM can price them. A blocked background job shows as `waiting` until `claude rm`, as in `claude agents`, because it is work that waits for a decision. A session with one unknown model gets no price, not a partial sum.
- Values: one state in one place (the same list as `claude agents`). Deliver first. Secrets stay protected (no key reaches the output).
- Conditions: Claude Code 2.1.285. If old blocked jobs fill the list, an age rule is open again.

## 2026-10-06: technical defaults of the design of step 25g

- Decision: idfix reads the Claude Code files only and does not run `claude agents --json`. Prices and model windows come from the cached LiteLLM price file, at most one download per 24 hours. An ended Claude session gets a new row state `ended`. The `ctx` cell shows the size and the share of the window, for example `123k 62%`. The design is [claude-sessions-top.md](design/claude-sessions-top.md).
- Values: use the platform and established data before own tables (LiteLLM, as ccusage does). Cache expensive work. Deliver first: no proxy and no hooks for this slice.
- Conditions: Claude Code 2.1.285 file formats. If `claude agents --json` gives data that the files lack, or if the LiteLLM file goes away, the decision is open again.

## 2026-10-04: step 23 is paused, step 32 is dropped

- Decision: step 32 (an sbx sandbox for each runner job, spike 32c) is dropped. Step 23 (Claude Code subagents inside the sbx sandbox) is paused, and Claude subagents run on the host in worktrees. The read side of step 23 moves to step 25g. The key hygiene of the proxy (driver-layer design, section 2.5) stays, because it protects keys.
- Values: our agents cooperate, and no protection work happens without a feature goal (meta 384ff44). Secrets and keys stay protected.
- Conditions: the rule of meta 384ff44. If the user wants isolation again, for example for jobs of other people on the runner, the decision is open again.
