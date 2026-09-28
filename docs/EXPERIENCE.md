# Experience from the first use

These notes come from the first use of GLM 5.3 Flash subagents through opencode in a Python project in September 2026. The rules of the skill in [skills/oc-sub/](../skills/oc-sub/) follow from them.

## Benchmark

GLM repeated four finished coding steps of the project from the same parent commit, with the plan text of each step as the brief. The orchestrator compared each result with the earlier version of Claude.

| Step | Files | Time | Cost | Result |
| --- | --- | --- | --- | --- |
| Retry on rate limits | 5 | 6 min | 0.07 USD | Complete. The other interface names made 7 of 37 tests of the earlier version fail. |
| A new label through the whole tool | 10 | 9 min | 0.13 USD | Complete. Two edge cases were missing. |
| Audio cutting with ffmpeg | 5 | 18 min | 0.09 USD | Complete, with tests that cut a real tone. |
| Short command arguments | 11 | 49 min | 0.33 USD | Mostly complete. One consumer of the arguments was missed. |

In all four runs, all tests and the linters passed. GLM made small commits and wrote honest reports. In most cases, it reported a denied command and did not try to get around it. In one later run, it deleted a file through a test run after `rm` was denied.

Research runs took 9 to 13 minutes and cost 0.08 to 0.09 USD for a report of 2,000 to 6,000 words with sources.

## Lessons

1. Small and medium steps with a precise brief work well. Large steps across many files get slow, expensive, and incomplete. Split them.
2. The orchestrator must review every diff and run the tests. GLM trusted the SDK types over the real server behavior once, and a review found the bug.
3. For a pure JSON answer without tools, GLM needs low reasoning effort. With the default thinking, it used all output tokens and gave no answer.
4. Without a routing rule, OpenRouter mixes cheap providers. A run then costs about half of the price of the main provider. The speed was 30 to 140 tokens per second.

## The reported cost is an estimate from the model catalog

On 2026-09-28, research runs in terminator suddenly showed three to nine times the cost of earlier runs. A fit of cost against tokens over each stored session (`~/.local/share/opencode/opencode.db`) shows two price levels for the same model `z-ai/glm-5.3-flash`:

| Runs | Input | Cached input | Output |
| --- | --- | --- | --- |
| Up to 14:03 on 2026-09-28 | 0.040 USD | 0.015 USD | 0.50 USD |
| From 18:27 on 2026-09-28 | 0.150 USD | 0.030 USD | 0.50 USD |

The prices are in USD per million tokens. The cause is not OpenRouter. opencode computes the `cost` of each step from the token counts and the price in its model catalog, which it loads from models.dev and caches in `~/.cache/opencode/models.json`. On the evening of 2026-09-28, that catalog listed `openrouter/z-ai/glm-5.3-flash` with `{"input": 0.15, "output": 0.5, "cache_read": 0.03}`. So the cost in opencode, and in `oc-sub watch` and `oc-sub log`, is an estimate. The real charge is only visible at OpenRouter: on the activity page, or through `GET /api/v1/generation?id=...`.

Tests that led to this result, with a prompt of about 8,000 tokens each:

1. `"sort": "price"` in `provider.openrouter.models["z-ai/glm-5.3-flash"].options.provider` did not change the reported cost.
2. `"order": ["inference-net"]` with `"allow_fallbacks": false`, in the same place and in `provider.openrouter.options.extraBody`, did not change it either, and gave no error.
3. A run with the global key and a run with a project key showed the same price.
4. The model name `openrouter/z-ai/glm-5.3-flash@preset/cheapest` fails with `ProviderModelNotFoundError` (opencode issue 48016). The global opencode configuration used it as the default model, so that default never worked.

The OpenRouter list of providers (`https://openrouter.ai/api/v1/models/z-ai/glm-5.3-flash/endpoints`) shows prices from 0.045 to 0.75 USD per million input tokens.

Lessons:

1. Compare runs by their tokens, not by the reported cost. The tokens come from the provider, and the cost comes from a catalog that can change.
2. For the real cost, ask OpenRouter.
3. The token counts confirm the context growth. The most expensive terminator run read 17.3 million cached tokens, and the earlier runs read 1.0 to 4.1 million.
