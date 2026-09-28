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

## Price per token after the key rotation

On 2026-09-28, research runs in terminator suddenly cost three to nine times more. A fit of cost against tokens over each stored session (`~/.local/share/opencode/opencode.db`) shows two price levels for the same model `z-ai/glm-5.3-flash`:

| Runs | Input | Cached input | Output |
| --- | --- | --- | --- |
| Up to 14:03 on 2026-09-28 | 0.040 USD | 0.015 USD | 0.50 USD |
| From 18:27 on 2026-09-28 | 0.150 USD | 0.030 USD | 0.50 USD |

The prices are in USD per million tokens. Between the two times, the user rotated the OpenRouter key and gave each project its own key. After that, the global key and the project keys pay the higher price. The OpenRouter list of providers (`https://openrouter.ai/api/v1/models/z-ai/glm-5.3-flash/endpoints`) shows providers from 0.045 USD per million input tokens, and 0.15 USD is the most common price.

Tests with a prompt of about 8,000 tokens, each at about 0.0015 USD:

1. `"sort": "price"` in `provider.openrouter.models["z-ai/glm-5.3-flash"].options.provider` had no effect. The server showed the merged option in `GET /config`.
2. `"order": ["inference-net"]` with `"allow_fallbacks": false` in the same place had no effect either. So opencode 1.18.32 did not pass the option to OpenRouter in this setup.
3. The model name `openrouter/z-ai/glm-5.3-flash@preset/cheapest` fails with `ProviderModelNotFoundError`. The global opencode configuration used it as the default model, so that default never worked.

Lessons:

1. Make sure that the price per token stays the same after a change of key or configuration. One tiny run and a look at the cost per input token are enough.
2. The cost of a run depends on the price per token and on the context growth. Check the price first, because it is the cheaper check.
