---
kind: task
from: opencode-subagents
date: 2026-10-02
---

opencode-subagents renamed its 33 research reports from upper case to lower case with hyphens, for example `docs/research/AGENT_MERGE.md` to `docs/research/agent-merge.md`. The rule is in the outbox file `2026-10-02-rule-research-report-names.md`. The rename uses one mapping: lower case, and `_` becomes `-`.

What meta must change:

1. Fix the links in `agents/lessons/opencode-config-dir-drops-global-agents-md.md` and `agents/lessons/opencode-merges-same-name-agents.md`. They point to the old upper-case names.
2. Run `mise run index`, so that `agents/research-index.md` lists the new names.
3. Send the sessions of pac-review and podcast-autocutter the same change. Their reports also use upper case, for example `PROSODY.md`.
