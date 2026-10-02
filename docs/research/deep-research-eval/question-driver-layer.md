# Test question 1: a driver layer above Claude Code

This is the question that every deep research tool in the comparison gets, word for word. Gemini Deep Research (run by hand) is the reference. Paste everything below the line into the tool.

---

Research question: Which approach best fits a control layer above Claude Code (the Anthropic coding agent CLI) that drives a software implementation through all its steps to the end, steered by the values of the user, while each Claude Code session keeps a small context? Compare adopting an existing tool with building a small one. Evaluate the real effort and the known failure modes of each, not only the demo.

Current setup:
- One developer, several Linux machines (WSL2/native), several projects. Claude Code is the main agent per project. It plans, reviews, and delegates research and small coding steps to cheap sub-agents (opencode with GLM models through OpenRouter, driven by a small CLI). A large step goes to a Claude subagent in a git worktree.
- Each step ends with a hand-off: the session updates a plan file (docs/PLAN.md), the status, and the open tasks of the user, writes lessons, merges into a branch named alpha, and pushes. A new session must continue from the files alone.
- A "supervisor" Claude Code session restarts a background project session after its hand-off with the Claude Code CLI (`claude agents --json`, `claude stop`, `claude rm`, `claude --bg -n <name> "Continue with the plan."`). Nothing starts the next step automatically today. Sessions message each other with Claude Code's ListAgents and SendMessage tools.
- Reason for small sessions: a long session pays again for its whole context when its prompt cache expires, and quality drops in long contexts.

The values the layer must enforce (from the rules of the user):
- Research before a decision; the result goes into the repository.
- Review each step before implementation. Small steps, each with tests and documentation.
- Fix the structure, not the symptom. Use established libraries instead of own code.
- Hand off after each step; one step per session.
- Ask the user only for decisions about direction, money, quality, or the user's configuration. Make technical decisions with a sensible default.
- Estimate the cost before a paid run; stop on a usage limit or an authentication error.

Criteria:
1. Drives a plan to the end: picks the next step, starts it, checks the result against the values, starts the next step.
2. Each session stays small: one step per session, state in files.
3. The values are checked, not only stated (for example gates, checklists, an independent reviewer).
4. Works with the existing setup above, or names exactly what it replaces.
5. Cost per step is bounded; no runaway loops; a cost cap.
6. Robust: survives a crash, a usage limit, a stuck session; the user can watch and stop it.
7. Low maintenance for one user.

Cover at least: Claude Code's own features (Agent SDK, headless mode `claude -p`, hooks, background sessions, agent teams, plugins), community orchestrators and "loop until done" tools (for example the Ralph pattern and its implementations), workflow engines, agent platforms, and skills on skills.sh. For each candidate, give its maturity (activity, users, stability), real reports of use, and known failure modes, with sources.

Output: a report in Markdown with a criteria table, the options with gains and costs, a recommendation that names the criteria that decide it, and the open questions. Every claim links its source.
