# `oc-sub top`: what it needs from Ink and from the opencode server

Research for step 8 of [PLAN.md](../PLAN.md). Written 2026-09-29, updated 2026-09-30 (section 6, after step 9), against opencode/SDK 1.18.32, bun 1.4.2 (`mise.toml`). Facts carry sources; guesses are marked.

## 1. Ink under bun

**Version.** Latest Ink is **7.1.1** (2026-07-16). It requires React `>=19.3.0` as a peer dependency and Node `>=22` (ink master `package.json`, GitHub releases API for vadimdemedes/ink). The project runs bun 1.4.2.

**Known bun problems.** Three closed issues mention bun in the title (GitHub issue search):

- #696 "Compatibility issue with Bun 1.2" (closed, completed): `TypeError: stdin.ref is not a function` inside Ink's `handleSetRawMode`; worked again on Bun 1.1.45. This is the raw-mode/`useInput` path.
- #864 "Cursor disappears when running Ink CLI with Bun on macOS" (closed 2026-04-23, **not planned** — so not fixed in Ink).
- #636 "Bun support" (closed, not planned).

No release note from v4.2.0 to v7.1.1 mentions bun. So: bun is not officially supported or tested by Ink, the raw-mode bug was fixed, and a macOS cursor issue is open by policy. **Nothing here proves Ink 7.1.1 breaks on bun 1.4.2, and nothing proves it works. A smoke test (a `useInput` counter in the alternate screen, run with `bun run`) is the first implementation step.** opencode's own TUI runs under bun but uses `@opentui/*` + solid-js, not Ink (opencode `packages/tui/package.json`, tag v1.18.32), so it is no proof either way.

Update 2026-09-30: v7.1.1 is still the latest release (GitHub releases API: newest tag v7.1.1, published 2026-07-16; the repo is active, last push 2026-09-29, ~40k stars). No new issue with "bun" in the title since then — the only bun-titled issues remain the three closed ones above; the three issues opened on 2026-09-29 (#1034 cursor lost on sibling re-render, #1035/#1036 incremental rendering) are not bun-specific.

### Ink under bun (2026-09-30, step 8b)

Smoke test done (`src/top/smoke.tsx`, `test/top-smoke.test.tsx`): an Ink 7.1.1 + React 19.3.0 counter app with `useInput` (`j`/`k`/`q`, `useApp().exit()`), `useWindowSize()`, and `render(<Smoke/>, {alternateScreen: true})`.

- **Bun test:** `bun test` with `ink-testing-library` 4.0.0 renders the counter, feeds `j j k` through stdin, sees count 1, and exits on `q`. Passes.
- **Real pseudo terminal:** `(sleep 1; printf j; sleep 0.5; printf q) | script -qec "bun src/top/smoke.tsx" /dev/null` — exit code 0. Raw mode, `useInput`, and the alternate screen worked: the frame updated from 0 to 1, and the previous terminal content was restored on exit. **No error appeared** — in particular no `stdin.ref is not a function` (issue #696).

Result: Ink 7.1.1 works under bun 1.4.2 for rendering, key input, alternate screen, and clean exit. Building `top` on Ink is safe.

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

## 6. Several servers since step 9 (added 2026-09-30)

Since step 9, several opencode servers can run at once: the host server on 127.0.0.1:8767 and one sandbox server per project, each published on a host port from 18768 up, with a state file `~/.local/state/oc-sub/sandbox-<project>.json` (`src/sandbox.ts:94-96`, `sandboxStatePath`). `top` must show the sessions of all of them.

### 6.1 Server discovery

`top` lists the host server plus every sandbox state file, probes each URL once, and subscribes only to the ones that answer. Proposed function (new, in `src/sandbox.ts`):

```ts
/** One known server: which project it belongs to, and its base URL. */
export type KnownServer = { project: string; url: string; sandbox: boolean };

/** The host server plus every project sandbox with a valid state file. Pure: no network. */
export function listServers(env: Env): KnownServer[] {
  const servers = [{ project: "", url: resolveServerUrl(undefined, env), sandbox: false }];
  // Same listing loop as `usedSandboxPorts` (src/sandbox.ts:167-183).
  for (const entry of readdirSync(stateDir(env))) {
    if (!entry.startsWith("sandbox-") || !entry.endsWith(".json")) continue;
    const state = readSandboxState(path.join(stateDir(env), entry));
    if (state === null) continue; // missing, unreadable, or invalid: skip
    servers.push({
      project: entry.slice("sandbox-".length, -".json".length),
      url: `http://127.0.0.1:${state.port}`,
      sandbox: true,
    });
  }
  return servers;
}
```

Reused pieces of `src/sandbox.ts`: `stateDir` (re-exported from `src/state.ts`), `readSandboxState`/`parseSandboxState` (src/sandbox.ts:102-126) — they already tolerate a missing or invalid file by returning `null` — and the port-in-URL form of `sandboxUrlFor` (src/sandbox.ts:138-145). `usedSandboxPorts` (src/sandbox.ts:167-183) shows the exact `readdirSync` + filename-filter pattern; `listServers` is the same loop without the `own` exclusion. The host URL comes from `resolveServerUrl` in `src/config.ts` (the same default 8767 that `status.ts:139` uses).

**A server that does not answer.** Probe each URL with `probeServer(url, env, timeout)` (`src/client.ts`, as `status.ts:141-145` already does). `probeServer` returns `{state: "down"}` instead of throwing, so a stopped sandbox is a normal state: `top` keeps one dim row per known server with state `down` (and the project name from the state file), starts no event subscription for it, and re-probes it on the periodic reconciliation tick (section 5) — when `sbx` has restarted the sandbox and the port answers again, `top` subscribes and the row fills in. Guess on the UI detail (dim row + re-probe); the mechanism (`probeServer` returning `down`) is fact.

### 6.2 Event streams: one `/global/event` per server

Confirmed in the opencode source at tag v1.18.32:

- **`GET /global/event` exists and has no directory filter.** It is registered as `handleRaw("event", ...)` on the root API group (packages/opencode/src/server/routes/instance/httpapi/handlers/global.ts:60-124, `handleRaw` at line 120). Its stream is `GlobalBus.on("event", ...)` wrapped in a `Stream.callback`, plus a 10-second `server.heartbeat` (handlers/global.ts:28-42) — nothing filters by directory.
- **The GlobalBus is server-wide.** It is a plain process-wide `EventEmitter` (packages/opencode/src/bus/global.ts:11-22); `GlobalEvent = { directory?, project?, workspace?, payload }` (bus/global.ts:4-9).
- **`question.asked` and `permission.asked` reach the GlobalBus.** The publish path is `EventV2Bridge`: it attaches the instance location on publish (event-v2-bridge.ts:19-32) and a single `events.listen` forwards *every* event to `GlobalBus.emit("event", { directory: event.location?.directory ?? ..., payload: { type, properties } })` (event-v2-bridge.ts:35-44). Both asked events are published through that bridge:
  - `question.asked` — type string in packages/schema/src/v1/question.ts:58; published in packages/opencode/src/question/index.ts:104 (`events.publish(Event.Asked, info)` with `Event = QuestionV1.Event`, index.ts:25).
  - `permission.asked` — type string in packages/schema/src/v1/permission.ts:61; published in packages/opencode/src/permission/index.ts:100.
- So the wire names on `/global/event` are exactly the v1 strings `question.asked`/`permission.asked` that `src/events.ts:70-73` already reads; this also answers open question 2 of the first report. (The v2 names `question.v2.asked`/`permission.v2.asked` in packages/schema/src/question.ts:70 and permission.ts:43 are separate definitions, not what these servers publish.) The global stream is per *server*, not per project: `top` opens one subscription per discovered server and buckets by the `directory` field of each `GlobalEvent`.

### 6.3 Paths inside a sandbox are host paths

Yes — the session directory inside a sandbox is the same absolute path as on the host, so `top` can map every event's `directory` to a project and worktree across all servers with plain path comparison:

- Step 9a creates the sandbox with the project root as workspace: `sbx create --name NAME opencode ROOT ./opencode:ro` (src/sandbox.ts:465-470, PLAN.md step 9a design). The `sbx` test on 2026-09-29 recorded: "The workspace appears under the same absolute path as on the host" (docs/research/sandbox.md, section 7, line 115).
- The plugin mount keeps its host path on purpose, so `OPENCODE_CONFIG_DIR` has the same value inside and outside (src/sandbox.ts:459-463 comment; PLAN.md:134).
- Consequence: a worktree session of a sandboxed project carries a `directory` that is identical on the host, so `top` can reuse `worktreesOf` (src/status.ts:46-53) and `displayFolder` (src/status.ts:39-43) unchanged, keyed by directory per server. Caveat: two servers never see the same directory, because a sandboxed project no longer reaches the host server (PLAN.md:121), so project→server is unambiguous.

### 6.4 `opencode attach` for a sandbox session

The key `o` prints `opencode attach http://127.0.0.1:<published-host-port> --session <id> --dir <worktree>` — the **published host port** from the sandbox state file, the same URL that `sandboxUrlFor` returns, not the internal port 4096. `opencode attach` takes a positional server URL (`command: "attach <url>"`, default example `http://localhost:4096`, packages/opencode/src/cli/cmd/attach.ts:7-16) plus `--session`/`-s` and `--dir` options (attach.ts:17-30); the host publishes the sandbox's 4096 on the fixed port (src/sandbox.ts:537-545), so attaching to `127.0.0.1:<host-port>` reaches the server inside the sandbox. This matches the Docker variant of sandbox.md section 5: "the user's `opencode attach http://127.0.0.1:<port>` ... just points at the published port".

## Open questions

Revisited 2026-09-30:

1. ANSWERED by smoke test (2026-09-30, "Ink under bun" in section 1): Ink 7.1.1 + React 19.3.0 runs cleanly under bun 1.4.2 — rendering, `useInput`, alternate screen, clean exit, in `bun test` and in a real pty.
2. ANSWERED by source: `question.asked`/`permission.asked` are published through the EventV2Bridge, which forwards every event to the GlobalBus, so they arrive on `/global/event` (section 6.2). A first live run should still confirm it end to end.
3. OPEN. Does `ink-select-input` work with Ink 7 in practice (peer range says yes)?
4. OPEN. Should `top` import `@opencode-ai/sdk/v2` in parallel for the typed `Session.cost`/`tokens` and `session.next.*` events, or stay v1-only and accumulate? Decide during implementation.
5. OPEN (new). Do the sandbox state files of stopped sandboxes age out? A project that left sandbox mode leaves a state file whose port may later be reused by something else; `listServers` would show a wrong server. A down-probe plus an entry in the UI is tolerable for the first version, but a `down --sandbox` that keeps the file (by design, src/sandbox.ts:628-631) makes stale entries likely.
