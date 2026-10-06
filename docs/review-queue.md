# Review queue

Decisions that a session made from the canon of values. Newest entry first.

## 2026-10-06: open points of step 25g.1

- Decision: `waitingFor` keeps the full `needs` text, also a URL of a key management page. It holds no key, and it is the text that Claude Code shows the user. `claude-glm` sessions stay without a price until the GLM features come back, then an `openrouter/` prefix lookup in LiteLLM can price them. A blocked background job shows as `waiting` until `claude rm`, as in `claude agents`, because it is work that waits for a decision. A session with one unknown model gets no price, not a partial sum.
- Values: one state in one place (the same list as `claude agents`). Deliver first. Secrets stay protected (no key reaches the output).
- Conditions: Claude Code 2.1.285. If old blocked jobs fill the list, an age rule is open again.

## 2026-10-06: technical defaults of the design of step 25g

- Decision: idfix reads the Claude Code files only and does not run `claude agents --json`. Prices and model windows come from the cached LiteLLM price file, at most one download per 24 hours. An ended Claude session gets a new row state `ended`. The `ctx` cell shows the size and the share of the window, for example `123k 62%`. The design is [claude-sessions-top.md](design/claude-sessions-top.md).
- Values: use the platform and established data before own tables (LiteLLM, as ccusage does). Cache expensive work. Deliver first: no proxy and no hooks for this slice.
- Conditions: Claude Code 2.1.285 file formats. If `claude agents --json` gives data that the files lack, or if the LiteLLM file goes away, the decision is open again.

## 2026-10-04: step 23 is paused, step 32 is dropped

- Decision: step 32 (an sbx sandbox for each runner job, spike 32c) is dropped. Step 23 (Claude Code subagents inside the sbx sandbox) is paused, and Claude subagents run on the host in worktrees. The read side of step 23 moves to step 25g. The key hygiene of the proxy (driver-layer design, section 2.5) stays, because it protects keys.
- Values: our agents cooperate, and no protection work happens without a feature goal (meta 384ff44). Secrets and keys stay protected.
- Conditions: the rule of meta 384ff44. If the user wants isolation again, for example for jobs of other people on the runner, the decision is open again.
