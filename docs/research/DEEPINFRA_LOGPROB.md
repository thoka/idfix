# The DeepInfra stream error on a null log probability

Research on 2026-10-01. No paid API call was made. Context: opencode 1.18.32 sends GLM 5.3 Flash requests to DeepInfra through `https://api.deepinfra.com/v1/openai/chat/completions` (model `zai-org/GLM-5.3-Flash`, streaming). About 1 in 25 requests fails inside the stream, after HTTP 200, with DeepInfra's own error text:

```
Exception: 1 validation error for OpenAIChatCompletionStreamOut choices.0.logprobs.content.0.logprob Input should be a valid number [type=float_type, input_value=None, input_type=NoneType]
```

Reads: [DEEPINFRA.md](DEEPINFRA.md), [COST_PROXY.md](COST_PROXY.md). The exact error text and where the model returns it comes from the user's brief; I could not reproduce it (no paid call).

## Criteria

From the global rules (research before assumption, small steps, failure modes named) and the brief:

- Evidence: every claim carries a source; guesses are marked.
- Safety: a retry must not duplicate already-delivered content or double-bill tokens.
- Effort: a production-quality fix stays small and testable with the existing `bun test` setup.
- Blast radius: the fix must not break the pass-through property of the cost proxy (COST_PROXY.md C1).

## Answers

### 1. Does DeepInfra know this error?

**No public evidence of it.** What I checked:

- **DeepInfra status page** (https://status.deepinfra.com, read 2026-10-01 via reader): no incident history at all — only badges and 90-day health strips. GLM-5.3-Flash shows "Operational, 100% uptime over 34.8 of 90 days" with no downtime events. The page lists only a deprecation notice (GLM-5.1 → GLM-5.3 on 2026-10-01). No mention of streaming, logprobs, or validation errors.
- **GitHub issue search** for the model name in the error (`gh search issues "OpenAIChatCompletionStreamOut"`, 2026-10-01): no hits at all. The name is DeepInfra-internal, so nobody else has pasted this error publicly in an indexed issue.
- **Web search** for the error text combined with DeepInfra/GLM (2026-10-01): no direct report. The closest matches are the same *class* of bug in other projects, where a pydantic model rejects a missing or null `logprobs` field in a stream: openai/openai-agents-python #1269/#1227 (fixed by PR #1246, https://github.com/openai/openai-agents-python/issues/1269), LiteLLM PR #28555 (`Optional` without `= None` makes the field required, https://github.com/BerriAI/litellm/pull/28555), SGLang PR #9368 (https://github.com/sgl-project/sglang/pull/9368), vLLM issue #46028 (https://github.com/vllm-project/vllm/issues/46028). These show the pattern is a common server-side pydantic mistake: the schema says `logprob: float` (required, non-null) but the serving code emits `null` for some token.
- **Discord / DeepInfra support**: unknown. I have no access to their Discord. Reporting the error to DeepInfra with the request id is an action we can take; it is not done yet.

Interpretation **[guess]**: the error is a bug in DeepInfra's own response serialization for GLM-5.3-Flash, not in the client. The server fails to validate its *own* stream output before sending it, so the client cannot receive that chunk at all. GLM models are the plausible trigger because Zhipu GLM servers emit non-standard fields elsewhere too (see the `finish_reason: network_error` pydantic crashes in LiteLLM issue #23386 and pydantic-ai issue #7678).

### 2. Is there a request option that avoids it?

**The client already asks for no logprobs, and there is no documented option that changes the failure.** Facts:

- `@ai-sdk/openai-compatible` 3.0.62 (the package opencode uses for custom OpenAI-compatible providers, including our cost-proxy path; DEEPINFRA.md section 5) **never sends `logprobs` or `top_logprobs`**. I downloaded the npm tarball and grepped: the string `logprob` does not appear anywhere in `package/src` (checked 2026-10-01). The only stream parameter it sends is `stream_options.includeUsage`, and only in strict compatibility mode (`package/src/chat/openai-compatible-chat-language-model.ts:452-453`).
- DeepInfra's API spec makes `logprobs` a boolean request parameter ("Whether to return log probabilities of the output tokens or not") and `top_logprobs` an integer 1–20 (https://docs.deepinfra.com/api-reference/chat-completions/openai-chat-completions, fetched 2026-10-01 via search index). The OpenAI semantics: logprobs are returned only when requested, default off (https://community.openai.com/t/logprobs-in-chatcompletion/329471/1).
- So the request does not trigger logprob output. The server emits a `logprobs.content[0].logprob = null` in a stream chunk anyway (or its serializer fills the object unconditionally) and its own pydantic model rejects it. **[guess]** The null likely comes from a token for which DeepInfra's serving stack has no log probability (for example a special or reasoning token of GLM-5.3-Flash, whose `reasoning_content` handling is non-standard).
- Sending `logprobs: false` explicitly, omitting `stream_options`, or changing `stream_options` variants: **unknown, no source says they change this**. The failure is in server-side output validation, so no request option documented in the spec plausibly avoids it. One live A/B call (`logprobs: false` vs absent) would settle it cheaply if we want to rule it out.
- The **non-OpenAI DeepInfra endpoint** (`/v1/inference/<model>`, native protocol, logprobs inline per token, https://docs.deepinfra.com/chat/log-probs) is a different wire protocol. opencode and `@ai-sdk/openai-compatible` cannot speak it; it is not an option for us.

Conclusion: this is not fixable from the request side with documented means. It needs a DeepInfra server fix, or a retry somewhere.

### 3. Can a streaming proxy retry such a request safely?

**Yes before the first content chunk; no after content without accepting duplication or a continuation hack.** The established practice, with sources:

- **Retry only pre-first-chunk is the default rule** in several gateways and libraries. qwen-code PR #5171: "Adds a bounded automatic retry ... before the first chunk is yielded ... Once any chunk has been yielded, the error propagates unchanged", because mid-stream retries "would duplicate already-streamed output" (https://github.com/QwenLM/qwen-code/pull/5171, merged 2026). The npm package `llm-retry-kit` documents the same default: "By default, it retries only if the stream fails before the first chunk. After a chunk has been yielded, retrying could duplicate output" (https://github.com/JavadRostami3/llm-retry-kit README). VernLLM documents the same split (https://vernllm.dev/docs/core/streaming).
- **LiteLLM buffers the first chunk** to detect error-only streams: `create_response` fetches the first SSE chunk, and if it parses as an error it returns a normal JSON error response instead of an SSE stream, so the caller sees a retryable HTTP error (https://github.com/BerriAI/litellm/blob/main/litellm/proxy/common_request_processing.py, read 2026-10-01). Our proxy could copy this pattern: buffer nothing but the first chunk, forward it only once it is not an error frame.
- **Mid-stream (after content) LiteLLM does a "fallback with continuation"**: it wraps the error in `MidStreamFallbackError` with `generated_content`, re-runs the request on a fallback model, and injects "Continue from where it left off: '<previous content>'" (PR #9809, https://github.com/BerriAI/litellm/pull/9809; mid-stream fallback wiring PR #28214). This needs a second model, rewrites the request, and one reviewer of #9809 notes it "does not resolve the issue" in some cases — it is the heaviest and least reliable option.
- **OpenRouter** (a gateway, same situation as our proxy): "Failover also stops once part of the answer has reached you, since your application already holds output from the first provider." Before any token, it silently retries on a backup provider; mid-stream it emits an SSE error chunk with `finish_reason: "error"` and leaves recovery to the client (https://openrouter.ai/docs/api_reference/errors-and-debugging, read 2026-10-01).
- Billing risk: a retried request re-bills the prompt. On GLM-5.3-Flash that is cheap ($0.075/M in, DEEPINFRA.md section 1), so the cost risk of a bounded pre-first-chunk retry is small; the duplication risk is the real one.

For our error specifically: the brief says the failure appears "inside the stream, after HTTP status 200". Whether the poisoned chunk is the first content chunk or a later one decides safety. **[guess]** If it fires roughly 1 in 25 runs and ends the stream with no `finish_reason`, it may often come early; but only the proxy's log lines can tell us where in the stream it lands. The proxy (COST_PROXY.md section 7) already records `finish_reason` and stream errors per request, so the data arrives by itself.

### 4. Does opencode 1.18.x or later retry stream errors of this kind?

**No, not this kind.** Facts:

- opencode has a session retry policy (`SessionRetry`), capped at 5 retries with backoff since commit c789868 (~v1.18.x, 2026-08-12; issue #43596 quotes `RETRY_MAX_RETRIES = 5` in `packages/opencode/src/session/retry.ts`, https://github.com/anomalyco/opencode/issues/43596).
- The retry path only fires after the error is *classified* as retryable. Open issue #21893 ("Some transient stream/rate-limit errors bypass retry and terminate sessions", open, https://github.com/anomalyco/opencode/issues/21893) describes exactly our failure class: "some stream-layer / wrapped validation failures with transient upstream semantics do not enter retry. The session ends in error/idle, and the task stops." The error in our brief is a validation error wrapped in an SSE frame with no HTTP status — it lands as `UnknownError` and is never retried.
- The fixes in this area are narrow: PR #23841 / #30323 teach `parseStreamError` the OpenAI/Codex Responses error envelope (`server_error`, `server_is_overloaded`, `stream_read_error`, rate limits). A pydantic `Exception:` text is none of those types, so none of them match it.
- The changelog (https://opencode.ai/no/changelog, read 2026-10-01) confirms the pattern of narrow additions: "Retry provider responses that end with `finish_reason: network_error`", "Retry more network error variants", "Retry xAI capacity and temporary unavailability stream errors", "Preserved structured mid-stream provider errors so compatible providers can retry failed responses".
- There is no `opencode.json` retry knob for this yet; issue #43596 asks for one (`experimental.retry`), PR #44517 exists, and the v2 plugin docs expose a `retry` hook that can make a terminal failure retryable (https://opencode.ai/v2/docs/build/plugins, read 2026-10-01) — but that is the v2 surface, not 1.18.32.
- A third-party plugin exists for exactly this gap on 1.18.x: **`opencode-sse-retry`** wraps the provider's `fetch`, reassembles SSE events, matches configured error texts, and classifies the match as `ECONNRESET` so opencode's built-in retry loop repeats the request (https://github.com/liyangink/opencode-sse-retry/blob/main/README.en.md, read 2026-10-01). It supports content-match rules ("contains": ...) with per-rule retry counts, and states "OpenCode retries the whole model stream" once classified. This is the only ready-made opencode-side fix I found.

## Options for us

| Option | Cost | Risk | Notes |
| --- | --- | --- | --- |
| **A. Do nothing** | Zero | Every ~25th DeepInfra run dies mid-task; the user re-prompts | Status quo. DeepInfra may fix it server-side at any time (no report needed from us for that to happen, but no evidence they know). |
| **B. Report to DeepInfra** (support/Discord, with request id and error text) | ~15 min | None | The correct structural fix is theirs. No evidence they know (answer 1). No guaranteed turnaround. |
| **C. One live A/B call** (`logprobs: false` vs absent) | One cheap request | None | Rules out the only documented request-side lever. [guess] Likely no change; the failure is in output validation. |
| **D. Proxy retry before the first content chunk** in `src/proxy/` | ~50–100 lines + tests | Safe only pre-content; the poisoned chunk may come later in the stream; duplicated billing of the prompt (cheap, $0.075/M) | Matches established practice (LiteLLM first-chunk buffering, qwen-code, OpenRouter). Needs the proxy log data first to know where the failure lands. |
| **E. `opencode-sse-retry` plugin with a rule matching the error text** | Config + one dependency | Third-party plugin, small install base (immature); it retries the whole stream including already-streamed parts, so mid-stream retries duplicate content; it works by piggybacking on the `ECONNRESET` classification, which can change between opencode versions | Only ready-made opencode-side fix that works on 1.18.x. |
| **F. Route GLM-5.3-Flash away from the DeepInfra endpoint** (other OpenRouter providers, or DeepInfra only when nothing else) | Config change; loses the 50%-off DeepInfra price when avoided | Lower failure exposure, but OpenRouter failover already masks provider errors pre-token (answer 3, OpenRouter docs) | Treats the symptom; the same fp4 backend also serves DeepInfra via OpenRouter, so the same server bug can surface there. |

Which criteria decide: the deciding questions are (a) where in the stream the failure lands (proxy log data answers it), and (b) whether DeepInfra fixes it once told (B is nearly free either way). D and E overlap; D fits our existing proxy and stays under our control, E needs no code but adds a third-party dependency.

## Open questions

1. Does the poisoned chunk arrive before or after the first content chunk? Answerable from the cost proxy's per-request `end` lines once we route DeepInfra traffic through it.
2. Does sending `logprobs: false` explicitly change the server behavior? One live call answers it (option C).
3. Is DeepInfra's Discord/support aware? Unknown — no access from here.
4. Does the same failure occur on the DeepInfra GLM-5.3-Flash endpoint via OpenRouter (same fp4 backend)? Needs OpenRouter request logs, not tried.
5. Does `opencode-sse-retry`'s ECONNRESET piggyback survive future opencode 1.18.x releases? Untested; the plugin README itself flags the reliance.

## Search log (for repeating)

- Web: `"logprobs" "Input should be a valid number" DeepInfra stream error` — 0 direct hits, 4 same-class bugs in other projects.
- Web: `"OpenAIChatCompletionStreamOut" "logprob"` — 0 hits.
- Web: `opencode retry stream error mid-stream provider retry setting` — issue #21893, PRs #30323/#23841/#41939, changelog, plugin docs.
- Web: `LiteLLM retry streaming "before first chunk"` — PR #5171 (qwen-code), LiteLLM `common_request_processing.py`, PR #9809/#28214, OpenRouter error docs, `llm-retry-kit`, VernLLM.
- `gh search issues "OpenAIChatCompletionStreamOut"` — 0 hits. `gh search issues "deepinfra" "logprobs"` — 0 relevant hits. `gh search issues --repo anomalyco/opencode "deepinfra"` — 0 hits on this error.
- npm tarball grep of `@ai-sdk/openai-compatible` 3.0.62 — 0 occurrences of `logprob`.
- Reader: https://status.deepinfra.com — no incident history.
