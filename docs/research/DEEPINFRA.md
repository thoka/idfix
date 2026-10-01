# DeepInfra as a direct provider for GLM, and how it measures cost

Research on 2026-10-01. No paid API call was made and no key file was read. Every live call was free (public model pages, docs, `models.dev/api.json`, the DeepInfra public model list). Context: oc-sub runs GLM 5.3 Flash through OpenRouter (see [PROVIDER_PROBE.md](PROVIDER_PROBE.md)); the user has a DeepInfra account and says DeepInfra is 50 percent cheaper.

## Criteria

From the global rules (research before assumption, established libraries, quality first, cost cap) and the brief:

- Model fit: the exact model oc-sub uses (`z-ai/glm-5.3-flash`) must be served directly, with 1M context.
- Precision: quantization must not be fp4 (the fp4 incident of 2026-09-28; PROVIDER_PROBE.md section 1).
- Feature parity: tool calls, streaming with usage, reasoning, prompt caching must work through the OpenAI-compatible API.
- Cost truth: the client must be able to read the real cost per request, and a spend limit must exist.
- Integration effort: opencode 1.18.32 must be able to use it with the built-in provider mechanism or a small config block.
- Catalog correctness: models.dev prices must match what DeepInfra charges.

## Short answers

1. **Models.** DeepInfra serves eight GLM models directly, including `zai-org/GLM-5.3-Flash` with the full 1,048,576-token context. Standard prices are $0.15 in / $0.50 out / $0.03 cached per 1M tokens; the current "50% off" discount brings that to **$0.075 / $0.25 / $0.015** — the same numbers as the DeepInfra endpoint on OpenRouter. No end date for the discount is published anywhere (unconfirmed how long it lasts).
2. **Quantization.** The model pages badge GLM-5.3-Flash and GLM-5.3 as **fp4**; no higher-precision serverless variant is offered. fp8 is only available on a dedicated (private) deployment. **This repeats the fp4 problem that led to the broken-output incident**, so DeepInfra fails the precision criterion today.
3. **API features.** Yes to all four: function tool calls, streaming with `stream_options.include_usage`, `reasoning_effort`/`reasoning_content`, and automatic prompt caching with an optional `prompt_cache_key` and `prompt_tokens_details.cached_tokens` in usage.
4. **Cost measurement.** The response `usage` carries `estimated_cost` in USD. The billing API offers `GET /payment/usage` (per month, per model, with discount names) and `GET /payment/usage/{api_token}` (per key), plus `POST /v1/request-costs` (`requestIds` → `costNanoUsd`) if the request id is captured. Spend limits exist at account level (`POST /payment/config`) and for scoped JWTs; a per-API-key spend limit is not documented.
5. **opencode integration.** `deepinfra` is a built-in provider in opencode (models.dev entry, npm package `@ai-sdk/deepinfra`, env `DEEPINFRA_API_KEY`); it needs no custom config, only the key. An `@ai-sdk/openai-compatible` entry with `baseURL: "https://api.deepinfra.com/v1/openai"` and an `{file:...}` key also works, as with the cost proxy today.
6. **models.dev.** Yes, it lists `deepinfra` with all GLM models — at the **standard (undiscounted)** prices. During the 50% discount opencode's cost estimate will be about **2× the real cost**.

## 1. GLM models on DeepInfra today

Source: the public model list `GET https://api.deepinfra.com/v1/openai/models` (fetched 2026-10-01) contains these GLM model IDs; prices and context lengths from the model pages and from `models.dev/api.json` (provider `deepinfra`, fetched 2026-10-01):

| Model ID | Context | In $/M | Out $/M | Cached $/M | Source |
| --- | --- | --- | --- | --- | --- |
| `zai-org/GLM-4.6` | 202,752 | 0.50 | 2.00 | 0.10 | models.dev, deepinfra.com/zai-org/GLM-4.6/api |
| `zai-org/GLM-4.7` | 202,752 | 0.40 | 1.75 | 0.08 | models.dev |
| `zai-org/GLM-4.7-Flash` | 202,752 | 0.06 | 0.40 | 0.01 | models.dev |
| `zai-org/GLM-5` | 202,752 | 0.60 | 2.08 | 0.12 | models.dev, deepinfra.com/zai-org/GLM-5 |
| `zai-org/GLM-5.1` | 202,752 | 1.05 | 3.50 | 0.205 | models.dev, deepinfra.com/zai-org/GLM-5.1/api |
| `zai-org/GLM-5.2` | 1,048,576 | 0.75 | 2.40 | 0.14 | models.dev, deepinfra.com/zai-org/GLM-5.2/api |
| `zai-org/GLM-5.3` | 1,048,576 | 0.563 (list 0.90) | 2.50 (list 4.00) | 0.125 (list 0.20) | deepinfra.com/zai-org/GLM-5.3/api |
| `zai-org/GLM-5.3-Flash` | 1,048,576 | **0.075 (list 0.15)** | **0.25 (list 0.50)** | **0.015 (list 0.03)** | deepinfra.com/zai-org/GLM-5.3-Flash/api |

Notes:

- The model list API returns `"quantization": null, "context_length": null, "price_data": null` for every GLM model, so the numbers come from the pages, not the API.
- The GLM-5.3-Flash page shows `$0.075 in, $0.25 out, $0.015 cached / 1M tokens` against struck-through `$0.15 in, $0.50 out, $0.03 cached`, with a **"50% off"** badge. The DeepInfra blog confirms: "Standard pricing is $0.15 per 1M input tokens and $0.50 per 1M output tokens, with cached tokens at $0.03 per 1M. A 50% discount is currently active, bringing those figures down to $0.075, $0.25, and $0.015 respectively" (https://deepinfra.com/blog/glm-5-3-flash-deepinfra, published 2026-09-28). This matches the user's statement and exactly matches the DeepInfra endpoint prices in PROVIDER_PROBE.md section 1.
- **No end date and no terms** are published for the discount — not on the model page, not in the blog. Duration unconfirmed. GLM-5.3 (non-Flash) is discounted 38% instead; other GLM models show no discount.
- Context of 1,048,576 for GLM-5.3-Flash: model page badge and blog ("The full 1,048,576-token context window is supported"). models.dev agrees (`limit.context: 1048576, output: 131072`).
- Service tiers exist: Standard 1×, Priority 1.5×, Flex 0.8× (https://deepinfra.com/pricing). Cache-write premium with retention windows (5m 1.25×, 1h 2×) is documented on the GLM-5.2 page.

## 2. Quantization

- The GLM-5.3-Flash page badges the model **fp4** (reader fetch of https://deepinfra.com/zai-org/GLM-5.3-Flash/api, 2026-10-01). Same for GLM-5.3 ("badges: Public, Zero retention, fp4, 1,048,576…"). The DeepInfra blog also says: "DeepInfra's listing also notes fp4 precision" (https://deepinfra.com/blog/glm-5-3-flash-pricing-providers-cost).
- **No higher-precision serverless variant is offered.** No fp8/bf16 badge or variant link appears on either page. The quantization field of the public model list is `null` for all GLM models.
- fp8 is only available on a **dedicated** deployment: the deploy API accepts `quantization: enum: fp8, awq, gptq, awq_marlin, gptq_marlin, compressed-tensors, bitsandbytes` (https://docs.deepinfra.com/api-reference/dedicated-models/deploy-create-llm). No fp4 or bf16 option there; no dedicated pricing was researched (GPU-hour rental, out of scope for oc-sub's per-token model).
- Consequence for the fp4 exclusion: PROVIDER_PROBE.md excluded all fp4 endpoints after the broken-output incident. **DeepInfra direct serves the same fp4 weights as the DeepInfra endpoint on OpenRouter that we excluded.** Whether DeepInfra's fp4 serving is identical in quality to what it serves through OpenRouter is unknown (unconfirmed); it may be the same backend behind both. This is the single biggest open risk.

## 3. OpenAI-compatible API features

Endpoint: `POST https://api.deepinfra.com/v1/openai/chat/completions`, `Authorization: Bearer <key>` (https://deepinfra.com/zai-org/GLM-5.3-Flash/api; docs https://docs.deepinfra.com/chat/overview.md).

- **Tool calls: yes.** `tools` ("Currently, only functions are supported as a tool"), `tool_choice` (none/auto/required/specific), assistant `tool_calls` with id/type/function (https://docs.deepinfra.com/api-reference/chat-completions/openai-chat-completions.md). The model pages badge "Function".
- **Streaming with usage: yes.** `stream: true`; `stream_options.include_usage` (default true) and `stream_options.continuous_usage_stats` (default false) (same spec page). Better than OpenRouter here: usage is on by default.
- **Reasoning: yes.** Parameters `reasoning_effort` ("none, minimal, low, medium, high, xhigh, and max") and `reasoning` (ChatReasoningSettings); assistant message carries `reasoning_content` (same spec page). The blog names `reasoning_effort` (low, high, max) for GLM-5.3-Flash specifically.
- **Prompt caching: yes, automatic.** "Prompt caching is **automatic** — no extra parameters required." Optional explicit `prompt_cache_key`, `prompt_cache_options` (ttl 5m/1h), `prompt_cache_breakpoint`, per-message `cache_control`; hits appear as `prompt_tokens_details.cached_tokens` (https://docs.deepinfra.com/chat/prompt-caching.md). The GLM-5.2 page documents cache-retention pricing tiers.

## 4. Learning the real cost of a request

Three mechanisms, all documented:

1. **`usage.estimated_cost` in the response.** The model pages' response examples show:
   ```json
   "usage": { "prompt_tokens": 15, "completion_tokens": 16, "total_tokens": 31, "estimated_cost": 0.0000268 }
   ```
   (https://deepinfra.com/zai-org/GLM-5.3-Flash/api and .../GLM-5.3/api). Present in every example, streaming and non-streaming presumed; the OpenAPI spec leaves the response schema untyped (`schema: {}`), so the field is confirmed by example, not by schema. USD as a decimal — the examples match the published prices.
2. **Per-request cost lookup.** `POST /v1/request-costs` with body `{"requestIds": [...]}` returns `RequestCostItem { requestId, costNanoUsd }` (https://docs.deepinfra.com/api-reference/logs-&-metrics/get-request-costs). To use it, a proxy must capture the request id of each call — the response header that carries it is **not documented** (unconfirmed; needs one live call to check, e.g. `x-request-id`).
3. **Usage/billing API.** `GET /payment/usage` returns per-month items with `model.model_name`, `units`, `rate`, `cost`, `total_cost`, and a `discount {name, description}` field per item (https://docs.deepinfra.com/api-reference/billing/usage). `GET /payment/usage/{api_token}` does the same **for one API key** — this is the equivalent of OpenRouter's `GET /key` delta measurement, and it does not depend on a proxy. `GET /payment/checklist` returns `recent` (usage since the last invoice), `stripe_balance`, and the account `limit`.

**Spend limits:** yes, two documented levels:

- Account: `POST /payment/config` with `{"limit": <usd>}` — "Set usage limit (in USD). Negative means no limit" (https://docs.deepinfra.com/api-reference/billing/set-config). The pricing page: "You can also set a spending limit to avoid surprises."
- Scoped JWT: `POST /v1/scoped-jwt` with `"spending_limit": 1.0`, plus model allow-list and expiry — "Requests using disallowed models, expired tokens, or over-budget tokens will be rejected" (https://docs.deepinfra.com/account/authentication).
- A spend limit **per regular API key** is not documented (unconfirmed). Keys are created in the dashboard; only usage per key (`/payment/usage/{api_token}`) is documented.

## 5. Adding DeepInfra to opencode 1.18.32

`deepinfra` is a **built-in provider**. models.dev's `deepinfra` entry declares `"env": ["DEEPINFRA_API_KEY"], "npm": "@ai-sdk/deepinfra"` (models.dev/api.json), and `@ai-sdk/deepinfra` 3.0.62 on npm depends on `@ai-sdk/openai-compatible` — the standard models.dev-driven provider. The opencode docs list Deep Infra among the built-in providers: "Head over to the Deep Infra dashboard, create an account, and generate an API key. Run the /connect command and search for Deep Infra" (https://opencode.ai/docs/providers/, fetched 2026-10-01).

So the minimal setup is the key file plus env, no provider block:

```
~/.config/opencode-subagents/deepinfra.key   # key only, mode 600
DEEPINFRA_API_KEY={file:~/.config/opencode-subagents/deepinfra.key}
```

Model selection: `deepinfra/zai-org/glm-5.3-flash` in the model config. The explicit custom entry (same pattern as the cost proxy's `baseURL` override, COST_PROXY.md section 1) also works if we want to pin options:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "deepinfra": {
      "models": {
        "zai-org/GLM-5.3-Flash": {
          "options": { "reasoning_effort": "low" }
        }
      }
    }
  }
}
```

Or, fully explicit without the built-in provider:

```json
{
  "provider": {
    "deepinfra-direct": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "DeepInfra (direct)",
      "options": {
        "baseURL": "https://api.deepinfra.com/v1/openai",
        "apiKey": "{file:~/.config/opencode-subagents/deepinfra.key}"
      },
      "models": { "zai-org/GLM-5.3-Flash": {} }
    }
  }
}
```

Unverified details (no paid call possible): whether the custom `baseURL` entry needs `type: "openai-compatible"` in 1.18.32, and whether the built-in entry picks up the catalog's tool/reasoning flags correctly for this model. The `{file:...}` syntax is the one oc-sub already uses for OpenRouter.

## 6. models.dev price correctness

Yes, models.dev lists `deepinfra` as a provider with all eight GLM models (`zai-org/GLM-5.3-Flash`: cost input 0.15, output 0.5, cache_read 0.03; context 1048576, output 131072 — models.dev/api.json, fetched 2026-10-01). **But it lists the standard prices, not the discounted ones.** During the 50% discount, opencode's cost estimate will be about 2× what DeepInfra actually charges; the plugin/`oc-sub` should prefer `usage.estimated_cost` (question 4) as the real number, or divide by the discount factor while it lasts. The catalog does not carry any discount field.

## Options judged

| Criterion | A: DeepInfra direct (built-in provider) | B: stay on OpenRouter, status quo |
| --- | --- | --- |
| Model fit | Exact model, full 1M context | Same model via 31 providers |
| Precision | **Fails today: fp4 only, no fp8 serverless variant** | Passes: fp8 providers (z-ai, parasail, together) |
| Features | Passes all four (tools, stream+usage, reasoning, caching) | Passes |
| Cost truth | Best of both: `usage.estimated_cost` per request, usage per key; cheaper ($0.075/$0.25 vs $0.15/$0.50 Z.AI) | Good: `cost` in final usage chunk, generation API, key usage (late) |
| Effort | Near zero: built-in provider, one key file | Zero |
| Catalog correctness | models.dev has standard prices; estimate 2× real during discount | Correct |

Known failure modes: A — fp4 serving was the prime suspect in the 2026-09-28 broken-output incident (PROVIDER_PROBE.md), and discount may end at any time (no end date). B — 2× the discounted price, provider attribution only through the proxy.

## Recommendation

**Do not switch production traffic to DeepInfra until its fp4 serving passes a probe.** The price and the cost-measurement side are genuinely better (real `estimated_cost` per request, usage per key, spend limits), and integration is free. But precision is the criterion that already caused an incident, and DeepInfra offers nothing above fp4 without a dedicated deployment. Suggested next step: 3 probe runs (`bun probe/run.ts` shape) against DeepInfra direct with the same A/B task; if it passes gross-breakage checks and survives the oc-sub validation runs, add it as the first entry of `opencode/opencode.json` while the 50% discount holds.

## Open questions

1. Is DeepInfra's fp4 serving on its own API the same backend as its fp4 OpenRouter endpoint (which failed the broken-output probe indirectly)? Only a probe answers it.
2. Which response header carries the request id for `POST /v1/request-costs`? Undocumented; one live call resolves it.
3. How long does the 50% discount last? No published end date.
4. Can a regular API key (not a scoped JWT) have its own spend limit in the dashboard? Not documented.
5. Does `usage.estimated_cost` also appear in the final chunk of a streamed response (the examples are non-streaming)? Almost certainly, but unconfirmed.
6. Does opencode 1.18.32 send `reasoning_effort` and read `reasoning_content` through `@ai-sdk/deepinfra` correctly for this model? Needs one test run.
