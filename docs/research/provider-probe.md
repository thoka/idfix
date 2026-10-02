---
checked: 2026-09-30
recheck: 2w
decisions:
  - "the provider order of opencode/opencode.json"
  - "DeepInfra as a direct provider"
---

# Provider probe: picking approved OpenRouter providers for GLM 5.3 Flash

Research for PLAN.md step 10a, written on 2026-09-30. No OpenRouter key was used and no paid call was made. The only live call was the free endpoints API.

## Criteria

The criteria come from the global rules (research before assumption, established patterns, small steps, quality first, cost cap) and from PLAN.md step 10:

- **Attribution**: the probe must know which provider served each request.
- **Realism**: the probe must reproduce the failure modes seen in real oc-sub runs (loops, garbage text, runaway reasoning, broken tool calls), which happened in opencode agent loops over a large file, not in toy one-shot calls.
- **Checkable pass rules**: correct answer, a commit, no repeated identical calls, no unreadable text, reasoning under a limit — all checked by code.
- **Cost**: the whole probe stays inside the 0.15–0.30 USD budget of step 10.
- **Speed measurement**: per-provider latency and throughput, comparable to what OpenRouter publishes.
- **Effort**: a production-quality version must be small; it reuses the step 6 detectors where possible.

## 1. Who serves `z-ai/glm-5.3-flash` today

Source: `GET https://openrouter.ai/api/v1/models/z-ai/glm-5.3-flash/endpoints`, fetched 2026-09-30, no key needed. The response holds 33 endpoints from 31 distinct providers (BaseTen and Fireworks have two endpoints each). Excerpt of the raw response (the current provider first):

```json
{"name": "Z.AI | z-ai/glm-5.3-flash-20260826", "provider_name": "Z.AI",
 "quantization": "fp8", "context_length": 1048576, "max_completion_tokens": 131072,
 "pricing": {"prompt": "0.00000015", "completion": "0.0000005", "input_cache_read": "0.00000003"},
 "uptime_last_5m": 99.8, "uptime_last_30m": 99.7, "uptime_last_1d": 99.5,
 "latency_last_30m": {"p50": 3446, "p75": 5534, "p90": 7986, "p99": 21556},
 "throughput_last_30m": {"p50": 28, "p75": 44, "p90": 68, "p99": 101},
 "supported_parameters": ["reasoning", ..., "tools", "tool_choice", "response_format", "reasoning_effort"]}
```

Full table (prices in USD per million tokens; latency in ms, throughput in tokens/s, both `p50` of the last 30 minutes as published by OpenRouter; uptime in percent). Every endpoint lists `tools` and `tool_choice` in `supported_parameters`. Quantization `unknown` means OpenRouter does not publish it.

| Provider | Quant | Ctx | Max out | In $/M | Out $/M | Cache $/M | Up 5m/30m/1d | Lat p50 | Tput p50 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| OpenInference | fp4 | 1.0M | 943k | 0.020 | 0.248 | 0.010 | 100/100/99.5 | 1781 | 14 |
| Relace | unknown | 1.0M | 131k | 0.035 | 0.500 | 0.035 | 100/99.6/99.7 | 1473 | 35 |
| Sail Research | fp8 | 1.0M | 131k | 0.045 | 0.600 | 0.029 | 100/99.7/99.6 | 1539 | 21 |
| DeepInfra | fp4 | 1.0M | 131k | 0.075 | 0.250 | 0.015 | 100/99.6/99.6 | 2227 | 12 |
| Novita | fp8 | 1.0M | 131k | 0.084 | 0.280 | 0.017 | 99.7/99.6/98.6 | 3332 | 27 |
| StreamLake | fp8 | 1.0M | 128k | 0.087 | 0.290 | 0.017 | 99.5/97.8/97.8 | 1762 | 31 |
| GMICloud | fp8 | 1.0M | 943k | 0.090 | 0.300 | 0.018 | 99.5/97.1/98.4 | 3422 | 31 |
| InferenceNet | fp4 | 1.0M | 128k | 0.100 | 0.450 | 0.030 | 100/99.7/99.1 | 1072 | 33 |
| AtlasCloud | fp8 | 1.0M | 131k | 0.115 | 0.385 | 0.023 | 98.7/95.8/96.6 | 3473 | 34 |
| Near AI | fp8 | 1.0M | 131k | 0.120 | 0.400 | 0.028 | 99.8/99.0/98.5 | 2496 | 13 |
| Decart | fp4 | 1.0M | 943k | 0.128 | 0.425 | 0.025 | 99.9/99.9/99.0 | 1306 | 59 |
| Phala | fp8 | 1.0M | 131k | 0.128 | 0.425 | 0.025 | 99.9/98.9/98.9 | 3527 | 28 |
| Modal | nvfp4 | 1.0M | 943k | 0.150 | 0.500 | 0.030 | 99.4/99.7/99.2 | 373 | 61 |
| BaseTen (a) | fp8 | 1.0M | 131k | 0.150 | 0.500 | 0.030 | 97.7/98.7/97.8 | 697 | 118 |
| BaseTen (b) | fp8 | 1.0M | 131k | 0.150 | 0.500 | 0.030 | 98.9/98.7/97.7 | 637 | 128 |
| Crusoe | fp4 | 1.0M | 943k | 0.150 | 0.500 | 0.030 | 100/99.7/99.0 | 741 | 45 |
| CoreWeave | nvfp4 | 1.0M | 943k | 0.150 | 0.500 | 0.050 | 98.5/98.4/98.8 | 908 | 53 |
| Fireworks (a) | unknown | 1.0M | 943k | 0.150 | 0.500 | 0.030 | 100/99.9/99.0 | 1591 | 53 |
| Friendli | unknown | 1.0M | 943k | 0.150 | 0.500 | 0.030 | 99.3/99.2/95.4 | 2387 | 67 |
| SiliconFlow | fp8 | 1.0M | 262k | 0.150 | 0.500 | 0.030 | 99.8/98.8/98.7 | 1415 | 39 |
| DigitalOcean | unknown | 1.0M | 943k | 0.150 | 0.500 | 0.030 | 99.9/99.8/99.8 | 585 | 28 |
| Together | unknown | 1.0M | 943k | 0.150 | 0.500 | 0.030 | 100/99.9/99.8 | 537 | 98 |
| Reka | unknown | 262k | 235k | 0.150 | 0.500 | 0.030 | 100/99.9/99.7 | 1791 | 31 |
| Parasail | fp8 | 1.0M | 943k | 0.150 | 0.500 | 0.030 | 99.7/99.8/99.8 | 750 | 97 |
| Venice | unknown | 1.0M | 131k | 0.150 | 0.500 | 0.030 | 90.2/95.4/97.8 | 3299 | 16 |
| Io Net | fp8 | 262k | 65k | 0.150 | 0.500 | 0.030 | 87.1/95.9/96.4 | 2148 | 9 |
| **Z.AI** | fp8 | 1.0M | 131k | 0.150 | 0.500 | 0.030 | 99.8/99.7/99.5 | 3446 | 28 |
| Wafer | unknown | 1.0M | 943k | 0.165 | 0.500 | 0.030 | 99.9/100/99.3 | 719 | 43 |
| NextBit | fp8 | 1.0M | 128k | 0.165 | 0.550 | 0.033 | 100/99.0/99.9 | 2310 | 28 |
| Morph | fp8 | 1.0M | 943k | 0.180 | 0.630 | 0.040 | 99.1/99.7/98.6 | 1406 | 42 |
| Inceptron | fp8 | 1.0M | 943k | 0.225 | 0.450 | 0.080 | 100/100/98.7 | 10792 | 25 |
| Fireworks (b) | unknown | 1.0M | 943k | 0.225 | 0.750 | 0.045 | 100/100/99.8 | 1066 | 67 |
| Cloudflare | unknown | 1.0M | 943k | 0.300 | 1.000 | 0.030 | 94.3/98.3/98.6 | 3527 | 28 |

Notes on the numbers:

- The units of `latency_last_30m` and `throughput_last_30m` are not named in the response. Milliseconds and tokens/s are the plausible reading and match OpenRouter's model pages; treat as an assumption.
- Each endpoint also carries `perf_last_30m_by_workload.text_generation.request_count` (for example OpenInference: 81,060 requests in 30 minutes), so the published percentiles rest on large real-traffic samples.
- 11 of 33 endpoints (33 percent) serve fp4 or nvfp4. This confirms the EXPERIENCE.md observation ("about a third of the providers serve it in fp4").
- The response carries no tool-call error rate. That signal lives on the model page's Performance tab and feeds Auto Exacto (see §2); it is not in this API response.
- The fp4/nvfp4 endpoints (OpenInference, DeepInfra, InferenceNet, Decart, Modal, Crusoe, CoreWeave) stay excluded: the plugin already filters them with `quantizations: ["fp8","bf16","fp16"]`, and the broken-output incident makes low precision the prime suspect.
- Z.AI is mid-field on speed (latency p50 3446 ms, throughput p50 28 tok/s). BaseTen, Parasail, and Together are 3–4 times faster.

## 2. Exacto for this model

Facts, from the OpenRouter docs (fetched 2026-09-30):

- Exacto started (2025-10-21 blog "Provider Variance: Introducing Exacto") as a static curated list of endpoints with better tool-calling accuracy, selected per model (`moonshotai/kimi-k2-0905:exacto`, `z-ai/glm-4.6:exacto`, …). GLM 5.3 Flash was not in that launch list.
- Since the "Auto Exacto" announcement (2026-03-12), Exacto is no longer a static endpoint list. Auto Exacto "runs by default on every tool-calling request, requiring no configuration" and reorders providers every ~5 minutes using throughput, tool-call telemetry (JSON validity, tool-name accuracy, schema compliance), and benchmark scores (GPQA Diamond, 10 epochs; Tau2-Bench Airline, 1 epoch).
- The `:exacto` model-suffix variant exists for explicitly requesting quality-first sorting ("Auto Exacto is a routing step that automatically optimizes provider ordering for all requests that include tools"; "`:exacto` is the explicit shortcut when you want to request the Exacto sorting mode directly on a specific model slug"). Per the Auto Exacto doc it "can be used anywhere provider sorting is meaningful", i.e. on any model — there is no per-model enrollment any more.
- The endpoints API response for GLM 5.3 Flash contains no Exacto-specific endpoints and no `exacto` tag on any endpoint. So there is nothing named "Exacto endpoints" for this model; what exists is the Auto Exacto reordering plus the `:exacto` sort shortcut.
- Selection in a request: append `:exacto` to the model slug, or rely on Auto Exacto for tool-calling requests. Explicit sorting wins: "If you explicitly sort by price, throughput, or latency, that explicit sort still takes precedence", and `sort: "price"` (or `:floor`) opts out of Auto Exacto.
- Consequence for opencode: the plugin pins `provider.options` and relies on explicit routing, which bypasses Auto Exacto. Also, opencode 1.18.32 cannot use model suffixes at all (openrouter-routing.md §2, issue #48016). A probe that talks to the OpenRouter API directly can use `:exacto` freely; opencode cannot until the suffix bug is fixed.
- Interaction with caching: Auto Exacto "reorders providers on every tool-calling request, which can conflict with the sticky routing used by prompt caching" and can cause cache misses mid-session. Another reason our routing stays explicit rather than `:exacto`.
- Benchmark quality control: scores for routing are aggregated over a rolling 32-day window, and "runs must meet a minimum sample-size floor to count (currently at least 50 GPQA questions and 45 Tau2 tasks)". Deranking threshold: baseline median minus 2σ.

OpenRouter's own tool-call error metric ("Tool Call Error Rate" per endpoint per day) is computed at request level: a request counts as errored if any tool call has invalid JSON, an unknown tool name, or a schema violation (docs "How Tool-Calling Success Rate Is Measured", cited in the tool-calling guide).

## 3. How established tools test provider quality for the same open model

- **OpenRouter (Auto Exacto)**: measures per endpoint, from real production traffic, the tool-call error rate (request-level: valid JSON, known tool name, schema match), throughput, and latency; plus an internal benchmark harness (GPQA Diamond with 10 epochs, Tau2-Bench Airline with 1 epoch) pinned to one endpoint per run. Samples: a 32-day rolling window with a floor of at least 50 GPQA questions and 45 Tau2 tasks per qualifying run; derank at baseline median − 2σ (docs/guides/routing/auto-exacto).
- **Artificial Analysis, Endpoint Accuracy Index** (launched 2026-08-04, covers GLM-5.2 among others): re-runs a fixed suite against every endpoint and compares against a self-hosted reference deployment of the official weights. Suite: BFCL v4-500 (tool calling, 500 questions, 3 repeats), HLE-250 (hard reasoning, 250 questions, 10 repeats), AA-LCR-25 (long-context recall, 25 questions, 10 repeats); 95% confidence intervals from per-repeat variation; parity = endpoint result inside the CI of the reference. So separating a bad provider from noise rests on 500–2500 scored requests per endpoint.
- **MoonshotAI K2-Vendor-Verifier** (open source, GitHub): 4,000 requests per provider, responses compared against the official Moonshot API. Metrics: tool-call trigger F1 (should the model have called a tool at all) and schema accuracy (share of triggered calls passing schema validation). Their noise calibration: repeated runs of the official API gave tool_call_f1 between 75.81% and 76% (K2-thinking), so they set acceptance thresholds ~2 points below the observed average. It already found real vendor defects: schema accuracy 72–85% on Baseten, Together, AtlasCloud, vLLM for kimi-k2-0905. It supports OpenRouter per-provider pinning exactly the way step 10 plans it: `--extra-body '{"provider": {"only": ["YOUR_DESIGNATED_PROVIDER"]}}'` (README).
- **16x Eval provider evaluation** (blog, 2025-07-21, Kimi K2): 7 providers, 2 tasks (writing, coding), each test repeated 3 times, human ratings 1–10 plus speed. Small-sample, exploratory, but the same shape as our probe.

Common lesson: everyone separates a bad provider from noise either with many samples (hundreds to thousands) or with a fixed deterministic task plus repeats, and everyone pins one provider per request. A cheap probe with one fixed task and 3–5 repeats can only catch gross breakage (wrong answer, garbage output, loops, huge reasoning), not small degradation — which is exactly the goal of step 10. Ranking close calls needs more runs or the published OpenRouter percentiles.

## 4. Measuring speed per provider

From the OpenRouter docs and openrouter-routing.md §4 (facts):

- Every response (streaming and not) carries the generation id: header `X-Generation-Id`, or top-level `id` (`gen-...`) for non-streaming.
- `GET https://openrouter.ai/api/v1/generation?id=<gen-id>` returns `provider_name`, `native_tokens_prompt`, `native_tokens_cached`, `total_cost`, `upstream_inference_cost`, and more (latency and generation time among the fields; the docs page "Get request & usage metadata for a generation" lists them). This endpoint needs the API key.
- The chat response's `usage` object can carry the real `cost` when usage accounting is enabled.
- The endpoints API (§1) gives the published baseline: `latency_last_30m` and `throughput_last_30m` percentiles per endpoint, plus `uptime_last_5m/30m/1d`.

What a probe can read without a proxy: everything, if the probe talks to OpenRouter directly instead of through opencode. A direct call sees the response body, the `X-Generation-Id` header, and can then query the generation API with the project key. opencode, by contrast, stores neither provider nor real cost (PLAN.md step 11 root cause), which is why an opencode-based probe would need the step 11 proxy for attribution. This is a strong argument for a direct-API probe.

Speed metrics for the probe:

- **Time to first token (TTFT)** and **end-to-end wall time** per request, measured client-side.
- **Output tokens per second** from streaming (token count from usage, wall time client-side).
- Cross-check against the published `throughput_last_30m` p50/p90 of the endpoint, so a probe result far below the published value is itself a warning.
- Real cost per run from the generation API (`total_cost`), which also validates the 0.005 USD per probe estimate.

## 5. Design proposal for the probe

### Task

The A/B task from EXPERIENCE.md, unchanged: a file of 11,656 lines with three known types at lines 4,868, 5,047, and 7,820. The agent must find the three types (grep and paged reads with `offset`), write their field names into `answer.md`, and commit it. Expected answer, commit, and tool-call sequence are known, so all pass rules are code-checkable.

### Pass rules (all checked by code)

1. `answer.md` contains exactly the three expected field-name sets (correct answer).
2. A git commit exists in the run worktree (commit happened).
3. No more than N (say 3) consecutive identical tool calls (loop detector; same rule as `oc-sub watch` step 6).
4. Output text passes a readability check: no long runs of unrelated words, symbols, or non-ASCII noise (the "84,000 characters of meaningless text" failure).
5. Reasoning tokens per step under 16,000 (step 6 guard threshold).

Plus hard rules: the run finishes inside a time limit, and every tool call is valid JSON with a known tool name and schema-valid arguments (the OpenRouter tool-call buckets, §2–3).

### Options judged

| Criterion | Option A: direct API probe script | Option B: oc-sub runs per provider | Option C: third-party harness (K2VV tool_calls_eval / 16x Eval) |
| --- | --- | --- | --- |
| Attribution | Exact: `provider.only` pins the endpoint; generation API confirms `provider_name` | Inexact without the step 11 proxy: opencode stores no provider | Good: per-provider pinning supported, results labeled per provider |
| Realism | Medium: must replicate an agent loop (tools + file + commit) by hand; the real failures happened inside opencode's loop and prompts | High: the exact production path, same agent files, same loop | Low: generic tool-call samples, not our coding task; would not have caught the "meaningless text" failure mode |
| Pass rules | Fully code-checkable; probe owns the loop | Fully checkable from session events (step 6 detectors already exist) | Not our rules; F1/schema metrics only, no loops-in-agent, no garbage-text rule |
| Speed metrics | Full: TTFT, wall time, tok/s, generation API | Indirect: only via the proxy (step 11), else nothing | Some (tok/s in 16x Eval) |
| Cost | ~0.005 USD per run, minimal overhead (same task) | Same model cost plus opencode system prompt overhead | K2VV needs 4,000 requests per provider — orders of magnitude over budget |
| Effort | A small script: chat-completions call with tools, a fixed tool loop, checks, generation-API read. Reuses detector logic | Small too (config per provider + `oc-sub run`), but attribution blocked until step 11 exists | Near zero, but wrong shape |
| Known failure modes | A hand-rolled loop can differ from opencode's (prompt caching, sticky routing, opencode system prompt) → may miss provider breakage that only shows in long sessions; one fixed task overfits | No provider attribution without proxy (step 11 root cause); costlier and slower per run | Wrong task, wrong budget, no garbage-text detection |

Known failure modes with sources: Option B's attribution gap is the documented step 11 root cause (PLAN.md); Option C's budget is from the K2VV README ("a set of 4,000 requests" per provider); Option A's realism risk is inherent to any synthetic loop and is why the task is copied from the A/B test rather than invented.

### Recommendation

**Option A as the main program, with a small Option B validation of the finalists.** The decisive criteria are attribution, checkable pass rules, and cost, and Option A wins all three; Option B cannot attribute providers until the step 11 proxy exists. Because Option A's realism is only medium, the two or three providers that pass the probe get one additional confirmation through a real oc-sub run each (cheap: ~0.01 USD per run, 4 runs ≈ 0.04 USD) before they enter `opencode/opencode.json`. `:exacto` is not usable in opencode 1.18.32 (suffix bug #48016) and would fight prompt caching anyway, so it is out of the production config; the probe can still record one `:exacto` run for reference.

### Probe program, concretely

- **Baseline**: 3 runs against Z.AI, to know what "good" looks like on this machine.
- **Candidates** (fp8, tools support, uptime ≥ ~99% over 1d, spread across the price/speed field): **Novita** (cheapest fp8, $0.084/$0.28), **StreamLake** (fp8, $0.087/$0.29), **SiliconFlow** (fp8, 262k context, 39 tok/s), **Parasail** (fp8, 97 tok/s, 99.8% uptime), **BaseTen** (fastest: 118–128 tok/s, latency p50 ~0.65 s), **Fireworks (a)** (99.9% uptime, but quantization `unknown` — the probe result decides whether it is trustworthy). Optionally **Sail Research** (cheapest fp8 at $0.045 input but only 21 tok/s and 131k max output). Excluded: all fp4/nvfp4 endpoints, providers with uptime < 99% over 1d (Venice, Io Net, AtlasCloud, GMICloud, StreamLake is borderline at 97.8%), and providers whose max output is under the probe's needs.
- **Runs**: 3 per candidate for the first pass (matches PLAN.md step 10.2 and the 16x Eval precedent); 5 for any candidate that will be approved, to separate gross flakiness from a single unlucky run. 8 candidates × 3 + 3 finalists × 2 extra ≈ 30 runs.
- **Speed metrics per run**: TTFT, wall time, output tokens/s (streaming), input/output/reasoning tokens, and from the generation API: `provider_name`, `total_cost`, native token counts. Report median and max per provider; compare against the endpoint's published `throughput_last_30m` p50.
- **Cost estimate**: the A/B runs cost 0.0062–0.0100 USD each with the full opencode agent; a direct probe with the same task should land near 0.005 USD. 30 runs ≈ **0.15 USD**, plus ~0.04 USD for the oc-sub validation of finalists — inside the 0.15–0.30 USD budget of step 10.
- **Output**: a table (pass count, pass rules failed, TTFT, tok/s, cost) and a proposed `order` list for `opencode/opencode.json`, e.g. `["z-ai", "<fastest-passing>", "<next>"]` with `allow_fallbacks` and the existing quantization filter.

### Open questions

1. Units of `latency_last_30m` / `throughput_last_30m` are assumed (ms / tokens per second); confirm against a model page during the probe.
2. Does `GET /api/v1/generation` return latency and generation-time fields for streaming requests of this model, and does it need the key of the account that made the request? (Docs say yes for the fields; untested without a key.)
3. Does the Fireworks endpoint's `quantization: "unknown"` hide fp8 or something worse? Only the probe answers this.
4. Will a hand-rolled tool loop reproduce the provider breakage seen in real opencode sessions (long context, opencode system prompt, caching)? The oc-sub validation of finalists covers the residual risk.
5. Does provider pinning with `only` bypass Auto Exacto reordering entirely, or does Auto Exacto also reorder within `only`? The docs say explicit sorting takes precedence, but the interaction of `only` + Auto Exacto is not spelled out.

## Review of the main thread (2026-09-30)

The main thread accepts sections 1 to 4 and changes the recommendation of section 5.

- The attribution argument against option B is wrong. A probe run pins one provider with `only: [<provider>]` and `allow_fallbacks: false`. OpenRouter then refuses the request or sends it to that provider, so the provider of every step is known without the proxy of step 11. EXPERIENCE.md proves that opencode passes these options.
- Speed needs no proxy either. opencode stores the start and end time and the tokens of each assistant message, so a run gives the time to the first step and the output tokens per second. The real cost comes from the key usage of the project key, if the probe runs one run at a time.
- So option B wins on realism with no loss on attribution, and it needs no own agent loop. The failures of 2026-09-28 happened inside the opencode loop, so the probe must use that loop. Decision: option B. The cost is about 0.01 USD per run, so 30 runs cost about 0.30 USD.
- StreamLake is both a candidate and excluded in section 5. Its uptime over one day is 97.8 percent, so it is excluded.
- Open for the coder step: how one opencode server serves a run with another `only` list. Candidates are one model entry per provider in the configuration of the probe, or one server per provider with its own `OPENCODE_CONFIG_CONTENT`.

## Probe result (2026-09-30)

The main thread ran the probe with `bun probe/run.ts`: one control run, then three runs each for eight providers, one run at a time, through the cost proxy of step 11. The raw lines are in `probe/results/2026-09-30.jsonl`. The first two Z.AI batches of that file measured two bugs of the setup (a proxy path bug and a worktree race, PLAN.md 10d and 10e), not the provider. The table uses the batch `193831`. The cost and the first-byte time come from the proxy log, which names the serving provider of every request. The tokens per second come from the evaluator.

| Provider | Passed | First byte (median of the model requests) | Tokens/s (median of the runs) | Cost per run (proxy) |
| --- | --- | --- | --- | --- |
| Z.AI | 3/3 | 2.3 s | 19 | 0.0041 USD |
| Parasail (fp8) | 3/3 | 0.9 s | 29 | 0.0059 USD |
| Together (quantization unknown) | 3/3 | 0.8 s | 40 | 0.0054 USD |
| Fireworks (quantization unknown) | 3/3 | 1.2 s | 14 | 0.0042 USD, 6 of 27 requests failed |
| SiliconFlow (fp8) | 3/3 | 2.1 s | 16 | 0.0084 USD |
| Novita (fp8) | 3/3 | 5.6 s | 11 | 0.0046 USD |
| Sail Research (fp8) | 3/3 | 4.9 s | 9 | 0.0044 USD |
| BaseTen (fp8) | 0/3 | - | - | every request: "temporarily rate-limited upstream" |

- The control run with `no-such-provider` got "No allowed providers are available for the selected model", so the pin reaches OpenRouter.
- Every request of a pinned run went to the pinned provider. The title requests of opencode went to Google, through the small model of opencode.
- The key usage delta per run is not usable: OpenRouter counts late, so the delta of one run lands in the next one. The proxy log is the source of the real cost.
- Three runs per provider catch only gross breakage. The broken output of 2026-09-28 came in long runs, so this probe does not prove that a provider is safe in long runs.

Decision of the main thread, from the goal of step 10 (fallbacks after Z.AI): `order` and `only` are `["z-ai", "parasail", "together"]`, with `allow_fallbacks: false`. Parasail is second because it serves fp8, passed, and is fast. Together is third because it is the fastest, but its quantization is not published. Open for the user: whether a faster provider goes first.
