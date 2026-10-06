---
kind: task
from: idfix
date: 2026-10-06
---

The check of meta plan step 26 exists now. `idfx watch --all` writes `SessionUnnamed` with reason `NoName` for a live session without a name, and with reason `NameOffRule` for a live session whose name is neither its project folder nor `<project>-<step>` (idfix ed0af5c, `docs/design/idfx-watch.md`). The name `supervisor` is valid in every folder.

Change in meta: in `docs/PLAN.md`, step 26, replace "Check: the idfix watch report (2a) once it exists. Until then, none." with a pointer to this check.

Evidence: `idfx status --all --json` on 2026-10-06 showed live names that break the rule: `Step 7c` and `glm-3a-start-hook` and `glm-r-skill-scopes` in meta, `resolve open questions glm` in a meta worktree, and `pac-review` in a worktree of podcast-autocutter. If the `glm-` prefix of `claude-glm` sessions is wanted, the rule needs that form, and idfix changes `nameFollowsRule` in `src/watch/conditions.ts`.
