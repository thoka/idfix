# The real cost from OpenRouter for `oc-sub`

Research for [PLAN.md](../PLAN.md) step 5: how can `oc-sub` show the cost that OpenRouter actually charges for a run, instead of the estimate that opencode computes from the models.dev catalog? Sources: OpenRouter docs, opencode source (dev branch on GitHub, anomalyco/opencode), the plugin documentation, and `@openrouter/ai-sdk-provider`.

## 1. Where OpenRouter reports the real cost

| Channel | Works with a normal API key? | What it gives |
| --- | --- | --- |
| `usage` object in every response | yes, always | `cost` (total charged, in credits/USD) and `cost_details.upstream_inference_cost` per request |
| `GET /api/v1/generation?id=...` | yes (bearer API key) | `total_cost` (required field), `upstream_inference_cost`, token counts, `provider_name`, latency, `is_byok` |
| `GET /api/v1/key` | yes | lifetime `usage`, `usage_daily`/`usage_weekly`/`usage_monthly`, `limit_remaining` for the key |
| `GET /api/v1/activity` | **no — management key required** (403 otherwise) | last 30 completed UTC days, rows with `usage` in USD, `requests`, tokens, `model`, `provider_name`, `date` |
| `GET /api/v1/credits` | **no — management key required** | total credits purchased and used |

Facts with sources:

- The `usage` object arrives automatically. The docs say: "OpenRouter automatically returns detailed usage information with every response, including ... 3. Cost in credits ... No additional parameters are required." The old `usage: { include: true }` and `stream_options: { include_usage: true }` are "deprecated and have no effect" (https://openrouter.ai/docs/use-cases/usage-accounting).
- "`cost`: The total amount charged to your account; `cost_details.upstream_inference_cost`: The actual cost charged by the upstream AI provider" (same page). Caveat: via the generation endpoint, `upstream_inference_cost` is "only available for BYOK requests. For all other requests it will be 0 or null."
- `GET /generation` uses plain bearer-token API-key security, no management-key annotation; `total_cost` is a required field of the response (https://openrouter.ai/docs/api/api-reference/generations/get-request-&-usage-metadata-for-a-generation).
- `GET /activity` is marked "[Management key] required"; its 403 example reads "Only management keys can perform this operation" (https://openrouter.ai/docs/api/api-reference/analytics/get-user-activity-grouped-by-endpoint.md). Same for `GET /credits` (https://openrouter.ai/docs/api/api-reference/credits/get-remaining-credits.md). `GET /key` documents no management-key requirement and returns per-key usage (https://openrouter.ai/docs/api/api-reference/api-keys/get-current-api-key.md).

Consequence for us: since each project has its own OpenRouter key, `GET /generation` and `GET /key` work with the project key that `oc-sub` already uses. No management key is needed unless we want account-wide activity.

## 2. Does opencode receive or store the real cost?

No, on all counts. Facts from the dev branch of opencode (dev ≈ 1.18.32+):

- Cost storage: `packages/opencode/src/session/processor.ts` (`case "step-finish"`) calls `Session.getUsage(...)` and does `ctx.assistantMessage.cost += usage.cost`. `Session.getUsage` in `packages/opencode/src/session/session.ts` computes `tokens × input.model.cost` (the models.dev catalog, with tier handling) — it never reads `metadata.openrouter`. The only provider-reported cost honored is Copilot's `metadata.copilot.totalNanoAiu`. No generation id is written anywhere in `message-v2.ts`, `processor.ts`, or `session.ts`. ([session.ts](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/session.ts), [processor.ts](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/processor.ts))
- Receiving: the bundled `@openrouter/ai-sdk-provider` does forward usage into `result.providerMetadata.openrouter.usage` (including `cost`), but its README shows this only "if usage accounting is enabled" (`usage: { include: true }` on the model factory). opencode's processor never sets that option, and OpenRouter's docs say the flag is deprecated anyway — so whether the cost even reaches opencode's stream is unverified. (https://github.com/OpenRouterTeam/ai-sdk-provider/blob/main/README.md)
- Plugin hooks: the docs list only `message.updated`, `message.part.updated`, `message.part.removed`, `message.removed` (https://opencode.ai/docs/plugins). Text/reasoning/tool parts persist a `metadata` field, but the cost-bearing step-finish event is not persisted as a part, and no hook intercepts the step finish. So a plugin cannot today store the OpenRouter cost into the session.

## 3. Can opencode use the real cost instead of the catalog price?

- No configuration path exists. `Session.getUsage` reads `input.model.cost` from the resolved model object. The config docs (https://opencode.ai/docs/config/) show no per-model `cost` field; a custom model definition can carry a cost, which would only replace the catalog price with another estimate, not with the real charge.
- Open feature request: issue [#43818](https://github.com/anomalyco/opencode/issues/43818) "[FEATURE]: Honor provider-reported cost (usage.cost) from LLM gateways (OpenRouter, LiteLLM, Manifest)", open since 2026-08-21. No issue or PR surfaced about storing the OpenRouter generation id.
- The Copilot precedent (`totalNanoAiu` read from `providerMetadata`) shows the intended shape: a small patch could read `providerMetadata.openrouter.usage.cost` in `getUsage` the same way. That is upstream work, not something `oc-sub` can switch on.

## 4. Simplest way for `oc-sub` to show the real cost per run

Proposal, matching the given facts (many concurrent sessions per server, one key per project, cost of child sessions summed in `src/summary.ts`):

**After a run finishes, `oc-sub` collects the OpenRouter generation costs for the time window of the run, via `GET /api/v1/generation?id=...` for each step — but the generation IDs are not stored by opencode, so the practical variant is the credits/activity fallback below, or per-step generation lookup through a proxy.** Concretely, in order of preference:

1. **Real total via the key's usage delta (simplest, real numbers).** Before the run, `oc-sub` calls `GET /api/v1/key` with the project key and notes `data.usage` (cumulative USD). After the run, it calls it again; the difference is the exact charge of everything the key did in between. Because each project has its own key, overlap is the only mixing source.
2. **Per-step real cost via the generation endpoint.** A small local HTTP proxy (or the SDK debug path) between opencode and OpenRouter captures the generation id (`id` header / `gen-...`) per request; after the run, `oc-sub` queries `GET /api/v1/generation?id=...` for each captured id and sums `total_cost`, even attributing per provider. This gives per-run *and* per-provider detail. Works with the normal project key. Cost: one proxy and one request per step.
3. **Management-key activity endpoint.** `GET /api/v1/activity` grouped by day/model is too coarse for runs that overlap; only useful as a sanity check, and it needs a second (management) key per account.

Limits:

- **Overlap:** `oc-sub` runs many sessions at once on one server. With variant 1, two overlapping runs on the same project key mix into one delta; the report can only bound the cost ("between X and Y for the whole batch"). Variant 2 (generation ids) is the only one that attributes cost per run correctly despite overlap. Variant 1 per project key still separates projects, since keys differ.
- **Timing:** `GET /generation` data becomes available asynchronously after the request; a short poll/retry (404 → wait) is needed. Unverified in practice.
- **BYOK:** `upstream_inference_cost` is 0/null for non-BYOK requests; `total_cost` (what the account pays) is what we want and is always present.
- **Storage:** opencode stores no generation id, so without the proxy (variant 2) the per-run real cost cannot be joined to the per-session token counts. Keep showing the opencode estimate next to the real delta.

Recommendation: implement variant 1 now (two `GET /key` calls, no new infrastructure), and add variant 2 (proxy capturing generation ids) if per-run attribution under overlap matters. Decision with the user per PLAN.md step 5.2.

## Open questions

1. Does `providerMetadata.openrouter.usage.cost` actually arrive in opencode's stream in 1.18.32 without `usage: { include: true }`? Needs a proxy/debug capture.
2. How fast is `GET /generation` data available after a streaming request completes (poll delay)?
3. Does a merged PR ever land for issue #43818 (honor `usage.cost`)? Re-check before building variant 2.
4. Is the model's resolved SDK package for `z-ai/glm-5.3-flash` the bundled `@openrouter/ai-sdk-provider` (leftover from openrouter-routing.md, also relevant for capturing ids)?
