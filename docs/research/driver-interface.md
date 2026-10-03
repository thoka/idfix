---
checked: 2026-10-03
recheck: 2m
decisions:
  - "extend the in-house cost proxy for all drivers, do not adopt LiteLLM or claude-code-router"
  - "attribute a Claude Code request to its session with a header from ANTHROPIC_CUSTOM_HEADERS"
  - "run the host proxy as a systemd user unit"
---

# Driver interface: one cost proxy for opencode and Claude Code

Gemini Deep Research report for step 25, pasted back by the user on 2026-10-03. The question is [driver-layer-question.md](driver-layer-question.md). The name `driver-layer.md` already belongs to an older report about a loop above Claude Code, so this report has its own name.

Known gap: the paste lost the source links of Gemini. Section 6 lists the claims that the design depends on and their check by the researcher.

---

Here is the evaluation of the driver layer designs, comparing an extension of your in-house proxy against adopting an established router.

### 1. Session Attribution

Claude Code sends a per-session JSON blob within the `metadata.user_id` field to the Anthropic API. While this can identify a session, it is not an opaque string, which causes issues for proxies. For example, LiteLLM reads this JSON blob and treats every unique session as a completely new customer, which bypasses default budgets and bloats the database. Furthermore, Anthropic's API strictly rejects the `metadata.user_id` field if it detects an email address or PII, returning a 400 Bad Request.

A much more stable injection method is using the `ANTHROPIC_CUSTOM_HEADERS` environment variable. This allows your driver to inject a custom session ID (e.g., `x-my-session-id: 12345`) which Claude Code will parse, validate, and forward on every request. Tools like LiteLLM already use this pattern to track usage via the `x-litellm-customer-id` header. Other tools, like `ccusage`, avoid headers entirely and calculate usage by reading the `.jsonl` session files stored locally on the host, though users report this breaks down when trying to sync across multiple machines without a shared NAS.

### 2. Adopt or Extend: Candidate Evaluation

Below is a review of established proxies and routers, including searches from the skills.sh directory.

**LiteLLM**

* **Maturity:** Very mature, highly active, and widely used.
* **API Shape:** Natively supports both OpenRouter routing and the Anthropic `/v1/messages` passthrough endpoint.

* **Per-session cost:** Yes, via the `x-litellm-customer-id` header.


* **Streaming & Tools:** Fully supports SSE streaming without breaking tool use.
* **Failure Modes:** The biggest pitfall is the database bloat caused by Claude Code's native `metadata.user_id` blob. You must configure `validate_end_user_id_in_db: true` to drop unrecognized JSON blobs.



**claude-code-router (CCR)**

* **Maturity:** Moderate. It is a community-built Node.js proxy specifically designed to map Claude Code to OpenRouter, DeepSeek, and Ollama.


* **API Shape:** Translates Anthropic requests to OpenRouter formats.


* **Per-session cost:** No. It does not natively log or aggregate per-session costs, relying instead on the upstream provider.


* **Streaming & Tools:** Supports streaming, but has a known failure mode where proxy-level failures (like upstream timeouts) crash the router and send a `SIGTERM` to the underlying process, making stream recovery impossible and hiding the error.


* **Failure Modes:** Environmental proxy variables (like `http_proxy`) can interfere with Claude Code reaching the router's local `127.0.0.1:3456` bind address.



**anthropic-proxy (skills.sh)**

* **Maturity:** Low. A simple proxy server to convert Anthropic requests to OpenAI for OpenRouter.


* **API Shape:** Converts Anthropic to OpenAI.


* **Per-session cost:** No native cost tracking features.
* **Streaming & Tools:** Basic passthrough, lacks advanced observability.

### 3. Proxy Placement and Lifecycle

For a small, always-available local proxy on native Linux and WSL2, a **systemd user unit** is the most robust pattern. It starts automatically on boot without requiring root privileges and safely manages environment variables. A **socket-activated service** is another excellent option for low-resource environments, keeping the proxy dormant until `idfx` or an interactive session makes an HTTP request to the socket.

**Mixing OAuth and API Keys:**
Claude Code uses OAuth tokens for Claude subscriptions. If you point `ANTHROPIC_BASE_URL` to a non-first-party host (your proxy), Claude Code disables certain features like MCP tool search by default. More importantly, if a cached Anthropic OAuth login exists while you route traffic to an API proxy, Claude Code will throw 400 "model not found" errors; users must run `/logout` to clear the cache. Additionally, custom endpoints lack Anthropic's context management features; using an alternative base URL triggers a 400 error unless you bypass it by setting `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=true`.

### 4. Key Hygiene

To guarantee that no provider key reaches a log or the sandbox, the proxy must redact the following targets before dumping access logs or error states:

* The standard `Authorization: Bearer ` header.


* The `x-api-key` header (used by Anthropic).


* Custom headers like `anthropic-workspace-id`.


* The `metadata` object in the JSON body, as users or agents might accidentally leak PII there.



**Pitfall:** Naively logging the entire HTTP request body for debugging will dump the OAuth token or API key if they are passed in the payload, and will capture the `metadata.user_id` blob.

### 5. Mixed Endpoint Reality (OpenRouter)

OpenRouter provides an Anthropic-compatible API ("Anthropic skin"), but pathing is a major pitfall.

* **Path Handling:** Claude Code automatically appends `/v1/messages` to the `ANTHROPIC_BASE_URL`. You must set `ANTHROPIC_BASE_URL=[https://openrouter.ai/api](https://openrouter.ai/api)`. If you set it to `[https://openrouter.ai/api/v1](https://openrouter.ai/api/v1)`, Claude Code will request `/api/v1/v1/messages`, resulting in a 404 error.


* **Model Mapping:** OpenRouter requires namespaced model IDs (e.g., `anthropic/claude-3.5-sonnet`). If the proxy translates payloads, it must map standard Claude names to these slugs.


* **Usage Fields:** OpenRouter surfaces routing and usage metadata inside a custom `openrouter_metadata` field (or the legacy `X-OpenRouter-Experimental-Metadata` header), which differs from Anthropic's native `usage` block.



### Criteria Evaluation

| Criterion | Extend In-House Proxy | LiteLLM | claude-code-router |
| --- | --- | --- | --- |
| 1. Per-session cost | Yes (via shared top table) | Yes (requires header config) | No |
| 2. Streaming tools | Yes (already built for GLM) | Yes | Mostly (SIGTERM risk) |
| 3. Key hygiene | Full custom control | Needs DB validation config | Yes |
| 4. WSL2/Native Linux | Yes | Yes (via Docker/systemd) | Yes (via npm) |
| 5. 4th CLI support | Yes | Yes | Limited (Claude focus) |
| 6. Keeps existing CLI | Yes | No (requires new DB/UI) | No |

### Recommendation

**Extend the in-house proxy.**

Adopting LiteLLM introduces an entirely new database and UI stack for a single user, violating the "low maintenance" constraint. LiteLLM also struggles with Claude Code's native JSON metadata blobs unless heavily configured to drop them. `claude-code-router` lacks the per-session cost tracking required for your `top` table.

Since you already have a working HTTP proxy that logs session IDs, tracks costs for `opencode`, and handles OpenRouter tool judging, extending it requires minimal effort. You only need to add support for the `ANTHROPIC_CUSTOM_HEADERS` injection to grab the session ID, and strip the OAuth/API keys at the middleware level to ensure key hygiene. This keeps your `idfx` CLI completely unchanged.

### Open Questions

1. How will the in-house proxy explicitly differentiate between Claude Code OAuth tokens (subscriptions) and raw Anthropic API keys so it knows when to safely pass the token upstream versus replacing it?
2. When the third driver starts Claude Code on the Anthropic API inside the sandbox, how will the supervisor ensure that `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=true` does not disable features that the native Anthropic connection requires?

## 6. Check of the claims (researcher, 2026-10-03)

Each claim gets a verdict (true, false, unclear), a short quote, and a source. Sources are pages read on 2026-10-03.

### 6.1 `metadata.user_id` and session headers

**Verdict: mostly true, one part unclear.**

- Claude Code sends a per-session value in `metadata.user_id` on `/v1/messages`. The exact fields changed in v2.1.78. Before: a flat string `user_{device_id}_account_{uuid}_session_{sid}`. Since v2.1.78: a JSON string `{"device_id":"...","account_uuid":"...","session_id":"..."}`. Quote (third-party proxy source that normalizes the field): "Claude Code v2.1.78 将 user_id 从扁平字符串改为 JSON 对象字符串: v2.1.77: `user_{device_id}_account_{uuid}_session_{sid}` / v2.1.78: `'{\"device_id\":\"...\",\"account_uuid\":\"...\",\"session_id\":\"...\"}'`". Source: https://github.com/robinduvip-tech/ai-trun/blob/main/backend-go/internal/handlers/common/request.go. LiteLLM docs confirm the blob shape: "Claude Code, for example, puts a JSON blob in `metadata.user_id`: `{"device_id": "4ec41ed1...", "account_uuid": "...", "session_id": "..."}`". Source: https://docs.litellm.ai/docs/proxy/customers.
- Headers that name the session: a third-party proxy prioritizes `X-Claude-Code-Session-Id` and `X-Client-Request-Id` before falling back to `metadata.user_id` (same ai-trun source, `ExtractUnifiedSessionID`). This confirms those headers exist in the wild, but I found **no Anthropic documentation** of `x-claude-code-session-id`. No source found in Anthropic docs.
- Client identification: the user agent looks like `cli/1.0.25 (external, cli)` plus `anthropic-client-*` headers (seen in a request dump in https://github.com/anthropics/claude-code/issues/2182). LiteLLM confirms stability: "Claude Code specifically sends a value that's stable for the lifetime of one CLI session and only changes on restart" (https://github.com/BerriAI/litellm/issues/37508).

### 6.2 `ANTHROPIC_CUSTOM_HEADERS`

**Verdict: true.** Format is `Name: Value`, one pair per line (newline-separated). Claude Code docs: "`ANTHROPIC_CUSTOM_HEADERS` | Custom headers to add to requests (`Name: Value` format, newline-separated for multiple headers)... Requires Claude Code v2.1.227 or later" for the strict character validation. Source: https://code.claude.com/docs/en/env-vars. The gateway guide shows an example with a custom `ANTHROPIC_BASE_URL` and states "For a gateway that injects its own `Authorization` header... preserves the `Authorization` header you supply, for example through `ANTHROPIC_CUSTOM_HEADERS`". Source: https://code.claude.com/docs/en/llm-gateway-connect. Multiple headers via `\n` confirmed in https://github.com/anthropics/claude-code/issues/1859.

### 6.3 OAuth (Pro/Max) through a custom `ANTHROPIC_BASE_URL`

**Verdict: mixed; parts unclear.**

- Does the OAuth token go to the proxy? **True.** A gateway that forwards to api.anthropic.com receives the real OAuth `Authorization` header: "(a) forwards Claude Code's real OAuth `Authorization` header through to `api.anthropic.com` unchanged". Source: https://github.com/anthropics/claude-code/issues/84583.
- Is it allowed by Anthropic terms? **Unclear.** The compliance docs say OAuth "is intended exclusively for purchasers of Claude Free, Pro, Max, Team, and Enterprise subscription plans and is designed to support ordinary use of Claude Code", and forbid reselling or intermediating usage on behalf of end users, but they do not address a personal local proxy that forwards the unmodified Claude Code binary. Press coverage of the 2026-02 terms update says "Using OAuth tokens obtained through Claude Free, Pro, or Max accounts in any other product, tool, or service — including the Agent SDK — is not permitted", which a proxy may or may not fall under. Sources: https://code.claude.com/docs/en/legal-and-compliance; https://www.theregister.com/software/2026/02/20/anthropic-clarifies-ban-on-third-party-tool-access-to-claude/5014546.
- Features that turn off with a non-first-party base URL: **partially true.** Remote Control: "Remote Control is only available when using Claude via api.anthropic.com" (https://code.claude.com/docs/en/errors). A warning appears since v2.1.196 when `ANTHROPIC_BASE_URL` is not `api.anthropic.com` even with a claude.ai login (same page). But the "MCP tool search turns off" effect is documented as a consequence of `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`, not of the base URL itself: "MCP tool search is disabled and all MCP tools load upfront" (https://code.claude.com/docs/en/env-vars). No source found for MCP tool search turning off by base URL alone.
- Cached OAuth login + proxy → 400 "model not found", fixed by `/logout`: **partially true.** Issue #23022 reports the failure with cached subscription credentials plus a leftover `ANTHROPIC_BASE_URL`: "Claude Code silently uses the custom URL instead of Anthropic's API. This causes confusing 404 'model not found' errors" and the suggested fix is "Run `/logout` and remove `ANTHROPIC_BASE_URL`" — the error is 404, not 400, and it is a feature request for a warning, not a confirmed fix. Issue #33330 reports 401 instead. Sources: https://github.com/anthropics/claude-code/issues/23022, https://github.com/anthropics/claude-code/issues/33330. The docs confirm the auth-conflict mechanism: "A gateway credential variable takes precedence over a saved claude.ai login... To clear a saved login so only the gateway credential remains, run `/logout`" (https://code.claude.com/docs/en/llm-gateway-connect).

### 6.4 `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`

**Verdict: true.** The variable exists and is documented: "Set to `1` to strip Anthropic-specific `anthropic-beta` request headers and beta tool-schema fields (such as `defer_loading` and `eager_input_streaming`) from API requests. Use this when a proxy gateway rejects requests with errors like 'Unexpected value(s) for the `anthropic-beta` header'... MCP tool search is disabled and all MCP tools load upfront". Source: https://code.claude.com/docs/en/env-vars. Does a custom base URL need it? **Often yes**: with a custom `ANTHROPIC_BASE_URL`, Claude Code sends beta headers third-party endpoints reject, and "The workaround is to set `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`" (https://github.com/anthropics/claude-code/issues/46105). Known failure mode: the flag is not complete — some betas leak through it in several versions (https://github.com/anthropics/claude-code/issues/56970, #22893), and the gateway docs recommend it for exactly this case (https://code.claude.com/docs/en/llm-gateway-connect).

### 6.5 OpenRouter Anthropic-compatible endpoint

**Verdict: true.** Base URL: "Use the full OpenRouter API URL, including the scheme: `https://openrouter.ai/api`" — `export ANTHROPIC_BASE_URL="https://openrouter.ai/api"`, with the key in `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_API_KEY=""`. Source: https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration. Cost lives in the `usage` block as an OpenRouter-extended `cost` field: "Every response includes a `usage` object with detailed token information... `cost`: The total amount charged to your account"; the Anthropic-format response schema extends `AnthropicUsage` with `cost` and `cost_details` (https://openrouter.ai/docs/api/api-reference/anthropic-messages/create-a-message). Streaming: "This information is included in the last SSE message for streaming responses". A separate `/generation` lookup exists but is optional, and there "`upstream_inference_cost`... is only available for BYOK". Source: https://openrouter.ai/docs/use-cases/usage-accounting.

### 6.6 LiteLLM

**Verdict: true.** The header exists and overrides the blob: "`x-litellm-customer-id` | Track by customer/end-user ID... Headers are checked before any request body field, so the header wins over whatever the client puts in `metadata.user_id`, and Claude Code can set it through `ANTHROPIC_CUSTOM_HEADERS`" (https://docs.litellm.ai/docs/proxy/customers). The per-session problem is documented: "Every distinct customer ID LiteLLM sees is upserted into the customer table, which becomes a problem when a client sends a per-session identifier... Each session then lands in Usage -> Customer Usage as its own customer, and if you have a default customer budget configured, each session gets its own copy of that budget" (same page). GitHub issue on the blob bloating the DB: "`disable_end_user_cost_tracking` does not gate SpendLogs.end_user / DailyEndUserSpend writes... tens of thousands of rows... because Anthropic SDK / Claude Code stamps a unique per-session `metadata.user_id` blob" — https://github.com/BerriAI/litellm/issues/27038. `validate_end_user_id_in_db` exists: "Set `validate_end_user_id_in_db` to keep those IDs out. Available in v1.87.0 and above" (https://docs.litellm.ai/docs/proxy/customers); "IDs shaped like a JSON object or array are dropped before any database lookup".

### 6.7 claude-code-router (CCR)

**Verdict: mostly true.** Per-session cost: CCR logs per-request "cost estimates" ("Observability | Request and response details; resolved provider, model, and credential; status; latency; tokens; estimated cost", https://github.com/musistudio/claude-code-router), but no per-session aggregation is documented. No source found for per-session cost. SIGTERM failure mode: reported as "[Bug]: Process terminates with Exit Code 143 (SIGTERM) when using Claude Code Router with NVIDIA NIM" with the user's diagnosis "Is CCR sending SIGTERM to the Claude subprocess on certain internal error conditions rather than passing a proper error response through to the SDK?" — https://github.com/musistudio/claude-code-router/issues/1341. The upstream-timeout crash is issue #698: "Crash when the model takes too long to response" — undici `BodyTimeoutError` crashes the router when a slow upstream times out, https://github.com/musistudio/claude-code-router/issues/698. The two are separate reports; the report's claim (proxy-level failure → crash → SIGTERM to Claude Code, stream unrecoverable) matches the reported symptoms but neither issue proves the exact causal chain. Project status: active, 37.5k stars, pushed 2026-09-26.

### 6.8 Other maintained options

- **ccusage** (ryoppippi/ccusage): reads the local JSONL transcripts Claude Code writes under `~/.claude/projects/` and reports per-session, daily, monthly, and 5-hour-block cost; no proxy involved, so it cannot see a remote proxy's traffic and works per machine. "A CLI tool that analyzes your Claude Code token usage and cost across daily, monthly, session, and 5-hour billing windows" (https://claudekit.io/en/tools/ccusage/). 18.8k stars, pushed 2026-10-03 (`gh api repos/ryoppippi/ccusage`). Cost modes: pre-calculated `costUSD` from the JSONL or computed from tokens via LiteLLM pricing (https://www.mintlify.com/ryoppippi/ccusage/advanced/cost-modes).
- **Helicone**: maintained LLM gateway (6.2k stars, pushed 2026-09-16, `gh api repos/Helicone/Helicone`); can sit as `ANTHROPIC_BASE_URL` and attribute per request/user, but it is a docker-compose stack or paid cloud — heavy for one user (also judged in [cost-proxy.md](cost-proxy.md) section 3).
- **raine/claude-code-proxy**: an Anthropic-to-Codex/Kimi OAuth proxy; per-session cost is not its goal (https://github.com/raine/claude-code-proxy). 632 stars, pushed 2026-09-30. **1rgs/claude-code-proxy** (Anthropic→OpenAI, 3.7k stars) has not been pushed since 2026-06-23 — aging.
- No other maintained proxy dedicated to per-session Claude Code cost attribution through the API path was found; the space is either transcript readers (ccusage and clones) or full gateways (LiteLLM, CCR, Helicone).