# Research: which model does an opencode subagent use?

Date: 2026-10-01. Version checked: opencode v1.18.32 (tag `v1.18.32`), plus current `dev`.

## Criteria

For judging the options at the end:

- Correct: `--model PROVIDER/MODEL` of the run reaches the `reader` subagent.
- Small change: no fork, no patch of opencode itself.
- No surprise cost: the reader must not silently fall back to an expensive provider.
- Keeps agent config: permissions and reasoning effort of `reader.md` stay.

## Question 1: which model does a subagent use when its agent file sets no `model`?

Answer: the model of the calling session, that is, the model of the parent's assistant message. Not the model of the primary agent file, and not the global default.

Source, `packages/opencode/src/tool/task.ts` at tag `v1.18.32`
(https://raw.githubusercontent.com/sst/opencode/v1.18.32/packages/opencode/src/tool/task.ts, read 2026-10-01):

```ts
const model = next.model ?? {
  modelID: msg.info.modelID,
  providerID: msg.info.providerID,
}
```

`next` is the resolved subagent (`agent.get(params.subagent_type)`), so `next.model` is the agent file's `model:`. If it is unset, the fallback is `msg`, the parent assistant message of the current session (`MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID })`). This includes a prompt override: our `say` fix (docs/HISTORY.md, "Step 2b") sets the model on the user message, so the assistant message carries the `--model` value. The same expression is still in `dev` (same URL without the tag, read 2026-10-01). There is no global-default fallback in this path.

The docs agree (https://opencode.ai/docs/agents/, section "Model", read 2026-10-01):

> If you don't specify a model, primary agents use the model globally configured while subagents will use the model of the primary agent that invoked the subagent.

The v2 docs say the same in one line: "A subagent uses its configured model, or inherits the parent session's model when none is configured" (https://opencode.ai/v2/docs/agents/, read 2026-10-01).

Because `reader.md` does set `model: openrouter/z-ai/glm-5.3-flash`, the configured model wins and `--model` never reaches the reader. That matches the observed behavior.

## Question 2: can a prompt or a task call pass a model to a subagent at run time?

Answer: not in 1.18.32. The task tool's parameter schema has only `description`, `prompt`, `subagent_type`, `task_id`, `command`, and optional `background`. There is no `model` field (task.ts at `v1.18.32`, URL above).

## Question 3: open issues or newer releases that change this?

Still open as of 2026-10-01; no release adds the feature yet:

- PR 26535 "feat(opencode): add model parameter to task tool for subagent model override" — open, conflicted, waiting since May. Model priority `params.model` > `agent.model` > parent session model; gated by a `model_override` permission. https://github.com/anomalyco/opencode/pull/26535
- PR 29447 — forward port of 26535 onto current dev, open. https://github.com/anomalyco/opencode/pull/29447
- PR 35800 — independent implementation of the same feature, open. https://github.com/anomalyco/opencode/pull/35800
- PR 36146 — `OPENCODE_SUBAGENT_MODEL` env var, open. https://github.com/anomalyco/opencode/pull/36146
- Issue 44680 reports that in v1.16.42 the task tool ignored the agent.md model and inherited the parent model; the maintainer triage on issue 36132/35126 could not reproduce this on current dev, so the `next.model`-wins behavior in the source is the current truth.

Note: the GitHub search surfaced this project under the org `anomalyco/opencode`; the raw source is served from `sst/opencode`. The issue numbers above are as reported by the search index; I did not verify each PR page directly.

## What we must change so that `--model` reaches the `reader`

Options:

| Option | Correct | Small change | Cost risk | Keeps agent config | Risk |
| --- | --- | --- | --- | --- | --- |
| A. Remove `model:` from `reader.md` | Yes — reader inherits the parent session model, which `--model` sets (task.ts fallback) | Yes, one line | Medium — no pinned cheap fallback; if a researcher runs without `--model`, the reader uses the researcher's model | Yes | If someone pins the researcher cheaply later, the reader follows it. The parent's `variant` is forwarded (`variant: next.model ? undefined : variant`), so the reader's `reasoning.effort: low` could be affected if the parent run sets a variant |
| B. oc-sub rewrites the model in `reader.md` (or a generated agent file) before the run | Yes | Medium — new code, file mutation | Low | Yes, except the model line | Mutating files in the repo during a run is ugly; concurrent runs would race on the same file; a crash can leave the file changed |
| C. Wait for an upstream `model` param on the task tool | Yes, later | None now | Low | Yes | Four PRs have waited for months; no merged release as of 2026-10-01. No date |

Option A is the one that follows from the code: the reader exists to be a cheap page fetcher, and the run already picks one model on purpose. Removing the pinned model makes `--model` the single source of truth. If a run needs the reader on a different model than the researcher, option B covers that later; option C removes the need for both when it lands.

Recommendation: option A, plus a line in the `reader.md` comment saying the model comes from the run. Verify after the change with one run whose proxy log shows only the `--model` provider for reader requests.

## Open points

- Exact status (merged or not) of PRs 26535, 29447, 35800, 36146; I relied on the search index snapshots plus the dev source check.
- Whether option A interacts with `variant`/reasoning-effort forwarding in a way that changes reader output quality; needs one test run.
- Whether oc-sub should also pass `--model` through when the user omits it (currently the agent file model wins for the primary agent unless `say` sends a model; see docs/HISTORY.md step 2b).
