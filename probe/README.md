# Provider probe: fixture and evaluator

Parts of PLAN.md step 10 that need no server and no paid call. The design and
the review are in `docs/research/PROVIDER_PROBE.md` (section 5).

## Fixture (`make-fixture.ts`, `fixture/types.ts`, `expected.json`, `task.md`)

`make-fixture.ts` generates `fixture/types.ts`, a deterministic TypeScript
file of 11,656 lines (the size of the A/B test file in
`docs/EXPERIENCE.md`). It holds filler code and three interfaces at fixed
lines:

| Interface | Line | Fields |
| --- | --- | --- |
| `ProbeLedgerEntry` | 4,868 | 6 |
| `ProbeManifestField` | 5,047 | 4 |
| `ProbeReplicaConfig` | 7,820 | 5 |

The generated file and `expected.json` are committed. To regenerate after a
layout change:

```
bun probe/make-fixture.ts
```

The script rewrites `fixture/types.ts` and `expected.json`; the line numbers
stay valid because the generation is deterministic. `task.md` is the prompt
of the probe task: find the three interfaces, write their field names into
`answer.md` in the run folder (one bullet per field, no prose), and commit
`answer.md`.

## Evaluator (`src/probe/evaluate.ts`)

Pure functions, no I/O and no clock. `evaluateRun` takes the messages of a
finished session (the `MessageEntry` type of `src/summary.ts`), the content
of `answer.md` or null, whether a commit exists, and the expected answer. It
returns `{ pass, failures }` with one entry per failed rule:

1. `answer` — the answer holds exactly the expected field names per
   interface (order and backticks do not matter, duplicates and prose do).
2. `commit` — a commit exists in the run worktree.
3. `loop` — no row of identical tool calls; reuses `detectLoop` from
   `src/detect.ts`, the offline variant of the live loop detector.
4. `unreadable` — the assistant text passes two cheap heuristics: (a) the
   share of non-ASCII characters among non-whitespace characters stays under
   5 percent (`NON_ASCII_LIMIT`), and (b) the total assistant text stays
   under 20,000 characters (`TEXT_LIMIT`), because the answer of this task is
   short. Known gap: meaningless text in plain ASCII under the limit passes
   both heuristics.
5. `reasoning` — every step stays under `REASONING_LIMIT` (16,000 reasoning
   tokens) from `src/detect.ts`.
6. `tool-error` — no tool call ends in an error state.

`speedMetrics` reads the speed numbers from the same messages:
`timeToFirstTokenMs` (from the first user message to the earliest part start
of the first assistant message; the message creation time only measures the
request start), `wallTimeMs` (first user message to the last assistant
message end), `generationMs` (the sum of the model time of each step, which
leaves out the tool time between steps), output and reasoning tokens, and
`generationTokensPerSecond` (output plus reasoning tokens divided by the
generation time).

## Tests

`test/probe-evaluate.test.ts` covers a passing run, every failed rule, the
speed metrics, the loop check, and the fixture line numbers, with messages in
the real `@opencode-ai/sdk` shapes. Run with `bun test`.

## Probe runner (`src/probe/runner.ts`, `probe/run.ts`)

The runner (PLAN.md step 10d) executes the probe task once per provider and
run number, strictly one run at a time, so the real-cost delta of the project
key belongs to exactly one run. One run does, in order:

1. Create the run worktree `probe-<provider>-<n>-<HHMMSS>` inside the sandbox
   clone with the same code as `oc-sub worktree` (branch `feature/probe-...`
   from `host/alpha`, no setup command). The `HHMMSS` stamp comes from the
   start time of the batch, so a step name is unique per batch and a leftover
   of an older batch is never reused.
2. Write `.opencode/opencode.json` into the worktree, through `sbx exec`,
   **before** the first server request to the folder (a fresh directory
   loads its config on first use, see `docs/research/PROBE_ROUTING.md`
   section 4). The file defines one model alias `glm-probe-<provider>` whose
   `id` is `z-ai/glm-5.3-flash` and whose `options.provider` pins the
   OpenRouter provider: `{ "only": ["<provider>"], "allow_fallbacks": false }`.
3. Note the key usage of the project key (`fetchKeyUsage`, the function that
   `realcost.ts` uses), create the session in the worktree, and send the
   text of `probe/task.md` to the agent `coder` with the model alias
   (`model: { providerID: "openrouter", modelID: "glm-probe-<provider>" }`).
4. Wait until the session tree is settled (the logic of `oc-sub watch` as a
   poll loop, with the guards: status map, descendant sessions, pending
   question and permission requests, and the missing-session grace). The
   time limit is 15 minutes; after it, the run is aborted and counts as
   failed with rule `timeout`.
5. Read the messages, `answer.md` (through `sbx exec cat`), and whether a
   commit exists over `host/alpha` (through `sbx exec git`), and call
   `evaluateRun` and `speedMetrics`.
6. Read the key usage again and write one JSON line to
   `probe/results/<date>.jsonl`: provider, run number, session id, pass,
   failures, the speed metrics, the estimated cost (models.dev catalog of
   the session), the real cost delta, and the wall time. The alias
   inherits the catalog cost of the API id, so the estimate stays correct
   (PROBE_ROUTING.md section 2). The real cost delta can be low by a
   request or two, because OpenRouter counts a request a minute or two
   late.
7. Remove the run worktree (`oc-sub worktree rm` code).

A run that fails at any step writes a result line with the error and the
loop goes on with the next run. A failure in a worktree step (create, config
write, or remove) counts with rule `setup`: the end table shows it in a
separate `setup` column and leaves those runs out of the pass rate of the
provider, because they are not provider failures.

**Control mode** (`--control`): one run with the provider
`no-such-provider`. The pin must make OpenRouter refuse the request, so the
control counts as passed when the run fails without answering, and as
failed when the run answers. If it answers, the provider pin does not
reach OpenRouter and the whole oc-sub-based probe is invalid.

**CLI**:

```
bun probe/run.ts --providers z-ai,baseten --runs 3 [--dir ROOT] [--control] [--yes]
```

It prints the number of runs and a cost estimate of 0.01 USD per run and
needs `--yes` to start paid runs. Without it, nothing runs. It prints one
line per run and a table at the end: provider, passes, the median time to
the first token, the median tokens per second, and the median real cost.

**Tests**: `test/probe-runner.test.ts` covers every dependency with fakes
(the `sbx` runner, the server client, the OpenRouter fetch, the key source,
the pending requests, the results writer, the clock): a passing run, a
failed rule, a run that throws in the middle, the timeout, the control
mode, the order of the steps (config before run), and the JSONL line. No
paid call and no real `sbx` call runs in the tests.

## Jev probe (`probe/jev.ts`)

PLAN.md step 18: learn whether the Jev slugs on OpenRouter answer and what
they cost. Run it on the host:

```
bun probe/jev.ts [MODEL ...]
```

Without arguments it probes two slugs: `typesafe/jev-router` (the only Jev
entry in the public OpenRouter model list) and `~typesafe/jev-latest`
(unconfirmed whether it serves direct requests, see TRACE_ANALYSIS.md
"Jev API access"). Per slug it sends one non-streaming
`POST /api/v1/chat/completions` with `max_tokens: 200`, a structured-output
JSON schema (`response_format: { type: "json_schema", ... }`), and a short
state: a fake agent step (tool call `bash ls src`, its output, and the claim
"I listed the folder") plus two typed questions in the user message — one
Choice ("which tag fits the step: ok | wasted | wrong-tool |
hallucinated-claim") and one Noul ("does the result support the claim? yes
or no"). The schema has one field per question (`tag`, `claim_supported`).

It then prints per slug: the HTTP status, the error text if any, the
`model` and `provider` fields of the response, the content (at most 1,000
characters), the `usage` block, and the generation cost from
`GET /api/v1/generation?id=<id>` (up to three tries, two seconds apart,
because OpenRouter counts a request a minute or two late). One JSON line
per slug goes to `probe/results/jev-<date>.jsonl`; it holds no key.

The key comes from `OPENROUTER_API_KEY`, else from the project key file
`~/.config/opencode-subagents/openrouter.key`. The key is never printed.
Without a key the script exits 2 with a message.

**Cost cap**: two requests, at most 200 output tokens each, plus the two
generation lookups, which cost nothing. The script makes no other paid call.

**Tests**: `test/probe-jev.test.ts` covers the request body (model,
`max_tokens`, schema, state, questions), the key order, a 404 error text,
the cost extraction and its retry limit, the JSONL line, and that the key
never appears in the output or the result line, all with a fake fetch.
