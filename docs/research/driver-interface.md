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