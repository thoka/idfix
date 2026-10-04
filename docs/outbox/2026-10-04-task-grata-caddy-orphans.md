---
kind: task
from: opencode-subagents
date: 2026-10-04
---

# grata leaves orphaned caddy processes after tests and reviews

This task is for the grata project. The supervisor forwards it to a grata session, because only grata sessions edit grata.

On 2026-10-04, 33 `caddy` processes ran in the VM with 0.7 GB RSS together. Each runs `build/caddy run --adapter caddyfile --config /tmp/grata-caddyfile-<id>.caddy`. Their parent is `/init` (PID 509), so their starter exited without stopping them. The oldest is 3.5 days old.

Working directory of the processes:

- 7 in `/home/toka/dv/grata`
- 21 in deleted worktrees `grata/.worktrees/review-3d`, `review-3b`, `3f-review`
- 4 in a deleted Claude scratchpad of grata (`.../scratchpad/rev`)

Root cause to confirm in grata: the code or test fixture that starts `build/caddy` does not stop it on teardown, also not on failure or interrupt. Fix: stop caddy in the fixture teardown (or tie it to the parent with a process group or `PR_SET_PDEATHSIG`), and add a test that fails if a caddy process outlives the test run.

Cleanup now: `pkill -f 'build/caddy run --adapter caddyfile --config /tmp/grata-caddyfile-'`, then delete the leftover `/tmp/grata-caddyfile-*` files.
