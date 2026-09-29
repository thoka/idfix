# `oc-sub top`: what it needs from Ink and from the opencode server

Research for step 8 of [PLAN.md](../PLAN.md). Written 2026-09-29, against opencode/SDK 1.18.32, bun 1.4.2 (`mise.toml`). Facts carry sources; guesses are marked.

## 1. Ink under bun

**Version.** Latest Ink is **7.1.1** (2026-07-16). It requires React `>=19.3.0` as a peer dependency and Node `>=22` (ink master `package.json`, GitHub releases API for vadimdemedes/ink). The project runs bun 1.4.2.

**Known bun problems.** Three closed issues mention bun in the title (GitHub issue search):

- #696 "Compatibility issue with Bun 1.2" (closed, completed): `TypeError: stdin.ref is not a function` inside Ink's `handleSetRawMode`; worked again on Bun 1.1.45. This is the raw-mode/`useInput` path.
- #864 "Cursor disappears when running Ink CLI with Bun on macOS" (closed 2026-04-23, **not planned** — so not fixed in Ink).
- #636 "Bun support" (closed, not planned).

No release note from v4.2.0 to v7.1.1 mentions bun. So: bun is not officially supported or tested by Ink, the raw-mode bug was fixed, and a macOS cursor issue is open by policy. **Nothing here proves Ink 7.1.1 breaks on bun 1.4.2, and nothing proves it works. A smoke test (a `useInput` counter in the alternate screen, run with `bun run`) is the first implementation step.** opencode's own TUI runs under bun but uses `@opentui/*` + solid-js, not Ink (opencode `packages/tui/package.json`, tag v1.18.32), so it is no proof either way.

**Packages for table + selected row + detail pane.**

- `ink-table` 3.1.0, last published 2023-12-06 (npm registry packument). Stale, peers `ink >=3`, and it has no row selection. Not suitable for the main view.
- `ink-select-input` 6.2.0, published 2025-04-29, by the Ink author (npm registry). It is a selectable list, not a table; peers `ink >=5`, `react >=18` satisfy Ink 7/React 19.3 on paper. Untested with Ink 7 — open question.
- `ink-spinner` 5.0.0 (npm registry) for a busy indicator, same author as Ink.

Guess/recommendation: the table is small (one line per session, fixed columns), so render rows as plain `Box`es and handle selection with `useInput` + a highlight — this is what most Ink dashboards do, avoids a stale dependency, and keeps the detail pane free. Take `ink-select-input` only if a list-style picker is wanted later.

## 2. Full-screen handling in Ink

All of it is built into Ink 7; no extra packages needed.

- **Alternate screen buffer:** `render(<App/>, { alternateScreen: true })`, added in v7.0.0 (2026-04-08, release notes; issue #263). "Renders into the terminal's alternate screen buffer (like vim or less), restoring the previous terminal content on exit." Documented in `src/render.ts` on master: only works in interactive mode; teardown output is treated as disposable (print anything you must keep before unmounting). Ink 6.x had earlier "fullscreen" fixes, but v7's `alternateScreen` is the supported option; the old option is gone from `src/render.ts`.
- **Resize:** the `useWindowSize()` hook (added v7.0.0) returns `{columns, rows}` and re-renders on resize. Resize handling had fixes in v6.5.1 (#828) and v7.0.4 (shared listener, #952). In non-interactive mode Ink disables resize handling — `top` must only use it for a real TTY.
- **Clean exit:** raw mode is set in a `useEffect` and restored by its cleanup (`src/hooks/use-input.ts`: `setRawMode(true)` / cleanup `setRawMode(false)`); `exitOnCtrlC` defaults to true; `patchConsole` (default true) is restored during unmount; `alternateScreen` restores the previous buffer on exit. `useApp().exit()` / `unmount()` end the program. For later steps: v7.1.0 added `suspendTerminal()` to hand the terminal to a child process — the natural fit if `o` ever runs `opencode attach` for real.

## 3. The opencode 1.18.32 server

**One stream across all projects exists: `GET /global/event`.**

- `GET /event` is per instance/directory. The server filters the stream: `event.location?.directory === instance.directory` (opencode source, tag v1.18.32, `packages/opencode/src/server/routes/instance/httpapi/handlers/event.ts`). The SDK takes `?directory=` as query (`@opencode-ai/sdk` dist/gen/types.gen.d.ts:3366-3373) — this is what `watch` and `status` use today.
- `GET /global/event` is on the root API (`handlers/global.ts`, handleRaw `"event"`). It listens to the server-wide `GlobalBus` with **no directory filter**. The wire format is `GlobalEvent = { directory: string; payload: Event }` (SDK dist/gen/types.gen.d.ts:603-606), so every event names its project directory and `top` can bucket by directory itself. The v2 SDK's `GlobalEvent` additionally carries `project` and `workspace` (dist/v2/gen/types.gen.d.ts:553-556). One subscription replaces one per worktree.

**Where the numbers live** (SDK 1.18.32 types, file:line; event names as on the wire):

- **Tokens per step / cost:** `message.part.updated` with `part.type === "step-finish"` → `cost`, `tokens.input/output/reasoning/cache.read/cache.write` (dist/gen/types.gen.d.ts:282-296). `message.updated` carries the finished `AssistantMessage` with the same totals plus `time.completed` (98-128). Caution: the v1 `Session` object has **no** `cost`/`tokens` fields (465-492) — only the v2 SDK's `Session` has them. Session totals must be accumulated from step events (as `tree.ts` already does) or taken from the v2 SDK.
- **Reasoning:** `tokens.reasoning` in step-finish / AssistantMessage. Reasoning text streams as `message.part.updated` parts of type `reasoning` (dist/gen 158). The v2 stream has richer `session.next.reasoning.*` and `session.next.step.started/ended` events with explicit `timestamp` (dist/v2 types 735-760, 788-813) — nice, but not required.
- **Time of the last token:** the v1 `message.part.updated` payload has no timestamp (355-359), so record `Date.now()` on arrival — good enough for "seconds since last token". Text parts do carry `time: {start, end?}` (146-153) for finished text.
- **Tool calls:** `message.part.updated` with `part.type === "tool"` (`state.status`, `callID`, input) — exactly what `events.ts:80-94` already parses.
- **Session status:** `session.status` events with `SessionStatus = idle | busy | retry {attempt, message, next}` (dist/gen 407-412 and the `SessionStatus` type), plus `session.idle`. This gives the "retrying" state for free.
- **Waiting (question/permission):** `permission.asked` and `question.asked` events exist on the wire but the published v1 gen lacks their types — `events.ts:65-73` already reads them as plain strings, and the step 4 live test (PLAN.md) proved they arrive on `/event`. Assume the same on `/global/event`; verify in the first run.

## 4. What other live views do

- **opencode TUI** (same repo, `packages/tui`): solid-js + `@opentui/core`/`@opentui/solid`/`@opentui/keymap`, runs under bun. It is per-project and interactive; `top` differs by being cross-project and read-only. Copyable: the session list with live status derived from `session.status`/`session.idle` events.
- **claude-squad** (smtg-ai/claude-squad, Go): a list of agent sessions with a preview/diff pane and a bottom menu of keys (`↑/j`, `↓/k`, `tab`, `?`); runs each agent in tmux. Copyable: the layout (list left/top, detail right/bottom, key menu as footer) and "navigate with j/k" muscle memory.
- **k9s** (derailed/k9s, Go + tview/tcell forks in `go.mod`): a sortable resource table with status columns, a detail view per row (`y`/`d`/`l`), breadcrumbs, and a footer showing key bindings per context. Copyable: one row per object with dense status columns, selection + detail drill-down, and the footer that always shows what each key does.

## 5. Proposed structure of `oc-sub top`

**Data sources.** One `client.global.event()` SSE subscription (`GET /global/event`) feeds a reducer per session ID: state (`session.status`/`session.idle`), pending requests (`question.asked`/`permission.asked`), last activity time (arrival time of any `message.part.updated`), step tokens/cost (`step-finish` parts), tool-call log and loop/stall flags (the detection module from step 6, fed with the same events). At startup, and after each reconnect, `top` reconciles with the REST calls that `status` already uses: `project.list`, `session.list`, `session.status`, pending request lists — per directory of the current project and its worktrees (`--all`: all projects). The event stream labels every event with `directory`, so sessions map to projects without per-directory subscriptions.

**Polling.** No polling loop for the table itself: the SSE stream pushes updates; Ink re-renders on state change. Only two low-frequency timers: a 2-second tick to age "seconds since last token"/elapsed columns and to re-run the stalled/looping detection over accumulated state, and a 30-second reconciliation poll of the REST status map as a safety net against missed events (the stream has a heartbeat; `watch.ts:113-116` shows the same pattern).

**Layout.** `render(<Top/>, {alternateScreen: true})`: a one-line-per-session table (project/worktree, agent, state, elapsed, steps, tool calls, context tokens, cost), `j/k` or arrows to select, a detail pane for the selection (last events, pending question/permission, subagent tree), and a footer with server URL and day totals. `q` or Ctrl+C exits; `o` prints the `opencode attach` command into the log area (first version shows only).

**`top --once`.** No `render()` call at all: it does the startup REST reconciliation, waits a short grace period for one stream burst (or runs stream-less, REST-only for the first version), and prints the same table plus the selected detail as plain text — like `status`, one line per session, machine-readable with `--json`. `interactive: false` in Ink terms, or simply `console.log` formatting shared with the Ink table renderer.

## Open questions

1. Does Ink 7.1.1 + React 19.3 run cleanly under bun 1.4.2 (raw mode, `useInput`, alternate screen)? Needs a smoke test; bun issues in Ink are closed but none documents bun 1.4.
2. Do `question.asked`/`permission.asked` events arrive on `/global/event` exactly as on `/event`? Verify with a live run.
3. Does `ink-select-input` work with Ink 7 in practice (peer range says yes)?
4. Should `top` import `@opencode-ai/sdk/v2` in parallel for the typed `Session.cost`/`tokens` and `session.next.*` events, or stay v1-only and accumulate? Decide during implementation.
