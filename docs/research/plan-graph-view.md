---
checked: 2026-10-03
recheck: 3m
decisions:
  - "plan graph view: plan format, ranking score, rendering stack"
---

# A graph view for plan files, round 2

Round 1 is `plan-graph-tools.md` in the same folder. It picked "build a thin view" and left
four gaps. This report closes them: plan formats, ranking methods, the MVP path, rendering
libraries, and agent mission-control projects. The four sample plans in
`.opencode/context/plans/` (grata, markgraf, meta, opencode-subagents) are the test input.

## Criteria

- Plan stays readable prose Markdown in git. No own database, no tool lock-in.
- Dependencies and open decisions become machine-readable with little edit work.
- Ranking of decisions is explainable: the user can see why a question is on top.
- MVP path to a milestone is visible as a marked path in the graph.
- 20 to 300 nodes render as a readable layered graph with click, highlight, and collapse.
- Live reload when `PLAN.md` changes.
- Bun and TypeScript, small build, established libraries, MIT or permissive license.
- First three steps each give the user something to open in a browser.

## Short answers

1. Plan format. Established tools solve this either by dropping prose (beads stores issues
   as JSONL and calls Markdown plans the problem) or by keeping one task per Markdown file
   with a fixed ID and dependency fields (Backlog.md). Org-mode keeps prose but only
   supports hierarchy and sibling order, not free cross-references. For our plans the best
   fit is a small grammar inside `PLAN.md`: a `depends:` line under each step heading and a
   `decision:` marker for open questions. A sidecar file drifts; LLM extraction alone is
   unstable. See question 1.
2. Ranking. Only beads_viewer ranks, with PageRank, betweenness, HITS, and critical path.
   `bd ready` does not rank, it only filters to unblocked work. The explainable choice is
   blocked-work count: for each open decision, count the steps that it transitively blocks.
   It answers the user question directly. PageRank does not. See question 2.
3. MVP path. The minimal set of steps to a milestone is the set of all ancestors of the
   milestone node in the DAG. The longest path through that set is its critical path. No
   npm library computes this; it is about 20 lines on a topological order, or use
   graphology-dag. See question 3.
4. Rendering. React Flow (`@xyflow/react`, MIT, about 60 kB gzip) plus elkjs (EPL-2.0,
   about 433 kB gzip) for the layered layout. React Flow has first-party ELK and dagre
   examples, selection hooks, and an expand-and-collapse example. Cytoscape.js is the
   React-free alternative. Mermaid stays the zero-build fallback from round 1. See
   question 4.
5. Mission control. None of the projects read (agent-os, ironclaw, CoWork-OS, AgentTeams,
   Crystal, Vibe Kanban, claude-squad, Gastown) shows a plan graph or ranks decisions.
   Gastown and beads are the strongest source of ideas: a dependency-aware graph ledger
   with `bd ready` and dependency validation. See question 5.
6. skills.sh. New queries ("roadmap", "decision", "dependencies", "milestone", "mvp")
   found no skill that keeps a plan machine-readable or ranks decisions. The closest is
   `decision-mapping` (mattpocock/skills, 45041 installs), which I could not read
   (404 on the guessed path). See question 6.
7. Recommendation. Grammar in `PLAN.md`, blocked-work count as the score, ancestor-set
   plus longest path for the MVP route, React Flow plus elkjs for the view, and three
   first steps that each open in a browser. See the last section.

## Details

### Question 1: plan formats

**beads (gastownhall/beads)**, read 2026-10-03 (README and `docs/CLI_REFERENCE.md`).
27610 stars, MIT, pushed 2026-10-03. This is the core repository that round 1 could not
find; it moved to the `gastownhall` organization. The README states the position directly:
"Beads ... replaces messy markdown plans with a dependency-aware graph". Data lives in a
Dolt database; `.beads/issues.jsonl` is an export in git. Dependencies are edges
(`bd dep add <child> <parent>`). `bd ready` shows "open issues with no active blockers",
through a `GetReadyWork` API. No ranking in `bd ready`. `bd swarm validate` checks an
epic's dependency graph for orphans, cycles, and disconnected subgraphs, and reports
"Ready fronts (waves of parallel work)" and "Maximum parallelism".

**Backlog.md (MrLesk/Backlog.md)**, read 2026-10-03 (README). 6933 stars, MIT, pushed
2026-09-28. One plain Markdown file per task under `backlog/`, IDs like `BACK-1`. The
README promises "Milestones and dependencies, structure bigger efforts and make execution
order reviewable, with task detail showing what a task waits on and what waits on it".
Decisions are documents, searchable. The README warns: "prefer Backlog.md commands over
hand-editing task files, so field types and metadata stay consistent". This is the known
weak point of a Markdown-plus-fields format: agents must keep fields correct.

**Taskwarrior**, read 2026-10-03 (taskwarrior.org docs and the task RFC on GitHub).
The `depends` attribute is "a string containing a comma-separated unique set of UUIDs.
If task 2 depends on task 1, then it is task 1 that must be completed first". Tasks are
database records, not prose. The dependency idea is the same as ours; the storage is not.

**org-mode**, read 2026-10-03 (orgmode.org manual, section TODO dependencies).
Dependencies come from structure: "a parent TODO task should not be marked as done until
all TODO subtasks ... are marked as done", and the `ORDERED` property blocks a child until
"all earlier siblings are marked as done". Good for hierarchy, weak for cross-references
between distant steps. Our plans need cross-references (meta step 4 needs step 25 of
another project).

**MADR (adr/madr)**, read 2026-10-03 (README and template). One decision per file
`nnnn-title.md`, with optional YAML front matter (`status`, `date`, and more), sections
for context, decision drivers, considered options, and decision outcome. The template has
"no built-in task linkage". Good model for how we record a decision, not for the graph.

**Comparison of the three ways for our plans.**

Our four samples are prose with numbered `###` step headings, lettered sub-steps
(`25b`, `1h`), dependencies in sentences ("starts when the user has Claude Max",
"waits for meta step 4"), sections "Open for the user" or "Open tasks of the user",
"Later", and "Default decisions, open for a change by the user".

- (a) Small fixed grammar in `PLAN.md`. Each step heading gets one optional line
  `depends: 23, meta-4` right under the heading. Each open decision gets a marker line
  such as `decision: blocks 7b, 7f` (or the parser infers blocking from decision
  references in step text). The prose stays. Edits are one line per step.
  Cost for the samples: opencode-subagents needs about 12 lines, meta about 10, markgraf
  about 4, grata about 3. [guess] The parser is lenient: a missing line means no
  dependency, and the view shows what it did not understand.
- (b) Sidecar file (YAML or JSON) next to `PLAN.md`. Zero change to the plans at first.
  But the data has two homes, and Backlog.md names the failure: hand-edited fields drift
  from the canonical source. Our agents write the plans, so they would have to update two
  files, and a stale sidecar silently lies in the graph. Needs a check that fails on
  drift (a rule needs a check). More machinery for the same data.
- (c) LLM extracts the graph from the prose. Zero change to the plans, and it works on
  the existing text today. Cost with `z-ai/glm-5.3-flash` is low (about 0.01 to 0.05 USD
  per plan, from the real costs of similar runs in meta step 7). Instability is the risk:
  the same prose can give different edges across runs, and meta step 4-pre already learned
  that a quote gate (every claim must exist word for word in the source) is needed.
  Cache by section hash so only changed sections re-extract. Best used as an assist: the
  LLM proposes `depends:` lines, the user or main thread accepts them, and they land as
  (a).

Decision: (a) as the source of truth, (c) as a one-time and on-demand helper that writes
the (a) lines into the file. This matches round 1 ("PLAN.md needs a short grammar section").

### Question 2: ranking

- beads_viewer: PageRank, betweenness, HITS, and critical path scores in its triage view
  (round 1, read 2026-10-03). These are graph-central scores. They answer "which node is
  structurally central", not "which answer unlocks the most work".
- `bd ready`: no ranking, only a filter to unblocked work (CLI reference, read
  2026-10-03). Its useful idea is dependency validation with ready fronts.
- CPM (critical path method): the longest path in the DAG. Textbook method, no library
  needed in JS beyond a topological sort.
- Transitively blocked count: for node X, the number (or total weight) of nodes that
  cannot start before X resolves. This is the direct answer to "which question blocks the
  most work".
- Value-of-information: formal but needs probability and value estimates per decision.
  Too heavy for a first version. [guess]

Recommendation: one score, `blocked = number of open, unfinished steps that transitively
depend on the decision`. Show it as a plain number in the node tooltip and sort the
decision list by it. Break ties by whether the decision sits on the critical path. This is
explainable in one sentence, cheap to compute, and beads_viewer is the proof that richer
scores are not needed to be useful.

### Question 3: shortest path to an MVP

- Walking skeleton and tracer bullets: build the thinnest end-to-end slice first.
  The `to-tickets` skill of mattpocock/skills (round 1, 590k installs) turns plans into
  "tracer-bullet tickets, each declaring its blocking edges". The idea marks the path, the
  DAG computes it.
- CPM: longest path from a start node to the milestone node gives the schedule-critical
  chain inside the milestone's ancestor set.
- Minimal set: in a DAG, the milestone needs exactly its ancestors (all nodes with a path
  to it). Compute with a reverse reachability walk from the milestone.
- Libraries: `graphology` 0.26.0 (MIT, published 2025-01-26) and `graphology-dag` 0.4.1
  (MIT, published 2023-12-09) give topological helpers. npm search for "critical path dag"
  found no dedicated CPM library (search 2026-10-03). The longest path on a topological
  order is about 20 lines of TypeScript. Use graphology for the graph data structure and
  hand-roll the two walks.

### Question 4: rendering

Data from the npm registry and bundlephobia API, 2026-10-03. "gzip" is the bundlephobia
gzip size of the latest version.

| Library | Version | License | Last publish | gzip | React needed | Role |
|---|---|---|---|---|---|---|
| @xyflow/react | 12.12.0 | MIT | 2026-09-24 | 60 kB | yes | render, interaction |
| elkjs | 0.12.0 | EPL-2.0 OR GPL-3.0 | 2026-07-17 | 433 kB | no | layered layout |
| @dagrejs/dagre | 3.1.1 | MIT | 2026-08-08 | 16 kB | no | layered layout (simpler, weaker) |
| d3-dag | 1.2.2 | MIT | 2026-07-05 | n/a | no | layered layout, render yourself |
| cytoscape | 3.34.3 | MIT | 2026-09-07 | 137 kB | no | render + graph, layout via extension |
| mermaid | 12.1.0 | MIT | 2026-10-02 | 173 kB | no | text to SVG, ELK layout |
| sigma | 3.0.3 | MIT | 2026-04-30 | 26 kB | no | WebGL, for thousands of nodes |

Notes from the docs (read 2026-10-03 through the page reader):

- React Flow: MIT, requires React. Built-in pan, zoom, drag, selection; interaction hooks
  (`useOnSelectionChange`) for click and highlight. First-party examples for elkjs and
  dagre layouts, and an "Expand and Collapse" example for groups. It renders and
  interacts; the layout engine computes positions.
- elkjs: layout only ("elkjs is not a diagramming framework itself"), layer-based
  Sugiyama layout is its flagship, Web Workers supported. EPL-2.0 (or GPL) is permissive
  for use in our tool. At 433 kB gzip it is the biggest part of the bundle; dagre at
  16 kB is the cheap fallback but handles wide graphs worse.
- Cytoscape.js: pure JS, no external dependencies, MIT core and first-party extensions;
  dagre and ELK layouts are separate extension repos. It is the choice if we ever drop
  React. React Flow has the better TypeScript story and examples for our exact needs.
- sigma.js: WebGL. Not needed at 20 to 300 nodes. Round 1 and the size table agree.
- Mermaid: stays the fallback output of the script (round 1 step 2), zero build.

Live reload: a small Bun server that watches `~/dv/*/docs/PLAN.md` (chokidar or
`Bun.file` watcher) and pushes updates over SSE to the page. The project already has SSE
experience (`docs/research/sse-client.md`).

Stack decision: Vite + React + `@xyflow/react` + elkjs, built with Bun. The deciding
criteria are interaction out of the box, first-party ELK integration, MIT license, and the
smallest bundle that still gives click, highlight, and collapse.

### Question 5: agent mission control

All facts from GitHub API and README greps, 2026-10-03.

| Project | Stars | License | Pushed | Plan graph? | Decision ranking? |
|---|---|---|---|---|---|
| buildermethods/agent-os | 5466 | MIT | 2026-08-29 | no; spec and standards workflow | no |
| nearai/ironclaw | 12636 | Apache-2.0 | 2026-10-01 | no hit for graph/plan/decision in README | no |
| agentscope-ai/AgentTeams | 5694 | n/a | 2026-10-03 | no (multi-agent OS, human in the loop) | no |
| CoWork-OS/CoWork-OS | 470 | n/a | 2026-10-03 | no; task timeline, knowledge graph of automation runs | no |
| stravu/crystal | 3123 | MIT | 2026-02-26 | no; orchestration of Claude Code sessions | no |
| BloopAI/vibe-kanban | 28258 | Apache-2.0 | 2026-09-19 | no; kanban issues for agent work | no |
| smtg-ai/claude-squad | 8567 | n/a | 2026-08-20 | no; terminal agent manager | no |
| gastownhall/gastown | n/a | n/a | 2026-10-03 | beads ledger as work state; convoys of beads | stall detection, not ranking |

Reading the READMEs confirms round 1's guess: these projects solve session and work
orchestration, not plan visualization. Nothing to copy for ranking or rendering. What to
copy: beads' data discipline (dependency edges as first-class data, dependency validation
with ready fronts and cycle checks) and Backlog.md's dependency wording in the UI
("what a task waits on and what waits on it").

### Question 6: skills.sh

Queries on 2026-10-03: "roadmap", "decision", "dependencies", "milestone", "mvp"
("critical path" returned unparseable JSON).

- "roadmap": 5 skills, all PM-style roadmap writing (anthropics/knowledge-work-plugins
  `roadmap-update` 2954, phuryn/pm-skills `outcome-roadmap` 9681, and more). None
  machine-readable.
- "decision": `decision-mapping` (mattpocock/skills, 45041 installs) is the one relevant
  hit. Its SKILL.md was not readable at the guessed raw path (404); open question. Other
  hits are ADR-writing skills (github/awesome-copilot 10198, wshobson/agents 18913),
  which match MADR, already covered.
- "dependencies", "milestone", "mvp": code-dependency and interview/PM skills. Nothing
  that keeps a plan as a graph or ranks decisions.

Conclusion: no prior art on skills.sh beyond what round 1 found. Our grammar would be a
candidate for a new skill later (for example `plan-graph`), so that other agents write
the `depends:` lines correctly.

## Comparison

| Option (format) | Plan stays prose | Edit cost on samples | Drift risk | Cost per change |
|---|---|---|---|---|
| (a) grammar in PLAN.md | yes | about 3 to 12 lines per plan | low, one source | zero |
| (b) sidecar YAML/JSON | yes | zero at first | high, two sources | zero, plus a check |
| (c) LLM extraction | yes | zero | none in file, unstable edges | 0.01 to 0.05 USD per plan [guess] |
| beads / Backlog.md format | no, data moves to their store | full rewrite | low | zero |

| Option (render) | Bundle | Interaction | Layout quality | React | License |
|---|---|---|---|---|---|
| React Flow + elkjs | about 493 kB gzip | best, examples for all our needs | layered, strong | yes | MIT / EPL-2.0 |
| React Flow + dagre | about 76 kB gzip | same | layered, weaker on wide graphs | yes | MIT |
| Cytoscape + elk ext | about 200 kB gzip+ | good | layered via extension | no | MIT / EPL |
| Mermaid | about 173 kB gzip | almost none | layered (ELK) | no | MIT |
| sigma.js | about 26 kB gzip+ | WebGL scale | force, not layered | no | MIT |

## Recommendation for the first milestone

- Format: (a), a small grammar in `PLAN.md`: `depends:` line under each step heading,
  `decision:` marker for open questions, lenient parser, LLM helper to write the first
  lines. One screen of grammar documentation goes at the top of each plan or in the repo.
- Ranking: `blocked` count (transitive steps blocked by the decision), tie-break on the
  critical path.
- MVP path: pick a milestone node, show its full ancestor set, and highlight the longest
  path inside it.
- Rendering: React Flow plus elkjs; Mermaid text output stays as the zero-build fallback.
- Live reload: Bun server with SSE and a file watcher over `~/dv/*/docs/PLAN.md`.

First three small steps, each opens in a browser:

1. Parser and data. A Bun script parses `docs/PLAN.md` with the grammar, emits
   `plan.json` (steps, edges, decisions with blocked counts, milestone paths). It also
   emits a Mermaid flowchart into one static HTML file, decisions colored by blocked
   count, critical path highlighted. The user opens that file directly. Tests cover the
   parser on the four sample plans.
2. Interactive view. A Vite page renders `plan.json` with React Flow and elkjs: click a
   node shows its prose text, a path highlight, decision list sorted by blocked count.
3. Live view. The Bun server watches all `~/dv/*/docs/PLAN.md`, re-parses on change, and
   pushes to the page over SSE. A project switcher selects the plan.

Known failure modes: the grammar still needs discipline from agents (Backlog.md names
this risk), so each step of this project adds a parser check that fails on unknown
constructs instead of hiding them. elkjs adds 433 kB; if that hurts, swap in dagre at
16 kB.

## Search log

- GitHub repo search: "beads issue tracker yegge" (10 hits, led to steveyegge/beads,
  redirected to gastownhall/beads, 27610 stars, MIT). "claude squad" (smtg-ai/claude-squad
  8567). "CoWork-OS" (CoWork-OS/CoWork-OS 470, plus two look-alikes). "AgentTeams in:name"
  (agentscope-ai/AgentTeams 5694).
- GitHub API repo lookups 2026-10-03: gastownhall/beads, buildermethods/agent-os,
  nearai/ironclaw, stravu/crystal, BloopAI/vibe-kanban. Note: `gh` is unauthenticated and
  hit GraphQL rate limits; I used `curl` against api.github.com instead.
- Raw README reads via curl, greped: gastownhall/beads (README, docs/CLI_REFERENCE.md),
  gastownhall/gastown, MrLesk/Backlog.md, buildermethods/agent-os, nearai/ironclaw,
  CoWork-OS/CoWork-OS, BloopAI/vibe-kanban, stravu/crystal, mattpocock decision-mapping
  (404).
- npm registry: @xyflow/react, elkjs, @dagrejs/dagre, d3-dag, cytoscape, mermaid, sigma,
  graphology, graphology-dag (versions, licenses, dates above). bundlephobia API for
  gzip sizes. npm search "critical path dag": no CPM library.
- skills.sh API: queries above; best hit `decision-mapping`, unread.
- Pages read through the reader subagent 2026-10-03: reactflow.dev/learn,
  js.cytoscape.org, elkjs README and package.json, taskwarrior.org commands docs plus the
  Taskwarrior task RFC, adr/madr README and template, orgmode.org/org.html section on
  TODO dependencies (read with curl, not the reader).
- Files read: `.opencode/context/plans/{meta,grata,markgraf,opencode-subagents}.md`
  (grata, markgraf, opencode-subagents via heading and keyword scan),
  `docs/research/plan-graph-tools.md`.

## Open questions

- What does `decision-mapping` (mattpocock/skills) actually do? The raw path 404ed. It
  may define a decision format worth adopting.
- Does the user want decisions to carry a manual value or effort weight, or is the plain
  blocked count enough? Ask when step 1 shows real numbers.
- Where do decisions that live in "Default decisions, open for a change by the user"
  (opencode-subagents plan) sit in the graph? They change made decisions instead of
  blocking steps. Needs a grammar answer.
- Does the elkjs EPL-2.0 license need a note in our NOTICE file? Use as a dependency is
  fine, but confirm the project's license policy for EPL dependencies.
