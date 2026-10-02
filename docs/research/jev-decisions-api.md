# The OpenRouter decisions endpoint for Jev (step 18)

Researched 2026-10-01 in worktree `r18-decisions`. Companion to `trace-analysis.md` ("Jev API access") and `probe/README.md` ("Jev probe"). That probe showed: `typesafe/jev-router` routes chat to other models, and `~typesafe/jev-latest` answers chat completions with the error "use the /api/alpha/decisions endpoint instead". This report documents that endpoint.

## Criteria

- Exact request and response schema, from the official OpenRouter docs.
- Billing that a probe can predict: price, `usage` block, key and spending limit.
- Which Jev versions the endpoint serves, and how many questions fit in one call.
- Stability statement, so we know what may change under us.

## Sources

- [Decisions API reference (submit a decisions request)](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request) — read 2026-10-01 via reader.
- [Jev documentation hub](https://openrouter.ai/docs/guides/community/jev) — read 2026-10-01 via reader and search.
- [Jev tutorial](https://openrouter.ai/docs/guides/community/jev-tutorial) — read 2026-10-01 via search highlights (contains a live captured response).
- [TypeSafe SDK guide](https://openrouter.ai/docs/guides/community/typesafe-sdk) — read 2026-10-01 via search highlights.
- [Jev classification cookbook](https://openrouter.ai/docs/cookbook/evaluate-and-optimize/jev-classification) — read 2026-10-01 via search highlights.
- [OpenRouter blog: What is Jev?](https://openrouter.ai/blog/insights/what-is-jev/) (2026-09-21) — read 2026-10-01 via search highlights.
- [OpenRouter blog: moderation tutorial](https://openrouter.ai/blog/tutorials/how-to-use-jev/) (2026-09-23) — read 2026-10-01 via search highlights.
- [`~typesafe/jev-latest` model page](https://openrouter.ai/~typesafe/jev-latest) — read 2026-10-01 via search highlights; a direct reader fetch got 404 (bot or auth wall; the page exists and is linked from the official docs).
- [markwylde.com: Playing with Jev](https://markwylde.com/blog/jev-and-luna-play-an-rts/) (2026-09-26) — read 2026-10-01 via search highlights (independent third party, same schema).
- `GET https://openrouter.ai/api/v1/models`, run locally on 2026-10-01.

## 1. Request and response format

`POST https://openrouter.ai/api/alpha/decisions`, Bearer auth with the normal OpenRouter key, `Content-Type: application/json` (API reference). This is not an OpenAI-compatible chat endpoint.

### Request fields (API reference, `DecisionsRequest`)

| Field | Required | Meaning |
| --- | --- | --- |
| `model` | yes | string, e.g. `typesafe/jev-1.13` or `~typesafe/jev-latest` |
| `state` | yes | "The content to evaluate: a plain string, or a JSON object or array of related context." |
| `questions` | yes | object; keys are your question IDs, values are question objects |
| `provider` | no | Provider routing preferences (same shape as chat: `only`, `order`, `allow_fallbacks`, `max_price`, ...) |
| `session_id` | no | string, max 256 chars |
| `trace`, `user` | no | optional metadata; `user` max 256 chars |

### Question objects

Every question has `type` (`choice`, `score`, or `noul`) and `instructions` ("a plain string, or a JSON object or array of structured guidance"). `criteria` differs per type (API reference):

- **`choice`** — `instructions` and `criteria` required. `criteria` is an **object**: one key per option, value describes the option (string, or object/array of structured guidance).
- **`score`** — `instructions` and `criteria` required. `criteria` is an **array** (`minItems: 1`) of ordered level descriptions, best first.
- **`noul`** — only `type` and `instructions` required. `criteria` optional, an object with exactly the keys `"true"` and `"false"` (both required if present). The moderation tutorial shows noul without `criteria` works.

### Response fields (`DecisionsResponse`)

Required: `model`, `answers`, `usage`. Optional: `id`, `provider`.

- `id` — string, e.g. `gen-dec-1789738314-X5e5eKGQdvR9rblyX250` (this is the id for `GET /api/v1/generation?id=...`).
- `model` — the dated snapshot that served the request, e.g. `typesafe/jev-1.13-20260917`.
- `provider` — e.g. `TypeSafe`.
- `answers` — one entry per question ID:
  - **noul**: `{ "type": "noul", "noul": 0.96 }` — the probability of yes, 0–1.
  - **choice**: `{ "type": "choice", "choice": "payments", "confidence": 0.67, "probabilities": { "payments": 0.78, "frontend": 0.22, "account": 0 } }`. `confidence` and `probabilities` are optional (cookbook schema).
  - **score**: `{ "type": "score", "score": 1.99, "confidence": 0.99, "probabilities": { "0": 0, "1": 0, "2": 1 }, "legend": { "0": "...", "1": "...", "2": "..." } }` — the score is the probability-weighted position on the ordered scale, index 0 is the first criterion.
- `usage` — `{ "input_tokens": 476, "output_tokens": 70, "cost": 0.000019992 }`. `cost` is USD and optional in the schema, but the cookbook rejects a response without it.

All of this is confirmed by a live captured response in the Jev tutorial and independently by markwylde.com. The OpenRouter SDK returns `usage.inputTokens`/`outputTokens` in camelCase; raw HTTP uses snake_case.

### Complete example (from the Jev tutorial, a live captured response)

Request:

```json
{
  "model": "typesafe/jev-1.13",
  "state": {
    "customer_tier": "enterprise",
    "ticket": "My checkout page shows a blank screen after I click Pay. I have tried two browsers."
  },
  "questions": {
    "is_bug": {
      "type": "noul",
      "instructions": "Is the customer reporting a software defect?",
      "criteria": {
        "true": "The customer describes broken or unexpected product behavior.",
        "false": "The customer is asking a question or requesting a feature."
      }
    },
    "team": {
      "type": "choice",
      "instructions": "Which team should own this ticket?",
      "criteria": {
        "payments": "Checkout, billing, or payment processing issues.",
        "frontend": "Rendering, layout, or browser compatibility issues.",
        "account": "Login, permissions, or profile issues."
      }
    },
    "urgency": {
      "type": "score",
      "instructions": "How urgent is this ticket?",
      "criteria": [
        "Can wait for the next release",
        "Should be fixed this week",
        "Blocking revenue right now"
      ]
    }
  }
}
```

Response (captured from the live API, tutorial):

```json
{
  "id": "gen-dec-1790015143-AIaTutprXsJ5EwohRSjb",
  "model": "typesafe/jev-1.13-20260917",
  "provider": "TypeSafe",
  "answers": {
    "is_bug": { "type": "noul", "noul": 0.96 },
    "team": {
      "type": "choice",
      "choice": "payments",
      "confidence": 0.67,
      "probabilities": { "payments": 0.78, "frontend": 0.22, "account": 0 }
    },
    "urgency": {
      "type": "score",
      "score": 1.99,
      "confidence": 0.99,
      "probabilities": { "0": 0, "1": 0, "2": 1 },
      "legend": {
        "0": "Can wait for the next release",
        "1": "Should be fixed this week",
        "2": "Blocking revenue right now"
      }
    }
  },
  "usage": { "input_tokens": 476, "output_tokens": 70, "cost": 0.000019992 }
}
```

## 2. Billing

- **Input tokens only; output free.** "Jev is billed based on the number of input tokens, and output tokens are free" (tutorial FAQ). The cookbook states "$0.042 per million input tokens with no output-token charge" and says the current price is on the model page. Both the state and the questions count toward the input budget (moderation tutorial).
- **The `usage` block carries the cost.** Each response has `usage.cost` in USD for that call (tutorial FAQ; example values: 476 input tokens → $0.000019992, 275 input tokens → $0.00003).
- **The normal OpenRouter key applies.** "`typesafe/jev-1.13` (or the `~typesafe/jev-latest` alias) is available to anyone with an OpenRouter API key, and billed to your OpenRouter account" (Jev hub). "Any valid OpenRouter API key is fine. No need for a TypeSafe account" (moderation tutorial). No separate key or signup exists.
- **Spending limits apply.** The cookbook treats a `402` as "your credits or key limit ran out", except one transient case where the body includes `limit_source: "openrouter_in_flight_budget"` (per-key in-flight budget, retry after `Retry-After`). So the key's spending limit and the account credit limit govern these calls like any other OpenRouter call.
- Prices match the direct TypeSafe price from `trace-analysis.md` ($0.042/MTok input, output free), so OpenRouter adds no markup that the docs show. Caveat: the public model list (`GET /api/v1/models`, checked locally 2026-10-01) does **not** list `typesafe/jev-1.13` or `~typesafe/jev-latest` — only `typesafe/jev-router`. So the probe cannot read the price from the models list; it must use `usage.cost` from the response.

## 3. Versions and number of questions

- **Served versions**: `typesafe/jev-1.13` (pinned; the response names a dated snapshot such as `jev-1.13-20260917`) and `~typesafe/jev-latest` (alias that "always redirects to the latest model in the Jev family"). Both work on the decisions endpoint (Jev hub, tutorial FAQ). The docs do not name older pinned versions; only 1.13 and the alias appear in the OpenRouter docs. This matches `trace-analysis.md`: TypeSafe's current stable release is `jev-1.13.0`.
- **Best practice**: "Pin `typesafe/jev-1.13` when you need thresholds tuned against one specific version to stay stable" (tutorial FAQ). This supports the plan in `trace-analysis.md` section 2 to pin.
- **Number of questions**: no maximum is documented (API reference has no max). The docs encourage batching: "put every independent question about the same state in one request. All questions in the request are answered in parallel and cannot see each other's answers" (tutorial FAQ). A third-party test ran 16 questions in one request in 343 ms (markwylde.com); the classification cookbook builds one choice plus one noul per tag, so dozens of questions per request are normal. The binding limit is the context window: **32,000 tokens** for state plus questions (Jev hub).
- Note the parallelism caveat for `trace-analysis.md`: questions cannot see each other's answers, so a tag set must not assume dependency between questions.

## 4. Alpha status and changes

- The endpoint path itself carries `alpha`, and the OpenAPI tags it "Alpha feature endpoints for Decisions requests" (API reference; same wording in the Python and Go SDK docs, "Alpha.Decisions").
- Neither the API reference, the Jev hub, nor the tutorial states an explicit "unstable" or "subject to change" warning. The Jev tutorial and cookbook treat it as the normal, documented way to call Jev, and the OpenRouter SDKs (`@openrouter/sdk` 1.3.x) ship typed support for it.
- The error from our probe and the 2026-09 blog posts confirm the endpoint is live and intended for production use; the "alpha" label says the shape may still change. No change policy, deprecation promise, or stability guarantee is published — **unknown**. Our probe should therefore store the full request and response and treat the schema as pinned by example.

## Example probe request

A probe script can send exactly this. Three state lines (tool call, output, claim), one Choice with four options, one Noul:

```json
{
  "model": "typesafe/jev-1.13",
  "state": {
    "tool_call": "bash 'ls src'",
    "tool_output": "agents.ts\nconfig.ts\ndetect.ts\nmain.ts",
    "claim": "I listed the folder and it contains only test files."
  },
  "questions": {
    "tag": {
      "type": "choice",
      "instructions": "Which tag best fits this step?",
      "criteria": {
        "ok": "The step did what it intended and the claim matches the output.",
        "wasted": "The step repeated earlier work or was not needed.",
        "wrong-tool": "The step used the wrong tool for the job.",
        "ungrounded-claim": "The claim does not match the tool output."
      }
    },
    "claim_supported": {
      "type": "noul",
      "instructions": "Does the tool output support the claim?"
    }
  }
}
```

Expected answer shapes: `answers.tag` is `{ "type": "choice", "choice": "ungrounded-claim", "confidence": <0–1>, "probabilities": {...} }`; `answers.claim_supported` is `{ "type": "noul", "noul": <0–1> }`. Send it to `POST https://openrouter.ai/api/alpha/decisions` with `Authorization: Bearer $OPENROUTER_API_KEY` and `Content-Type: application/json`. Read the real cost from `usage.cost`.

## Search log

- `websearch` "openrouter /api/alpha/decisions endpoint Jev typesafe documentation" — 6/6 relevant hits (docs reference, hub, tutorial, SDK guide, cookbook, model page).
- `websearch` "OpenRouter ~typesafe/jev-latest decisions endpoint API format" — 6/6 relevant hits (same pages plus two third-party blog posts).
- Reader: API reference + Jev hub (combined), `~typesafe/jev-latest` page (404 via reader; content known from search index of the same day).
- Local: `GET https://openrouter.ai/api/v1/models` — 1 Jev hit (`typesafe/jev-router`); `jev-1.13` and `jev-latest` absent from the public list.

## Open questions

1. The price on the `~typesafe/jev-latest` model page could not be fetched directly (reader 404). The $0.042/MTok input figure comes from the OpenRouter cookbook and blog; the authoritative page is `https://openrouter.ai/~typesafe/jev-latest`. The probe gets the exact per-call cost from `usage.cost` anyway.
2. Whether the decisions endpoint counts the same context window as the docs say (32,000 tokens) for very large states, and what error it returns when exceeded — not documented; probe if needed.
3. Any published change policy for the `alpha` namespace — none found; treat schema as pinned by the examples above.
4. Whether other pinned Jev versions (older or newer than 1.13) are callable — only 1.13 and the alias appear in OpenRouter docs.
