# Review queue

Decisions that a session made from the canon of values. Newest entry first.

## 2026-10-04: step 23 is paused, step 32 is dropped

- Decision: step 32 (an sbx sandbox for each runner job, spike 32c) is dropped. Step 23 (Claude Code subagents inside the sbx sandbox) is paused, and Claude subagents run on the host in worktrees. The read side of step 23 moves to step 25g. The key hygiene of the proxy (driver-layer design, section 2.5) stays, because it protects keys.
- Values: our agents cooperate, and no protection work happens without a feature goal (meta 384ff44). Secrets and keys stay protected.
- Conditions: the rule of meta 384ff44. If the user wants isolation again, for example for jobs of other people on the runner, the decision is open again.
