# Probe routing: how one opencode 1.18.32 server pins one OpenRouter provider

Research for PLAN.md step 10b, written on 2026-09-30. No paid call was made. All facts come from the opencode source at tag `v1.18.32` (commit `545f51d26cc39a907d2867492d498d9607ea5fa4`, cloned to `/tmp/opencode/src-v1.18.32`) and from the two earlier reports of this project. File paths and line numbers below refer to that tag.

## Criteria

From the brief and the global rules:

- **No restart**: the mechanism must work on the one running server, without restarting it.
- **No plugin config change**: `opencode/opencode.json` of the plugin (which pins `z-ai` for `z-ai/glm-5.3-flash`) stays untouched.
- **Clear failure**: when the pin does not reach OpenRouter, the probe must detect it, not silently route to the default provider.
- **Small effort**: the probe program (step 10.2) stays small; the mechanism needs no new server infrastructure.
- **Correct cost reporting**: the probe runs must still report a sensible estimated cost through the models.dev catalog (step 5 lesson).

## 1. Config loading: per directory, merge order, deep merge

**Question 1: Does opencode load a project configuration per session directory, and how does it merge with `OPENCODE_CONFIG_DIR`?**

Yes. The server creates one *instance* per request directory and loads the configuration for it. Every instance HTTP request resolves its directory from `?directory=` or the `x-opencode-directory` header, falling back to the server process cwd (`packages/opencode/src/server/routes/instance/httpapi/middleware/workspace-routing.ts:87`).

The merge order in `packages/opencode/src/config/config.ts` (`loadInstanceState`, lines 412–490), each later source merged on top of the previous:

1. Global config: `~/.config/opencode/opencode.json(c)` (line 412–413).
2. `OPENCODE_CONFIG` file flag (line 415–418).
3. **Project config files**: `opencode.json` / `opencode.jsonc` found by walking up from the request directory, stopping at the worktree root (`ConfigPaths.files`, `packages/opencode/src/config/paths.ts:10–21`; merged at `config.ts:420–424`). The list is reversed before merging, so files closer to the root merge first and a deeper file wins a shared key.
4. **`OPENCODE_CONFIG_DIR`**: for every directory in the directory list (which always includes `OPENCODE_CONFIG_DIR` itself, `paths.ts:39`), if the directory ends with `.opencode` or equals the flag, its `opencode.json` / `opencode.jsonc` merges (config.ts:432–448).
5. **`OPENCODE_CONFIG_CONTENT`** (config.ts:482–490), always last.

So for `provider.openrouter.models.<model>.options.provider`, **`OPENCODE_CONFIG_DIR` wins over the project file** (merged later), and `OPENCODE_CONFIG_CONTENT` wins over both. This is why a project config cannot override the plugin's `only: ["z-ai"]` on the *same* model key — the plugin merges last among files.

**Deep or replaced?** Deep. The merge is `mergeDeep` from `remeda` (`config.ts:7,42–43`); only the `instructions` array is concatenated and deduplicated (`config.ts:46–51`), every other array is replaced by the later source. Inside `options.provider`, the merge is key by key: a later source that defines `only` replaces it, a key defined only by the earlier source (for example `sort`) survives. The same deep merge applies at model level in the provider runtime: `options: mergeDeep(existingModel?.options ?? {}, model.options ?? {})` (`packages/opencode/src/provider/provider.ts:1557`).

## 2. Model alias with a different name than the API id

**Question 2: Can a model entry have another name than its API id?**

Yes. The config schema (`packages/core/src/v1/config/provider.ts:13–14`) defines:

```ts
export const Model = Schema.Struct({
  id: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  ...
```

`models` is `Schema.Record(Schema.String, Model)` (line 130), so the config key is the local name and `id` is the API id. At runtime (`provider.ts:1493–1511`):

```ts
for (const [modelID, model] of Object.entries(provider.models ?? {})) {
  const existingModel = parsed.models[model.id ?? modelID]
  const apiID = model.id ?? existingModel?.api.id ?? modelID
  ...
  const parsedModel: Model = {
    id: ModelV2.ID.make(modelID),
    api: { id: apiID, npm: apiNpm, url: ... },
```

Consequences for the probe:

- A config entry `glm-probe-baseten` with `id: "z-ai/glm-5.3-flash"` registers a local model whose API id is the real slug. The alias key must not contain `/` before the provider split — `Model.parse` splits at the first `/` into providerID and modelID (`packages/core/src/model.ts:23–29`), and `ModelV2.ID` is a plain branded string (`packages/schema/src/model.ts:8–9`).
- The alias **inherits the catalog metadata of the real model**: `existingModel` is looked up under the API id (line 1494), so capabilities, cost, limit, and headers come from the models.dev entry (`provider.ts:1520–1563`). Cost reporting through the catalog stays correct.
- The alias has its own `options` object, separate from the plugin's `z-ai/glm-5.3-flash` entry (different key under `models`), so the deep merge of §1 cannot overwrite it.

## 3. The prompt API: model and variant per message, no routing options

**Question 3: Can the prompt API choose a model variant or pass provider options per message?**

Both endpoints (`POST /session/:sessionID/message` = `prompt`, `POST /session/:sessionID/prompt_async` = `promptAsync`) take the same payload: `PromptPayload = Schema.Struct(Struct.omit(SessionPrompt.PromptInput.fields, ["sessionID"]))` (`packages/opencode/src/server/routes/instance/httpapi/groups/session.ts:70`, endpoints at lines 316–342).

`PromptInput` (`packages/opencode/src/session/prompt.ts:1499–1520`):

```ts
export const PromptInput = Schema.Struct({
  sessionID: SessionID,
  messageID: Schema.optional(MessageID),
  model: Schema.optional(ModelRef),        // { providerID, modelID }
  agent: Schema.optional(Schema.String),
  noReply: Schema.optional(Schema.Boolean),
  tools: Schema.optional(...).annotate({ description: "@deprecated ..." }),
  format: Schema.optional(SessionV1.Format),
  system: Schema.optional(Schema.String),
  variant: Schema.optional(Schema.String),
  parts: Schema.Array(...),
})
```

So per message you can choose the **model** (any registered provider/model pair, i.e. any alias) and the **variant**, but there is **no field for provider routing options**. The request schema has no place for `provider: { only, allow_fallbacks }`.

Variant options do reach the wire: the per-request options are `mergeOptions(mergeOptions(mergeOptions(base, input.model.options), input.agent.options), variant)` with `mergeOptions = mergeDeep` (`packages/opencode/src/session/llm/request.ts:53,80–91`), and they go out as `providerOptions: ProviderTransform.providerOptions(input.model, prepared.params.options)` (`packages/opencode/src/session/llm.ts:316`). `ProviderTransform` remaps them to the SDK key: `@openrouter/ai-sdk-provider` → `"openrouter"` (`packages/opencode/src/provider/transform.ts:85–86,486–493`). But variants themselves are defined in the config (`variants` under the model, `provider.ts:1568–1576`), so a variant is not an inline escape hatch either.

This also confirms in the actual release tag the pass-through chain that OPENROUTER_ROUTING.md §1 could only read from `dev`: v1.18.32 merges model options into `providerOptions` under the `openrouter` key.

## 4. Config caching: per directory, needs dispose or a new directory

**Question 4: Does opencode cache the configuration of a directory?**

Yes. `Config.state` is an `InstanceState` — a `ScopedCache` keyed by the instance directory, unbounded capacity, no TTL (`config.ts:614–618`; `packages/opencode/src/effect/instance-state.ts:26–45`). Once a directory's config is loaded in the server process, it stays until the instance is disposed. Nothing watches config files (the only `Watcher` use is git in `project/vcs.ts`), and `Config.invalidate` (`config.ts:652–654`) only invalidates the *global* cache.

Two ways to reload without a server restart:

- `POST /instance/dispose` on the server disposes the instance of the request's directory; the next request reloads the config from disk (`packages/opencode/src/server/routes/instance/httpapi/groups/instance.ts:62–71`, handler `handlers/instance.ts:24–27`).
- A directory never used before (a fresh run worktree) loads its config on first use.

Practical rule for the probe: **write the per-run config before the first server request to that directory**, or dispose the instance afterwards.

## 5. Options judged

| Criterion | A: aliases in the plugin config | B: per-run `.opencode/opencode.json` in the run directory | C: one server per provider (`OPENCODE_CONFIG_CONTENT`) | D: per-message model/variant only |
| --- | --- | --- | --- | --- |
| No restart | Yes (static config) | Yes — new run directory loads config on first use (§4) | No — env is fixed at server start, one server per provider, or restart per change | Yes |
| No plugin config change | No — grows with every candidate provider | Yes — the plugin `opencode.json` stays untouched | Yes | Yes |
| Clear failure | Yes (`only` stays pinned; wrong provider = OpenRouter error) | Yes — missing alias fails with a model-not-found error; pin verified with a control run (below) | Yes | No mechanism to pin at all |
| Effort | Small but churns the reviewed plugin file | Small: one JSON file per run directory, written by the probe program | Large: N servers, N state files, oc-sub plumbing | Zero, but cannot pin |
| Cost reporting | Correct | Correct — alias inherits catalog cost via the API id (§2) | Correct | Correct |
| Sandbox clone mode | Fine | One caveat: in clone mode the run worktree exists only inside the sandbox clone, so the probe writes the file with `sbx exec` (step 14c context, PLAN.md) | Fine | Fine |

Option B's known failure modes:

- Config written *after* the directory's instance exists → stale config, pin silently absent. Mitigation: write first, or `POST /instance/dispose`.
- The pin option never reaches OpenRouter (the unresolved #41810 suspicion, OPENROUTER_ROUTING.md §1) → the run silently routes to the default provider. Mitigation: the control run below turns this into a loud failure.

## 6. Recommendation

**Option B: one model alias per provider, defined in a `.opencode/opencode.json` inside each probe run directory.** The deciding criteria are *no restart* and *no plugin config change*: a fresh run directory loads its config on first use (§4), the alias mechanism is first-class (§2), and the per-run file cannot collide with the plugin's pin because `models` merges key by key (§1). Option A violates the plugin-config criterion; option C violates the restart criterion and multiplies servers; option D cannot pin at all.

Per run directory (one worktree per provider):

```json
{
  "provider": {
    "openrouter": {
      "models": {
        "glm-probe-baseten": {
          "id": "z-ai/glm-5.3-flash",
          "options": {
            "provider": { "only": ["baseten"], "allow_fallbacks": false }
          }
        }
      }
    }
  }
}
```

The probe run selects the model per message with `model: { providerID: "openrouter", modelID: "glm-probe-baseten" }` (§3) — `oc-sub run` needs a way to pass the model, which it can take from the run brief or a flag.

**Clear failure when the pin does not apply.** Two checks, both cheap:

1. **Control run first**: one run with `only: ["no-such-provider"]`, `allow_fallbacks: false`. OpenRouter must reject it. If the run succeeds, the `provider` object is not reaching the request body — the whole oc-sub-based probe is invalid, and this settles the open question left in OPENROUTER_ROUTING.md (issue #41810) with one ~0.01 USD run.
2. **Per-run verification**: with the pin applied, a serving provider other than the pinned one is impossible unless OpenRouter ignores the object; the real cost from the project key usage (step 5) or the generation API (`GET /api/v1/generation`) names the provider. A price far off the pinned endpoint's published price is a second signal.

## Open questions

1. Does `afs.up(start, stop)` in `ConfigPaths.files` include an `opencode.json` placed at the worktree root itself when the request directory *is* the worktree root? The probe's config sits exactly there; if the stop boundary excludes it, the file goes one level deeper or the run starts from a subdirectory. One cheap test with `GET /config` (or a debug log) settles it.
2. In sandbox clone mode, does the server instance for the run directory see a file written with `sbx exec` immediately (no caching layer besides the config state)? Expected yes — same filesystem, config reloaded per new directory.
3. Does `oc-sub run` already accept a `--model provider/model` flag, or does the coder step add it? The server API supports it (§3); only the CLI surface is in question.
4. The exact OpenRouter behavior when `only` names a provider that has no endpoint for the model: connection error, or a 4xx with a clear message? The control run (§6) shows the real error text.

## Review of the main thread (2026-09-30)

The main thread accepts option B: one model alias per provider in a `.opencode/opencode.json` of each probe run directory, selected per message with `model`.

- The control run of section 6 is already done. EXPERIENCE.md ("Broken output from the provider, and routing that works") shows that OpenRouter refused a request with `order: ["no-such-provider-xyz"]` and `allow_fallbacks: false`. So opencode passes the `provider` object. The probe still starts with one control run with the alias mechanism, because the alias path is new.
- The probe runner (10d) writes the file with `sbx exec` before the first server request to the run directory, and it adds a `--model` flag to `oc-sub run` if none exists.
