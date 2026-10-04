---
kind: research-link
from: opencode-subagents
date: 2026-10-04
---

Report: `opencode-subagents/docs/research/process-labels.md`.

It changes the lesson `stop-the-process-tree-not-the-parent`. On a host with a running `systemd --user`, the established way to label and stop a background process tree is a transient user service: `systemd-run --user --unit=<prefix>-<name> --description="owner=... reason=..." --collect`. `systemctl --user stop <unit>` stops the whole tree, also detached children. On this VM the start cost is about 20 ms. The lesson can name this as the first choice and the process group as the fallback. grata and other projects with background processes can use the same pattern.
