# Design: `idfx watch --all` and the tool protocol (step 25g, watch slice)

Status: draft for review, 2026-10-06. The scope comes from the supervisor (meta plan step 22, grill `~/dv/meta/docs/interviews/2026-10-05-watch-protocol.md`). The protocol comes from the meta report `~/dv/meta/docs/research/tool-protocol.md` (version 0, provisional until the Gemini check of the user). This design links to that report and does not copy it.

## 1. Goal

The recurring problem: a session that waits, stalls, runs full, fails, or ends without a clean hand-off stays unseen until the user looks. The supervisor must learn of it without polling each project. `idfx watch --all` finds these changes in the Claude Code sessions of the machine, writes each change as one event to a log, and wakes the supervisor. It uses no LLM. The first test case is the set of sessions that `idfx top --once --all` shows today, with seven sessions that wait for 1 to 3 days.

## 2. Command

- `idfx watch --all` runs the watcher as a long process. It polls the Claude source of `src/claude/rows.ts` (the same source as `top`) every 15 seconds.
- `idfx watch --all --json` also prints each new event on stdout, one JSON line each.
- `idfx watch --all --once` polls one time, writes the events of that poll, and exits. Tests and a manual check use it.
- `idfx watch SESSION` keeps its old meaning: it waits for one opencode run. A `SESSION` argument together with `--all` is a usage error (exit code 2).

The first slice watches Claude Code sessions only. opencode runs keep `idfx watch SESSION` and the guards of `src/detect.ts`.

## 3. Conditions

Each condition belongs to one session (the `subject`). The watcher computes all conditions at each poll. An event reports a change of one condition (an edge), not each poll.

```tbl
type: Condition type
true: True when
sev: Severity of the True event
reason: Reasons
--
type: SessionWaitsForUser
true: the row state is `waiting` for more than 10 minutes (from `statusUpdatedAt` of the session file, or `updatedAt` of a blocked job)
sev: WARN 13
reason: `input_required`, `auth_required`
--
type: SessionStalled
true: the row state is `busy`, and the transcript did not grow for 15 minutes
sev: WARN 13
reason: `NoTranscriptGrowth`
--
type: ContextHigh
true: the context share is over 50% of the model window
sev: WARN 13
reason: `OverHalfWindow`
--
type: HandoverFailed
true: the session ended, and `handover check <cwd>` exits with code 1
sev: WARN 13
reason: `HandoverCheckFailed`, with the first problem line in `message`
--
type: ApiError
true: the transcript has a new `system` line with subtype `api_error` since the last poll, or the waiting text of a blocked job holds `API Error`
sev: ERROR 17
reason: `UsageLimit`, `AuthError`, `ApiError`
--
type: SessionUnnamed
true: a live session has no `name` (user decision 2026-10-06, meta plan step 26)
sev: INFO 9
reason: `NoName`
```

The reason of `SessionWaitsForUser` has exactly two values, from tool protocol v0 (meta `docs/research/tool-protocol.md`, section 1). They are the words of MCP tasks (status `input_required`) and of A2A (`TASK_STATE_INPUT_REQUIRED`, `TASK_STATE_AUTH_REQUIRED`), so a consumer needs no table of names:

- `auth_required`: the waiting text asks for a login or a key. The research (`docs/research/claude-session-sources.md`, section 2) names no `waitingFor` value for a login, so the watcher matches the text: `401`, `/login`, `not logged in`, `login required` or `login needed`, `authentication failed`, `required`, or `error`, an invalid or expired key or token, or `key expired` and `token has expired`. A dialog title such as `Allow edit of src/login.ts?` does not match.
- `input_required`: every other wait. That is a permission dialog, the fixed texts `input needed`, `dialog open`, `sandbox request`, and `worker request`, a blocked job, and a wait without a text.

The kind of wait goes into `message`, for people: `<kind>, waits for the user since <n> min`. The kind is `permission dialog: <title>`, one of the fixed texts, `blocked job: <needs>`, `login needed: <text>`, or `unknown wait`. For example `permission dialog: Bash permission, waits for the user since 12 min`. A long kind is cut so that the message stays at 200 characters with its suffix.

A condition that turns False gives an event with severity INFO 9. A session that disappears from the source sets its open conditions to False. `HandoverFailed` runs `handover check` once, at the edge to `ended`, not at each poll. An exit code 2 (for example a folder outside git) gives no event. `ApiError` turns False at the next poll without a new error line, so each new error gives one True event.

The reasons of `ApiError` come from the error text: `usage limit` or `rate limit` gives `UsageLimit`, `401`, `403`, `login`, or `authentication` gives `AuthError`, and else `ApiError`. The transcript reader of 25g.1 keeps only a count of `api_error` lines today. This slice extends it to keep the text of the last error, cut to 200 characters.

## 4. Event log

The envelope and the file follow section 6 of the meta report:

- File: `$XDG_STATE_HOME/idfx/events.jsonl`, append only, one full line per `write` call. One writer: the watcher. A file lock (`flock` on `events.lock`) stops a second watcher, which exits with code 1 and a message.
- Envelope: CloudEvents 1.0 JSON. The attributes are `specversion`, `id`, `source` (`//<hostname>/idfx`), `type`, `time`, `subject` (the session name, else the first 8 characters of the session id), `sequence` (20 digits with leading zeros), `severitytext`, `severitynumber`, and `data`.
- `type`: `dv.idfx.session.<condition in kebab case>`, for example `dv.idfx.session.stalled`. `SessionWaitsForUser` uses `dv.idfx.session.waiting`, the type of tool protocol v0. A log line from before that change has `dv.idfx.session.waits-for-user`; the restore reads `data.condition`, so it still counts. The heartbeat is `dv.idfx.watch.heartbeat`, every 5 minutes, severity INFO 9.
- `data`: `condition`, `status` (`True` or `False`), `reason`, `message`, `lastTransitionTime`, `session` (the full id), `cwd`, and `kind`.
- Rotation: above 10 MB the watcher renames the file to `events.<first sequence>.jsonl` and starts a new file. The sequence continues.

The event file is the state of the watcher. At start, the watcher reads the last event of each condition and subject from the current file. So a restart does not repeat a True event that is still true. It sends a False event for a condition that cleared while it was down.

## 5. Wake-up of the supervisor

Each notice costs context in the supervisor, so the watcher sends few notices (supervisor decision, 2026-10-06):

- Only a True edge of `SessionWaitsForUser` or `ApiError` gives a notice. The set is the constant `NOTIFY_CONDITIONS` in `src/watch/wake.ts`. The other conditions (`SessionStalled`, `ContextHigh`, `HandoverFailed`, `SessionUnnamed`) and all False edges go only to the log.
- One poll gives at most one notice, with all its notifying edges.
- At most one notice goes out in 60 seconds. Edges that come in the pause wait, and the first poll after the pause sends them in one notice.
- A known state never gives a second notice. A condition that stays True gives no edge. A restart restores the state from the log, so a condition that is still True gives no edge either.
- If the event log was empty or missing at start (the first run), the first poll is the baseline. It writes its events to the log, but sends no notice.

The watcher sends the notice with `notify-session --name supervisor -- "<text>"` from the PATH. Without a session ID, `notify-session` finds the live session by its name (meta af773a4). The `--` keeps a text that starts with `-` from being read as an option. The text names the count, the first three edges in short form, and the log, for example `idfx watch: 2 events: meta waits for user (permission dialog: Bash permission), grata API error (UsageLimit). Log: /home/u/.local/state/idfx/events.jsonl`. A wait shows its kind from the message (at most 80 characters), not only its reason, so the supervisor sees what to do. Without a message, it shows the reason. The log is the record, and the notice is only a wake-up. If `notify-session` fails, the watcher writes a warning to stderr, drops the notice, and goes on. If `notify-session` is not on the PATH, the watcher warns once. `--once` also sends a notice.

## 6. `status --json` and `doctor --json` in the protocol form

- `status --json` becomes one object (meta report section 6). Its fields are `tool`, `version`, `time`, `source`, `sequence` (the last sequence of the event file, or absent without a file), `conditions` (the current True conditions, as the watcher computes them), and `items` (the session list of today). No code outside idfix reads the old array (measured on 2026-10-06 with a search in `~/dv`). The GUIDE and the skill reference change with it.
- `doctor --json` becomes one object `{tool, version, status, checks, fixes?}`. Each check gets `type: urn:dv:idfx:doctor:<name>`. A check that cannot run gets `error`. The exit code is 2 for a usage error or a doctor that cannot run.
- A new `doctor` check `watch-running`: if no watcher holds the lock, it warns.

## 7. The systemd user service

idfix gives the unit file `contrib/systemd/idfx-watch.service`: `ExecStart=%h/.local/bin/idfx watch --all`, `Restart=on-failure`, `RestartSec=10`, `WantedBy=default.target`. A user service gets a short PATH (`/usr/local/bin:/usr/bin`), so the unit sets `PATH` with `%h/.local/bin`, `%h/dv/meta/dv/bin` (`notify-session` and `handover`), and the mise shims. By the rule of 2026-10-05, arch-helper owns the links and the install of project commands. So an outbox task asks arch-helper to install and enable the unit through chezmoi. idfix does not install it. `doctor` only reports it.

## 8. Modules

- `src/watch/conditions.ts`: pure. From the rows of two polls, the clock, and the old condition state, it computes the new conditions and the edges.
- `src/watch/log.ts`: the event file: the lock, the sequence, the append, the rotation, and the read of the last state.
- `src/watch/run.ts`: the poll loop, the heartbeat, the `handover check` call, and the wake-up. All processes and the clock are injected.
- Changes in `src/cli.ts`, `src/status.ts`, `src/doctor.ts`, and `src/claude/transcript.ts` (the text of the last error).

## 9. Tests

- Each condition: the edge to True after its threshold, no event while it stays true, and the edge to False.
- The log: the sequence after a restart, the rotation, the second watcher that the lock stops, and one full line per event.
- A restart: no second True event for a condition that is still true.
- The wake-up: one call per poll with WARN events, the 60-second pause, and a failing `notify-session`.
- A JSON Schema check of each event against the CloudEvents schema plus `sequence` and the severity fields. The schema file comes from a copy in `test/fixtures/`. If the meta conformance test exists, the test uses its schema.
- `status --json` and `doctor --json`: stdout is one JSON object, with the fields of section 6.

## 10. Order of work

1. W1: `src/watch/` (conditions, log, run) and `idfx watch --all [--json] [--once]`, without the wake-up.
2. W2: the wake-up through `notify-session`, the `watch-running` check, the unit file, and the outbox task to arch-helper.
3. W3: `status --json` and `doctor --json` in the protocol form.

## 11. Known gaps

- The protocol is provisional. If the Gemini check changes the envelope, the change stays in `src/watch/log.ts`.
- The 15-second poll misses a wait shorter than the threshold. That is on purpose.
- opencode runs give no events yet.
- A session on another machine gives no events. Each machine runs its own watcher with its own `source`.
- `handover check` of a worktree session checks the worktree, not the main checkout. The supervisor then reads the event and decides.
