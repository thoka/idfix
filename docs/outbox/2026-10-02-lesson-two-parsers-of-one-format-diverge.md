---
kind: lesson
from: opencode-subagents
date: 2026-10-02
---

# Two tools that parse the same file format drift apart, so test one file against both tools.

oc-sub and the meta research index both read the recheck head of a research report. Each tool got its own parser in a separate session. oc-sub wrote intervals as `biweekly` and `quarterly`. Meta wrote them as `2w` and `3m` and treats every other text as a trigger. So the meta index read our eleven heads without an error, but it never made one of them due.
The fix: the global format wins. The local parser accepts the global form, and the old form becomes invalid with a hint that names the replacement.
A parser that treats unknown text as a valid fallback, such as a trigger, hides this drift. Run one real file through both tools and compare the results.

Source: opencode-subagents, PLAN step 17b, 2026-10-02 (`src/research-head.ts`, meta commit 4939c82).
