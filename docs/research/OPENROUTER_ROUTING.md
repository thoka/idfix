# OpenRouter routing from opencode 1.18.32

Note of the orchestrator, added after the run: the premise of this question was wrong. The price did not change at OpenRouter. opencode computes the cost from the models.dev catalog, and that catalog price changed. The tests with forced routing could not show an effect, because the reported cost does not come from OpenRouter. See [EXPERIENCE.md](../EXPERIENCE.md#the-reported-cost-is-an-estimate-from-the-model-catalog). The facts about the request path and the configuration below stay valid, but nobody has tested them yet.

Research question (PLAN.md step 5): how can opencode send OpenRouter provider routing options, so that GLM 5.3 Flash goes to the cheapest provider? Sources: opencode source on GitHub (anomalyco/opencode, dev ≈ 1.18.32), the `@openrouter/ai-sdk-provider` source (2.9.0), and OpenRouter docs (openrouter.ai/docs).

## 1. How opencode builds the OpenRouter request

- opencode bundles the official SDK `@openrouter/ai-sdk-provider` (pinned 2.9.0) for the `openrouter` provider: `packages/opencode/src/provider/provider.ts` maps `openrouter` to `createOpenRouter` in `BUNDLED_PROVIDERS`, and only adds `HTTP-Referer`/`X-Title` headers. ([provider.ts](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/provider/provider.ts), [package.json](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/package.json))
- Model-level `options` from the config do **not** reach the SDK model factory. `packages/opencode/src/session/llm/request.ts` merges `base + model.options + agent.options + variant` per request, and `llm.ts` sends them as `providerOptions`. `packages/opencode/src/provider/transform.ts` maps the npm package to a key: for `@openrouter/ai-sdk-provider` the key is `openrouter`, so the config `options.provider: {"sort": "price"}` should become `providerOptions: { openrouter: { provider: { sort: "price" } } }`.
- Inside the SDK, `OpenRouterChatLanguageModel.doGenerate/doStream` spreads the openrouter providerOptions into the request body (minus `cacheControl`), so the object should land in the POST body as `provider`. ([chat/index.ts, tag 2.9.0](https://github.com/OpenRouterTeam/ai-sdk-provider/blob/2.9.0/src/chat/index.ts))
- `extraBody` is a **factory setting** of the SDK (`createOpenRouter({ extraBody })`), merged into every request body. No opencode code handles `extraBody`; it can only arrive through provider-level options.

### Why our test had no effect — facts and open points

Fact: opencode issue [#41810](https://github.com/anomalyco/opencode/issues/41810) (open) reports exactly this: OpenRouter support said "OpenCode may not be passing the provider object to OpenRouter at all". In that case the config used `npm: "@ai-sdk/openai-compatible"` — that SDK's providerOptions schema strips unknown keys, so the routing object is dropped.

Our config did not set `npm`, so the model should resolve to the bundled `@openrouter/ai-sdk-provider`, where the pass-through exists in the 2.9.0 source. Two plausible causes for our failure, both **unverified guesses**:

1. A real OpenRouter key difference: the price jump coincided with the key rotation, and OpenRouter may apply account or key settings we cannot see. OpenRouter documents no key-level routing default (see §3), so this is speculative.
2. The option reaches the body but something later overrides or drops it in the 1.18.32 release build (the source I read is dev ≈ 1.18.33).

What would settle it: capture the actual request body (see §4). I could not verify the resolved `npm` value for `z-ai/glm-5.3-flash` from here.

## 2. Correct configuration in opencode 1.18.32

Facts:

- **Model suffixes `:floor` and `:nitro`**: `:floor` = sort by price plus flex tier; `:nitro` = sort by throughput plus priority tier ([provider-routing docs](https://openrouter.ai/docs/features/provider-routing)). But opencode issue [#48016](https://github.com/anomalyco/opencode/issues/48016) (open): route-modifier suffixes (`:floor`, `:nitro`, `:exacto`) **cannot be referenced in model IDs**; open PR [#48117](https://github.com/anomalyco/opencode/pull/48117) fixes it. This also explains our `@preset/cheapest` failure: preset and suffix references are not resolved in 1.18.32 (`ProviderModelNotFoundError`).
- **`options.provider` under the model**: passes through the SDK as described above; reported broken in #41810, and did not work in our test.
- **`options` under the provider** (`provider.openrouter.options`): these reach `createOpenRouter` as factory settings, and `extraBody` there is merged into every request body by the SDK. opencode itself has no special handling for `extraBody` — the SDK does the merge. This is the path most likely to survive, but it is **untested**.
- **Model variant**: a variant would carry the same `options` path, so it inherits the same uncertainty.

### Recommended configuration (untested)

```json
{
  "provider": {
    "openrouter": {
      "options": {
        "extraBody": {
          "provider": {
            "sort": "price",
            "allow_fallbacks": true
          }
        }
      },
      "models": {
        "z-ai/glm-5.3-flash": {
          "options": {
            "provider": { "sort": "price" }
          }
        }
      }
    }
  }
}
```

Set both: the model-level `options.provider` is the intended per-model path; the provider-level `extraBody` is the fallback that bypasses the per-request providerOptions path. Before trusting it, verify with the test in §4 that `provider` really appears in the request body — that is the decisive check, not the price alone.

## 3. Account- or key-level defaults on OpenRouter

Facts from openrouter.ai/docs:

- No documented default `sort`/`order` on an account or API key. The API-key update endpoint has only `disabled`, `include_byok_in_limit`, `limit`, `limit_reset`, `name` ([update-an-api-key](https://openrouter.ai/docs/api/api-reference/api-keys/update-an-api-key)).
- Account-wide routing settings exist only for **privacy** routing: disable providers that train on data (`openrouter.ai/settings/privacy`), ZDR ([provider-logging](https://openrouter.ai/docs/guides/privacy/provider-logging)).
- **Presets** (`openrouter.ai/settings/presets`) can hold provider routing preferences, but they are applied per request: `"model": "@preset/slug"`, a `preset` field, or `"model": "model@preset/slug"` ([presets docs](https://openrouter.ai/docs/features/presets)). There is no documented default-preset-for-the-account. In opencode the only way to reference a preset is the model name, which is broken in 1.18.32 (#48016). So PLAN.md step 5.1 (set a routing default on the account) has no documented lever beyond privacy settings.

## 4. How to test that routing works

Facts from OpenRouter docs:

- Every response (streaming and not) carries the generation id: header `X-Generation-Id`, or the top-level `id` (`gen-...`) of a non-streaming response ([streaming docs](https://openrouter.ai/docs/api_reference/streaming)).
- `GET https://openrouter.ai/api/v1/generation?id=<gen-id>` returns `provider_name`, `native_tokens_prompt`, `native_tokens_cached`, `total_cost`, `upstream_inference_cost`, and more ([generations API](https://openrouter.ai/docs/api/api-reference/generations/get-request-&-usage-metadata-for-a-generation)).

Test plan:

1. Confirm the request carries the option: run one opencode request with the SDK debug or a local HTTP proxy between opencode and OpenRouter, and check that the body contains `"provider": {"sort": "price"}`. This directly answers why our earlier test failed.
2. Run a small opencode request, take `X-Generation-Id` (or the id from the session), then `curl https://openrouter.ai/api/v1/generation?id=...` and check `provider_name` against the endpoint list from `https://openrouter.ai/api/v1/models/z-ai/glm-5.3-flash/endpoints`: the serving provider must be one whose input price is at the cheap end (about 0.045 USD/Mtok), not 0.15.
3. Cross-check in the stored sessions (`opencode.db`): input token price about 0.04–0.05 USD per million, as in the earlier EXPERIENCE.md table.

## Open questions

1. Does the request body in the 1.18.32 release actually contain the `provider` object? (Needs a proxy or debug capture; not verified here.)
2. Is the model's resolved SDK package `@openrouter/ai-sdk-provider` (not `@ai-sdk/openai-compatible`) for our config?
3. Does `extraBody` at provider level survive opencode's option merging into `createOpenRouter`?
4. Why did the price jump with the new keys — account-level privacy or preset settings are the remaining hypothesis, but nothing is documented.
