# Help 41sHW68C: idfx watch
Summary: idfx watch --all watches all Claude Code sessions of this machine and writes each change of their state as one event into the watch log.
Example: `idfx watch --all --once --json`
Next: {>qIuSgJ7L}, {>9cYT4KA9}, {>QDgofAd8}, {>t46yCjCG}, {>TxkQy5Ca}

The help of `idfx watch`, the most used command of idfx: a systemd unit of `contrib/` runs `idfx watch --all` all the time. The full list of the commands and flags is `idfx --help`.

## Unit qIuSgJ7L: the conditions
Summary: Every 15 seconds the watcher reads each session and sets its conditions: it waits for the user, it stalls, its context is high, it ended without a clean hand-off, it hit an API error, or it has no name.
Next: {>9cYT4KA9}, {>QDgofAd8}
Readers: user, worker, integrator, tool
Tasks: watch-sessions

A condition is True or False. Only a change of a condition gives a new event, so a session that waits for an hour gives one event, not 240.

## Unit 9cYT4KA9: the watch log
Summary: Each event is one CloudEvent JSON line in $XDG_STATE_HOME/idfx/events.jsonl, with a sequence number; a heartbeat event follows every 5 minutes.
Next: {>TxkQy5Ca}
Usage: `idfx watch --all --json`
Readers: user, worker, integrator, tool
Tasks: read-events

With --json the watcher also prints each new event on stdout, one JSON line each. --once polls one time and exits. `idfx status --json` prints the True conditions and the sequence of the last event.

## Unit QDgofAd8: the wake of the supervisor
Summary: A session that waits for the user or hits an API error wakes the supervisor session through notify-session, at most once per minute.
Next: {>TxkQy5Ca}
Readers: user, integrator
Tasks: watch-sessions

The first run on a new log wakes nobody, so a restart of the watcher sends no old alarms.

## Unit t46yCjCG: one opencode run
Summary: idfx watch SESSION follows one opencode run on its server and cannot be combined with --all.
Next: {>TxkQy5Ca}
Usage: `idfx watch SESSION [--dir DIR] [--json]`
Readers: user, worker
Tasks: watch-run

It does not work for Claude Code runs yet: read those with `idfx log SESSION`.

## Unit TxkQy5Ca: the exit codes
Summary: Exit codes: 0 the watch ended, 1 another watcher holds the lock or the only poll of --once failed, 2 wrong usage.
Readers: user, worker, integrator, tool
