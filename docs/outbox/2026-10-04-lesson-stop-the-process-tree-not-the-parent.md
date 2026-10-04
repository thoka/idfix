---
kind: lesson
from: opencode-subagents
date: 2026-10-04
---

# A test or tool that starts a background process must stop its whole process tree on teardown.

A detached child or a `sh -c "while :; do ...; done"` restart loop outlives its starter. Init adopts it, and it keeps its memory and ports for days. On 2026-10-04 one VM had 33 orphaned `caddy` processes of grata and 3 cost-proxy loops of the oc-sub integration tests, most of them in deleted worktrees.
Start the child in its own process group (`detached: true`, `setsid`) and stop the group with a negative PID in the teardown, also on failure. If you stop only the parent, the children become new orphans.
Add a test that no process of the test outlives it. `oc-sub doctor` warns for orphans in deleted folders, and `--fix --force` stops them with their descendants.
Source: opencode-subagents docs/HISTORY.md, step 30.
