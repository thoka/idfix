---
checked: 2026-10-02
recheck: 3m
decisions:
  - "whether oc-sub adopts LangGraph for any part (expected: no)"
---

# LangGraph and oc-sub: what could gain, what could not

Research date: 2026-10-02. Question: which parts of oc-sub plus its Claude Code skill could gain from LangGraph, and which could not?

Facts carry a source. Statements marked **[guess]** are my judgment.

## Criteria

- Does a LangGraph feature cover the part, with evidence?
- Cost of an integration: new runtime (LangGraph is Python/JS; oc-sub is TypeScript on bun), new dependencies, rewrite of working code.
- Fits the architecture: Claude Code is the main thread; opencode already runs the agent loop; oc-sub is a thin CLI over the opencode HTTP/SSE API (README.md, `src/cli.ts`).
- Small dependency footprint: the plugin ships to other projects through a marketplace; the launcher installs locked dependencies on first call (README.md "Plugin layout").
- License and cost: MIT and no paid service preferred (project is MIT, README.md).
- Activity of the project (maintained, current).

## 1. Current state of LangGraph (2026-10-02)

- **What it is**: a stateful agent/workflow runtime. The core ideas: a graph of nodes, state saved as checkpoints at each super-step, threads keyed by `thread_id`, durable execution (resume after crash or pause), and `interrupt()` for human-in-the-loop pauses ([checkpointing docs](https://docs.langchain.com/oss/python/langgraph/checkpointers), [interrupts docs](https://docs.langchain.com/oss/python/langgraph/interrupts), both fetched 2026-10-02).
- **Versions**: Python `langgraph` 1.2.12 on PyPI (checked via PyPI JSON API, 2026-10-02). JavaScript `@langchain/langgraph` 1.4.18 on npm (checked via `npm view`, 2026-10-02). LangGraph 1.0 shipped 2025-10-22 with a no-breaking-changes promise until 2.0 ([Medium/a8gent summaries](https://a8gent.com/platforms/langgraph), [A8gent](https://a8gent.com/platforms/langgraph)).
- **License and activity**: MIT, 42,619 stars, pushed 2026-10-02 (same day), 819 open issues. Source: GitHub API `repos/langchain-ai/langgraph` (2026-10-02). Actively maintained.
- **Checkpointing / durable execution**: a checkpointer saves graph state at every super-step; three durability modes (`exit`, `async`, `sync`); resume is from checkpoints; pending per-task writes let a failed node resume without re-running successful sibling nodes. Checkpointers exist for memory, SQLite, Postgres, Mongo, and others via the `BaseCheckpointSaver` interface ([checkpoint docs](https://docs.langchain.com/oss/python/langgraph/checkpointers), [libs/checkpoint README](https://github.com/langchain-ai/langgraph/blob/5931a5f0/libs/checkpoint/README.md)).
- **Human-in-the-loop**: `interrupt(payload)` suspends the graph, persists state, and waits indefinitely; resume with `Command(resume=value)` and the same `thread_id`. The node restarts from its beginning on resume, so code before `interrupt()` runs again ([interrupt docs](https://docs.langchain.com/oss/python/langgraph/interrupts)). A HITL middleware for tool approval exists in LangChain 1.x ([LangChain HITL docs](https://docs.langchain.com/oss/python/langchain/human-in-the-loop)).
- **Streaming**: typed streaming (`stream_events` v3) surfaces message deltas, per-step state snapshots, and interrupts ([interrupt docs](https://docs.langchain.com/oss/python/langgraph/interrupts); [Interrupt 2026 overview](https://www.langchain.com/blog/interrupt-2026-overview)).
- **Hosted parts**: the managed runtime is now "LangSmith Deployment" (formerly LangGraph Platform). The framework itself is free and MIT. Managed deployment requires LangSmith Plus at $39/seat/month; beyond one free small serverless deployment, compute is metered in LCUs ($1.50) and LSUs ($1.00). Self-hosting the managed control plane is Enterprise-only. ([LangChain pricing page](https://www.langchain.com/pricing-langsmith), [truefoundry breakdown, 2026-08-27](https://www.truefoundry.com/blog/langgraph-pricing), [markaicode, 2026-09-01](https://markaicode.com/pricing/langgraph-pricing-comparison/)).
- **LangSmith tracing**: SaaS observability. Free Developer tier: 1 seat, 5,000 base traces/month, 14-day retention. Plus: $39/seat, 10,000 base traces/month. ([LangChain pricing page](https://www.langchain.com/pricing-langsmith)). The trace-analysis product line (Insights, Engine) was already reviewed in [trace-analysis.md](trace-analysis.md) section 2: proprietary SaaS, no opencode read path.
- **Managed Deep Agents** (announced at Interrupt, 2026-05-14): a hosted runtime for deep agents with durable threads, checkpointing, HITL, sandboxed code execution, and subagent delegation ([LangChain blog](https://www.langchain.com/blog/interrupt-2026-overview)). This is the closest LangChain offering to what oc-sub does — but it is a hosted service that would replace, not extend, opencode.

## 2. Part-by-part assessment

The runtime mismatch frames every row: oc-sub is TypeScript on bun, a stateless CLI whose commands start, exit, and are re-run by Claude Code (README.md "Layout"). LangGraph wants to own a long-running process that holds graph state in memory or a checkpointer. Using LangGraph means either adding the JS package (`@langchain/langgraph`, plus `@langchain/core`) into the plugin bundle, or running a separate Python service next to the opencode server.

| oc-sub part | What it does today | LangGraph feature that covers it | Verdict |
| --- | --- | --- | --- |
| Run state (run records in `.opencode/runs/`, `src/runs.ts`) | JSON file per run, plus a copy in the state folder | Checkpoints / threads could hold this state | **No gain.** The state is one small file; opencode itself already persists the session. A graph runtime to store it is overhead. [guess] |
| Watch loop (`src/watch.ts`, SSE + 2 s poll) | Follows the opencode event stream, prints lines, ends on idle or pause | Typed streaming; a graph node could consume events | **No gain.** The loop is already event-driven and ~200 lines of plain code. LangGraph streaming streams *its* graph, not opencode's SSE; it adds nothing to reading a foreign stream. [guess] |
| End detection / settled race (`src/settled.ts`) | Pure function deciding if a missing session has ended | Not covered — no LangGraph feature names this | **No fit.** This is opencode-server-specific knowledge, not workflow state. |
| Warning signs: loop, stall, reasoning (`src/detect.ts`) | Pure detectors over the event stream; exit code 4 | No direct feature. LangGraph has no built-in loop/stall detection; its "durable execution" assumes the graph works, not that it misbehaves | **No fit.** These are detectors over an external agent's behavior. LangChain's *paid* LangSmith Engine does failure analysis, but as SaaS over traces with no opencode read path (trace-analysis.md section 2). [fact + judgment] |
| Permission answers (`src/answer.ts`, `src/requests.ts`) | Lists `GET /question` and `GET /permission`, posts replies | `interrupt()` / HITL middleware pause-and-resume | **Pattern matches, mechanism does not.** opencode already implements exactly this pattern server-side: pause, list pending, reply resumes (subagent-questions.md sections 1 and 4). LangGraph's interrupt would only help if *the graph itself* asked the question. Here the opencode agent asks, and LangGraph would only relay the answer — a pass-through, not a checkpoint owner. [judgment] |
| Trace analysis (`src/trace.ts`, `src/jev.ts`) | Cuts sessions into steps, tags with Jev | LangSmith Insights/Engine is the LangChain answer | **No fit for LangGraph itself.** LangSmith Engine does trace tagging and root-cause analysis, but it is proprietary SaaS billed in LCUs, sends our code traces to a vendor cloud, and cannot read opencode sessions (trace-analysis.md section 2). Our Jev pipeline is cheaper per run (≈ $0.00003/step, PLAN.md step 18) and local. [judgment] |
| Cost accounting (`src/summary.ts`, `src/realcost.ts`, proxy) | Token sums + real cost from OpenRouter/proxy log | Not covered | **No fit.** Pure accounting over provider responses; no workflow. |
| Multi-step orchestration across several subagents | Claude Code is the orchestrator; the skill encodes the workflow; `oc-sub` executes single steps | This is the one real LangGraph use case: a durable graph that runs step → watch → review → follow-up, survives a crash, and pauses for HITL between subagents | **Covers it, at a cost.** See options below. The gain is durability of the *orchestration* only — Claude Code sessions already persist and resume, and each step is handed off through files (AGENTS.md "Hand off after each step"). [judgment] |
| Server lifecycle (`up`/`down`/`restart`, `src/up.ts`) | PID files, signals, sandbox handling | Not covered | **No fit.** Process management, not agent state. |
| Doctor / checks (`src/doctor.ts`) | Registry of checks with fixes | Not covered | **No fit.** |
| Skill (`skills/oc-sub/SKILL.md`) | Instructions for Claude Code | Not covered | **No fit.** Prompt text, not code. |
| `oc-sub top` (`src/top/`) | Live TUI over all sessions | Not covered | **No fit.** |

## 3. Where LangGraph does not fit, structurally

1. **The agent loop already has an owner.** opencode runs the model loop, tools, permissions, and subagent sessions. LangGraph's core value — durable execution *of an agent loop* — duplicates what opencode does. Wrapping opencode runs in LangGraph nodes would checkpoint a state that the opencode server already holds. (prior-art.md section 2 documents opencode's session persistence; subagent-questions.md section 1 documents its pause machinery.)
2. **The orchestrator is Claude Code, an interactive process with its own resume model.** oc-sub's design hands off after each step through files, so a crashed Claude session loses at most one step (AGENTS.md "Hand off after each step"). LangGraph's durability would buy back less than it costs: a long-running LangGraph server would have to live somewhere, outlive Claude sessions, and be restarted itself — the same operational problem `oc-sub up` already solves for opencode, now twice.
3. **The CLI shape is a feature.** Each `oc-sub` command is a short-lived process that exits with a code Claude Code reads. That is how background tasks, exit codes 3 and 4, and the review flow work. A LangGraph graph runs inside a resident process; adopting it changes the deployment model of the plugin, which today installs as pure files plus a bun bundle (README.md "Plugin layout").
4. **Paid parts are the wrong shape for a cost-sensitive tool.** Managed deployment needs LangSmith Plus at $39/seat/month, and LangSmith tracing sends run content to a vendor cloud ([pricing](https://www.langchain.com/pricing-langsmith)). oc-sub exists to run cheap GLM runs with local cost accounting; per-run platform cost above the model cost defeats the goal. [judgment]
5. **Runtime mismatch.** LangGraph JS exists (`@langchain/langgraph` 1.4.18), so bun could run it. But it pulls the `@langchain/core` stack into the plugin's locked dependencies, and the graph then must be hosted (a long-running bun process with a checkpointer store — SQLite at minimum) for durability to mean anything. Without that host, LangGraph is just an in-process state machine that dies with the CLI call — no better than the current code. [judgment]

## 4. Alternatives of the same class (short)

Checked only against the criteria where they beat LangGraph:

- **Inngest / Temporal / Restate** (durable workflow engines): stronger durable execution than LangGraph, but heavier — each wants its own service. Worse on the "small dependency footprint" criterion. Not examined in depth.
- **Plain state files + Claude Code hand-off** (what oc-sub does now): zero runtime, survives crashes at step granularity. Wins every criterion except mid-step resume.
- **OpenAI Agents SDK `RunState`**: serializes a paused run to JSON and resumes it (subagent-questions.md section 3.5) — a lighter durable-HITL pattern, but it owns the agent loop, so it cannot wrap opencode either.
- No alternative was found that wraps *foreign* agent sessions (opencode) durably. The orchestration state for this project already lives in run records, plans, and Claude Code itself. [judgment, based on prior-art.md section 1 and subagent-questions.md section 3]

## 5. Options

**Option A — no LangGraph (recommended).**
- Gain: none lost; no new dependency; the plugin stays files + one bun bundle; cost stays at model tokens only.
- Cost: none now. Known gap that remains: if the machine dies mid-run, the opencode run keeps going or dies with the sandbox; the orchestrator restarts from the plan. Today that is acceptable because runs cost cents (EXPERIENCE.md, per-run costs well under a dollar).
- Deciding criteria: dependency footprint, architecture fit, cost. LangGraph covers no part better than the existing code (section 2).

**Option B — LangGraph as an experiment for a durable multi-run orchestrator.**
- Build a small Python or bun service: a graph with one node per plan step (worktree → run → watch → review → merge hand-off), checkpoints in SQLite, `interrupt()` where a permission answer or a user decision is needed, streaming for the watch output.
- Gain: the orchestration survives a Claude Code crash at sub-step granularity, and the pause/resume of follow-ups becomes explicit state instead of exit codes and files. This is the only part where a LangGraph feature genuinely covers a need (section 2, last row).
- Cost: a second always-on-ish process next to the opencode server; `@langchain/langgraph` + `@langchain/core` or a Python runtime via mise; a rewrite of the skill's workflow logic into graph nodes; two sources of truth for "which step is running" (graph state vs. PLAN.md/run records); paid LangSmith is optional and skippable.
- Deciding criteria: covers the multi-step criterion, fails dependency footprint and cost-at-scale for a tool whose runs cost cents. [guess] that the durability gain is worth it only if runs become long (hours) and many.

**Option C — LangSmith tracing/Engine instead of the Jev pipeline.**
- Gain: ready-made failure taxonomy and root-cause grouping (trace-analysis.md section 2).
- Cost: SaaS, $39/seat beyond 10k traces, sends code and transcripts to a vendor cloud, no opencode read path (needs a converter). Fails the cost, privacy, and criteria-fit tests decisively. Listed for completeness; not recommended.

## 6. What I could not find out

- Whether LangGraph JS on bun is officially supported (bun is not named in the docs I read; Node is). Unverified.
- The current exact naming and boundaries of LangGraph Platform vs. LangSmith Deployment vs. Fleet — the sources disagree on naming (rebrand in progress, [truefoundry 2026-08-27](https://www.truefoundry.com/blog/langgraph-pricing), [pricing page](https://www.langchain.com/pricing-langsmith)).
- Whether any existing project wraps opencode (or another CLI agent) as LangGraph nodes — I did not search GitHub specifically for this; a quick check would be `gh search repos "langgraph opencode"`.
- Real-world failure modes of LangGraph interrupt/checkpoint under version upgrades (the 2.0 no-breaking-changes promise ends somewhere); sources describe the promise, not its track record.

## 7. Sources

- https://docs.langchain.com/oss/python/langgraph/checkpointers (fetched 2026-10-02)
- https://docs.langchain.com/oss/python/langgraph/interrupts (fetched 2026-10-02)
- https://docs.langchain.com/oss/python/langchain/human-in-the-loop (fetched 2026-10-02)
- https://github.com/langchain-ai/langgraph/blob/5931a5f0/libs/checkpoint/README.md (fetched 2026-10-02)
- GitHub API `repos/langchain-ai/langgraph` (2026-10-02): MIT, 42,619 stars, pushed 2026-10-02, 819 open issues
- PyPI JSON `pypi.org/pypi/langgraph/json` (2026-10-02): latest 1.2.12
- npm `view @langchain/langgraph` (2026-10-02): 1.4.18
- https://www.langchain.com/pricing-langsmith (fetched 2026-10-02)
- https://www.langchain.com/blog/interrupt-2026-overview (2026-05-14)
- https://www.truefoundry.com/blog/langgraph-pricing (2026-08-27)
- https://markaicode.com/pricing/langgraph-pricing-comparison/ (2026-09-01)
- https://a8gent.com/platforms/langgraph (August 2026 data)
- Local: README.md, docs/GUIDE.md, docs/PLAN.md, docs/research/prior-art.md, docs/research/subagent-questions.md, docs/research/trace-analysis.md, src/ layout
