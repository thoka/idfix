---
checked: 2026-10-04
recheck: 3m
decisions:
  - "plan graph: task keys, grammar, one graph across projects, read-only first version"
---

# Plan graph: design

Step 28 of [PLAN.md](../PLAN.md). Research: [plan-graph-tools.md](../research/plan-graph-tools.md) (round 1) and [plan-graph-view.md](../research/plan-graph-view.md) (round 2).

## 1. Goal

A browser view of all plans in `~/dv/*/docs/PLAN.md` as one graph. It shows the steps and their dependencies across projects. It ranks the open decisions by the work that they block, so that the user answers the important questions first. It shows the shortest path to a milestone.

## 2. Decisions of the user (2026-10-04)

| Question | Answer |
|---|---|
| Can agents add grammar lines to the plans? | Yes. |
| Weights on decisions? | Later, as an inline YAML object. The first version counts blocked steps. |
| One graph across projects? | Yes. Tasks get keys like Jira (for example `OCS-28`). |
| Answer a decision in the view? | Later. The first version only reads. |
| Where does the code live? | In this project until the first milestone, then in its own repository. |

The answer "ria codes" reads as Jira-style keys. If that is wrong, section 4 changes.

## 3. Values

- Plan stays prose: the plan is the one source. The grammar adds lines and never moves text into a store.
- Established libraries: graphology for the graph, React Flow and elkjs for the view, `yaml` for inline objects.
- Deliver first: milestone 1 is read-only and has no weights.
- Small steps: each step gives the user a page to open.

## 4. Grammar

### 4.1 Project key

The first lines of each plan name its key, in a front matter block:

```
---
key: OCS
---
```

A key is 2 to 6 upper-case letters, unique in `~/dv`. Proposed keys: `OCS` (opencode-subagents), `META`, `ARCH` (arch-helper), `GRATA`, `MARK` (markgraf), `PAC` (pac-review), `POD` (podcast-autocutter), `TERM` (terminator). A plan without a key gets the folder name in upper case, and the view shows a warning.

### 4.2 Node

A heading or a list item that starts with a key marks a node:

```
### OCS-28: a graph view of the plans
- OCS-D3: decide on DeepInfra.
```

- A step key is `<KEY>-<number>` with an optional letter for a sub-step: `OCS-25b`.
- A decision key is `<KEY>-D<number>`: `OCS-D3`. A decision is open while it is in the plan. A made decision moves to the history, as today.
- A milestone key is `<KEY>-M<number>`: `OCS-M1`.
- The text of a heading node ends at the next heading of the same or a higher level. The text of a list node is the list item.

### 4.3 Attributes

Lines directly after the node line, before any other text, give attributes. Each line is `name: value`:

```
### OCS-28: a graph view of the plans
depends: OCS-D7, META-4
status: active
```

- `depends`: a comma-separated list of keys. A key of another project makes a cross-project edge.
- `status`: `open` (default), `active`, `blocked`, or `done`.
- Later: `meta: {weight: 3, due: 2026-11-01}`, an inline YAML object, parsed with the `yaml` package.

A list node takes its attributes inline after the text, in braces: `- OCS-D3: decide on DeepInfra. {depends: OCS-2}`.

### 4.4 Leniency

The parser never fails on a plan. It collects problems and the view shows them: an unknown key in `depends`, a duplicate key, a cycle, an unknown attribute. A plan without any node shows as one node per project.

## 5. Computation

- Graph: graphology, one directed graph over all plans. An edge goes from the dependency to the dependent step.
- Blocked count of a decision: the number of open steps that can reach it by edges in reverse, that is all its transitive dependents that are not `done`.
- Ranking: sort the open decisions by blocked count. A tie goes to the decision on the longest chain.
- Milestone path: the ancestor set of a milestone node, and the longest chain inside it.
- Cycles: the parser reports them and drops the edge that closes the cycle, so the rest stays a DAG.

## 6. Architecture

The code lives in `plan-graph/` with its own `package.json`, so that `git filter-repo --subdirectory-filter plan-graph` moves it to its own repository later. It shares no code with `src/`.

- `plan-graph/src/parse.ts`: Markdown to nodes, edges, and problems. Uses `remark` (mdast) for the headings and list items, `yaml` for the front matter.
- `plan-graph/src/graph.ts`: graphology graph, blocked counts, milestone paths.
- `plan-graph/src/cli.ts`: `plan-graph json` writes `plan.json`. `plan-graph serve` starts the server.
- `plan-graph/web/`: Vite and React page with React Flow and elkjs.
- Server: `Bun.serve` on 127.0.0.1, a file watcher on `~/dv/*/docs/PLAN.md`, and Server-Sent Events to the page.

## 7. Milestone 1 (OCS-M1)

1. OCS-28a: the parser and the graph module, with tests on fixtures of the grammar and on copies of the four sample plans. `plan-graph json` prints the nodes, the edges, the ranked decisions, and the problems.
2. OCS-28b: migrate the plans. An agent adds the front matter, the keys, and the `depends:` lines to each plan in `~/dv`. The session of each project or the supervisor does this. The parser report shows no problems.
3. OCS-28c: the static page. `plan-graph html` writes one HTML file with a Mermaid graph. Decisions are colored by blocked count. The user opens the file.
4. OCS-28d: the interactive page. React Flow and elkjs. A click on a node shows its text. A list of decisions sorted by blocked count. A choice of a milestone highlights its path. A project filter.
5. OCS-28e: the live view. `plan-graph serve` watches the plans and pushes changes to the page.

After milestone 1: weights (inline YAML), answering a decision in the view (writes into `PLAN.md`), and the move into its own repository.

## 8. Open questions

- Step 28b changes the plans of all projects. Each project has one writer, its own sessions. So the supervisor sends each project session the grammar and a task. The alternative is that the user allows this session a one-time change in all plans.
- The section "Default decisions, open for a change by the user" holds made decisions. They get no decision key, so they do not show as open.
- The skill `decision-mapping` (mattpocock/skills) is unread. It can define a decision format to adopt.
