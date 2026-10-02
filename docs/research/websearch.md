---
checked: 2026-09-29
recheck: 3m
decisions:
  - "build oc-sub instead of an existing tool"
---

# Why the researcher has no websearch tool

Date: 2026-09-29. Scope: opencode 1.18.32, model `openrouter/z-ai/glm-5.3-flash`, agent `opencode/agents/researcher.md`.

## 1. When does opencode give the `websearch` tool to a model?

The registry filters the tool list per model:

- `packages/opencode/src/tool/registry.ts:294`: if `tool.id === WebSearchTool.id`, the tool is kept only when `webSearchEnabled(input.providerID, { exa: flags.enableExa, parallel: flags.enableParallel })` returns true.
- `packages/opencode/src/tool/registry.ts:58-64` is the exact condition:

```ts
export function webSearchEnabled(providerID, flags = { exa: false, parallel: false }) {
  return (
    providerID === ProviderV2.ID.opencode ||
    providerID === ProviderV2.ID.make("opencode-go") ||
    flags.exa ||
    flags.parallel
  )
}
```

So the tool is exposed only when the provider is `opencode` or `opencode-go`, or one of the runtime flags is on. The flags come from environment variables (`packages/opencode/src/effect/runtime-flags.ts:31-36`): `enableExa` is true when `OPENCODE_EXPERIMENTAL`, `OPENCODE_ENABLE_EXA`, or `OPENCODE_EXPERIMENTAL_EXA` is truthy; `enableParallel` when `OPENCODE_ENABLE_PARALLEL` or `OPENCODE_EXPERIMENTAL_PARALLEL` is truthy.

Our researcher uses `openrouter/...`, so the provider check fails, no flag is set, and the tool is filtered out. The server still lists `websearch` in `/experimental/tool/ids` because the tool is registered as builtin; the filter applies later, when the tool list is built for the model. That last sentence is an interpretation of the registry code flow, not a quoted fact.

## 2. Which service does it call? Key? Cost?

The tool calls a hosted MCP service, not a REST API (`packages/opencode/src/tool/websearch.ts:69,85`):

- Exa: `https://mcp.exa.ai/mcp`, with `?exaApiKey=...` appended only if `EXA_API_KEY` is set (`packages/opencode/src/tool/mcp-websearch.ts:4-5`).
- Parallel: `https://search.parallel.ai/mcp` (`mcp-websearch.ts:7`). A `PARALLEL_API_KEY` is optional; without it only a User-Agent header is sent (`websearch.ts:54-58`).

The provider is chosen by `OPENCODE_WEBSEARCH_PROVIDER`, else the flags, else a per-session hash that picks exa or parallel roughly 50/50. Without a key both endpoints are used unauthenticated; the official docs say no key is required (https://opencode.ai/docs/tools/). Cost: the docs mention no price. Whether the free anonymous endpoints have rate limits or usage caps is unknown.

## 3. What do the official docs say?

https://opencode.ai/docs/tools/: "This tool is only available when using the OpenCode or OpenCode Go provider, or when either the `OPENCODE_ENABLE_EXA` or `OPENCODE_ENABLE_PARALLEL` environment variable is set to any truthy value". "No API key is required — the tool connects directly to the backend's hosted MCP service without authentication." The docs confirm our reading of the code.

## 4. How to turn it on for the researcher on an OpenRouter model

Set `OPENCODE_ENABLE_EXA=true` (or `=1`) in the environment of the `opencode serve` process. It is read through effect Config from the process environment (`runtime-flags.ts:31-36`); it is not an `opencode.json` setting and does not belong in the agent file. The agent file already has `permission: websearch: allow` (`opencode/agents/researcher.md:19`), which is correct and enough once the tool exists.

## 5. Alternative if it cannot be turned on

If the environment of the server cannot be changed, an established alternative is a search MCP server configured in `opencode.json` under `mcp`, for example the Exa MCP server at `https://mcp.exa.ai/mcp` (the same service opencode uses internally) or Tavily's MCP server. This is a guess about fit, not a tested setup; both are documented by their vendors.

## Recommendation

Set `OPENCODE_ENABLE_EXA=true` in the environment of `opencode serve`, then restart the server. Cost: none — no API key is needed and the docs name no price; Exa's paid tier only applies with `EXA_API_KEY`, which we do not set. Open questions: rate limits of the anonymous Exa/Parallel MCP endpoints, and whether result quality from `glm-5.3-flash` is good enough to use the tool well.
