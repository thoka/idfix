# Trace analysis for cheap agent runs (step 17)

Researched 2026-10-01 in worktree `17-trace-research`. Sources are URLs or files with line evidence from the local opencode database and SDK.

## Criteria

- Reads opencode sessions (v1.18.32) directly or via a small converter.
- Finds failure patterns and detours, not just single errors.
- Cheap per run (our traces are 15k–50k tokens; runs must cost cents).
- Open source or scriptable, so we can run it after every subagent run.
- Fits the pipeline: script → cheap tagging → cheap grouping → report.
- Produces evidence (quotes, event references), not only verdicts, so the report is reviewable.

## 1. Jev

Jev is a proprietary "System One" model by TypeSafe AI (released in early access 2026-09-15, US$40M seed led by DCVC). It does not generate text: it takes a state (string, JSON, or array) plus typed questions and returns calibrated answers in one parallel pass ([Wikipedia](https://en.wikipedia.org/wiki/Jev_(AI_model))). Three question primitives: **Choice** (option + probabilities), **Score** (ordered levels), **Noul** (yes/no probability) — because answers are schema-bound, the model cannot return a value outside the schema ([Wikipedia](https://en.wikipedia.org/wiki/Jev_(AI_model)), [jevai.org/docs](https://www.jevai.org/docs)).

For agent traces, Jev judges evidence against claims: "Give Jev the task, the tool trace and the claimed result, and get a typed verdict on completion, compliance and quality" ([jevmodel.org](https://jevmodel.org/use-cases/ai-agent-evaluation/)). Best practice from third-party guides: evaluate atomic criteria per step, keep event IDs and parent references to avoid hindsight leakage, use Jev only for bounded semantic judgments and code for deterministic checks ([befailproof.ai](https://befailproof.ai/jev/evals/agent-trajectories/)). Reusable for us: the primitive shape (choice/score/noul with evidence in the state), the "judge claims against the trace, not the narration" method, and batching many questions against one state in a single call — one request with hundreds of questions takes about as long as one with a single question ([docs.rs/typesafe-jev](https://docs.rs/typesafe-jev/latest/typesafe_jev/)). No code, weights, or technical paper are published; license is proprietary ([Wikipedia](https://en.wikipedia.org/wiki/Jev_(AI_model))). Not open source; no stars/releases in the usual sense. The GitHub presence is client adapters only (e.g. [typesafe-ai/system-one-adapter-python](https://github.com/typesafe-ai/system-one-adapter-python), referenced from the [blog](https://typesafe.ai/blog/introducing-system-one-models-and-jev)).

## 2. Prior art (short)

- **Docent (Transluce)** — agent transcript analysis: LLM summarization, search, clustering, and interactive conversion of a vague question ("is my model reward hacking") into a precise rubric, then quantitative measurement of how often the behavior occurs. Open source under Apache 2.0 since 2025-09-24 ([transluce.org](https://transluce.org/docent/blog/open-source)); repo [TransluceAI/docent](https://github.com/TransluceAI/docent) (110 stars, alpha status). Ingestion via a Python tracing library or Inspect; no opencode integration, but a custom transcript converter exists ([transluce.org](https://transluce.org/docent)). Taxonomy: user-driven rubrics, not a fixed tag list. Free hosted alpha; internal LLM cost not published.
- **LangSmith Insights / Engine (LangChain)** — Insights analyzes traces with hierarchical categories (top-level categories, subcategories, percentages, links to example traces) ([docs.langchain.com/langsmith/insights](https://docs.langchain.com/langsmith/insights)). Engine goes further: recurring issue detection, root-cause diagnosis, proposed fix, auto-generated evaluator, reopen on regression; issues are tagged "such as Silent tool error or Hallucination", and Red Teaming uses a fixed taxonomy of 10 issue classes (Content Policy, Instruction Hierarchy, Indirect Injection, Data Exposure, Auth Isolation, Tool Safety, Workflow Integrity, Session Integrity, Input Robustness, Reliability Safety) ([docs.langchain.com/langsmith/engine](https://docs.langchain.com/langsmith/engine), fetched via `engine.md`). Proprietary SaaS, billed in LCUs; no opencode read path.
No tool reads opencode sessions out of the box. This pass was not exhaustive; the wider 2025–2026 survey line stays open.

## 3. The data: how opencode 1.18.32 stores a session

opencode stores sessions in **SQLite** at `~/.local/share/opencode/opencode.db` (verified on this machine), with tables `session`, `message`, `part`, plus link and event tables. Verified schema (from `sqlite_master`):

- `message(id, session_id, time_created, time_updated, data)` — `data` is JSON with `role`, `model {providerID, modelID}`, `agent`, `time`, and for user messages `summary.diffs`.
- `part(id, message_id, session_id, time_created, time_updated, data)` — `data` is JSON with `type` one of `step-start | reasoning | text | tool | step-finish | patch`, `text`, `time`, `metadata`.
- `session` carries aggregate columns `cost`, `tokens_input`, `tokens_output`, `tokens_reasoning`, `tokens_cache_read`, `tokens_cache_write`.

The HTTP API of the running server returns the same data: `GET /session/{id}/message` with optional `limit` query returns `Array<{info: Message, parts: Array<Part>}>` (SDK type `SessionMessagesData`/`SessionMessagesResponses`, `node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts:2209-2243`).

A **reasoning part** is (`types.gen.d.ts:157-170`):

```ts
{ id, sessionID, messageID, type: "reasoning", text, metadata?: {[key:string]: unknown}, time: { start, end? } }
```

Verified real example: reasoning parts carry `metadata.openrouter.reasoning_details` (an array of `{type: "reasoning.text", text}`) when the run went through OpenRouter.

## 4. Do the providers return GLM 5.3 Flash reasoning to opencode?

**Yes, on both routes, verified empirically** in the local database:

- OpenRouter (`openrouter / z-ai/glm-5.3-flash`): assistant messages contain `reasoning` parts with `metadata.openrouter.reasoning_details`. OpenRouter docs confirm reasoning tokens are returned by default in the `reasoning` field, billed as output tokens ([openrouter.ai/docs … reasoning-tokens](https://openrouter.ai/docs/projects/docs/guides/best-practices/reasoning-tokens)).
- DeepInfra direct (`deepinfra / zai-org/GLM-5.3-Flash`): assistant messages contain `reasoning` parts too (50 reasoning parts alongside 98 step-starts, no `metadata.openrouter`). DeepInfra documents `reasoning_effort` and a `reasoning` object for GLM models ([docs.deepinfra.com/chat/reasoning](https://docs.deepinfra.com/chat/reasoning)); the exact response field name (`reasoning_content` vs `reasoning`) is not stated in the pages I read — open point, but the pipeline only needs the stored opencode part, which exists.

## 5. Design: three stages

**Stage 1 — script, no model.** Read `opencode.db` (or `GET /session/:id/message`) and cut each session into steps: a `step-start`…`step-finish` span with its reasoning, text, tool, and patch parts. Compute cheap signals without a model: tool errors and retries, duplicate tool calls, steps that re-read or re-edit the same file, step latency and token deltas, claim-vs-evidence gaps. Output: one JSON record per step with stable IDs (`sessionID`, `messageID`, `part` IDs) so later stages can cite evidence.

**Stage 2 — cheap tagging with Jev.** For each step, build a small state (step text, tool call, tool result, reasoning excerpt) and ask a batched set of typed questions in one call (batching shares the state cost, [jevai.org/docs](https://www.jevai.org/docs)). Fixed tag list, informed by LangSmith Engine categories and Docent's rubric style, as Jev **Choice** questions:

- `wrong-tool` (tool selection error), `tool-error` (execution failed), `silent-tool-error` (failed tool presented as success),
- `redundant-work` (repeat of an earlier step), `rework` (undoes own change),
- `ungrounded-claim` (claim without tool evidence), `hallucination`,
- `instruction-drift` (worked outside the brief), `permission-detour` (blocked by permissions, then detoured),
- `recovery` (a good step after a failure — also a Score 0–3), plus a per-step `severity` Score and a `step-honest` Noul (claim matches evidence).

Each answer carries a quote from the step as evidence. Store the exact question, projection, and model version with each record ([befailproof.ai](https://befailproof.ai/jev/evals/agent-trajectories/)).

**Stage 3 — grouping over runs.** Stage 3 needs prose-style synthesis across runs, a poor fit for Jev (no text generation). Use a cheap GLM agent for the grouping and report, with Jev for the judgments inside it: Noul checks like "do these five tagged steps share one root cause?", Choice on "which layer is responsible (brief | agent prompt | tool | environment)" ([befailproof.ai](https://befailproof.ai/jev/evals/agent-trajectories/)), and Score on recurrence. The GLM agent receives the tag table and writes the report naming changes to briefs, prompts, and tools.

**Quality measurement.** Keep 3–5 known runs with hand-written per-step labels. Metrics: per-tag precision/recall against those labels; calibration (Jev confidence vs. actual agreement); inter-run stability (same step tagged twice, agreement rate); cost per session. Re-run when the tag list or Jev version changes (pin `jev-1.13.0`, not `jev-latest` — versions can shift behavior, [jevtypesafeai.com](https://www.jevtypesafeai.com/how-to-use), unofficial source).

## Jev API access

**OpenRouter route first.** The public OpenRouter model list contains only `typesafe/jev-router` ("TypeSafe: Jev Router"), described as running on Jev ([openrouter.ai/api/v1/models](https://openrouter.ai/api/v1/models)). I could not fetch `https://openrouter.ai/~typesafe/jev-latest` (404 without authentication) and `GET /api/v1/models/typesafe/jev-latest` returns 404 — **unconfirmed** whether that slug serves direct Jev requests. For `typesafe/jev-router`: context_length 1,000,000; pricing `prompt: -1`, `completion: -1` (variable, not published); endpoints list empty; `supported_parameters` includes `tools`, `tool_choice`, `structured_outputs`, `response_format`, `reasoning`, `include_reasoning` — so tool calls and JSON-schema structured output are advertised, but the router's behavior (whether it returns reasoning text or raw Jev primitives) is unconfirmed and must be probed.

**Direct Jev API (comparison).** Host `https://api.typesafe.ai`, Bearer auth, key from `TYPESAFE_API_KEY` ([docs.rs/jev-sdk](https://docs.rs/jev-sdk/latest/jev_sdk/)); endpoint per third-party docs: `POST /v1/systemone` or `/api/v1/decisions` ([jevtypesafeai.com](https://www.jevtypesafeai.com/how-to-use) — unofficial; [jevai.org/docs](https://www.jevai.org/docs) — provenance unclear). Not OpenAI-compatible (typed state+questions, no chat completions). Price: input $0.042/MTok, output free ([blog](https://typesafe.ai/blog/introducing-system-one-models-and-jev), confirmed by [Cloudflare](https://developers.cloudflare.com/ai/models/typesafe/jev/)); no free tier or minimum spend documented. Rate limits (unofficial): 250,000 tokens/s, 1,200 req/min; context 32k (Cloudflare/Vercel) up to 64k (unofficial). Key access via early access / console.typesafe.ai ([blog](https://typesafe.ai/blog/introducing-system-one-models-and-jev)); per-project key limits **not documented**. SDK: no official TypeScript/Bun SDK found; official adapters are Python (system-one-adapter-python) and community Rust crates; third-party TS wrappers exist (jevtypesafeai.com) — untrusted. Jev appears neither as provider nor model in [models.dev/api.json](https://models.dev/api.json), so opencode cannot route to it natively today.

**(g) Input size and cost estimate.** A stage-2 call sends one step (~300–2,000 tokens incl. tool result) plus ~200 tokens of question definitions; a batched call can cover a whole session. At $0.042/MTok: a 15,000-token trace costs ≈ **$0.0006** and a 50,000-token trace ≈ **$0.0021** per full pass (output free). Even 20 re-analyses per run stay under half a cent. The dominant cost stays in the stage-3 GLM agent.

## Search log

- `gh api`: sst/opencode (211k stars, active), TransluceAI/docent (110 stars, Apache-2.0).
- `openrouter.ai/api/v1/models`: 1 hit (`jev-router`); `jev-latest`: 404. `models.dev/api.json`: 0 hits.
- Web searches: "Jev AI model" (5/5), "Transluce Docent" (5/5), "LangSmith Insights" (4/4), "typesafe.ai Jev pricing" (6/6), "DeepInfra GLM reasoning" (4/4). Reader: typesafe.ai blog + Cloudflare + Vercel (fetched); OpenRouter (404, listing grepped locally); LangSmith `engine.md` (fetched; `engine-categories` 404).

## Open questions

1. Does `~typesafe/jev-latest` on OpenRouter actually serve raw Jev (choice/score/noul) requests, at what price, and with which providers? Needs an authenticated check or a probe request.
2. Per-project API key limits for TypeSafe (our rules want one key per project with a cap) — not documented anywhere I read.
3. Exact DeepInfra response field for reasoning (`reasoning_content`) — pipeline-neutral, but worth confirming if we ever parse provider responses directly.
4. Full taxonomy of LangSmith Engine issue categories (only examples are public); our tag list is therefore partly our own design.
5. Whether the `typesafe/jev-router` on OpenRouter preserves Jev's typed-question interface when used through an OpenAI-compatible client.
