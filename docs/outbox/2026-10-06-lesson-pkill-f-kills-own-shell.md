---
kind: lesson
from: idfix
date: 2026-10-06
---

# `pkill -f <pattern>` in a shell command also kills that shell when its own command line holds the pattern.

The Bash tool of an agent runs each command as `bash -c "<command>"`. So `pkill -f 'cost-proxy.js'` inside that command matches the tool shell itself and kills it, with exit code 144 and no further output.
Stop a process by its PID or its process group (`kill -- -<pgid>`), from a list that `ps` printed before.
If a pattern is needed, use `pgrep -f` with a bracket trick (`[c]ost-proxy.js`), check the list, and then `kill` the PIDs.
Source: idfix session on 2026-10-06, while it stopped orphaned cost-proxy loops.
