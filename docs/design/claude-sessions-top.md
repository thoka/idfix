# Design: Claude sessions in `idfx top` and `idfx status` (step 25g, read side)

Status: draft for review, 2026-10-06. The grill with the user settled Q1 to Q7. The answers are in `docs/PLAN.md`, section "Hand-off", and later in HISTORY. The facts on the data sources are in [claude-session-sources.md](../research/claude-session-sources.md).

## 1. Goal

The recurring problem: the user runs many agent sessions in many projects. No single place shows which session works, which waits for the user, and which uses much of the plan or of its context window. Step 25g solves it for Claude Code sessions next to the opencode runs that `top` already shows. The first test case is the set of sessions in `~/dv` on this machine.

This slice is read only. It starts nothing, stops nothing, and changes no configuration of Claude Code. The watch slice (`idfx watch --all`, the five events) gets its own design later. Its event format waits for the research of meta.

## 2. Data sources and how they join

idfix reads files only, by polling. It does not run `claude agents --json`, because each call starts a Node process, and the files hold the same data and more. It does not use a proxy and no hooks (decision of the grill).

1. Live sessions: `~/.claude/sessions/<pid>.json`. If the process `pid` lives and its start time matches `procStart`, the file counts. `procStart` is field 22 of `/proc/<pid>/stat`, the start time in clock ticks after boot (measured on 2026-10-06). A dead file is left alone. idfix never reads the `.key` files in that folder, and the reader only opens names that end in `.json`.
2. Background state: `~/.claude/jobs/<jobId>/state.json`, for a session file with `jobId`, and for ended background sessions. idfix reads `state`, `detail`, `needs`, `createdAt`, and `updatedAt`. It never reads or shows `intent` and `providerEnv`.
3. Transcripts: `~/.claude/projects/<cwd with dashes>/<sessionId>.jsonl`. Ended interactive sessions come from here: a transcript whose modification time is at most 60 minutes old and whose session has no live process.
4. Subagents: `<sessionId>/subagents/agent-<id>.jsonl` and `agent-<id>.meta.json` next to the transcript. Each one becomes a child row.

The key of a session is its `sessionId`. The join: session file, then job state through `jobId`, then the transcript through `cwd` and `sessionId`.

## 3. The transcript reader

The reader keeps a byte offset per transcript and reads only the new bytes at each poll. It keeps an incomplete last line for the next poll. For each session, it keeps:

- `model`: the `message.model` of the last `assistant` line.
- usage: one `message.usage` per `message.id` (several lines repeat the same usage). Input, output, cache read, and cache write tokens, per model.
- `contextTokens`: input plus cache read plus cache write tokens of the last request. This is the size of the context that the model saw.
- `steps`: the count of distinct `message.id` values. `toolCalls`: the count of `tool_use` blocks.
- `lastActivityMs`: the `timestamp` of the last line.
- `title`: the last `custom-title`, else the last `ai-title`, else the session `name`, else the first 60 characters of the folder name. idfix does not show prompts, so it never uses `last-prompt` or `history.jsonl`.
- `apiErrors`: the count of `system` lines with subtype `api_error`. The watch slice uses it, and this slice only keeps it.

A child row sums its own transcript. The parent row sums itself and its children, as for opencode.

## 4. Prices and the model window

idfix takes the prices and the context window of each model from the LiteLLM file `model_prices_and_context_window.json` (the source that ccusage also uses). It downloads the file at most once per 24 hours into `$XDG_CACHE_HOME/idfix/litellm-prices.json` and uses the cached copy offline. If no copy exists, the cost cell and the share cell stay empty. idfix keeps no price table of its own.

The API price of a session: the tokens per model times the prices of that model, with the cache read and cache write prices. A model that LiteLLM does not know (for example `z-ai/glm-5.3-flash` through `claude-glm`) gives no price and an empty cell, not a zero.

The model window: `max_input_tokens` of the model. A Claude Code model id with a `[1m]` suffix uses 1,000,000 tokens.

## 5. The row

A Claude session becomes one `SessionRow` of `src/top/model.ts`, with new fields:

- `driver`: `"opencode"` or `"claude"`. The agent icon in front of the CODE shows `✳` for a Claude session. A subagent row shows the icon of its `agentType`, as for opencode. The `where` column comes from the `cwd` of the session, with the same project and worktree rule as for opencode. The CODE is the last 6 characters of the `sessionId`.
- `model`: the model id, shown in the detail view and in `status --json`.
- `contextWindow`: the window of the model, or undefined.
- `costKind`: `"real"` for opencode, `"apiEquivalent"` for Claude. The `¢` cell of an `apiEquivalent` cost is gray (Q6).

The state:

- `sessions/<pid>.json` with `status: "waiting"` gives `waiting`, and the `waitingFor` text shows as a pending line under the row.
- A background job with `state: "blocked"` gives `waiting`, with `needs` as the pending line.
- `busy` and `shell` give `busy`. `idle` gives `idle`.
- An ended session gives the new state `ended`, gray, sorted last.

The `ctx` column shows the context size and its share of the window, for example `123k 62%`. If the model window of an opencode row is known, the share also shows. Else only the size shows.

## 6. Which sessions show (Q7)

- A live session always shows.
- A waiting session always shows and sorts to the top.
- An ended session shows for 60 minutes after its last activity, the `RECENT_MS` rule of `src/top/load.ts`.
- Without `--all`, the folder rule applies. If the `cwd` of a session is inside a directory of `projectDirectories` for `--dir` (the project and its worktrees), the session shows. With `--all`, every session shows, also outside `~/dv`.

## 7. Live view and keys

`top` polls the Claude files on the same 2-second tick as the stall check. The session folder and the job folders are small. The transcripts are read by offset, so a poll reads only new lines.

The key `o`:

- background session: a new tmux pane runs `claude attach <short id>`, like the opencode attach of `src/top/tmux.ts`.
- interactive session with a `tmux` field: the field has the form `<session>:@<window>.%<pane>`, for example `5:@5.%40`. `top` runs `tmux switch-client -t %40`, which also selects the window and the pane.
- interactive session without tmux: the footer says "no tmux pane".

## 8. `status --json`

`status --json` keeps its fields `id`, `state`, `title`, and `folder` (plus `project` and `server` with `--all`), and each entry gets `driver`. A Claude entry also has `name`, `kind`, `waitingFor`, `model`, `contextTokens`, `contextWindow`, `contextShare`, `lastActivity` (ISO time), and `apiEquivalentUsd`. As for opencode, child sessions do not show in `status`. The plain `status` lines get the Claude sessions too.

## 9. Modules

- `src/claude/files.ts`: the paths, the liveness check of a session file, and the readers of the session and job files.
- `src/claude/transcript.ts`: the incremental transcript reader of section 3. Pure over a byte buffer, so the tests need no files.
- `src/claude/prices.ts`: the LiteLLM cache and the price and window lookup.
- `src/claude/rows.ts`: the join and the mapping to `SessionRow`.
- Changes in `src/top/` (model, columns, view, tmux) and `src/status.ts`.

## 10. Tests

- Recorded samples of each file kind in `test/fixtures/claude/`, cleaned by hand: no prompts, no paths of other users, no keys. A format change of Claude Code breaks these tests first.
- The transcript reader: repeated usage per `message.id`, an incomplete last line, subagent sums, the context size.
- The liveness check: a session file of a dead pid and of a reused pid.
- Prices: a known model, an unknown model, the `[1m]` window, no cache file.
- The scope rule and the 60-minute rule with a fixed `nowMs`.
- The `o` key argv for both kinds.
- A test that the reader never opens a `.key` file.

## 11. Order of work

Each part is one subagent in a worktree, with tests and docs in `docs/GUIDE.md`:

1. 25g.1: `src/claude/` (files, transcript, prices, rows) and `status --all --json`.
2. 25g.2: the rows in `top --once` and in the live view, the gray cost, the `ended` state, and the `ctx` share.
3. 25g.3: the key `o` for Claude sessions.

Then the watch slice, after its own design.

## 12. Known gaps

- The format of `~/.claude` is undocumented and can change with each Claude Code release. The fixtures find the break, and the research report names each release as its recheck.
- An interactive session outside tmux cannot be opened from `top`.
- A session on another machine does not show.
- A `claude-glm` session shows no price, because LiteLLM has no entry for the OpenRouter id. The real GLM cost stays with the proxy of step 25c.
- The context share counts the tokens of the last request. Claude Code compacts earlier than the full window, so 100% never shows.
