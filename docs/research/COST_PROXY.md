# A local cost proxy between opencode and OpenRouter

Research for [PLAN.md](../PLAN.md) step 11a, written on 2026-09-30. No paid call was made. opencode version is 1.18.32 throughout; source quotes carry the tag.

Facts carry a source (URL or file with line number). Statements marked **[guess]** are judgment.

## Criteria

From the global rules (research before assumption, established libraries, small steps, quality first) and the brief:

- **C1 Streaming**: SSE pass-through without buffering the model stream.
- **C2 One small process per sandbox**: no heavy runtime, no database, fits the `sbx` holder process.
- **C3 No new paid service** and no code or data sent to a third party.
- **C4 Key safety**: the key never lands in a log and stays out of the agent's reach as today.
- **C5 Attribution**: the log line names the opencode session, the provider, the generation id, the tokens, the real cost, the latency, and the time; correct under overlapping runs.
- **C6 Effort**: a production-quality version stays small and testable with the existing `bun test` setup.
- **C7 Failure modes**: a proxy crash must be visible and bounded (it stops every model call of its server).
- **C8 Stability** (plugin option): survives opencode updates without breaking the server.

## 1. Where the proxy can run, and how opencode points at it

### The `baseURL` path exists and is documented

opencode applies `provider.<id>.options.baseURL` from the configuration to every model of that provider. Source at v1.18.32, `packages/opencode/src/provider/provider.ts`, `resolveSDK` (lines ~1737–1757):

```ts
const options = { ...provider.options }
...
const baseURL = iife(() => {
  let url =
    typeof options["baseURL"] === "string" && options["baseURL"] !== "" ? options["baseURL"] : model.api.url
  ...
})
if (baseURL !== undefined) options["baseURL"] = baseURL
```

Config options merge over the models.dev catalog entry with `mergeDeep(existing?.options ?? {}, provider.options ?? {})` (provider.ts:1488), so an `opencode.json` override wins. The docs say the same: "You can customize the base URL for any provider by setting the `baseURL` option. This is useful when using proxy services or custom endpoints" (https://opencode.ai/docs/providers/). `options.headers` and `options.apiKey` are also supported (same page).

The `openrouter` provider uses the bundled SDK `@openrouter/ai-sdk-provider` (`BUNDLED_PROVIDERS` at provider.ts:124), and that package takes a `baseURL` option: `createOpenRouter({ baseURL: 'https://proxy.example.com/openrouter' })` (npm README, `@openrouter/ai-sdk-provider` 3.1.0). So the configuration is one block in the plugin's `opencode/opencode.json` (or `OPENCODE_CONFIG_CONTENT` in sandbox mode):

```json
{ "provider": { "openrouter": { "options": { "baseURL": "http://127.0.0.1:4097/v1" } } } }
```

### Where the proxy runs

**Sandbox mode: inside the sandbox, next to `opencode serve`.** A proxy on the host is not reachable: the sandbox policy denies `host.docker.internal`, `localhost`, `127.0.0.0/8`, and all private ranges (`NETWORK_DENY_HOSTS`, src/sandbox.ts:37–44), and `up` verifies the denial on every start (src/sandbox.ts:735–744). Opening a hole to the host would undo the step 9 boundary. Inside the sandbox, loopback traffic stays inside the microVM, so the deny rules do not apply to it **[guess — verify that the sandboxed fetch of Bun honors `NO_PROXY`]**. Two adjustments are needed:

1. The serve environment must set `NO_PROXY=127.0.0.1,localhost` (or the proxy address), because the sandbox sets `HTTPS_PROXY=http://gateway.docker.internal:3128` and the deny rules would otherwise catch the request. Untested — open question.
2. The proxy's own upstream `fetch` to `https://openrouter.ai/api/v1/...` keeps the inherited `HTTPS_PROXY`, so the `sbx` gateway still injects the real project key. The proxy sees and forwards only the placeholder key `proxy-managed`; the real key never enters the proxy process. This keeps the C4 property exactly as today.

The holder process becomes a small `sh -c` wrapper that starts the proxy in the background and `exec`s the server:

```
sbx exec -e ... NAME sh -c 'bun /path/proxy.ts --port 4097 & exec opencode serve --hostname 0.0.0.0 --port 4096'
```

A restart loop around the proxy (`until bun proxy.ts; do sleep 1; done &`) bounds C7.

**Host mode: the same proxy binary on 127.0.0.1 next to `opencode serve`** (src/up.ts starts the server detached; the proxy starts the same way). In host mode the real key travels in the `Authorization` header through the proxy, so the proxy must never log that header (C4).

### How the log reaches the host

`spawnDetached` (src/sandbox.ts:322–342) already writes the stdout of the holder process into the host file `serveLogPath(env, port)` (`~/.local/state/oc-sub/serve-<port>.log`). The proxy prints one JSON line per request to stdout, so the log lands on the host with zero new plumbing, and `oc-sub` reads it there. The opencode server also writes into that file; every line is self-describing JSON, and the proxy tags its lines (`"source":"oc-sub-cost-proxy"`).

## 2. Does the streamed response carry provider and real cost?

**Yes. No second call to `GET /api/v1/generation` is needed.** From the OpenRouter docs (https://openrouter.ai/docs/use-cases/usage-accounting, fetched 2026-09-30):

> "OpenRouter automatically returns detailed usage information with every response, including: 1. Prompt and completion token counts using the model's native tokenizer 2. Cost in credits 3. Reasoning token counts (if applicable) 4. Cached token counts (if available). This information is included in the last SSE message for streaming responses, or in the complete response for non-streaming requests. **No additional parameters are required.**"

> "The `usage: { include: true }` and `stream_options: { include_usage: true }` parameters are deprecated and have no effect. Full usage details are now always included automatically in every response."

The final chunk's `usage` contains `cost` ("The total amount charged to your account") and `cost_details.upstream_inference_cost` (same page). This answers the open question 1 of [REAL_COST.md](REAL_COST.md): the cost arrives by itself; `usage: { include: true }` is not needed and cannot be added usefully.

The provider name is a top-level field of each SSE chunk, shown in the streaming example of the API reference:

```json
data: {"id":"cmpl-abc123","object":"chat.completion.chunk","created":1234567890,"model":"openai/gpt-4o","provider":"openai","error":{...},"choices":[...]}
```

(https://openrouter.ai/docs/api-reference/streaming). The docs do not state explicitly that the final usage chunk also carries `provider` — the proxy should take the provider from any chunk of the stream, not only the last one. The generation id arrives as header `X-Generation-Id` and top-level `id` ([PROVIDER_PROBE.md](PROVIDER_PROBE.md) section 4).

Consequence: the proxy taps the stream, forwards every byte immediately (C1), and extracts from the passing chunks: `id`, `provider`, and the `usage` of the final chunk.

## 3. Existing tools

| Option | C1 streaming | C2 per-sandbox process | C3 no paid service | C4 key safety | C5 attribution | C6 effort | C7/C8 failure modes |
|---|---|---|---|---|---|---|---|
| **LiteLLM proxy** | Streaming supported, but it inspects every chunk (repetition check); no unbuffered guarantee (https://docs.litellm.ai/docs/completion/stream) | Fails: Python ≥3.10 plus, for spend logs, a Postgres database (https://docs.litellm.ai/docs/proxy/cost_tracking) | Pass (MIT) | Pass | Its cost is its own estimate from its price map, not the OpenRouter charge; pass-through mode to OpenRouter exists but then re-writes the stream | High: a second runtime in every sandbox, config, DB | A heavy service to babysit per sandbox |
| **Helicone / Langfuse / OTel gateway** | Pass as gateways, but the opencode docs example routes a *custom* provider through Helicone's cloud (https://opencode.ai/docs/providers/) | Fails: self-hosted Helicone/Langfuse are docker-compose stacks (Postgres, ClickHouse); hosted = paid cloud | Fails for hosted; self-host is out of proportion | Code leaves the machine (hosted) | Rich, but no opencode session without extra wiring | High | Worst fit for one small server per project |
| **OpenRouter OTel broadcast** (no proxy at all) | No proxy in the data path at all: OpenRouter pushes an OTel trace per request to a configured endpoint, with cost, tokens, latency (https://openrouter.ai/docs — broadcast; see https://rajeevg.com/blog/one-door-for-every-token) | The receiver runs once on the host — but OpenRouter must reach it, which needs a public endpoint (Tailscale Funnel in the cited blog); the sandboxed projects would get traces for the whole account, mixed | Pass | Pass (nothing changes in the data path) | **Fails C5**: account-level, asynchronous, no opencode session id in the trace payload (not documented) | Low receiver, but the public endpoint is a new moving part | Delayed and account-mixed data; strikes need per-run attribution |
| **`openrouter-usage-proxy`** (npm, Loulen) | **Fails**: "Streaming responses are not supported (responses are buffered for logging)" (https://github.com/Loulen/openrouter-usage-proxy) | Pass (single npm CLI) | Pass | Pass | Logs model/tokens/cost, no session | Near zero | Buffering breaks agent streaming UX outright |
| **mitmproxy + script** | Pass | Fails-ish: Python process, plus CA certificate installation into the sandbox so TLS interception works | Pass | Risky by design: it sits inside TLS and can log the key | Header-based, fine | High: CA trust per sandbox image, script maintenance | A TLS-intercepting process in the hot path of every run |
| **Small Bun `fetch` pass-through** (own, ~100–150 lines) | Pass: Bun `fetch` response body is a `ReadableStream`; pipe it through and tap chunks with a `TransformStream` | Pass: one `bun` process, no new runtime (bun is already the oc-sub runtime) | Pass | Sandbox mode: proxy never sees the real key (sbx gateway injects it); host mode: never log `Authorization` | Header `X-Session-Id` (§4) + stream fields (§2) | Low | C7: a crash stops model calls — mitigated by a restart loop and the `up` health check |

The established big gateways solve a bigger problem than ours and fail C2/C6; the one small npm tool that matches the goal fails C1. **[fact, cited]** The Bun pass-through is the only option that passes all criteria; at ~150 lines it is smaller than the glue that any of the others would need.

## 4. Does the proxy know the opencode session?

**Yes.** opencode 1.18.32 sends the session id as a header with every LLM request. Source, `packages/opencode/src/session/llm/request.ts` (lines 187–206, tag v1.18.32):

```ts
headers: {
  ...(input.model.providerID.startsWith("opencode")
    ? { ..., "x-opencode-session": input.sessionID, ... }
    : {
        "x-session-affinity": input.sessionID,
        "X-Session-Id": input.sessionID,
        "User-Agent": USER_AGENT,
      }),
  ...(input.parentSessionID ? { "x-parent-session-id": input.parentSessionID } : {}),
  ...input.model.headers,
  ...headers,
},
```

The `openrouter` provider id does not start with `opencode`, so it gets `X-Session-Id` and `x-session-affinity`, plus `x-parent-session-id` for `task`-tool child sessions — exactly the attribution the step 2 cost view needs. The static `HTTP-Referer: https://opencode.ai/` and `X-Title: opencode` headers (provider.ts:471–474) identify the client but carry no session.

## 5. Status of opencode issue #43818

Still **open**. "[FEATURE]: Honor provider-reported cost (usage.cost) from LLM gateways (OpenRouter, LiteLLM, Manifest)" (https://github.com/anomalyco/opencode/issues/43818), opened 2026-08-21, assigned to rekram1-node, no comments, "Development: No branches or pull requests" (checked 2026-09-30). The proxy stays necessary; REAL_COST.md open question 3 stays open.

## 6. Can an opencode plugin do it instead?

The plugin surface at v1.18.32 is the `Hooks` interface in `packages/plugin/src/index.ts` (lines 224–337):

- `event` (`{ event }`), `config`, `auth`, `provider` (`models`), `tool`
- `"chat.message"`, `"chat.params"`, `"chat.headers"` — all receive `sessionID`, agent, model, provider
- `"permission.ask"`, `"command.execute.before"`, `"shell.env"`, `"tool.execute.before"`, `"tool.execute.after"`, `"tool.definition"`
- experimental: `"experimental.chat.messages.transform"`, `"experimental.chat.system.transform"`, `"experimental.provider.small_model"`, `"experimental.session.compacting"`, `"experimental.compaction.autocontinue"`, `"experimental.text.complete"`

What the hooks do and do not see:

- **No hook sees the raw response, the stream bytes, the provider of the request, or `usage.cost`.** `chat.params` output is `{ temperature, topP, topK, maxOutputTokens, options }` and `chat.headers` output is `{ headers }` — request-side only. There is no `chat.response`, no `step.finish`, and no fetch hook. The `event` hook sees bus events; the cost-bearing step-finish is not persisted as a part and carries only the catalog estimate ([REAL_COST.md](REAL_COST.md) section 2). Whether `providerMetadata.openrouter.usage.cost` reaches opencode's stream is still unverified (REAL_COST.md open question 1), and even if it did, no hook is called with it.
- **A hook knows the session id**: every `chat.*` hook input carries `sessionID` (and `chat.headers` can inject it into outgoing headers, request.ts:134–144, 202–204).
- **Custom fetch**: no hook provides one. A plugin runs inside the server process (plugin/index.ts loads the module and registers its hooks; `applyPlugin` at plugin/index.ts:114), so the only way to see the response is to wrap `globalThis.fetch` at plugin init — which intercepts every fetch of the whole server process, including the plugin's own SDK calls and the event loop traffic. **[fact for the loading model; the wrap is a guess-shaped workaround]**
- **Errors**: `Plugin.trigger` calls each hook with `Effect.promise(async () => fn(input, output))` (plugin/index.ts:285–296) and `session/llm/request.ts` has no catch around its three `plugin.trigger` calls (lines 69, 114, 134) — a throwing `chat.*` hook fails the request, i.e. the step. The `event` hook is called fire-and-forget (`void hook["event"]?.(...)`), so its errors surface only as session error events, not as request failures.
- **Stability (C8)**: `chat.headers` and the header set of request.ts are internal API without a stability promise; the `experimental.*` names say so themselves. A `globalThis.fetch` wrap depends on Bun's fetch call sites staying standard.

Judged on the criteria: the plugin wins C2 (no extra process) and attribution via `chat.headers` + `sessionID`, but **fails the core job**: it cannot record the provider or the real cost of a request without wrapping `globalThis.fetch`, which is fragile (C8), intercepts unrelated traffic (C7), and still re-implements SSE tapping — the hard part — inside the server process. As a hybrid it is useful: a plugin could later read the proxy log line via its header injection, but nothing in it replaces the proxy.

## 7. Recommendation

**A small Bun pass-through proxy (option F), one per server, run by the same holder process as `opencode serve`.**

- The deciding criteria are C5 (per-request attribution with session, provider, generation id, real cost), C1 (unbuffered SSE), C2/C6 (one tiny process in the runtime we already ship), and C4 (in sandbox mode the real key still never enters the sandbox). No existing tool passes those; LiteLLM and the gateways fail C2/C6, `openrouter-usage-proxy` fails C1, the OTel broadcast fails C5, mitmproxy fails C2/C4, and the plugin option cannot see the response at all without a fragile fetch wrap.
- The proxy listens on `127.0.0.1:4097` inside the sandbox (host mode: a second 127.0.0.1 port next to the server). The provider config sets `provider.openrouter.options.baseURL` accordingly. `up` writes the same value via `OPENCODE_CONFIG_CONTENT` in sandbox mode.
- **Log format**: one JSON line per request on stdout, prefixed by a tag field:

```json
{"source":"oc-sub-cost-proxy","time":"2026-09-30T12:00:00.000Z","session":"ses_abc123","parentSession":null,"model":"z-ai/glm-5.3-flash","provider":"Z.AI","generation":"gen-...","status":200,"latencyMs":3410,"cost":0.00123,"upstreamCost":0.00110,"tokens":{"input":194,"output":2,"reasoning":0,"cached":0}}
```

  The holder redirects stdout to the existing host file `~/.local/state/oc-sub/serve-<port>.log` (src/sandbox.ts `spawnDetached`, src/state.ts `serveLogPath`), so `oc-sub` on the host reads the log with plain file access; no port, no mount, no `sbx exec` per read. The later step 11b joins lines to sessions by the `session` field; strikes join by `provider`.
- **Failure mode (C7)**: a dead proxy fails every model call of that server. Mitigations: the holder wraps the proxy in a restart loop; `oc-sub doctor` (later step) greps the log for recent proxy lines and warns when the tag is missing; the error a run sees is the connection error, which `oc-sub watch` already reports.
- **Do not** use `usage: {include: true}` (deprecated, no effect) and **do not** call `GET /api/v1/generation` from the proxy — the last chunk carries `cost`; a `generation` lookup stays available later for latency fields.

## Open questions

1. Does Bun's fetch inside the sandbox honor `NO_PROXY` for `127.0.0.1:4097`, or must the proxy bind on another loopback address that the deny rules do not catch? Test with a real sandbox.
2. Does the final usage chunk of a streamed OpenRouter response carry the top-level `provider` field, or must the proxy take the provider from an earlier chunk? Confirm with the first real log lines.
3. Is the POST to `openrouter.ai` from the proxy covered by the same `sbx` policy rules that let opencode's POST through today (the proxy shares the sandbox and its `HTTPS_PROXY`)? Expected yes; verify in the first sandboxed run.
4. Does `X-Session-Id` also appear on the non-chat requests the openrouter provider makes (models list, etc.), and do the child-session headers survive on every step type (`x-parent-session-id` only when `parentSessionID` exists)?
5. Re-check issue #43818 before each later step; if opencode starts honoring `usage.cost` and storing the provider, the proxy can shrink to a provider-attribution-only tool or go away.

## Review of the main thread (2026-09-30)

The main thread accepts the recommendation: a small Bun pass-through proxy per server, inside the sandbox, with the key injected by the `sbx` gateway as today. The plugin option is out, because no hook sees the response.

Additions for the design step 11b:

- The proxy writes two lines per request: a `start` line when the request opens, and an `end` line with the fields of section 7. With both, `oc-sub watch` knows whether a model request is open. That fixes the false stall during a long bash command (known limit of step 6), and it finds a hanging provider after about 60 seconds instead of three minutes.
- The `end` line also records `finish_reason` and the HTTP error of a failed request, because retries and cut-off answers are provider signals for the strikes.
- The first implementation step starts with open question 1 (`NO_PROXY` inside the sandbox) as a live test of the main thread, before any other code.
