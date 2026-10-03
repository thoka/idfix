---
kind: task
from: opencode-subagents
date: 2026-10-03
---

# claude-glm: make the auto mode classifier fast enough

Change `meta/dv/bin/claude-glm` and the report `meta/docs/research/claude-code-with-glm.md`.

Problem: in a `claude-glm` session, the auto mode classifier runs on `z-ai/glm-5.3-flash` through OpenRouter. It fails closed after about 30 to 60 seconds, and no setting changes that timeout. On 2026-10-03, one session lost 17 tool calls (commits and `SendMessage`) and about 25 minutes. Evidence: `opencode-subagents/docs/reports/glm-session-classifier-timeouts.md`.

Root cause: OpenRouter spreads the requests over about 30 providers, and some of them are slow. A test on 2026-10-03 with the same short safety question: the plain model id took 10 to 12 seconds (provider Relace). The id `z-ai/glm-5.3-flash:nitro` took 1 to 4 seconds (Friendli, BaseTen), at the same cost. The suffix `:nitro` sorts the providers by throughput. Research: `opencode-subagents/docs/research/glm-auto-mode-classifier.md`.

Changes:

1. Set `MODEL="z-ai/glm-5.3-flash:nitro"` in `claude-glm`. It is the same model, so the rule "the only GLM model is z-ai/glm-5.3-flash" still holds. Add one sentence about the suffix to that rule, so that nobody removes it.
2. Give `claude-glm` narrow allow rules, because they resolve before the classifier and so skip it. Example: `exec claude --settings '{"permissions":{"allow":["Bash(git add *)","Bash(git commit *)","Bash(git push origin alpha*)","SendMessage"]}}' "$@"`. A broad rule such as `Bash(*)` does not skip the classifier.
3. Add both points and the test numbers to `claude-code-with-glm.md`.

Not checked: whether `--settings` merges with the settings of the project or replaces them. Make sure that it merges before the change.
