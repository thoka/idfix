# Deep research question: one driver layer with one cost path

The deep research question for step 25, word for word for Gemini Deep Research. Paste everything below the line into the tool. The report that comes back is [driver-interface.md](driver-interface.md).

---

Research question: This report designs a driver layer for a small in-house CLI. The layer makes three agent CLIs share one run record, one cost proxy, and one live view: opencode with GLM models through OpenRouter (already built), Claude Code on GLM through the OpenRouter Anthropic-compatible endpoint, and Claude Code on the Anthropic API. Compare extending the existing in-house proxy with adopting an established proxy or router. Evaluate real effort and known failure modes, not only the demo.

Current setup:

- One developer, several Linux machines (WSL2 and native), several projects. A small CLI called idfx starts agent runs in a sandbox and watches them. Its live table (`top`) shows every run with its cost per session.
- Today one driver exists: opencode 1.18.32 with GLM models through OpenRouter. An in-house HTTP proxy sits between opencode and OpenRouter. It logs every request with a session id that the opencode plugin adds. It records cost per session and keeps the OpenRouter key out of the run logs. It also calls the OpenRouter decisions endpoint for per-step judging.
- A second driver starts Claude Code on GLM: the script sets `ANTHROPIC_BASE_URL=https://openrouter.ai/api` and the model `z-ai/glm-5.3-flash`, with the project OpenRouter key. These sessions run in the sandbox and on the host.
- A third driver will start Claude Code on Claude (Anthropic API or a Claude subscription) inside the same sandbox.
- The live table must show every run of every driver with its cost. The shared commands over all drivers are: run, say (send a message to a running session), watch, log, and abort.

Goals and constraints:

- The driver interface stays open for a fourth CLI, for example Codex.
- All host sessions go through the proxy too, not only sandboxed runs: a supervisor session and interactive sessions that the user starts by hand.
- The proxy must never write a key or a token into its logs.
- The machines run WSL2 and native Linux. Tools and runtimes come from mise. Keep the maintenance low for one user.

Cover at least:

1. Session attribution: What does Claude Code send with a request to `/v1/messages` that a proxy can use to attribute the request to one session: the `metadata.user_id` field, the user agent, headers? Can `ANTHROPIC_CUSTOM_HEADERS` or a Claude Code hook inject a stable per-session id? How do existing tools attribute Claude Code traffic to a session or a project (for example ccusage, claude-code-router, LiteLLM, Helicone, Ballast, other Anthropic-compatible proxies)?
2. Adopt or extend: List every candidate proxy or router that you find, for example LiteLLM, claude-code-router, and Helicone. For each one, give its maturity (activity, users, stability) and its known failure modes, with sources. Answer three questions for each one. Does it log per-session cost? Does it speak both the OpenRouter API shape and the Anthropic `/v1/messages` shape? Does it stream SSE without breaking tool use? Also search the skills.sh directory (https://www.skills.sh/) for skills about Claude Code cost tracking and proxying.
3. Proxy placement and lifecycle on the host: Name the patterns for a small always-available local proxy that interactive sessions can point at with `ANTHROPIC_BASE_URL`. The options are a daemon, a systemd user unit, and a socket-activated service. A proxy can sit in front of Claude Code subscription (OAuth) traffic instead of API-key traffic. What breaks then? How do tools handle the mix of subscription auth and API keys?
4. Key hygiene: Name the patterns that keep provider keys and OAuth tokens out of proxy logs, access logs, and error dumps. Redaction targets are the `Authorization` header, the `x-api-key` header, the `anthropic-*` headers, and body fields. Name the known pitfalls too.
5. Mixed endpoint reality: OpenRouter serves both an OpenAI-style API and an Anthropic-style API under one host. Name the pitfalls: path handling (`https://openrouter.ai/api/v1` versus `https://openrouter.ai/api`), model name mapping, and usage fields (`usage` versus `usage_details`). How do proxies normalize them?

Criteria:

1. Per-session cost is correct for all three drivers. One table, no double counting.
2. Streaming tool use in Claude Code works through the proxy. No hangs, no truncated tool calls.
3. No key and no token reaches a log, a transcript, or the sandbox.
4. Works on WSL2 and native Linux. It starts after a reboot or on demand. It needs low maintenance for one user.
5. A fourth CLI can join later through a small driver interface.
6. The in-house CLI keeps its existing commands and its run records. The change stays small.

Output: a report in Markdown. It has a criteria table, the options with gains and costs, and a recommendation that names the criteria that decide it. It ends with the open questions. Every claim links its source.
