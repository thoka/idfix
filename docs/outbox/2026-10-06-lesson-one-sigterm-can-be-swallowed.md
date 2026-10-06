---
kind: lesson
from: idfix
date: 2026-10-06
---

# A stop routine repeats SIGTERM and ends with SIGKILL, because a library handler can catch one SIGTERM and keep the process alive.

A process without its own SIGTERM handler can still survive one SIGTERM. A library can install a handler for a short time. In opencode serve, npm's arborist installs a `signal-exit` handler while it installs the dependencies of a config folder. The handler aborts only the install, removes itself, and the server keeps running. A stop routine that sends one SIGTERM and waits then times out, but only when the signal hits that window. The result is a flaky test or a hung `down`.
Send SIGTERM to the process group, repeat it about every second while the process lives, and send SIGKILL to the group at the deadline, as systemd and `docker stop` do. Warn when SIGKILL was needed.
To find such a window, sample `SigCgt` in `/proc/<pid>/status` every 100 ms. A bit that comes and goes shows a temporary handler.
Source: idfix commit 8ae2dff (fix of the flaky `restart` in test/integration.test.ts).

Related: stop-the-process-tree-not-the-parent.md, python-sigterm-skips-finally.md.
