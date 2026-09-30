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
