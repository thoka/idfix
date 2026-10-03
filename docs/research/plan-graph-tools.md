---
checked: 2026-10-03
recheck: 3m
decisions:
  - "plan graph view: adopt a tool, a library, or build"
---

# Tools that show a plan as a graph

The user keeps project plans as `docs/PLAN.md` (Markdown with steps, dependencies, open user
decisions, user tasks). The user wants a browser view (SVG or WebGL) of that plan as a graph.

## Criteria

Each option gets judged by these lines:

- Reads `docs/PLAN.md` or plain files in git. No own database.
- Shows dependencies as a graph with a readable layered layout.
- Ranks open decisions and questions by the work that they block.
- Shows the critical path to an MVP.
- Mature: active commits, many users, established license.
- Small steps and established libraries, so we deliver first.

## Short answers

1. **Which tools show a plan as a graph?** No established tool does all of it. The closest
   projects are beads_viewer (graph TUI with PageRank and critical path), Backlog.md
   (Markdown tasks with a web board, no graph), and claude-task-master (task dependencies,
   no graph). Classic tools (Mermaid, PlantUML, GitHub dependency graph, Linear) show graphs
   but do not read plan prose. Skills on skills.sh map plans to issue graphs (plan-to-graph,
   wayfinder, to-tickets) but render nothing of their own.
2. **Who reads Markdown or plain files in git?** Backlog.md stores each task as a plain
   `.md` file in the repo. beads_viewer reads a JSONL export in `.beads/` in the repo, but
   that export comes from the beads tracker. claude-task-master stores its own JSON under
   `.taskmaster/`. plan-to-graph and wayfinder store tickets as GitHub Issues; wayfinder has
   a local-Markdown fallback. No tool parses a free-form `PLAN.md` with decision sections.
3. **Who ranks "answer this first"?** Only beads_viewer. It scores items with PageRank,
   Betweenness, HITS, and a critical path (longest dependent chain), and sorts its triage
   view by these scores. Backlog.md, task-master, and the skills do not rank by blocked work.
   Wayfinder has an unranked "frontier" of open, unblocked tickets.
4. **Which rendering libraries?** beads_viewer uses a custom ASCII/Unicode graph in a Go TUI
   and exports single-file HTML with a force-directed graph, plus Mermaid and DOT export.
   Mermaid v12 lays out flowcharts with ELK (formerly Dagre) and renders SVG in the browser.
   d3-dag computes layered (Sugiyama) layouts and leaves rendering to you; it is a drop-in
   layout engine for React Flow. For 20-300 nodes a layered SVG layout is readable; WebGL is
   not needed at that size.
5. **skills.sh:** relevant skills are `plan-to-graph` (lousy-agents/skills, 18 installs),
   `json-canvas` (kepano/obsidian-skills, 71k), `wayfinder`, `to-tickets`, `to-issues`
   (mattpocock/skills), `planning-with-files` (othmanadi, 45k), `plan-visualizer`
   (iliagerman/agents, 7 installs), `visualize-plan` (yonatangross/orchestkit, 105 installs).
6. **Recommendation:** build a thin view. Parse `PLAN.md` with a small script, compute
   ranks with a graph library, and render with Mermaid first (SVG, ELK layout, no build
   step). Grow to React Flow + d3-dag if interaction is not enough. See the last section.

## Details

### Agent-focused tools

**beads_viewer (Dicklesworthstone/beads_viewer)** — read 2026-10-03.
A terminal interface for the Beads issue tracker. Go, Bubble Tea TUI with a custom
ASCII/Unicode graph renderer. Exports "single-file HTML visualizations powered by a
force-directed graph engine" and Mermaid/DOT. Reads `.beads/issues.jsonl` in the repo.
Scores items with "PageRank, Betweenness, HITS" and shows a "Critical Path (Longest dependent
chain)". Triage ranks by these scores. 1706 stars, last push 2026-10-02, license badge
"MIT+OpenAI/Anthropic Rider" (a non-standard rider, so treat as non-standard MIT).
Limit: it visualizes beads issues, not a `PLAN.md`. You would have to move plan data into
beads or export JSONL from the plan.

**Backlog.md (MrLesk/Backlog.md)** — read 2026-10-03.
"Managing project collaboration between humans and AI Agents in a git ecosystem."
Every task is "a plain `.md` file in your repo". Has a terminal kanban and a local web UI
("backlog browser"). Tasks show "what a task waits on and what waits on it". It tracks
decisions as documents. 6933 stars, MIT, last push 2026-09-28.
Limit: no dependency-graph view, no critical path, no ranking of decisions. Its task format
is its own, not a free-form plan.

**claude-task-master (eyaltoledano/claude-task-master)** — read 2026-10-03.
Task management CLI + MCP for AI-driven development. Has dependency data and complexity
analysis, "no graph rendering, no TUI, no browser UI" in the repo. Stores its own JSON under
`.taskmaster/`. 28135 stars, last push 2026-04-28, "MIT License with Commons Clause" (no
hosted service, no selling). Limit: wrong input format, no graph, semi-stale pushes.

**Other "agentic OS" projects** — GitHub search 2026-10-03 (queries listed below). Projects
named "agentic OS" or "agent OS" (nearai/ironclaw 12.6k stars, buildermethods/agent-os 5.5k,
AgentTeams 5.7k, CoWork-OS 470) orchestrate agents. None of their descriptions name a plan
dependency-graph view for a Markdown plan. I did not read their READMEs. [guess] They solve
agent orchestration, not plan visualization.

**Issue-tracker plugins found in search:** `joshuadavidthomas/opencode-beads` (266 stars,
opencode plugin for beads), `Dicklesworthstone/beads_rust` (1112 stars), `assimelha/bdui`
(118 stars, TUI), `zjrosen/perles` (190 stars). All bind to beads, not to Markdown.

### Classic tools

- **Mermaid** (mermaid.js.org, flowchart page read 2026-10-03). Text in, SVG out, in the
  browser. Auto-layouts flowcharts with ELK since v12.0.0 ("laid out by ELK rather than
  Dagre"; Dagre still selectable). Layered ranking of nodes is built in. Established, huge
  ecosystem. No interaction, no ranking, no critical path. Many Markdown renderers (GitHub,
  VS Code) show Mermaid blocks with no build step.
- **d3-dag** (npm, homepage read 2026-10-03). "Lightweight, TypeScript-first DAG layout for
  the web." Sugiyama layered, Zherebko linear, and grid layouts. Layout only: it returns
  coordinates, "you render here". Works as "a drop-in replacement for dagre as a layout
  engine" in React Flow. MIT, active (npm release 2026-07-05).
- **React Flow** — SVG node/edge rendering for React, the standard choice for interactive
  flow graphs. [guess from ecosystem position and the d3-dag integration note; I did not
  read its docs.] Pairs with dagre/d3-dag/elkjs for layout.
- **GitHub dependency graph / Projects, Linear** — graph views live in hosted products with
  their own databases. They do not read `docs/PLAN.md`. Not candidates.
- **Gantt/PERT tools** (GanttProject, PlantUML) — time-focused or image-focused. No decision
  ranking, no agent integration. Not candidates.

### skills.sh findings (searched 2026-10-03)

Queries: "plan graph", "task planning", "visualize plan", "dependency graph".

- `plan-to-graph` (lousy-agents/skills, 18 installs) — read 2026-10-03. Maps a plan into
  GitHub Issues with "native `blocked-by` edges". Renders nothing; the graph is GitHub's UI.
  No ranking. Installs are few.
- `wayfinder` (mattpocock/skills, 602k installs) — read 2026-10-03. "Plan a huge chunk of
  work … as a shared map of decision tickets", resolve "one at a time until the way to the
  destination is clear". Every map and ticket is an issue; fallback is a "local-markdown
  tracker". The frontier is "the open, unblocked, unclaimed children", taken "in order" —
  not ranked by blocked work. Rendering comes from the tracker's UI.
- `to-tickets` (mattpocock/skills, 590k installs) — breaks a plan into "tracer-bullet
  tickets, each declaring its blocking edges". No rendering.
- `json-canvas` (kepano/obsidian-skills, 71k installs) — read 2026-10-03. The agent writes
  Obsidian `.canvas` files (JSON Canvas spec: nodes with x/y, edges with arrow ends). Manual
  layout, no auto-layout, no task semantics. Good only if the user uses Obsidian.
- `planning-with-files` (othmanadi, 45k installs) — planning discipline in files; not a
  graph view. Description only, not read.
- `visualize-plan` (yonatangross/orchestkit, 105 installs) and `plan-visualizer`
  (iliagerman/agents, 7 installs) — immature. Not read.

## Comparison

| Option | Input | Graph view | Critical path | Decision ranking | Maturity |
|---|---|---|---|---|---|
| beads_viewer | beads JSONL export | TUI + HTML export | yes | PageRank etc. | active, 1.7k stars, rider license |
| Backlog.md | own `.md` task files | kanban web UI, no DAG | no | no | active, 6.9k stars, MIT |
| claude-task-master | own JSON | none | no | complexity only | big, stale 5m, Commons Clause |
| plan-to-graph skill | GitHub Issues | tracker UI | no | no | 18 installs |
| wayfinder skill | Issues or local Markdown | tracker UI | no | frontier order only | 600k installs |
| json-canvas skill | `.canvas` files | Obsidian canvas | no | no | maintained by Obsidian CEO |
| Mermaid (library) | Mermaid text we generate | SVG, ELK layered | no (can color path) | no | established |
| React Flow + d3-dag (libraries) | our JSON | interactive SVG | we compute | we compute | established |

## Recommendation

**Build a thin view; adopt libraries, not a tool.** The deciding criteria are the input
format and small steps. No tool reads a free-form `PLAN.md`; every tool would force us to
move plan data into its own store (beads, Backlog.md tasks, GitHub Issues). That contradicts
"reads plain files in git" and breaks the existing workflow of many projects.

Thin view, three small steps:

1. **Parser + ranker.** A small script reads `docs/PLAN.md`, extracts steps, `depends-on`
   edges, and open decisions, and computes the critical path and per-decision blocked work
   with an established graph library (graphology + graphology-dag, or a topological walk).
   Tests cover the parser.
2. **Mermaid output.** The script emits a Mermaid flowchart into a single HTML file (or a
   code block in `PLAN.md`), colored by status, with the critical path and open decisions
   highlighted. Zero build step, SVG, ELK layered layout. This already delivers the user's
   four needs except interaction.
3. **Interactive view, only if needed.** A React Flow page with d3-dag as the layout
   engine, fed by the script's JSON. Add it only when step 2 is not enough.

Known failure modes: Mermaid handles 300 nodes but gets wide; use ELK layout and subgraphs.
The parser depends on plan conventions, so `PLAN.md` needs a short grammar section.

## Search log

- GitHub repo search: "agentic OS" (15 hits, none relevant to plan graphs);
  "task-master" (claude-task-master, 28k stars); "beads issue tracker" (beads_viewer 1.7k,
  opencode-beads 266, perles 190, bdui 118); "backlog.md" (Backlog.md 6.9k);
  topic:dependency-graph (code tools only, none plan-focused).
- GitHub API repo lookups: Backlog.md, beads_viewer, claude-task-master (stars, license,
  push dates, 2026-10-03). steve yegge `beads` core repo not found by API search
  [open question: current location of the beads tracker repo].
- npm search: "markdown task dependency graph" (no plan tool), "critical path DAG"
  (d3-dag 1.2.2, graphology-dag).
- skills.sh API: "plan graph", "task planning", "visualize plan", "dependency graph"
  (hits listed above).
- Web pages read through reader: beads_viewer README, Backlog.md README,
  claude-task-master README, lousy-agents plan-to-graph SKILL.md, kepano json-canvas
  SKILL.md, mattpocock wayfinder SKILL.md, d3-dag homepage, Mermaid flowchart docs.

## Open questions

- Where does the beads tracker core repo live now (search found only viewers and ports)?
- Does beads' own `bd` CLI (not the viewer) also show a graph with rankings in a browser?
- Does Task Master's commercial web UI (outside the repo) offer a dependency graph?
- Does the user use Obsidian? If yes, json-canvas plus a converter is a cheap extra view.
