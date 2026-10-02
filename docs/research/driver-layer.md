---
checked: 2026-10-02
recheck: 2m
decisions:
  - "build the driver as a small external loop over Claude Code sessions (fresh session per step), not as an in-session loop, a framework, or agent teams"
---

# Driver layer: what drives Claude Code to the end of a plan

Research date: 2026-10-02. Question: which approach best fits a control layer above Claude Code that drives an implementation through all its steps to the end, steered by the values of the user, while each Claude Code session keeps a small context?

Facts carry a source (URL or file with line number). Statements marked **[guess]** are my judgment. Local sources are repository files and the prior reports in `docs/research/`.

## 0. Short answers

1. The pattern the user describes has a name and a proven shape: the "Ralph" loop (Geoffrey Huntley: "Ralph is a Bash loop" — a loop that repeatedly starts a fresh agent against a plan file until a completion marker appears). The variants that use a **fresh session per iteration** with state in files match the user's values exactly; the variants that loop **inside one session** violate the small-context value. (Section 2)
2. Claude Code 2.1.285 already provides every primitive the driver needs: background sessions with a per-user supervisor (`claude --bg`, `claude agents --json`, `claude respawn`), cross-session messaging (`ListAgents`/`SendMessage`), deterministic gates (hooks, including `Stop` hooks with `type: "prompt"` and `type: "agent"`), and headless mode (`claude -p`). (Section 2.1)
3. No existing tool combines "fresh Claude Code session per step" with "values checked by deterministic gates" and "state in the project's own plan files". The closest ready-made tools are the official `ralph-wiggum` plugin (in-session, wrong shape), `stavarengo/ralph-wiggum-loop` (right shape, stale), and `mikeyobrien/ralph-orchestrator` (right shape, alpha, active). (Sections 2, 4)
4. Recommendation: a small external driver loop per project (a bash or bun script, or a systemd/tmux-supervised process) that starts one Claude Code session per step, checks the hand-off gates after each step, and starts the next — the current supervisor restart, generalized into a loop. Values are enforced inside each session by hooks; cost is capped by the loop, not by the model. (Section 6)

## 1. Criteria

From the brief and the Values section of the global rules:

1. **Drives to the end**: picks the next step, starts it, checks the result (tests, docs, review, research report), starts the next. Asks the user only for user decisions.
2. **Small sessions**: one step per session; state in files.
3. **Values checked, not stated**: enforcement mechanism named (gates, checklists, separate reviewer).
4. **Works with what exists**: Claude Code sessions, supervisor, oc-sub, plan files, git branches; or names what it replaces.
5. **Cost**: subscription/API cost per step bounded; no runaway loops; a cost cap.
6. **Robust**: survives crash, usage limit, stuck session; user can watch and stop.
7. **Low maintenance** for one user on one machine (WSL2).

## 2. What exists (state as of 2026-10-02)

### 2.1 Claude Code native primitives (v2.1.285)

Facts from the official docs:

- **Background sessions and agent view.** `claude --bg "<prompt>"` starts a full session with no terminal. A per-user supervisor process hosts the sessions; sessions survive terminal close and sleep, and stop at shutdown ([agent-view docs](https://code.claude.com/docs/en/agent-view), fetched 2026-10-02). Shell control: `claude agents --json`, `claude attach`, `claude logs`, `claude stop`, `claude respawn <id>` (restart with conversation intact), `claude rm`, `claude daemon status`. The supervisor auto-restarts a crashed session, and stops the process of a finished session after about one hour idle ([agent-view docs](https://code.claude.com/docs/en/agent-view)).
- **Auto worktree isolation.** A background session moves itself into a git worktree under `.claude/worktrees/` before its first write; removing the session deletes the worktree, so work must be committed or pushed first ([agent-view docs](https://code.claude.com/docs/en/agent-view), [multi-session handbook](https://handbook.reopt.ai/en/books/claude-code-advanced/multi-session)).
- **Rate limits.** "Background sessions consume your subscription usage the same as interactive sessions" ([agent-view docs](https://code.claude.com/docs/en/agent-view), [oflight overview 2026-05-13](https://www.oflight.co.jp/en/columns/claude-code-agent-view-parallel-orchestration-2026)).
- **Known bug relevant to the supervisor**: when a session backgrounded with custom flags (`--settings`, `--mcp-config`, `--permission-mode`, …) is respawned, the supervisor relaunches it with `respawnFlags: []` — all launch flags are silently dropped ([claude-code issue #58943](https://github.com/anthropics/claude-code/issues/58943)). Related: `claude respawn` silently fails on sessions that hit "request too large" (issue #59806, referenced there), and `claude respawn --all` was rejected as unknown option in v2.1.150 (issue #62448).
- **In-session loop scheduling**: `/loop` runs a prompt on a recurring interval ([oflight overview](https://www.oflight.co.jp/en/columns/claude-code-agent-view-parallel-orchestration-2026)).
- **Cross-session messaging**: `SendMessage` and `ListAgents` address other sessions on the machine; since v2.1.178 `SendMessage` auto-resumes a stopped agent ([iqraa guide](https://iqraa.tech/ai-genai/claude/claude-code-subagents/), [c-ai.chat overview 2026-09-17](https://c-ai.chat/claude-code/agents/)).
- **Agent teams** (experimental, `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`): a lead coordinates teammates over a shared task list and mailbox. Documented as "a poor fit for sequential work, same-file edits or anything with many dependencies"; teammates are not worktree-isolated; "teams cost considerably more tokens because each teammate is its own Claude instance"; spawning requires an interactive session ([c-ai.chat overview](https://c-ai.chat/claude-code/agents/)).
- **Hooks as deterministic gates.** Hooks "are deterministic and guarantee the action happens", unlike advisory `CLAUDE.md` ([hooks guide](https://code.claude.com/docs/en/hooks-guide)). The `Stop` hook can block the turn from ending (`decision: "block"` with a `reason` fed back to Claude), so it is a completion gate; Claude Code overrides it after 8 consecutive blocks without progress (`stop_hook_active`, `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`) ([hooks guide](https://code.claude.com/docs/en/hooks-guide)). Three gate styles per the official best practices: in-prompt check, `/goal` condition, deterministic Stop hook, or "a second opinion" — a verification subagent that refutes the result ([best practices](https://code.claude.com/docs/en/best-practices)). `type: "prompt"` hooks make an LLM call (Haiku by default); `type: "agent"` hooks spawn a subagent with up to 50 tool turns to verify against the files ([hooks guide](https://code.claude.com/docs/en/hooks-guide)).
- **Headless mode**: `claude -p "<prompt>"` runs one turn non-interactively and exits; usable as the executor of an external loop. Exit codes, `--output-format json`, and `--resume` let a script drive sessions ([cli reference](https://github.com/Claudient/Claudient/blob/main/guides/cli-reference.md); third-party, but matches the official CLI docs).
- **Known hook failure modes**: hooks fail open (any exit code other than 0 or 2 is a hook error that does not block), and exit-code-2 blocking had coverage gaps on `Write`/`Edit` ([agentpatterns.ai](https://agentpatterns.ai/instructions/enforcing-agent-behavior-with-hooks/)). A Stop gate that never clears blocks forever until the 8-block cap rescues it — the gate must delete its own trigger and check `stop_hook_active` ([hooks guide](https://code.claude.com/docs/en/hooks-guide), [captainrandom essay 2026-07-14](https://captainrandom.co.uk/learning/agentic-claude-code/hooks-deterministic-enforcement/)).

### 2.2 The Ralph family ("loop until done")

Named after Geoffrey Huntley's pattern: "Ralph is a Bash loop" — `while true; do cat PROMPT.md | claude; done`. Facts:

- **anthropics/claude-code `plugins/ralph-wiggum`** (official, MIT): `/ralph-loop "<task>" --completion-promise DONE --max-iterations 50`. Implemented as a **Stop hook in the current session**: the hook blocks exit and feeds the same prompt back. The prompt never changes; the work persists in files. The README names `--max-iterations` as the primary safety mechanism and notes the completion promise does exact string matching ([plugin README](https://github.com/anthropics/claude-code/blob/295dee881d0e1c1d0cd22fe171e4c1d07118fb04/plugins/ralph-wiggum/README.md)). **This loops inside one session — context grows each iteration.** Fails criterion 2.
- **stavarengo/ralph-wiggum-loop** (MIT, pushed 2026-02-09, low stars — immature): a Claude Code plugin with **fresh context per iteration**: the main session orchestrates, a `ralph-worker` subagent executes **one task per iteration** with a 9-step process (choose task from `fix_plan.md` → implement → test → document → update plan → commit → tag → signal `RALPH_COMPLETE`). Worker runs in `bypassPermissions`; user checkpoints every 10 iterations; `.ralph_stop` signal file; status in `status.json` ([repo](https://github.com/stavarengo/ralph-wiggum-loop)). **This is structurally the closest match to the user's workflow** (fresh context, plan file, one task per iteration, commits per task), but it is a third-party plugin that has not moved in eight months, and the worker runs with permissions bypassed.
- **mikeyobrien/ralph-orchestrator** (MIT, pushed 2026-10-02, alpha by its own docs): external loop tool, multi-backend (Claude Code, Gemini CLI, Codex, OpenCode, …). Has a **hat system** (personas coordinated by events), **backpressure gates** that reject incomplete work (tests, lint, typecheck), persistent memories/tasks, and five safety mechanisms: iteration limit (default 100), runtime limit (4 h), **cost limit ($10)**, consecutive-fails limit, and loop detection at 90 % output similarity ([docs](https://mikeyobrien.github.io/ralph-orchestrator/guide/overview/), [repo](https://github.com/mikeyobrien/ralph-orchestrator)). Its own docs say "expect occasional rough edges and breaking API/config changes between releases".
- **harrymunro/ralph-wiggum** (MIT, pushed 2026-01-29, low stars): bash loop spawning a **fresh Claude Code instance per iteration**, tasks in `prd.json` with `passes` flags, learnings appended to `progress.txt`, quality checks (typecheck, lint, test) before a story counts as passed, `TASK_COMPLETE` stop marker ([repo](https://github.com/harrymunro/ralph-wiggum)). Right shape, immature.

### 2.3 Frameworks and platforms

- **claude-flow / Ruflo** (ruvnet, MIT, npm `claude-flow` 3.38.21, ~18k weekly downloads, very active): "agent meta-harness" — MCP server, swarms with queen-led consensus, 100+ agents, vector memory, 27+ hooks, daemon ([repo](https://github.com/ruvnet/ruflo), [npm](https://www.npmjs.com/package/claude-flow)). Concerns: an independent audit profile (2026-09-15) notes the project's **own May 2026 audit rejected several headline multipliers** (the "352x" speedup "was generated rather than measured") and that policy enforcement needs `RUFLO_MCP_ENFORCE_POLICY=1` to have any effect ([rywalker.com research](https://www.rywalker.com/research/claude-flow)); user reports of v3.5.78 describe a broken execution flow ("swarm never executes") ([issue](https://github.com/ruvnet/claude-flow/issues/945)). Writes a large footprint (`.claude/`, MCP tools in every context). Fails criteria 4 and 7 for this user; the marketing claims fail the "quality first / research before assumption" value.
- **Workflow engines** (Temporal, Inngest, Restate, LangGraph): already assessed in [langgraph.md](langgraph.md) section 4 — stronger durability, but each wants its own always-on service and its own state store, and the orchestration state would then live in two places (engine and PLAN.md). Fails criterion 7 at this project's scale.
- **GUI/tmux orchestrators** (vibe-kanban — sunsetting; claude-squad — AGPL; Conductor — closed macOS; multi-agent-shogun — 1,423 stars, tmux hierarchy): all drive *parallel* agents from a human-facing UI. The driver layer here needs a *sequential, unattended* loop driven by files. Wrong layer; see [prior-art.md](prior-art.md) section 1.3 for the full list.

## 3. Design choices any driver must make

1. **Who decides the next step?** Either the driver (deterministic: it reads the plan file and picks the first open step), or the session itself (the model reads the plan and picks). Deterministic is cheaper and cannot drift; the session-driven variant handles steps whose outcome changes the plan. The existing hand-off protocol already makes the plan file the single source of next steps (AGENTS.md "Hand off after each step"), so a deterministic driver is possible today. **[judgment]**
2. **Where does state live?** All candidates that survive crashes keep state in files: plan file, task list, progress notes, git commits (ralph-wiggum-loop `fix_plan.md`/`status.json`, harrymunro `prd.json`/`progress.txt`). The project already has this: `docs/PLAN.md` + `docs/HISTORY.md` + git `alpha`. No engine-owned state needed.
3. **How is a result judged?** Options, from weak to strong (the official best practices name all of them: [best practices](https://code.claude.com/docs/en/best-practices)): (a) trust the session's report; (b) deterministic script checks (tests, typecheck, doc files exist, plan updated); (c) prompt-type Stop hook (a small model re-checks); (d) agent-type hook / separate reviewer subagent with fresh context; (e) backpressure gates that reject the step and re-drive (ralph-orchestrator). The user's values (tests and documentation part of each step, review before implementation) need (b) plus (d) — a gate a script can run, plus a reviewer that is not the author.
4. **Fresh session vs. continued session?** Fresh per step is the whole point of the hand-off protocol (cost: an old session re-pays its whole context once the prompt cache expires; quality drops in long contexts — stated in the brief and AGENTS.md). The official ralph-wiggum plugin continues one session and therefore contradicts this; the ralph-wiggum-loop and harrymunro variants spawn fresh instances per iteration.
5. **When does the driver ask the user?** The hand-off protocol already answers this: user decisions go to a named "Open tasks of the user" section; the driver stops that branch and reports, but can continue other branches. Plus a hard stop on usage limits (global rule: report, do not switch providers).
6. **Where does the loop live?** A background process on the machine (tmux/systemd on WSL2), driven by `claude --bg` / `claude -p` / `SendMessage`. A per-machine watchdog (like the meta supervisor) restarts it. Notably, Claude Code's own supervisor already restarts crashed sessions but does **not** start the next step — the loop is exactly the missing piece.

## 4. Candidates against the criteria

| # | Candidate | 1. Drives to end | 2. Small sessions | 3. Values enforced | 4. Works with existing | 5. Cost | 6. Robust | 7. Low maintenance |
|---|---|---|---|---|---|---|---|---|
| A | Status quo: per-step hand-off + manual/supervisor restart | No — restart is manual per step | Yes | Partial — gates exist (tests, review), no automated check that they ran | Yes | Good — one step per session | Yes — state in files | Yes |
| B | External driver loop (bash/bun script; fresh `claude` per step) | Yes — loop + completion marker | Yes | Yes — script checks + Stop hooks + reviewer subagent | Yes — uses existing CLI, plan files, git | Good — caps in the loop script | Yes — loop restartable, sessions stateless | Yes — ~200 lines [judgment] |
| C | Official `ralph-wiggum` plugin (Stop hook in one session) | Yes | **No — one session grows** | Partial — max-iterations only | Yes | Weak — one long session re-pays context; cache expiry | Yes | Yes — official |
| D | `stavarengo/ralph-wiggum-loop` | Yes — until `RALPH_COMPLETE` | Yes — fresh worker per task | Partial — 9-step checklist is prompt-level, not enforced; worker bypasses permissions | Partial — its own file conventions (`fix_plan.md`, `status.json`), not PLAN.md/oc-sub | Medium — checkpoints every 10 iters; no cost cap found | Medium — stop file, status.json | **No — stale since 2026-02, low stars** |
| E | `mikeyobrien/ralph-orchestrator` | Yes — gates + completion markers | Yes — fresh agent runs | Yes — backpressure gates (tests/lint/typecheck), 5 safety mechanisms incl. $10 default cap | Partial — spawns its own agent runs; no oc-sub, no opencode subagents | Good — cost cap built in | Good — checkpoints, retries, loop detection | Medium — self-declared alpha, active (pushed 2026-10-02) |
| F | Claude Code native: `claude --bg` + `/loop` + prompt Stop hook | Partial — `/loop` re-prompts one session; no step gating | No — `/loop` reuses the session | Partial — prompt hook is a model judgment, block cap 8 | Yes | Weak — subscription usage per repeat | Yes — supervisor restarts crashes | Yes — official |
| G | Agent teams | No — documented poor fit for sequential work | No — long-lived teammates | No | Partial — experimental flag, interactive-only spawn | Weak — each teammate its own instance | Weak — "task status can lag", no in-process resumption | No — experimental, flag may change |
| H | claude-flow / Ruflo | Claims yes | No — long-running swarms | No — prompt/hook soup; policy enforcement opt-in and audit-contradicted claims | **No — replaces the setup**, writes `.claude/` + MCP into every project | Unknown — no per-step accounting found | Weak — user-reported broken execution flows (v3.5.78) | **No** |
| I | Claude Agent SDK program (headless driver in TypeScript) | Yes — code controls the loop | Yes — one session per `query()` | Yes — same gates as B, plus `canUseTool` | Partial — replaces the supervisor with a program; new runtime surface | Good — caps in code | Yes — but the program itself must be supervised | Medium — a real component to maintain and version |
| J | Workflow engine / LangGraph | Yes | n/a | Yes — but engine-owned | **No** — second source of truth for state (langgraph.md §3, §5B) | Platform costs possible | Yes | **No** — new always-on service |

Evidence for each cell: sections 2 and 3; langgraph.md section 5; openhands.md (why not an agent platform: no Claude Code orchestrator story, unmaintained CLI, key model mismatch — openhands.md sections 2 and 5).

## 5. Options with gains and costs

**Option A — keep the status quo, no driver.** The user (or the meta supervisor, per restart) starts each next session. Gain: zero work. Cost: implementations stall whenever the user is away; the reason for this research stays. Not a driver layer.

**Option B — small external driver loop (recommended).** A script (bash or bun, ~200 lines [guess]) per project, run under tmux or systemd on WSL2:

1. Read the next open step from `docs/PLAN.md` (or a small `driver.json` pointer file).
2. Start a fresh Claude Code session for exactly that step: `claude --bg -n <step> --permission-mode auto "<continue the plan: step X>"` or `claude -p` with `--output-format json`.
3. Wait for the hand-off: session ends / `claude agents --json` shows completed, and the step's gates pass — tests and typecheck on the host, plan updated, docs present, merge into `alpha` done or reviewable.
4. On gate failure: restart the step once with the failure as the prompt; after a second failure, stop the branch and write it to the open-tasks section.
5. On user decision needed (marked step), skip and report.
6. Caps: max steps per day, max wall time, max cost (from `oc-sub log` totals plus Anthropic usage), consecutive-failure limit — the five ralph-orchestrator mechanisms, minus the ones oc-sub already has (`watch` loop/stall/reasoning detectors, README.md lines 210–211).

Gain: the implementations reach the end; each session stays one step; every value gate is a script, not a sentence in a prompt. Cost: one new small component to write and maintain; it duplicates nothing that exists (the Claude supervisor restarts a crashed session, it never starts the *next* step). Failure modes to design for, with sources: `respawnFlags` dropped on respawn (issue #58943) — so start each step as a **new** `claude --bg` dispatch, never rely on respawn preserving flags; hooks fail open ([agentpatterns.ai](https://agentpatterns.ai/instructions/enforcing-agent-behavior-with-hooks/)) — the driver re-runs the gates itself instead of trusting the session; Stop-hook block cap 8 — gates must be one-shot and check `stop_hook_active` ([hooks guide](https://code.claude.com/docs/en/hooks-guide)).

**Option C — adopt `mikeyobrien/ralph-orchestrator` as the loop.** Gain: ready-made caps, gates, checkpoints, multi-backend. Cost: an external tool with its own file conventions and breaking changes between alpha releases; it does not know oc-sub, opencode subagents, the hand-off protocol, or the `alpha` branch; wiring the gates to this project's values (plan updated, lessons written, research report format) would be a configuration effort comparable to writing Option B, on someone else's moving foundation. **[judgment]**

**Option D — adopt the ralph-wiggum-loop plugin.** Right structure (fresh worker per task, plan file, commit per task), but stale since February 2026, low adoption, worker bypasses permissions, and its file conventions would replace PLAN.md/HISTORY.md. Worse than B on criteria 4 and 7.

**Option E — Agent SDK program.** Option B implemented as a TypeScript program over the Agent SDK instead of CLI calls. Gain: typed control, `canUseTool`, structured output. Cost: a real runtime component where a script suffices; the CLI surface (2.1.285) is already proven by the meta supervisor. Only worth it if the driver grows real logic (branch priorities, dependency graphs between steps).

**Option F/G/H/J — rejected** by the table in section 4: F and G are wrong shapes (in-session / parallel), H fails trust and footprint, J duplicates state at engine scale the project does not have.

## 6. Recommendation

**Option B**, deciding criteria: (2) small sessions and (4) works with what exists are non-negotiable from the values; they eliminate C, F, G, H, J directly. (7) low maintenance eliminates E and, at alpha maturity with foreign conventions, C-as-ralph-orchestrator (option above). (3) values enforced decides the *shape* of the driver: it must re-run the gates itself (tests, typecheck, plan updated, docs present) after each step, and never trust the session's own completion claim — hooks fail open and models misreport; only the driver's script is deterministic. (5) cost puts the caps in the loop script, where they cannot be talked away by the model.

Concretely: generalize the existing meta supervisor restart into a per-project driver loop with the five caps; keep the hand-off protocol unchanged; the driver is a consumer of the hand-off, not a replacement for it. First version: one project, one branch, sequential steps only, no parallelism.

## 7. What I could not find out

- Whether `claude --bg` dispatches can be answered programmatically when a background session asks a question (the `waitingFor` field in `claude agents --json` marks it, but a documented programmatic answer path — equivalent of `oc-sub answer` — was not found; attach/peek is interactive). [gap]
- Current exact behavior of `/goal` conditions as an unattended completion check (named in best practices; no dedicated doc page found).
- Whether the meta supervisor's `claude --bg -n <name> --permission-mode auto` launch flags survive a supervisor-initiated restart (same class of bug as issue #58943; untested here).
- Any production report of ralph-orchestrator or ralph-wiggum-loop driving a real multi-week implementation (only self-documented alpha status found).
- Whether Claude Code subscription rate limits expose a machine-readable remaining-quota value the driver cap could read (not found; the oflight overview only says usage consumes quota linearly).

## 8. Search log

- `websearch`: "Claude Code agent teams background sessions claude respawn orchestration 2026" — 8 relevant hits (official agent-view docs, hooks, guides).
- `websearch`: "Claude Code autonomous loop until done orchestrator Ralph Wiggum pattern" — 6 highly relevant hits (official plugin, orchestrators, variants).
- `websearch`: "claude-flow ruvnet swarm orchestrator 2026" — 6 relevant hits (repo, npm, audit profile, issue).
- `websearch`: "Claude Code hooks Stop hook deterministic gates documentation" — 7 relevant hits (official hooks docs and best practices, failure-mode essays).
- `gh search repos "claude code orchestrator"` — 20 hits, 2 relevant beyond known ones (multi-agent-shogun, praktor); `gh search repos "claude code autonomous loop"` — 2 hits, irrelevant.
- `gh api repos/<name>` activity checks: stavarengo/ralph-wiggum-loop (2026-02-09), mikeyobrien/ralph-orchestrator (2026-10-02), harrymunro/ralph-wiggum (2026-01-29), yohey-w/multi-agent-shogun (2026-08-06).
- Not searched: skills.sh and the MCP registry (the driver is a loop over existing CLIs, not a tool to install — [judgment]; can be added on recheck if a skill-based driver appears).

## 9. Sources

- https://code.claude.com/docs/en/agent-view (fetched 2026-10-02)
- https://code.claude.com/docs/en/hooks and https://code.claude.com/docs/en/hooks-guide (fetched 2026-10-02)
- https://code.claude.com/docs/en/best-practices (fetched 2026-10-02)
- https://github.com/anthropics/claude-code/blob/295dee881d0e1c1d0cd22fe171e4c1d07118fb04/plugins/ralph-wiggum/README.md (fetched 2026-10-02)
- https://github.com/anthropics/claude-code/issues/58943, #59806, #62448 (fetched 2026-10-02)
- https://github.com/stavarengo/ralph-wiggum-loop ; https://github.com/mikeyobrien/ralph-orchestrator and https://mikeyobrien.github.io/ralph-orchestrator/guide/overview/ ; https://github.com/harrymunro/ralph-wiggum (all fetched 2026-10-02)
- https://github.com/ruvnet/ruflo ; https://www.npmjs.com/package/claude-flow ; https://www.rywalker.com/research/claude-flow ; https://github.com/ruvnet/claude-flow/issues/945 (fetched 2026-10-02)
- https://c-ai.chat/claude-code/agents/ (2026-09-17) ; https://iqraa.tech/ai-genai/claude/claude-code-subagents/ ; https://handbook.reopt.ai/en/books/claude-code-advanced/multi-session ; https://www.oflight.co.jp/en/columns/claude-code-agent-view-parallel-orchestration-2026 (2026-05-13) ; https://agentpatterns.ai/instructions/enforcing-agent-behavior-with-hooks/ ; https://captainrandom.co.uk/learning/agentic-claude-code/hooks-deterministic-enforcement/ (2026-07-14) ; https://github.com/Claudient/Claudient/blob/main/guides/cli-reference.md
- Local: AGENTS.md (repo and meta); docs/PLAN.md; docs/research/langgraph.md; docs/research/openhands.md; docs/research/prior-art.md; docs/research/subagent-questions.md; README.md (oc-sub watch guards, lines 210–211)
