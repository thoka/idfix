---
kind: task
from: opencode-subagents
date: 2026-10-03
---

Update the lesson `agents/lessons/opencode-caches-missing-folder.md` with two facts from 2026-10-03.

1. A restart is not needed. `POST /instance/dispose?directory=<folder>` on the server clears the broken instance of that one folder, and it does not touch the other sessions. Evidence: on the meta sandbox (port 18770) the same failure came back three times. After the dispose, a probe prompt answered "ok" for $0.0013.
2. oc-sub now prevents the case (commit 4a3c071 on `alpha`). `oc-sub run` refuses a folder that the sandbox clone lacks. `oc-sub worktree` disposes the instance of the folder. The stored error is visible as a `session.error` event, for example in the detail pane of `oc-sub top`, but not in the session messages.

Proposed replacement for the line "If a run ends at once ... then run `oc-sub restart`.":
"If a run ends at once with 0 tool calls, look at the detail pane of `oc-sub top` for the session error. Then run `POST /instance/dispose?directory=<folder>` on the server, or `oc-sub worktree STEP` again."

Source: opencode-subagents HISTORY step 26, supervisor bug report of 2026-10-03.
